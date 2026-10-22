/** Mach-O cryptid reading and patching, on synthetic thin and fat binaries. */

import { expect, test } from "vitest";
import { machoInfo, patchCryptid } from "../src/macho.ts";

function thin64(cryptid: number): Buffer {
	const bytes = Buffer.alloc(32 + 24);
	bytes.writeUInt32LE(0xfeedfacf, 0);
	bytes.writeUInt32LE(0x0100000c, 4); // arm64
	bytes.writeUInt32LE(1, 16); // ncmds
	bytes.writeUInt32LE(24, 20); // sizeofcmds
	bytes.writeUInt32LE(0x2c, 32); // LC_ENCRYPTION_INFO_64
	bytes.writeUInt32LE(24, 36);
	bytes.writeUInt32LE(0x4000, 40); // cryptoff
	bytes.writeUInt32LE(0x1000, 44); // cryptsize
	bytes.writeUInt32LE(cryptid, 48);
	return bytes;
}

function fat(offsetA: number, offsetB: number, size: number): Buffer {
	const bytes = Buffer.alloc(offsetB + size);
	bytes.writeUInt32BE(0xcafebabe, 0);
	bytes.writeUInt32BE(2, 4); // nfat_arch
	for (const [index, offset] of [offsetA, offsetB].entries()) {
		const entry = 8 + index * 20;
		bytes.writeUInt32BE(0x0100000c, entry);
		bytes.writeUInt32BE(0, entry + 4);
		bytes.writeUInt32BE(offset, entry + 8);
		bytes.writeUInt32BE(size, entry + 12);
		bytes.writeUInt32BE(12, entry + 16);
		const slice = thin64(1);
		slice.copy(bytes, offset);
	}
	return bytes;
}

test("machoInfo reads arch, cryptid and the encrypted range", () => {
	const info = machoInfo(thin64(1));
	expect(info).toEqual({ arch: "arm64", cryptid: 1, cryptoff: 0x4000, cryptsize: 0x1000 });
});

test("patchCryptid zeroes the cryptid and is idempotent", () => {
	const bytes = thin64(1);
	expect(patchCryptid(bytes).patched).toBe(1);
	expect(machoInfo(bytes)?.cryptid).toBe(0);
	expect(patchCryptid(bytes).patched).toBe(0);
});

test("patchCryptid patches every slice of a fat binary", () => {
	const bytes = fat(64, 128, 56);
	expect(machoInfo(bytes)?.cryptid).toBe(1);
	const result = patchCryptid(bytes);
	expect(result.patched).toBe(2);
	expect(bytes.readUInt32LE(64 + 48)).toBe(0);
	expect(bytes.readUInt32LE(128 + 48)).toBe(0);
});

test("machoInfo returns null for a non-Mach-O buffer", () => {
	expect(machoInfo(Buffer.from("not a mach-o at all"))).toBeNull();
});
