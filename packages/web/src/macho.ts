/**
 * Mach-O facts the iOS tools need, in one place: which architecture a binary
 * is, whether FairPlay still encrypts it (`cryptid`), and where the encryption
 * load command sits so a decrypted dump can be marked as such.
 *
 * Thin and fat binaries are both handled; a fat file is reported (and patched)
 * per slice, because an App Store binary can carry more than one slice and a
 * half-patched IPA installs but crashes.
 *
 * iOS arm binaries are little-endian, so the magic on disk is `cf fa ed fe`
 * (thin64) or `ce fa ed fe` (thin32), not the big-endian constant. Both orders
 * are accepted and load commands are read with the slice's own order.
 */

export interface MachOInfo {
	arch: string;
	/** LC_ENCRYPTION_INFO cryptid: 0 means the binary is decrypted. */
	cryptid: number;
	/** File offset and size of the encrypted region, 0 when absent. */
	cryptoff: number;
	cryptsize: number;
}

const LC_ENCRYPTION_INFO = 0x21;
const LC_ENCRYPTION_INFO_64 = 0x2c;

function archName(cpu: number): string {
	if (cpu === 0x0100000c) return "arm64";
	if (cpu === 0x0000000c) return "armv7";
	if (cpu === 0x01000007) return "x86_64";
	if (cpu === 0x00000007) return "i386";
	return "unknown";
}

interface ThinSlice {
	base: number;
	is64: boolean;
	littleEndian: boolean;
	commandStart: number;
	commandCount: number;
	arch: string;
}

function readU32(bytes: Buffer, offset: number, littleEndian: boolean): number {
	return littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
}

function writeU32(bytes: Buffer, offset: number, value: number, littleEndian: boolean): void {
	if (littleEndian) bytes.writeUInt32LE(value, offset);
	else bytes.writeUInt32BE(value, offset);
}

/** Locate the thin slices of a Mach-O image (one for thin, many for fat). */
function slices(bytes: Buffer): ThinSlice[] {
	if (bytes.length < 28) return [];
	const bigMagic = bytes.readUInt32BE(0);
	if (bigMagic === 0xcafebabe || bigMagic === 0xcafebabf) {
		const fat64 = bigMagic === 0xcafebabf;
		const count = bytes.readUInt32BE(4);
		const entrySize = fat64 ? 32 : 20;
		const found: ThinSlice[] = [];
		for (let index = 0; index < Math.min(count, 16); index += 1) {
			const entry = 8 + index * entrySize;
			if (entry + entrySize > bytes.length) break;
			const offset = fat64 ? Number(bytes.readBigUInt64BE(entry + 8)) : bytes.readUInt32BE(entry + 8);
			if (offset <= 0 || offset + 28 > bytes.length) continue;
			found.push(...slices(bytes.subarray(offset)).map((slice) => ({ ...slice, base: slice.base + offset })));
		}
		return found;
	}
	let is64: boolean;
	let littleEndian: boolean;
	if (bigMagic === 0xfeedfacf) {
		is64 = true;
		littleEndian = false;
	} else if (bigMagic === 0xfeedface) {
		is64 = false;
		littleEndian = false;
	} else {
		const littleMagic = bytes.readUInt32LE(0);
		if (littleMagic === 0xfeedfacf) {
			is64 = true;
			littleEndian = true;
		} else if (littleMagic === 0xfeedface) {
			is64 = false;
			littleEndian = true;
		} else {
			return [];
		}
	}
	const headerSize = is64 ? 32 : 28;
	if (bytes.length < headerSize) return [];
	return [
		{
			base: 0,
			is64,
			littleEndian,
			commandStart: headerSize,
			commandCount: readU32(bytes, 16, littleEndian),
			arch: archName(readU32(bytes, 4, littleEndian)),
		},
	];
}

/** Read arch/cryptid/cryptoff/cryptsize from the first slice that has them. */
export function machoInfo(bytes: Buffer): MachOInfo | null {
	for (const slice of slices(bytes)) {
		let cryptid = 0;
		let cryptoff = 0;
		let cryptsize = 0;
		let cursor = slice.base + slice.commandStart;
		for (let index = 0; index < Math.min(slice.commandCount, 4096); index += 1) {
			if (cursor + 8 > bytes.length) break;
			const command = readU32(bytes, cursor, slice.littleEndian);
			const size = readU32(bytes, cursor + 4, slice.littleEndian);
			if ((command === LC_ENCRYPTION_INFO || command === LC_ENCRYPTION_INFO_64) && cursor + 20 <= bytes.length) {
				cryptoff = readU32(bytes, cursor + 8, slice.littleEndian);
				cryptsize = readU32(bytes, cursor + 12, slice.littleEndian);
				cryptid = readU32(bytes, cursor + 16, slice.littleEndian);
			}
			if (size < 8) break;
			cursor += size;
		}
		return { arch: slice.arch, cryptid, cryptoff, cryptsize };
	}
	return null;
}

/**
 * Zero every encryption load command's cryptid so the binary reads as
 * decrypted. Mutates `bytes` in place and reports how many commands changed.
 */
export function patchCryptid(bytes: Buffer): { patched: number; arch: string } {
	let patched = 0;
	let arch = "unknown";
	for (const slice of slices(bytes)) {
		arch = slice.arch;
		let cursor = slice.base + slice.commandStart;
		for (let index = 0; index < Math.min(slice.commandCount, 4096); index += 1) {
			if (cursor + 8 > bytes.length) break;
			const command = readU32(bytes, cursor, slice.littleEndian);
			const size = readU32(bytes, cursor + 4, slice.littleEndian);
			if ((command === LC_ENCRYPTION_INFO || command === LC_ENCRYPTION_INFO_64) && cursor + 20 <= bytes.length) {
				if (readU32(bytes, cursor + 16, slice.littleEndian) !== 0) {
					writeU32(bytes, cursor + 16, 0, slice.littleEndian);
					patched += 1;
				}
			}
			if (size < 8) break;
			cursor += size;
		}
	}
	return { patched, arch };
}
