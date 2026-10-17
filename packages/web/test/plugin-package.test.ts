/**
 * Uploaded plugin packages: a zip (root or one directory deep) or a bare
 * plugin.json. Nothing is extracted, so the only things to get right are which
 * entry is the manifest and what the operator is told when there is none.
 */

import { describe, expect, test } from "vitest";
import { MAX_PLUGIN_PACKAGE_BYTES, readPluginPackage } from "../src/plugin-package.ts";

const DIGEST = "d".repeat(64);

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: 1,
		id: "com.example.recon",
		name: "侦察工具集",
		version: "0.1.0",
		description: "tests",
		author: "github:someone",
		source: "https://github.com/someone/recon",
		license: "MIT",
		image: `ghcr.io/someone/recon@sha256:${DIGEST}`,
		mcp: { transport: "http", port: 7801, path: "/mcp" },
		permissions: { network: "bridge" },
		locality: "any",
		...overrides,
	};
}

/** Minimal stored-entry zip; the package reader does not verify checksums. */
function buildZip(files: Array<{ name: string; data: Buffer }>): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name, "utf8");
		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(file.data.length, 18);
		local.writeUInt32LE(file.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);
		locals.push(Buffer.concat([local, file.data]));

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(file.data.length, 20);
		central.writeUInt32LE(file.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		centrals.push(central);

		offset += local.length + file.data.length;
	}
	const directory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(directory.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, eocd]);
}

function base64(buffer: Buffer): string {
	return buffer.toString("base64");
}

describe("readPluginPackage", () => {
	test("accepts a bare plugin.json", () => {
		const result = readPluginPackage("plugin.json", base64(Buffer.from(JSON.stringify(manifest()))));
		expect(result.manifest.id).toBe("com.example.recon");
		expect(result.name).toBe("plugin.json");
		expect(result.files).toEqual([]);
	});

	test("accepts a zip whose root holds plugin.json", () => {
		const zip = buildZip([
			{ name: "plugin.json", data: Buffer.from(JSON.stringify(manifest())) },
			{ name: "README.md", data: Buffer.from("# recon") },
		]);
		const result = readPluginPackage("recon.zip", base64(zip));
		expect(result.manifest.id).toBe("com.example.recon");
		expect(result.files).toContain("README.md");
	});

	test("accepts a zip with one top-level directory", () => {
		const zip = buildZip([
			{ name: "recon/plugin.json", data: Buffer.from(JSON.stringify(manifest())) },
			{ name: "recon/README.md", data: Buffer.from("# recon") },
		]);
		expect(readPluginPackage("recon.zip", base64(zip)).manifest.id).toBe("com.example.recon");
	});

	test("prefers the shallowest plugin.json", () => {
		const zip = buildZip([
			{ name: "docs/plugin.json", data: Buffer.from(JSON.stringify(manifest({ version: "9.9.9" }))) },
			{ name: "plugin.json", data: Buffer.from(JSON.stringify(manifest({ version: "0.1.0" }))) },
		]);
		expect(readPluginPackage("recon.zip", base64(zip)).manifest.version).toBe("0.1.0");
	});

	test("rejects a zip without a manifest", () => {
		const zip = buildZip([{ name: "README.md", data: Buffer.from("nothing here") }]);
		expect(() => readPluginPackage("recon.zip", base64(zip))).toThrow(/plugin\.json/);
	});

	test("rejects an unsupported extension", () => {
		expect(() => readPluginPackage("recon.tar.gz", base64(Buffer.from("x")))).toThrow(/zip/);
	});

	test("rejects an empty package and an oversized one", () => {
		expect(() => readPluginPackage("plugin.json", "")).toThrow(/为空/);
		const huge = Buffer.alloc(MAX_PLUGIN_PACKAGE_BYTES + 1);
		expect(() => readPluginPackage("plugin.json", base64(huge))).toThrow(/上限/);
	});

	test("reports manifest problems from inside the archive", () => {
		const zip = buildZip([
			{ name: "plugin.json", data: Buffer.from(JSON.stringify(manifest({ image: "ghcr.io/x/y:latest" }))) },
		]);
		expect(() => readPluginPackage("recon.zip", base64(zip))).toThrow(/digest/);
	});
});
