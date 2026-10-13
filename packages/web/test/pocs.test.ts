/**
 * Unit tests for the POC library: template parsing, import dedupe, zip
 * unpacking, and the never-silently-widen rule for the poc_read switch.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, test } from "vitest";
import { normalizePermissions } from "../src/permissions.ts";
import { createPocTools } from "../src/poc-tool.ts";
import { readZip } from "../src/poc-zip.ts";
import { PocStore, parseNucleiTemplate } from "../src/pocs.ts";

const TEMPLATE = (id: string, name = "Test template", severity = "high"): string => `id: ${id}

info:
  name: ${name}
  author: zgagent
  severity: ${severity}
  tags: cve,rce
  classification:
    cve-id: CVE-2021-44228

http:
  - method: GET
    path:
      - "{{BaseURL}}"
`;

interface CallableTool {
	execute(
		toolCallId: string,
		params: never,
	): Promise<{ content?: { type: string; text?: string }[]; isError?: boolean }>;
}

function callTool(tool: ToolDefinition | undefined, params: unknown) {
	return (tool as unknown as CallableTool).execute("call-1", params as never);
}

let dir: string;
let store: PocStore;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "zg-pocs-"));
	store = new PocStore(join(dir, "pocs.db"));
});

afterAll(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("parse extracts id, name, severity, tags and cve", () => {
	const parsed = parseNucleiTemplate(TEMPLATE("log4j-rce", "Log4Shell RCE", "critical"));
	expect(parsed).toEqual({
		id: "log4j-rce",
		name: "Log4Shell RCE",
		severity: "critical",
		tags: ["cve", "rce"],
		references: ["CVE-2021-44228"],
	});
});

test("a template without a usable id is rejected, unknown severity degrades to info", () => {
	expect(parseNucleiTemplate("no id here\ninfo:\n  name: x\n")).toBeNull();
	expect(parseNucleiTemplate(TEMPLATE("weird id", "x", "catastrophic"))).toBeNull();
	expect(parseNucleiTemplate(TEMPLATE("odd-sev", "x", "catastrophic"))?.severity).toBe("info");
});

test("import inserts, dedupes by template id, and reports skips", () => {
	const first = store.import([{ name: "a.yaml", bytes: Buffer.from(TEMPLATE("t1"), "utf8") }]);
	expect(first).toMatchObject({ imported: 1, replaced: 0, skipped: [] });

	// Same id: the re-import overwrites instead of forking a duplicate.
	const again = store.import([{ name: "b.yaml", bytes: Buffer.from(TEMPLATE("t1", "Renamed"), "utf8") }]);
	expect(again).toMatchObject({ imported: 0, replaced: 1 });
	expect(store.get("t1")?.name).toBe("Renamed");

	const bad = store.import([
		{ name: "not-yaml.txt", bytes: Buffer.from("hello", "utf8") },
		{ name: "broken.yaml", bytes: Buffer.from("id:\ninfo:\n  name: x\n", "utf8") },
	]);
	expect(bad.imported).toBe(0);
	expect(bad.skipped.map((item) => item.reason)).toEqual(
		expect.arrayContaining(["只支持 .yaml / .yml / .zip", "缺少有效的模板 id"]),
	);
});

test("list filters by tag, severity and search; stats count severities", () => {
	store.import([
		{ name: "low.yaml", bytes: Buffer.from(TEMPLATE("t-low", "Low one", "low"), "utf8") },
		{ name: "med.yaml", bytes: Buffer.from(TEMPLATE("t-med", "WordPress plugin", "medium"), "utf8") },
	]);
	expect(
		store
			.list({ tag: "rce" })
			.map((item) => item.id)
			.sort(),
	).toEqual(["t-low", "t-med", "t1"]);
	expect(store.list({ severity: "critical" })).toEqual([]);
	expect(store.list({ severity: "medium" }).map((item) => item.id)).toEqual(["t-med"]);
	expect(store.list({ search: "wordpress" }).map((item) => item.id)).toEqual(["t-med"]);
	expect(
		store
			.list({ search: "cve-2021-44228" })
			.map((item) => item.id)
			.sort(),
	).toEqual(["t-low", "t-med", "t1"]);
	expect(store.stats().total).toBe(3);
	expect(store.stats().bySeverity).toMatchObject({ high: 1, medium: 1, low: 1 });
	expect(store.delete("t-med")).toBe(true);
	expect(store.delete("t-med")).toBe(false);
});

test("agent tools search and read, and say the library is not executable", async () => {
	const tools = createPocTools({ store });
	const search = tools.find((tool) => tool.name === "poc_search");
	const read = tools.find((tool) => tool.name === "poc_read");
	expect(search?.description).toContain("read-only");
	expect(read?.description).toContain("write the yaml yourself");

	const result = await callTool(search, { search: "renamed" });
	const text = (result?.content as { type: string; text?: string }[])[0]?.text ?? "";
	expect(text).toContain("Renamed");

	const full = await callTool(read, { id: "t1" });
	expect((full?.content as { type: string; text?: string }[])[0]?.text ?? "").toContain("CVE-2021-44228");

	const missing = await callTool(read, { id: "nope" });
	expect(missing?.isError).toBe(true);
});

// --- zip ---

/** Build a minimal stored-entry zip by hand; the reader must accept it. */
function buildZip(files: { name: string; data: Buffer }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const nameBuf = Buffer.from(file.name, "utf8");
		const crc = 0; // the reader does not verify checksums
		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(0, 8); // stored
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(file.data.length, 18);
		local.writeUInt32LE(file.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		nameBuf.copy(local, 30);
		locals.push(Buffer.concat([local, file.data]));

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(file.data.length, 20);
		central.writeUInt32LE(file.data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);
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

test("zip entries are unpacked and imported", () => {
	const zip = buildZip([
		{ name: "templates/t-zip.yaml", data: Buffer.from(TEMPLATE("t-zip"), "utf8") },
		{ name: "templates/readme.txt", data: Buffer.from("skip me", "utf8") },
	]);
	const outcome = store.import([{ name: "pack.zip", bytes: zip }]);
	expect(outcome).toMatchObject({ imported: 1, replaced: 0 });
	expect(store.get("t-zip")?.sourceFile).toBe("templates/t-zip.yaml");

	const { entries } = readZip(zip);
	expect(entries.map((entry) => entry.name)).toEqual(["templates/t-zip.yaml", "templates/readme.txt"]);
	expect(() => readZip(Buffer.from("not a zip file at all, but long enough"))).toThrow();
});

// --- permissions ---

test("an old permissions.json never agreed to poc_read, so it reads as off", () => {
	const legacy = normalizePermissions({
		main: {
			read: true,
			bash: true,
			edit: true,
			write: true,
			codemode: true,
			tool_search: true,
			mcp: true,
			spawn_agent: true,
		},
		subagent: { read: true },
	});
	expect(legacy.main.poc_read).toBe(false);
	// A fresh install defaults to everything on, the library included.
	expect(normalizePermissions({}).main.poc_read).toBe(true);
});
