/**
 * Permanent record of gatekeeper judgments, kept in SQLite so an operator can
 * reconstruct what the console let through and what it stopped.
 *
 * Two rules shape this store:
 *
 * - Every judgment is recorded, including the ones that were allowed. A log of
 *   blocks alone cannot answer "what did the gatekeeper see", and the interesting
 *   question is usually a rate, not a single event.
 * - Nothing is ever pruned by age. The operator asked for permanent retention, so
 *   the only bound is a per-field size cap on long commands.
 *
 * Records are deleted only with their project: a judgment describes a command
 * aimed at one project's container, so it cannot outlive that project.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	SentinelGateApproval,
	SentinelGateDecision,
	SentinelGateDecisionKind,
	SentinelGateFilter,
	SentinelGatePage,
	SentinelGateStats,
} from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteValue } from "./sqlite.ts";

/** Longest command stored verbatim; a command line can carry a whole payload. */
const MAX_COMMAND_CHARS = 8 * 1024;
/** Longest reason/error stored verbatim. */
const MAX_TEXT_CHARS = 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gate_decisions (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  project_id TEXT,
  project_name TEXT,
  session_id TEXT,
  source TEXT NOT NULL,
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  command_truncated INTEGER NOT NULL DEFAULT 0,
  cwd TEXT,
  approval TEXT NOT NULL DEFAULT 'ai',
  decision TEXT NOT NULL,
  reason TEXT,
  latency_ms INTEGER NOT NULL,
  model TEXT,
  model_from TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  error TEXT
);
`;

/**
 * Indexes are separate from the table so the column migration below can run in
 * between: an index on a column an older database does not have yet would make
 * `CREATE INDEX` fail before the column is added.
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_gate_at ON gate_decisions(at DESC);
CREATE INDEX IF NOT EXISTS idx_gate_decision ON gate_decisions(decision, at DESC);
CREATE INDEX IF NOT EXISTS idx_gate_session ON gate_decisions(session_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_gate_project ON gate_decisions(project_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_gate_approval ON gate_decisions(approval, at DESC);
`;

/**
 * Add a column that a database written by an older console does not have.
 *
 * `ALTER TABLE` has no `IF NOT EXISTS`, and the table is created by the schema
 * above only when it is missing — so an existing file needs this to pick up a
 * new column without losing its rows. Every row that predates the column was a
 * gatekeeper judgment, hence the `'ai'` default.
 */
function ensureColumn(db: SqliteDatabase, table: string, column: string, ddl: string): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
	if (columns.some((entry) => entry.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

interface DecisionRow {
	id: string;
	at: number;
	project_id: string | null;
	project_name: string | null;
	session_id: string | null;
	source: string;
	tool: string;
	command: string;
	command_truncated: number;
	cwd: string | null;
	approval: string;
	decision: string;
	reason: string | null;
	latency_ms: number;
	model: string | null;
	model_from: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	total_tokens: number | null;
	error: string | null;
}

/** What a caller hands over; the store assigns the id. */
export interface GateDecisionInput {
	at: number;
	projectId?: string | null;
	projectName?: string | null;
	sessionId?: string | null;
	source: string;
	tool: string;
	command: string;
	cwd?: string | null;
	/** Defaults to `ai`: the gatekeeper is the only caller that used to record. */
	approval?: SentinelGateApproval;
	decision: SentinelGateDecisionKind;
	reason?: string;
	latencyMs: number;
	model?: string;
	/** Display name of the library entry that answered. */
	modelFrom?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	error?: string;
}

export function gatekeeperDbPath(agentDir: string): string {
	return `${agentDir}/gatekeeper.db`;
}

function truncate(value: string | undefined, max: number): { text: string | undefined; cut: boolean } {
	if (value === undefined) return { text: undefined, cut: false };
	if (value.length <= max) return { text: value, cut: false };
	return { text: `${value.slice(0, max)}\n…（已截断）`, cut: true };
}

function toDecision(row: DecisionRow): SentinelGateDecision {
	return {
		id: row.id,
		at: row.at,
		projectId: row.project_id,
		projectName: row.project_name,
		sessionId: row.session_id,
		source: row.source,
		tool: row.tool,
		command: row.command,
		...(row.command_truncated ? { commandTruncated: true } : {}),
		cwd: row.cwd,
		approval: row.approval as SentinelGateApproval,
		decision: row.decision as SentinelGateDecisionKind,
		...(row.reason ? { reason: row.reason } : {}),
		latencyMs: row.latency_ms,
		...(row.model ? { model: row.model } : {}),
		...(row.model_from ? { modelFrom: row.model_from } : {}),
		...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
		...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
		...(row.total_tokens !== null ? { totalTokens: row.total_tokens } : {}),
		...(row.error ? { error: row.error } : {}),
	};
}

/** The WHERE fragment and its bindings for one filter. */
function whereFor(filter: SentinelGateFilter | undefined): { sql: string; params: SqliteValue[] } {
	const conditions: string[] = [];
	const params: SqliteValue[] = [];
	if (filter?.decision) {
		conditions.push("decision = ?");
		params.push(filter.decision);
	}
	if (filter?.projectId) {
		conditions.push("project_id = ?");
		params.push(filter.projectId);
	}
	if (filter?.sessionId) {
		conditions.push("session_id = ?");
		params.push(filter.sessionId);
	}
	if (filter?.approval && filter.approval.length > 0) {
		// An empty list means "all three" rather than "none": the page sends the
		// tab's buckets, and a tab is never empty by construction.
		conditions.push(`approval IN (${filter.approval.map(() => "?").join(", ")})`);
		params.push(...filter.approval);
	}
	if (filter?.source) {
		conditions.push("source = ?");
		params.push(filter.source);
	}
	if (filter?.since !== undefined) {
		conditions.push("at >= ?");
		params.push(filter.since);
	}
	if (filter?.search) {
		conditions.push("(command LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\')");
		const needle = `%${filter.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
		params.push(needle, needle);
	}
	return { sql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

export class GatekeeperStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		// WAL keeps the audit page's reads from blocking the run that is writing.
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		ensureColumn(this.db, "gate_decisions", "approval", "approval TEXT NOT NULL DEFAULT 'ai'");
		this.db.exec(INDEXES);
	}

	/** Append one judgment and return the stored record. */
	record(input: GateDecisionInput): SentinelGateDecision {
		const id = `gate-${randomUUID()}`;
		const approval = input.approval ?? "ai";
		const command = truncate(input.command, MAX_COMMAND_CHARS);
		const reason = truncate(input.reason, MAX_TEXT_CHARS);
		const error = truncate(input.error, MAX_TEXT_CHARS);
		this.db
			.prepare(
				`INSERT INTO gate_decisions
				 (id, at, project_id, project_name, session_id, source, tool, command, command_truncated,
				  cwd, approval, decision, reason, latency_ms, model, model_from, input_tokens, output_tokens,
				  total_tokens, error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.at,
				input.projectId ?? null,
				input.projectName ?? null,
				input.sessionId ?? null,
				input.source,
				input.tool,
				command.text ?? "",
				command.cut ? 1 : 0,
				input.cwd ?? null,
				approval,
				input.decision,
				reason.text ?? null,
				input.latencyMs,
				input.model ?? null,
				input.modelFrom ?? null,
				input.inputTokens ?? null,
				input.outputTokens ?? null,
				input.totalTokens ?? null,
				error.text ?? null,
			);
		return {
			id,
			at: input.at,
			projectId: input.projectId ?? null,
			projectName: input.projectName ?? null,
			sessionId: input.sessionId ?? null,
			source: input.source,
			tool: input.tool,
			command: command.text ?? "",
			...(command.cut ? { commandTruncated: true } : {}),
			cwd: input.cwd ?? null,
			approval,
			decision: input.decision,
			...(reason.text ? { reason: reason.text } : {}),
			latencyMs: input.latencyMs,
			...(input.model ? { model: input.model } : {}),
			...(input.modelFrom ? { modelFrom: input.modelFrom } : {}),
			...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
			...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
			...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
			...(error.text ? { error: error.text } : {}),
		};
	}

	/**
	 * Rows per approval bucket, with the filter's other fields applied but not
	 * `approval` itself.
	 *
	 * This exists for the audit page's tab strip: the two tabs split one trail,
	 * so the count on each tab has to be readable while the other tab is open.
	 * Answering it from `stats(filter)` would scope the counts to the selected
	 * tab and show zero on the other one.
	 */
	bucketCounts(filter?: SentinelGateFilter): Record<SentinelGateApproval, number> {
		const byApproval: Record<SentinelGateApproval, number> = { ai: 0, human: 0, auto: 0 };
		const where = whereFor({ ...filter, approval: undefined });
		const rows = this.db
			.prepare(`SELECT approval, COUNT(*) AS n FROM gate_decisions ${where.sql} GROUP BY approval`)
			.all(...where.params) as unknown as Array<{ approval: string; n: number }>;
		for (const row of rows) {
			if (row.approval === "ai" || row.approval === "human" || row.approval === "auto") {
				byApproval[row.approval] = Number(row.n);
			}
		}
		return byApproval;
	}

	/** Newest first. `page` is 1-based. */
	list(filter: SentinelGateFilter | undefined, page = 1, pageSize = 50): SentinelGatePage {
		const size = Math.min(Math.max(Math.round(pageSize), 1), 200);
		const index = Math.max(Math.round(page), 1);
		const where = whereFor(filter);
		const totalRow = this.db
			.prepare(`SELECT COUNT(*) AS n FROM gate_decisions ${where.sql}`)
			.get(...where.params) as unknown as { n: number } | undefined;
		const rows = this.db
			.prepare(`SELECT * FROM gate_decisions ${where.sql} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`)
			.all(...where.params, size, (index - 1) * size) as unknown as DecisionRow[];
		return { items: rows.map(toDecision), total: Number(totalRow?.n ?? 0), page: index, pageSize: size };
	}

	/** Counts and cost figures; the filter narrows every number in the result. */
	stats(filter?: SentinelGateFilter): SentinelGateStats {
		const where = whereFor(filter);
		const rows = this.db
			.prepare(`SELECT decision, COUNT(*) AS n FROM gate_decisions ${where.sql} GROUP BY decision`)
			.all(...where.params) as unknown as Array<{ decision: string; n: number }>;
		const byDecision: Record<SentinelGateDecisionKind, number> = { allow: 0, block: 0, failed: 0 };
		for (const row of rows) {
			if (row.decision === "allow" || row.decision === "block" || row.decision === "failed") {
				byDecision[row.decision] = Number(row.n);
			}
		}
		const approvalRows = this.db
			.prepare(`SELECT approval, COUNT(*) AS n FROM gate_decisions ${where.sql} GROUP BY approval`)
			.all(...where.params) as unknown as Array<{ approval: string; n: number }>;
		const byApproval: Record<SentinelGateApproval, number> = { ai: 0, human: 0, auto: 0 };
		for (const row of approvalRows) {
			if (row.approval === "ai" || row.approval === "human" || row.approval === "auto") {
				byApproval[row.approval] = Number(row.n);
			}
		}
		const total = byDecision.allow + byDecision.block + byDecision.failed;
		const aggregate = this.db
			.prepare(
				`SELECT AVG(latency_ms) AS avg_latency, SUM(COALESCE(total_tokens, 0)) AS tokens
				 FROM gate_decisions ${where.sql}`,
			)
			.get(...where.params) as unknown as { avg_latency: number | null; tokens: number | null } | undefined;
		const since = Date.now() - 24 * 60 * 60 * 1000;
		const recentWhere = whereFor({ ...filter, since: Math.max(filter?.since ?? 0, since) });
		const recentRow = this.db
			.prepare(`SELECT COUNT(*) AS n FROM gate_decisions ${recentWhere.sql}`)
			.get(...recentWhere.params) as unknown as { n: number } | undefined;
		const failureWhere = whereFor({ ...filter, decision: "failed" });
		const failureRow = this.db
			.prepare(`SELECT COUNT(*) AS n, MAX(at) AS last_at FROM gate_decisions ${failureWhere.sql}`)
			.get(...failureWhere.params) as unknown as { n: number; last_at: number | null } | undefined;
		const lastErrorRow = this.db
			.prepare(`SELECT error, reason FROM gate_decisions ${failureWhere.sql} ORDER BY at DESC, rowid DESC LIMIT 1`)
			.get(...failureWhere.params) as unknown as { error: string | null; reason: string | null } | undefined;
		// A block is a successful judgment: the endpoint answered. Only `failed`
		// means the judge could not be reached. The decision filter is dropped here,
		// because "when did the judge last answer" is not a question about one verdict.
		const nonFailed = whereFor({ ...filter, decision: undefined });
		const successRow = this.db
			.prepare(
				`SELECT MAX(at) AS last_at FROM gate_decisions
				 ${nonFailed.sql ? `${nonFailed.sql} AND decision != 'failed'` : "WHERE decision != 'failed'"}`,
			)
			.get(...nonFailed.params) as unknown as { last_at: number | null } | undefined;
		return {
			total,
			byDecision,
			byApproval,
			blockRate: total > 0 ? byDecision.block / total : 0,
			avgLatencyMs: Math.round(Number(aggregate?.avg_latency ?? 0)),
			totalTokens: Number(aggregate?.tokens ?? 0),
			last24h: Number(recentRow?.n ?? 0),
			failures: Number(failureRow?.n ?? 0),
			lastFailureAt: failureRow?.last_at ?? null,
			lastSuccessAt: successRow?.last_at ?? null,
			lastError: lastErrorRow?.error ?? lastErrorRow?.reason ?? null,
		};
	}

	/** Judgments recorded for one project, for the deletion confirmation. */
	countByProject(projectId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM gate_decisions WHERE project_id = ?")
			.get(projectId) as unknown as { n: number } | undefined;
		return Number(row?.n ?? 0);
	}

	/** Delete one project's judgments; they describe commands aimed at its container. */
	purgeProject(projectId: string): number {
		const result = this.db.prepare("DELETE FROM gate_decisions WHERE project_id = ?").run(projectId);
		return Number(result.changes ?? 0);
	}

	close(): void {
		this.db.close();
	}
}
