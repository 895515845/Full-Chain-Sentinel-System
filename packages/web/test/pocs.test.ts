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
import { openSqliteDatabase } from "../src/sqlite.ts";

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

test("the tools steer the model away from treating a template's path as the target's", async () => {
	// Templates hardcode one common deployment's paths, so a scan that fired the
	// path as written and got a 404 proves nothing. The prompt says so, and every
	// read repeats it next to the yaml.
	const tools = createPocTools({ store });
	const search = tools.find((tool) => tool.name === "poc_search") as
		| { description?: string; promptGuidelines?: string[]; promptSnippet?: string }
		| undefined;
	const read = tools.find((tool) => tool.name === "poc_read");
	const guidelines = (search?.promptGuidelines ?? []).join("\n");
	expect(guidelines).toContain("generic fingerprinting");
	expect(guidelines).toContain("path and URL prefix are one common deployment");
	expect(guidelines).toContain("not evidence that the target is unaffected");
	expect(search?.description).toContain("generic fingerprint knowledge");
	expect(search?.promptSnippet).toContain("read-only Nuclei POC library");

	const full = await callTool(read, { id: "t1" });
	const text = (full?.content as { type: string; text?: string }[])[0]?.text ?? "";
	expect(text).toContain("真实路径");
	// The note survives clipping: a template over the output cap still carries it.
	const big = store.import([
		{ name: "big.yaml", bytes: Buffer.from(`${TEMPLATE("t-huge")}${"# pad\n".repeat(2_000)}`, "utf8") },
	]);
	expect(big.imported).toBe(1);
	const clipped = await callTool(read, { id: "t-huge" });
	const clippedText = (clipped?.content as { type: string; text?: string }[])[0]?.text ?? "";
	expect(clippedText).toContain("输出已截断");
	expect(clippedText).toContain("真实路径");
});

// --- zip ---

/** Build a minimal stored-entry zip by hand; the reader must accept it. */
function buildZip(files: { name: string; data: Buffer }[], options: { zip64?: boolean } = {}): Buffer {
	// A real writer switches to zip64 once the count no longer fits in the 16-bit
	// end-of-central-directory field; do the same by default so the helper never
	// builds an archive no writer would produce.
	const zip64 = options.zip64 ?? files.length > 0xffff;
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
	const trailer: Buffer[] = [];
	if (zip64) {
		const record = Buffer.alloc(56);
		record.writeUInt32LE(0x06064b50, 0);
		record.writeBigUInt64LE(44n, 4); // size of the rest of the record
		record.writeUInt16LE(45, 12);
		record.writeUInt16LE(45, 14);
		record.writeBigUInt64LE(BigInt(files.length), 24);
		record.writeBigUInt64LE(BigInt(files.length), 32);
		record.writeBigUInt64LE(BigInt(directory.length), 40);
		record.writeBigUInt64LE(BigInt(offset), 48);
		const locator = Buffer.alloc(20);
		locator.writeUInt32LE(0x07064b50, 0);
		locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
		locator.writeUInt32LE(1, 16);
		trailer.push(record, locator);
	}
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 8);
	eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
	eocd.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
	eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
	return Buffer.concat([...locals, directory, ...trailer, eocd]);
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

test("every subfolder of an archive is walked, however deep", () => {
	// A zip is a flat list of paths, so depth is only a prefix: the importer has
	// to pick up a template at any depth, and the depth stays in `sourceFile`.
	const zip = buildZip([
		{ name: "nuclei-templates/", data: Buffer.alloc(0) }, // directory entry
		{ name: "nuclei-templates/http/cves/2021/deep.yaml", data: Buffer.from(TEMPLATE("deep"), "utf8") },
		{ name: "a/b/c/d/e/deeper.YML", data: Buffer.from(TEMPLATE("deeper"), "utf8") },
		{ name: "nuclei-templates/http/cves/2021/README.md", data: Buffer.from("# notes", "utf8") },
		{ name: "nuclei-templates/bundle.zip", data: Buffer.from("PK", "utf8") },
		{ name: "__MACOSX/nuclei-templates/http/._deep.yaml", data: Buffer.from("junk", "utf8") },
		{ name: "../../etc/escape.yaml", data: Buffer.from(TEMPLATE("escape"), "utf8") },
	]);
	const outcome = store.import([{ name: "nuclei-templates.zip", bytes: zip }]);
	expect(outcome).toMatchObject({ imported: 2, replaced: 0 });
	// Non-yaml entries and unusable paths are dropped without a skip line: a real
	// nuclei archive carries hundreds of READMEs and macOS junk, and reporting
	// each one would bury the skips that matter.
	expect(outcome.skipped).toEqual([]);
	expect(store.get("deep")?.sourceFile).toBe("nuclei-templates/http/cves/2021/deep.yaml");
	expect(store.get("deeper")?.sourceFile).toBe("a/b/c/d/e/deeper.YML");
	// Non-yaml files (a README, a nested archive) stay out of the library, and
	// the escaping name is dropped rather than stored as a path.
	expect(store.get("escape")).toBeUndefined();
});

test("a zip64 archive reports its real entry count", () => {
	const zip = buildZip(
		[
			{ name: "a.yaml", data: Buffer.from(TEMPLATE("zip64-a"), "utf8") },
			{ name: "b.yaml", data: Buffer.from(TEMPLATE("zip64-b"), "utf8") },
		],
		{ zip64: true },
	);
	const { entries, skipped } = readZip(zip);
	expect(entries.map((entry) => entry.name)).toEqual(["a.yaml", "b.yaml"]);
	expect(skipped).toEqual([]);
	const outcome = store.import([{ name: "pack64.zip", bytes: zip }]);
	expect(outcome).toMatchObject({ imported: 2, replaced: 0, skipped: [] });
	expect(store.get("zip64-b")?.name).toBe("Test template");
});

test("an archive claiming more than 65535 entries is refused, not silently truncated", () => {
	// A writer that has more than 65535 entries stamps 0xFFFF and puts the real
	// count in a zip64 record. Without one, reading on reported "65535 entries"
	// as a successful import of a whole library.
	const zip = buildZip([{ name: "one.yaml", data: Buffer.from(TEMPLATE("clipped"), "utf8") }], { zip64: false });
	zip.writeUInt16LE(0xffff, zip.length - 12); // total entries
	expect(() => readZip(zip)).toThrow(/zip64/);
	const outcome = store.import([{ name: "huge.zip", bytes: zip }]);
	expect(outcome.imported).toBe(0);
	expect(outcome.skipped).toHaveLength(1);
	expect(outcome.skipped[0]?.name).toBe("huge.zip");
	expect(outcome.skipped[0]?.reason).toMatch(/zip64/);
	expect(store.get("clipped")).toBeUndefined();
});

test("an archive past the 16-bit entry limit is read whole", () => {
	const count = 66_000;
	const zip = buildZip(
		Array.from({ length: count }, (_, index) => ({
			name: `t-${index}.yaml`,
			data: Buffer.from(`id: bulk-${index}\ninfo:\n  name: bulk ${index}\n  severity: low\n`, "utf8"),
		})),
	);
	const { entries, skipped } = readZip(zip);
	expect(skipped).toEqual([]);
	expect(entries).toHaveLength(count);
	expect(entries[count - 1]?.name).toBe(`t-${count - 1}.yaml`);
});

test("opening an existing library adds the listing indexes", () => {
	// An operator's pocs.db predates these indexes; the schema runs on every open,
	// so the next console start adds them without a migration step.
	const path = join(dir, "legacy.db");
	const legacy = openSqliteDatabase(path);
	legacy.exec(
		"CREATE TABLE pocs (id TEXT PRIMARY KEY, name TEXT NOT NULL, severity TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', refs TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, source_file TEXT NOT NULL, imported_at TEXT NOT NULL)",
	);
	legacy.close();
	new PocStore(path).close();
	const reopened = openSqliteDatabase(path);
	const names = (reopened.prepare("PRAGMA index_list(pocs)").all() as unknown as { name: string }[]).map(
		(row) => row.name,
	);
	expect(names).toContain("idx_pocs_imported");
	expect(names).toContain("idx_pocs_severity_imported");
	reopened.close();
});

test("a list row carries the metadata and no template body", () => {
	// The list reads only summary columns: a page of 100 templates must not drag
	// up to 50MB of yaml out of the database to throw it away.
	const rows = store.list({});
	expect(rows.length).toBeGreaterThan(0);
	expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
		["id", "importedAt", "name", "references", "severity", "sourceFile", "tags"].sort(),
	);
});

test("an import larger than one commit chunk stays complete and countable", () => {
	// Imports commit in chunks of 5000, so cross that boundary: every template
	// must still land, and the second run must count replacements, not inserts.
	const ownDir = mkdtempSync(join(tmpdir(), "zg-pocs-chunk-"));
	const own = new PocStore(join(ownDir, "pocs.db"));
	try {
		const files = Array.from({ length: 5_001 }, (_, index) => ({
			name: `${index}.yaml`,
			bytes: Buffer.from(TEMPLATE(`chunk-${index}`), "utf8"),
		}));
		const first = own.import(files);
		expect(first).toMatchObject({ imported: 5_001, replaced: 0, skipped: [] });
		expect(own.stats().total).toBe(5_001);
		const again = own.import(files.slice(0, 2));
		expect(again).toMatchObject({ imported: 0, replaced: 2 });
		expect(own.stats().total).toBe(5_001);
	} finally {
		own.close();
		rmSync(ownDir, { recursive: true, force: true });
	}
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
