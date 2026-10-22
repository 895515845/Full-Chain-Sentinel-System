/** Whole-bundle Mach-O scanning, the check that catches never-loaded frameworks. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { missingImages, scanBundleImages } from "../src/ios-bundle.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

function app(): string {
	const root = mkdtempSync(join(tmpdir(), "ios-bundle-"));
	dirs.push(root);
	const appDir = join(root, "Payload", "Demo.app");
	mkdirSync(join(appDir, "Frameworks", "A.framework"), { recursive: true });
	mkdirSync(join(appDir, "PlugIns", "Ext.appex"), { recursive: true });
	writeFileSync(join(appDir, "Demo"), thin64(1));
	writeFileSync(join(appDir, "Frameworks", "A.framework", "A"), thin64(0));
	writeFileSync(join(appDir, "PlugIns", "Ext.appex", "Ext"), thin64(1));
	writeFileSync(join(appDir, "Info.plist"), "not a mach-o");
	return appDir;
}

test("scan reports every Mach-O with arch and cryptid", () => {
	const images = scanBundleImages(app());
	expect(images.map((image) => image.rel)).toEqual(["Demo", "Frameworks/A.framework/A", "PlugIns/Ext.appex/Ext"]);
	expect(images.find((image) => image.rel === "Frameworks/A.framework/A")?.cryptid).toBe(0);
	expect(images.find((image) => image.rel === "PlugIns/Ext.appex/Ext")?.cryptid).toBe(1);
	expect(images.every((image) => image.arch === "arm64")).toBe(true);
});

test("missingImages lists encrypted images the dump did not produce", () => {
	const images = scanBundleImages(app());
	const missing = missingImages(images, ["Demo"]);
	expect(missing.map((image) => image.rel)).toEqual(["PlugIns/Ext.appex/Ext"]);
});

test("a missing directory is an empty scan, not a throw", () => {
	expect(scanBundleImages(join(tmpdir(), "does-not-exist-sentinel"))).toEqual([]);
});
