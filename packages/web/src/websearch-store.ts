/**
 * The web-search query log: what was searched or extracted, which pool key
 * served it, and where the raw response was written.
 *
 * Same contract as the asset log: an audit trail, not a cache. Tavily meters
 * every call, so "who spent the credits and on what" has to be answerable after
 * the fact. Rows are project-scoped and deleted with their project; the raw
 * response itself goes to `evidence/search/` in the project work directory.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

/** Rows one `list` returns at most. */
export const WEBSEARCH_LOG_LIST_CAP = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS websearch_queries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  query TEXT NOT NULL,
  ok INTEGER NOT NULL,
  count INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  error TEXT,
  key_id TEXT,
  session_id TEXT,
  source TEXT,
  evidence_path TEXT,
  records TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_websearch_queries_project ON websearch_queries(project_id, created_at DESC, id);
`;

/** One logged call, as stored. */
export interface SentinelWebSearchQuery {
	id: string;
	projectId: string;
	kind: "search" | "extract";
	query: string;
	ok: boolean;
	count: number;
	latencyMs: number;
	error?: string;
	/** Pool key id that served the call. */
	keyId?: string;
	sessionId?: string;
	source?: string;
	evidencePath?: string;
	records: unknown[];
	createdAt: string;
}

export interface WebSearchQueryInput {
	projectId: string;
	kind: "search" | "extract";
	query: string;
	ok: boolean;
	count: number;
	latencyMs: number;
	error?: string;
	keyId?: string;
	sessionId?: string;
	source?: string;
	evidencePath?: string;
	records: unknown[];
}

export function websearchDbPath(agentDir: string): string {
	return join(agentDir, "websearch.db");
}

interface QueryRow {
	id: string;
	project_id: string;
	kind: string;
	query: string;
	ok: number;
	count: number;
	latency_ms: number;
	error: string | null;
	key_id: string | null;
	session_id: string | null;
	source: string | null;
	evidence_path: string | null;
	records: string;
	created_at: string;
}

function toQuery(row: QueryRow): SentinelWebSearchQuery {
	let records: unknown[] = [];
	try {
		const parsed = JSON.parse(row.records) as unknown;
		if (Array.isArray(parsed)) records = parsed;
	} catch {
		// A truncated record blob reads as "no records"; the metadata stays.
	}
	const query: SentinelWebSearchQuery = {
		id: row.id,
		projectId: row.project_id,
		kind: row.kind === "extract" ? "extract" : "search",
		query: row.query,
		ok: row.ok === 1,
		count: row.count,
		latencyMs: row.latency_ms,
		records,
		createdAt: row.created_at,
	};
	if (row.error) query.error = row.error;
	if (row.key_id) query.keyId = row.key_id;
	if (row.session_id) query.sessionId = row.session_id;
	if (row.source) query.source = row.source;
	if (row.evidence_path) query.evidencePath = row.evidence_path;
	return query;
}

export class WebSearchStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.db.close();
	}

	/** Log one call. Failing calls are stored too: they spent quota as well. */
	save(input: WebSearchQueryInput, now = new Date()): SentinelWebSearchQuery {
		const records = JSON.stringify(input.records ?? []);
		const row: QueryRow = {
			id: `ws-${now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`,
			project_id: input.projectId,
			kind: input.kind,
			query: input.query,
			ok: input.ok ? 1 : 0,
			count: input.count,
			latency_ms: input.latencyMs,
			error: input.error ?? null,
			key_id: input.keyId ?? null,
			session_id: input.sessionId ?? null,
			source: input.source ?? null,
			evidence_path: input.evidencePath ?? null,
			records,
			created_at: now.toISOString(),
		};
		this.db
			.prepare(
				"INSERT INTO websearch_queries (id, project_id, kind, query, ok, count, latency_ms, error, key_id, session_id, source, evidence_path, records, created_at) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				row.id,
				row.project_id,
				row.kind,
				row.query,
				row.ok,
				row.count,
				row.latency_ms,
				row.error,
				row.key_id,
				row.session_id,
				row.source,
				row.evidence_path,
				row.records,
				row.created_at,
			);
		return toQuery(row);
	}

	list(
		projectId: string,
		page = 1,
		pageSize = WEBSEARCH_LOG_LIST_CAP,
	): { items: SentinelWebSearchQuery[]; total: number; hasMore: boolean } {
		const where = " WHERE project_id = ?";
		const safePage = Math.max(1, Math.floor(page));
		const size = Math.min(Math.max(1, Math.floor(pageSize)), WEBSEARCH_LOG_LIST_CAP);
		const totalRow = this.db
			.prepare(`SELECT COUNT(*) AS n FROM websearch_queries${where}`)
			.get(projectId) as unknown as {
			n: number;
		};
		const total = Number(totalRow.n);
		const offset = (safePage - 1) * size;
		const rows = this.db
			.prepare(`SELECT * FROM websearch_queries${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
			.all(projectId, size, offset) as unknown as QueryRow[];
		return { items: rows.map(toQuery), total, hasMore: offset + rows.length < total };
	}

	countProject(projectId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM websearch_queries WHERE project_id = ?")
			.get(projectId) as unknown as { n: number };
		return Number(row.n);
	}

	/** Delete a project's rows; called when the project itself is removed. */
	purgeProject(projectId: string): number {
		const count = this.countProject(projectId);
		if (count > 0) this.db.prepare("DELETE FROM websearch_queries WHERE project_id = ?").run(projectId);
		return count;
	}
}
