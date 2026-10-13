/**
 * The POC library: operator-imported Nuclei templates the agent can consult.
 *
 * The library is a knowledge base, not an execution surface. Its yaml never
 * enters the project container (the database lives in the config directory,
 * which is not mounted), and the only agent-facing tools are a search and a
 * read. To actually fire a template the agent has to write its own yaml into
 * the working directory and run nuclei on it via bash — through the same gate
 * as every other command.
 *
 * Imports dedupe by the template's own `info.id`: re-importing a template
 * replaces the stored copy, so a library refresh does not fork duplicates.
 * Templates without a usable id are skipped with a reason.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openZip } from "./poc-zip.ts";
import type { ZGPoc, ZGPocFilters, ZGPocImportOutcome, ZGPocSeverity, ZGPocStats, ZGPocSummary } from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

/** Largest template accepted; real nuclei templates are a few kilobytes. */
const MAX_TEMPLATE_BYTES = 512 * 1024;
/** Templates listed in one poc_search answer. */
const LIST_CAP = 100;
/**
 * Templates stored per commit. A whole-archive import is one transaction per
 * chunk: not one per template (every statement autocommitted, ~0.6ms each) and
 * not one for the whole archive (whose rollback journal grows to the size of
 * the data being written, and which would discard a long import over one
 * unexpected error).
 */
const IMPORT_COMMIT_CHUNK = 5_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pocs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  severity TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  source_file TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pocs_severity ON pocs(severity);
-- The listed order is newest first, so both listing indexes carry imported_at
-- (and the id tiebreak). Without them every page of the library sorts the whole
-- table, template bodies included, to return 100 rows.
CREATE INDEX IF NOT EXISTS idx_pocs_imported ON pocs(imported_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_pocs_severity_imported ON pocs(severity, imported_at DESC, id);
`;

/**
 * The columns a list row needs. `content` is deliberately absent: a 100-row page
 * would otherwise read up to 50MB of template text out of the database only to
 * drop it in `toSummary`.
 */
const SUMMARY_COLUMNS = "id, name, severity, tags, refs, source_file, imported_at";

const SEVERITIES: readonly ZGPocSeverity[] = ["critical", "high", "medium", "low", "info"];

/** A template's metadata, extracted from its yaml at import time. */
interface ParsedTemplate {
	id: string;
	name: string;
	severity: ZGPocSeverity;
	tags: string[];
	references: string[];
}

interface PocRow {
	id: string;
	name: string;
	severity: string;
	tags: string;
	refs: string;
	content: string;
	source_file: string;
	imported_at: string;
}

/** A row as `list()` reads it: everything but the template body. */
type PocSummaryRow = Omit<PocRow, "content">;

function toSummary(row: PocSummaryRow): ZGPocSummary {
	return {
		id: row.id,
		name: row.name,
		severity: row.severity as ZGPocSeverity,
		tags: row.tags ? row.tags.split(",") : [],
		references: row.refs ? row.refs.split("\n") : [],
		sourceFile: row.source_file,
		importedAt: row.imported_at,
	};
}

function toPoc(row: PocRow): ZGPoc {
	return { ...toSummary(row), content: row.content };
}

/**
 * Extract a template's metadata without a yaml parser. Only the fields the
 * library indexes are read — `id`, `info.name`, `info.severity`,
 * `info.tags`, and `info.classification.cve-id` — and only at their standard
 * two- and four-space indent, which is how nuclei formats templates. Anything
 * unusual degrades to missing metadata, never to a failed import.
 */
export function parseNucleiTemplate(text: string): ParsedTemplate | null {
	let id = "";
	let name = "";
	let severity = "";
	let tags = "";
	let cveId = "";
	let section = ""; // top-level key we are inside of ("" = none)
	let sub = ""; // second-level key inside `info` ("" = none)

	for (const rawLine of text.split(/\r?\n/)) {
		if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
		const indent = rawLine.length - rawLine.trimStart().length;
		const line = rawLine.trim();
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();

		if (indent === 0) {
			section = key;
			sub = "";
			if (section === "id") id = value.replace(/^["']|["']$/g, "");
			continue;
		}
		if (section !== "info") continue;
		if (indent === 2) {
			sub = key;
			if (value) {
				if (sub === "name") name = value.replace(/^["']|["']$/g, "");
				else if (sub === "severity") severity = value.toLowerCase();
				else if (sub === "tags") tags = value;
			}
			continue;
		}
		if (indent >= 4 && sub === "classification" && key === "cve-id" && value) {
			cveId = value.replace(/^["']|["']$/g, "");
		}
	}

	// A usable id is what dedupe keys on; without it there is no stable identity.
	const trimmed = id.trim();
	if (!trimmed || /\s/.test(trimmed)) return null;
	return {
		id: trimmed,
		name: name.trim() || trimmed,
		severity: (SEVERITIES as readonly string[]).includes(severity) ? (severity as ZGPocSeverity) : "info",
		tags: tags
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean),
		references: cveId ? [cveId] : [],
	};
}

/** Files an import accepts, by extension. */
function isYamlName(name: string): boolean {
	return /\.ya?ml$/i.test(name);
}

/** Drop directory prefixes and anything that tries to escape, keep the basename path readable. */
function safeEntryName(name: string): string | null {
	const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
	if (normalized.includes("..") || normalized.startsWith("__MACOSX/")) return null;
	return normalized;
}

export interface ImportFile {
	/** File name as uploaded; .yaml/.yml are read as text, .zip is unpacked. */
	name: string;
	/** Raw file bytes; the console sends them base64-encoded over the WebSocket. */
	bytes: Buffer;
}

export function pocsDbPath(agentDir: string): string {
	return join(agentDir, "pocs.db");
}

export class PocStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.db.close();
	}

	/**
	 * Import templates. Zip archives are unpacked entry by entry, and every yaml
	 * is parsed and upserted by template id. One bad file never fails the batch;
	 * it lands in `skipped` with a reason.
	 */
	import(files: ImportFile[], now = new Date()): ZGPocImportOutcome {
		const skipped: { name: string; reason: string }[] = [];
		let imported = 0;
		let replaced = 0;
		const seen = new Set<string>();
		const stamp = now.toISOString();
		const upsert = this.db.prepare(
			"INSERT INTO pocs (id, name, severity, tags, refs, content, source_file, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
				"ON CONFLICT(id) DO UPDATE SET name=excluded.name, severity=excluded.severity, tags=excluded.tags, refs=excluded.refs, content=excluded.content, source_file=excluded.source_file, imported_at=excluded.imported_at",
		);
		const existing = this.db.prepare("SELECT 1 AS ok FROM pocs WHERE id = ?");
		let pending = 0;
		this.db.exec("BEGIN");
		try {
			for (const file of this.candidates(files, skipped)) {
				if (pending >= IMPORT_COMMIT_CHUNK) {
					this.db.exec("COMMIT");
					this.db.exec("BEGIN");
					pending = 0;
				}
				if (file.content.length > MAX_TEMPLATE_BYTES) {
					skipped.push({ name: file.name, reason: "模板过大" });
					continue;
				}
				const parsed = parseNucleiTemplate(file.content);
				if (!parsed) {
					skipped.push({ name: file.name, reason: "缺少有效的模板 id" });
					continue;
				}
				if (seen.has(parsed.id)) continue; // same id twice in one batch: first wins
				seen.add(parsed.id);
				if (existing.get(parsed.id)) replaced++;
				else imported++;
				upsert.run(
					parsed.id,
					parsed.name,
					parsed.severity,
					parsed.tags.join(","),
					parsed.references.join("\n"),
					file.content,
					file.name,
					stamp,
				);
				pending++;
			}
			this.db.exec("COMMIT");
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// A failed COMMIT may already have rolled the chunk back; the
				// import error is what the caller needs to see.
			}
			throw error;
		}
		return { imported, replaced, skipped };
	}

	/**
	 * The templates a batch holds, in upload order: `.yaml` files as they are, and
	 * zip entries pulled one at a time so a 300k-template archive is never fully
	 * materialized in memory.
	 */
	private *candidates(
		files: ImportFile[],
		skipped: { name: string; reason: string }[],
	): Generator<{
		name: string;
		content: string;
	}> {
		for (const file of files) {
			const safeName = safeEntryName(file.name);
			if (!safeName) {
				skipped.push({ name: file.name, reason: "非法文件名" });
				continue;
			}
			if (safeName.endsWith(".zip")) {
				let stream: ReturnType<typeof openZip>;
				try {
					stream = openZip(file.bytes);
				} catch (error) {
					skipped.push({ name: safeName, reason: error instanceof Error ? error.message : "解压失败" });
					continue;
				}
				for (const entry of stream.entries) {
					const name = safeEntryName(entry.name);
					if (!name) continue;
					if (isYamlName(name)) yield { name, content: entry.data.toString("utf8") };
				}
				// Entries the reader could not use, named after the archive so a
				// batch of several archives stays readable.
				for (const skip of stream.skipped) {
					skipped.push({ name: `${safeName}: ${skip.name}`, reason: skip.reason });
				}
				continue;
			}
			if (isYamlName(safeName)) yield { name: safeName, content: file.bytes.toString("utf8") };
			else skipped.push({ name: safeName, reason: "只支持 .yaml / .yml / .zip" });
		}
	}

	list(filters: ZGPocFilters = {}): ZGPocSummary[] {
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		if (filters.severity) {
			conditions.push("severity = ?");
			params.push(filters.severity);
		}
		if (filters.tag?.trim()) {
			conditions.push("(',' || tags || ',') LIKE ?");
			params.push(`%,${filters.tag.trim().toLowerCase()},%`);
		}
		if (filters.search?.trim()) {
			const needle = `%${filters.search.trim().toLowerCase()}%`;
			conditions.push("(LOWER(id) LIKE ? OR LOWER(name) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(refs) LIKE ?)");
			params.push(needle, needle, needle, needle);
		}
		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const rows = this.db
			.prepare(`SELECT ${SUMMARY_COLUMNS} FROM pocs${where} ORDER BY imported_at DESC, id LIMIT ${LIST_CAP + 1}`)
			.all(...params) as unknown as PocSummaryRow[];
		return rows.slice(0, LIST_CAP).map(toSummary);
	}

	get(id: string): ZGPoc | undefined {
		const row = this.db.prepare("SELECT * FROM pocs WHERE id = ?").get(id) as unknown as PocRow | undefined;
		return row ? toPoc(row) : undefined;
	}

	delete(id: string): boolean {
		// `changes` differs between runtimes (number vs bigint), so existence is
		// checked instead of counting what the DELETE reports.
		const row = this.db.prepare("SELECT 1 AS ok FROM pocs WHERE id = ?").get(id);
		if (!row) return false;
		this.db.prepare("DELETE FROM pocs WHERE id = ?").run(id);
		return true;
	}

	stats(): ZGPocStats {
		const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<
			ZGPocSeverity,
			number
		>;
		let total = 0;
		for (const row of this.db
			.prepare("SELECT severity, COUNT(*) AS n FROM pocs GROUP BY severity")
			.all() as unknown as {
			severity: string;
			n: number;
		}[]) {
			total += row.n;
			if ((SEVERITIES as readonly string[]).includes(row.severity)) {
				bySeverity[row.severity as ZGPocSeverity] = row.n;
			}
		}
		return { total, bySeverity };
	}
}
