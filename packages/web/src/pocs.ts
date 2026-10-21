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
 * Templates without a usable id are skipped with a reason, and so are nuclei
 * workflows, which carry an id and an info block but no request of their own.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { t } from "./i18n.ts";
import { openZip } from "./poc-zip.ts";
import type {
	SentinelPoc,
	SentinelPocFilters,
	SentinelPocImportOutcome,
	SentinelPocSeverity,
	SentinelPocStats,
	SentinelPocSummary,
} from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteStatement } from "./sqlite.ts";

/** Largest template accepted; real nuclei templates are a few kilobytes. */
const MAX_TEMPLATE_BYTES = 512 * 1024;
/**
 * Templates per page. The console paginates with this size; `poc_search` still
 * gets one page and points the model at narrowing the query when `hasMore`.
 */
export const LIST_CAP = 100;
/**
 * Templates stored per commit. A whole-archive import is one transaction per
 * chunk: not one per template (every statement autocommitted, ~0.6ms each) and
 * not one for the whole archive (whose rollback journal grows to the size of
 * the data being written, and which would discard a long import over one
 * unexpected error).
 */
const IMPORT_COMMIT_CHUNK = 5_000;
/** Entries between event-loop yields during an HTTP import. */
const ASYNC_YIELD_EVERY = 100;

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

const SEVERITIES: readonly SentinelPocSeverity[] = ["critical", "high", "medium", "low", "info"];

/** A template's metadata, extracted from its yaml at import time. */
interface ParsedTemplate {
	id: string;
	name: string;
	severity: SentinelPocSeverity;
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

function toSummary(row: PocSummaryRow): SentinelPocSummary {
	return {
		id: row.id,
		name: row.name,
		severity: row.severity as SentinelPocSeverity,
		tags: row.tags ? row.tags.split(",") : [],
		references: row.refs ? row.refs.split("\n") : [],
		sourceFile: row.source_file,
		importedAt: row.imported_at,
	};
}

function toPoc(row: PocRow): SentinelPoc {
	return { ...toSummary(row), content: row.content };
}

/** One page of `list()` results; `total` counts every match across pages. */
export interface SentinelPocListPage {
	items: SentinelPocSummary[];
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
}

/**
 * A nuclei workflow is not a template: it orchestrates other templates and has
 * no request of its own. Official archives ship them next to the templates
 * (`workflows/`), and a workflow also carries an `id` and an `info` block, so
 * without this check it would land in the library as an unusable entry.
 */
export function isNucleiWorkflow(text: string): boolean {
	return /^workflows\s*:/m.test(text);
}

/**
 * Extract a template's metadata without a yaml parser. Only the fields the
 * library indexes are read — `id`, `info.name`, `info.severity`,
 * `info.tags`, and `info.classification.cve-id` — and only at their standard
 * two- and four-space indent, which is how nuclei formats templates. Anything
 * unusual degrades to missing metadata, never to a failed import.
 */
export function parseNucleiTemplate(text: string): ParsedTemplate | null {
	// The import loop names this case before parsing, so the skip reason points
	// at the workflow rather than at a missing id.
	if (isNucleiWorkflow(text)) return null;
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
		severity: (SEVERITIES as readonly string[]).includes(severity) ? (severity as SentinelPocSeverity) : "info",
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
	/** Raw file bytes; an HTTP upload streams these to disk before the import starts. */
	bytes: Buffer;
}

/** Live counters for one async import; the HTTP job exposes this to the page. */
export interface PocImportProgress {
	processed: number;
	imported: number;
	replaced: number;
	skipped: number;
	current: string;
}

export interface PocImportOptions {
	/** Called every 100 entries and once at the end. */
	onProgress?: (progress: PocImportProgress) => void;
	/** Aborts the import at the next entry boundary. */
	signal?: AbortSignal;
}

interface ImportSession {
	skipped: { name: string; reason: string }[];
	imported: number;
	replaced: number;
	seen: Set<string>;
	upsert: SqliteStatement;
	existing: SqliteStatement;
	pending: number;
	stamp: string;
}

export function pocsDbPath(agentDir: string): string {
	return join(agentDir, "pocs.db");
}

export class PocStore {
	private readonly db: SqliteDatabase;
	/** Serializes async imports: the store has one SQLite writer. */
	private importTail: Promise<void> = Promise.resolve();

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.db.close();
	}

	/**
	 * Import templates synchronously. Kept for tests and small callers that already
	 * own the event loop; the console and subscription sync use `importAsync` so a
	 * large archive does not monopolise the HTTP/WebSocket event loop.
	 */
	import(files: ImportFile[], now = new Date()): SentinelPocImportOutcome {
		const session = this.beginImport(now);
		try {
			for (const file of this.candidates(files, session.skipped)) {
				this.rotateChunk(session);
				this.applyImport(session, file);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.rollback();
			throw error;
		}
		return { imported: session.imported, replaced: session.replaced, skipped: session.skipped };
	}

	/**
	 * Import one uploaded archive without blocking the event loop for its whole
	 * duration. Zip entries are still inflated synchronously one at a time, but
	 * the loop yields every `ASYNC_YIELD_EVERY` entries so health checks, progress
	 * polls, and the WebSocket stay responsive.
	 */
	importAsync(
		files: ImportFile[],
		options: PocImportOptions = {},
		now = new Date(),
	): Promise<SentinelPocImportOutcome> {
		const run = (): Promise<SentinelPocImportOutcome> => this.runImportAsync(files, options, now);
		const result = this.importTail.then(run, run);
		this.importTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async runImportAsync(
		files: ImportFile[],
		options: PocImportOptions,
		now: Date,
	): Promise<SentinelPocImportOutcome> {
		const session = this.beginImport(now);
		let processed = 0;
		let current = "";
		try {
			for (const file of this.candidates(files, session.skipped)) {
				if (options.signal?.aborted) throw new Error(t("导入已取消"));
				this.rotateChunk(session);
				this.applyImport(session, file);
				processed += 1;
				current = file.name;
				if (processed % ASYNC_YIELD_EVERY === 0) {
					options.onProgress?.(this.progress(session, processed, current));
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			}
			this.db.exec("COMMIT");
			options.onProgress?.(this.progress(session, processed, ""));
		} catch (error) {
			this.rollback();
			throw error;
		}
		return { imported: session.imported, replaced: session.replaced, skipped: session.skipped };
	}

	private beginImport(now: Date): ImportSession {
		const session: ImportSession = {
			skipped: [],
			imported: 0,
			replaced: 0,
			seen: new Set<string>(),
			upsert: this.db.prepare(
				"INSERT INTO pocs (id, name, severity, tags, refs, content, source_file, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
					"ON CONFLICT(id) DO UPDATE SET name=excluded.name, severity=excluded.severity, tags=excluded.tags, refs=excluded.refs, content=excluded.content, source_file=excluded.source_file, imported_at=excluded.imported_at",
			),
			existing: this.db.prepare("SELECT 1 AS ok FROM pocs WHERE id = ?"),
			pending: 0,
			stamp: now.toISOString(),
		};
		this.db.exec("BEGIN");
		return session;
	}

	/**
	 * Commit the previous chunk so a long import does not keep one giant journal.
	 * A failure in COMMIT is caught by the caller, which rolls back the open chunk.
	 */
	private rotateChunk(session: ImportSession): void {
		if (session.pending < IMPORT_COMMIT_CHUNK) return;
		this.db.exec("COMMIT");
		this.db.exec("BEGIN");
		session.pending = 0;
	}

	private applyImport(session: ImportSession, file: { name: string; content: string }): void {
		if (file.content.length > MAX_TEMPLATE_BYTES) {
			session.skipped.push({ name: file.name, reason: t("模板过大") });
			return;
		}
		if (isNucleiWorkflow(file.content)) {
			session.skipped.push({ name: file.name, reason: t("nuclei workflow，不是模板") });
			return;
		}
		const parsed = parseNucleiTemplate(file.content);
		if (!parsed) {
			session.skipped.push({ name: file.name, reason: t("缺少有效的模板 id") });
			return;
		}
		if (session.seen.has(parsed.id)) return; // same id twice in one batch: first wins
		session.seen.add(parsed.id);
		if (session.existing.get(parsed.id)) session.replaced += 1;
		else session.imported += 1;
		session.upsert.run(
			parsed.id,
			parsed.name,
			parsed.severity,
			parsed.tags.join(","),
			parsed.references.join("\n"),
			file.content,
			file.name,
			session.stamp,
		);
		session.pending += 1;
	}

	private progress(session: ImportSession, processed: number, current: string): PocImportProgress {
		return {
			processed,
			imported: session.imported,
			replaced: session.replaced,
			skipped: session.skipped.length,
			current,
		};
	}

	private rollback(): void {
		try {
			this.db.exec("ROLLBACK");
		} catch {
			// A failed COMMIT may already have rolled the chunk back; the
			// import error is what the caller needs to see.
		}
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
				skipped.push({ name: file.name, reason: t("非法文件名") });
				continue;
			}
			if (safeName.endsWith(".zip")) {
				let stream: ReturnType<typeof openZip>;
				try {
					stream = openZip(file.bytes);
				} catch (error) {
					skipped.push({ name: safeName, reason: error instanceof Error ? error.message : t("解压失败") });
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
			else skipped.push({ name: safeName, reason: t("只支持 .yaml / .yml / .zip") });
		}
	}

	list(filters: SentinelPocFilters = {}, page = 1, pageSize = LIST_CAP): SentinelPocListPage {
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
		const safePage = Math.max(1, Math.floor(page));
		const size = Math.min(Math.max(1, Math.floor(pageSize)), LIST_CAP);
		const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM pocs${where}`).get(...params) as unknown as {
			n: number;
		};
		const total = Number(totalRow.n);
		const offset = (safePage - 1) * size;
		const rows = this.db
			.prepare(`SELECT ${SUMMARY_COLUMNS} FROM pocs${where} ORDER BY imported_at DESC, id LIMIT ? OFFSET ?`)
			.all(...params, size, offset) as unknown as PocSummaryRow[];
		return {
			items: rows.map(toSummary),
			total,
			page: safePage,
			pageSize: size,
			hasMore: offset + rows.length < total,
		};
	}

	get(id: string): SentinelPoc | undefined {
		const row = this.db.prepare("SELECT * FROM pocs WHERE id = ?").get(id) as unknown as PocRow | undefined;
		return row ? toPoc(row) : undefined;
	}

	/**
	 * Templates by id, in the order asked for and without duplicates. One query,
	 * so a batched read is one trip to the database rather than one per id.
	 */
	getMany(ids: string[]): SentinelPoc[] {
		const unique = [...new Set(ids)];
		if (unique.length === 0) return [];
		const placeholders = unique.map(() => "?").join(", ");
		const rows = this.db
			.prepare(`SELECT * FROM pocs WHERE id IN (${placeholders})`)
			.all(...unique) as unknown as PocRow[];
		const byId = new Map(rows.map((row) => [row.id, row]));
		const found: SentinelPoc[] = [];
		for (const id of unique) {
			const row = byId.get(id);
			if (row) found.push(toPoc(row));
		}
		return found;
	}

	delete(id: string): boolean {
		// `changes` differs between runtimes (number vs bigint), so existence is
		// checked instead of counting what the DELETE reports.
		const row = this.db.prepare("SELECT 1 AS ok FROM pocs WHERE id = ?").get(id);
		if (!row) return false;
		this.db.prepare("DELETE FROM pocs WHERE id = ?").run(id);
		return true;
	}

	stats(): SentinelPocStats {
		const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<
			SentinelPocSeverity,
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
				bySeverity[row.severity as SentinelPocSeverity] = row.n;
			}
		}
		return { total, bySeverity };
	}
}
