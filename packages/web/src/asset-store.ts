/**
 * The asset-mapping query log: what was asked of which platform, what came back,
 * and where the raw response was written.
 *
 * This is an audit trail, not a cache. The platforms meter every query, so the
 * question "who spent the day's quota and on what" has to be answerable after the
 * fact — the console has no browsing page for these rows yet, but the settings
 * screen reports the last outcome per platform and the rows are what a future
 * page (or a support question) reads.
 *
 * Rows are project-scoped like the vulnerability hub and the capture store, and
 * are deleted with their project. The full raw response is not kept here: it goes
 * to `evidence/asset/` in the project working directory, which is where a finding
 * cites it from.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SentinelAssetPlatform } from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

/** Records kept per row. A page is at most 100, and each record is already clipped. */
const MAX_RECORDS_JSON = 512 * 1024;

/** Rows one `list` returns at most. */
export const ASSET_QUERY_LIST_CAP = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS asset_queries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  query TEXT NOT NULL,
  page INTEGER NOT NULL,
  size INTEGER NOT NULL,
  total INTEGER NOT NULL,
  count INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  error TEXT,
  quota TEXT,
  session_id TEXT,
  source TEXT,
  evidence_path TEXT,
  records TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_queries_project ON asset_queries(project_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_asset_queries_platform ON asset_queries(project_id, platform, created_at DESC, id);
`;

/** One logged query, as stored. */
export interface SentinelAssetQuery {
	id: string;
	projectId: string;
	platform: SentinelAssetPlatform;
	query: string;
	page: number;
	size: number;
	/** Total matches the platform reported. */
	total: number;
	/** Records actually returned in this page. */
	count: number;
	ok: boolean;
	latencyMs: number;
	error?: string;
	quota?: string;
	sessionId?: string;
	/** Which agent issued the query, e.g. "主代理" or a sub-agent label. */
	source?: string;
	/** Container-visible path of the raw response, when it was written. */
	evidencePath?: string;
	/** Normalized records, as JSON, for the query log. */
	records: unknown[];
	createdAt: string;
}

/** What `save` needs; the store assigns the id and timestamp. */
export interface AssetQueryInput {
	projectId: string;
	platform: SentinelAssetPlatform;
	query: string;
	page: number;
	size: number;
	total: number;
	count: number;
	ok: boolean;
	latencyMs: number;
	error?: string;
	quota?: string;
	sessionId?: string;
	source?: string;
	evidencePath?: string;
	records: unknown[];
}

export interface SentinelAssetQueryFilters {
	platform?: SentinelAssetPlatform;
	/** Case-insensitive substring of the query text. */
	search?: string;
}

export function assetsDbPath(agentDir: string): string {
	return join(agentDir, "assets.db");
}

interface AssetQueryRow {
	id: string;
	project_id: string;
	platform: string;
	query: string;
	page: number;
	size: number;
	total: number;
	count: number;
	ok: number;
	latency_ms: number;
	error: string | null;
	quota: string | null;
	session_id: string | null;
	source: string | null;
	evidence_path: string | null;
	records: string;
	created_at: string;
}

function toQuery(row: AssetQueryRow): SentinelAssetQuery {
	let records: unknown[] = [];
	try {
		const parsed = JSON.parse(row.records) as unknown;
		if (Array.isArray(parsed)) records = parsed;
	} catch {
		// A row whose record blob was truncated reads as "no records"; the query
		// metadata is still the part the audit cares about.
	}
	const query: SentinelAssetQuery = {
		id: row.id,
		projectId: row.project_id,
		platform: row.platform as SentinelAssetPlatform,
		query: row.query,
		page: row.page,
		size: row.size,
		total: row.total,
		count: row.count,
		ok: row.ok === 1,
		latencyMs: row.latency_ms,
		records,
		createdAt: row.created_at,
	};
	if (row.error) query.error = row.error;
	if (row.quota) query.quota = row.quota;
	if (row.session_id) query.sessionId = row.session_id;
	if (row.source) query.source = row.source;
	if (row.evidence_path) query.evidencePath = row.evidence_path;
	return query;
}

export class AssetStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.db.close();
	}

	/** Log one query. Failing queries are stored too: they spent quota as well. */
	save(input: AssetQueryInput, now = new Date()): SentinelAssetQuery {
		const records = JSON.stringify(input.records);
		const row: AssetQueryRow = {
			id: `aq-${now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`,
			project_id: input.projectId,
			platform: input.platform,
			query: input.query,
			page: input.page,
			size: input.size,
			total: input.total,
			count: input.count,
			ok: input.ok ? 1 : 0,
			latency_ms: input.latencyMs,
			error: input.error ?? null,
			quota: input.quota ?? null,
			session_id: input.sessionId ?? null,
			source: input.source ?? null,
			evidence_path: input.evidencePath ?? null,
			records: records.length > MAX_RECORDS_JSON ? "[]" : records,
			created_at: now.toISOString(),
		};
		this.db
			.prepare(
				"INSERT INTO asset_queries (id, project_id, platform, query, page, size, total, count, ok, latency_ms, error, quota, session_id, source, evidence_path, records, created_at) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				row.id,
				row.project_id,
				row.platform,
				row.query,
				row.page,
				row.size,
				row.total,
				row.count,
				row.ok,
				row.latency_ms,
				row.error,
				row.quota,
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
		filters: SentinelAssetQueryFilters = {},
		page = 1,
		pageSize = 50,
	): {
		items: SentinelAssetQuery[];
		total: number;
		page: number;
		pageSize: number;
		hasMore: boolean;
	} {
		const conditions = ["project_id = ?"];
		const params: (string | number)[] = [projectId];
		if (filters.platform) {
			conditions.push("platform = ?");
			params.push(filters.platform);
		}
		if (filters.search?.trim()) {
			conditions.push("LOWER(query) LIKE ?");
			params.push(`%${filters.search.trim().toLowerCase()}%`);
		}
		const where = ` WHERE ${conditions.join(" AND ")}`;
		const safePage = Math.max(1, Math.floor(page));
		const size = Math.min(Math.max(1, Math.floor(pageSize)), ASSET_QUERY_LIST_CAP);
		const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM asset_queries${where}`).get(...params) as unknown as {
			n: number;
		};
		const total = Number(totalRow.n);
		const offset = (safePage - 1) * size;
		const rows = this.db
			.prepare(`SELECT * FROM asset_queries${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
			.all(...params, size, offset) as unknown as AssetQueryRow[];
		return {
			items: rows.map(toQuery),
			total,
			page: safePage,
			pageSize: size,
			hasMore: offset + rows.length < total,
		};
	}

	get(id: string): SentinelAssetQuery | undefined {
		const row = this.db.prepare("SELECT * FROM asset_queries WHERE id = ?").get(id) as unknown as
			| AssetQueryRow
			| undefined;
		return row ? toQuery(row) : undefined;
	}

	countProject(projectId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM asset_queries WHERE project_id = ?")
			.get(projectId) as unknown as {
			n: number;
		};
		return Number(row.n);
	}

	/** Delete a project's rows; called when the project itself is removed. */
	purgeProject(projectId: string): number {
		const count = this.countProject(projectId);
		if (count > 0) this.db.prepare("DELETE FROM asset_queries WHERE project_id = ?").run(projectId);
		return count;
	}
}
