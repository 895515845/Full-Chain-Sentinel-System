import { expect, test } from "vitest";
import { getOfficialPlugin, listOfficialPlugins } from "../src/official-plugins.ts";
import { readZip } from "../src/poc-zip.ts";

test("the bundled catalog lists MemShellParty and the zip carries its manifest", () => {
	const listed = listOfficialPlugins();
	const memshell = listed.find((entry) => entry.manifest.id === "com.sentinel.memshell-party");
	expect(memshell).toBeDefined();
	expect(memshell?.manifest.ui?.sidebar).toEqual({ label: "MemShellParty", icon: "" });

	const bundled = getOfficialPlugin("com.sentinel.memshell-party");
	expect(bundled).toBeDefined();
	if (!bundled) return;
	expect(bundled.sizeBytes).toBeGreaterThan(0);
	const entries = readZip(Buffer.from(bundled.packageBase64, "base64")).entries;
	const manifestEntry = entries.find((entry) => entry.name === "plugin.json");
	expect(manifestEntry).toBeDefined();
	const manifest = JSON.parse(manifestEntry?.data.toString("utf-8") ?? "{}") as {
		id?: string;
		version?: string;
	};
	expect(manifest.id).toBe("com.sentinel.memshell-party");
	expect(manifest.version).toBe(bundled.manifest.version);
});

test("the catalog exposes every package manifest and rejects unknown ids", () => {
	for (const entry of listOfficialPlugins()) {
		expect(entry.manifest.id).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
		expect(entry.sizeBytes).toBeGreaterThan(0);
	}
	expect(getOfficialPlugin("com.example.unknown")).toBeUndefined();
});
