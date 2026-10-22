/**
 * Scan an app bundle for Mach-O images before a FairPlay dump.
 *
 * The device-side dump can only see images that are loaded in the target
 * process. Scanning the pulled bundle on the console answers the complementary
 * question: which images exist, which of them are still encrypted, and what did
 * the dump therefore miss. Frameworks and app extensions are separate Mach-O
 * files, so a single `cryptid` on the main executable is not enough.
 */

import { closeSync, type Dirent, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { machoInfo } from "./macho.ts";

export interface BundleImage {
	/** Path relative to the .app directory, using forward slashes. */
	rel: string;
	size: number;
	arch: string;
	cryptid: number;
}

const MAGIC_THIN_64 = 0xfeedfacf;
const MAGIC_THIN_32 = 0xfeedface;
const MAGIC_FAT = 0xcafebabe;
const MAGIC_FAT_64 = 0xcafebabf;
const MAGIC_SET = new Set([MAGIC_THIN_64, MAGIC_THIN_32, MAGIC_FAT, MAGIC_FAT_64]);

/** Read the four magic bytes without pulling an entire asset into memory. */
function hasMachOMagic(path: string): boolean {
	const buffer = Buffer.alloc(4);
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		if (readSync(fd, buffer, 0, 4, 0) !== 4) return false;
		// Thin arm64 is little-endian on disk (`cf fa ed fe`), while the fat
		// header is big-endian; accept either reading of the same four bytes.
		return MAGIC_SET.has(buffer.readUInt32BE(0)) || MAGIC_SET.has(buffer.readUInt32LE(0));
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Walk a pulled `.app` and return every Mach-O file with its arch and cryptid.
 * Symlinks are skipped: the dump replaces real files, and a symlinked framework
 * would otherwise be patched twice or written outside the bundle.
 */
export function scanBundleImages(appDir: string): BundleImage[] {
	const images: BundleImage[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!hasMachOMagic(full)) continue;
			let bytes: Buffer;
			try {
				// Mach-O headers live at the front, but the fat wrapper's slice
				// offsets can point anywhere; reading the file once is the simple
				// correct trade-off and matches what machoInfo expects.
				bytes = readFileSync(full);
			} catch {
				continue;
			}
			const info = machoInfo(bytes);
			if (!info) continue;
			images.push({
				rel: relative(appDir, full).split(sep).join("/"),
				size: bytes.length,
				arch: info.arch,
				cryptid: info.cryptid,
			});
		}
	};
	walk(appDir);
	return images.sort((left, right) => left.rel.localeCompare(right.rel));
}

/** Images the dump did not produce, i.e. encrypted images that never loaded. */
export function missingImages(images: BundleImage[], dumpedRels: Iterable<string>): BundleImage[] {
	const dumped = new Set(dumpedRels);
	return images.filter((image) => image.cryptid !== 0 && !dumped.has(image.rel));
}
