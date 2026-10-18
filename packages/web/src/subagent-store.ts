/**
 * Permanent record of sub-agent runs, kept in SQLite so a finished run can be
 * reviewed long after its in-memory session was disposed.
 *
 * Two tables: one row per run, one row per process step. Steps are append-only
 * and ordered by `seq`, which mirrors the order the sub-agent produced them.
 * Nothing is ever deleted; the operator asked for permanent retention, so the
 * only bound is a per-step size cap on long tool output.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SentinelSubagentEvent, SentinelSubagentRun, SentinelSubagentStatus } from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

/** Longest single step stored verbatim; larger payloads are truncated. */
const MAX_EVENT_BYTES = 64 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subagent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS subagent_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_session ON subagent_runs(session_id, started_at DESC);
`;

interface RunRow {
	id: string;
	session_id: string;
	task: string;
	status: string;
	turns: number;
	started_at: string;
	ended_at: string | null;
	result: string | null;
	error: string | null;
}

interface EventRow {
	payload: string;
}

function toRun(row: RunRow): SentinelSubagentRun {
	return {
		id: row.id,
		sessionId: row.session_id,
		task: row.task,
		status: row.status as SentinelSubagentStatus,
		turns: row.turns,
		startedAt: row.started_at,
		...(row.ended_at ? { endedAt: row.ended_at } : {}),
		...(row.result ? { result: row.result } : {}),
		...(row.error ? { error: row.error } : {}),
	};
}

export function subagentDbPath(agentDir: string): string {
	return `${agentDir}/subagents.db`;
}

export class SubagentStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		// WAL keeps reads (panel history) from blocking the run that is writing.
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.dropLegacyModeColumn();
	}

	/** Older databases recorded a mode per run; the concept is gone. */
	private dropLegacyModeColumn(): void {
		const columns = this.db.prepare("PRAGMA table_info(subagent_runs)").all() as unknown as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "mode")) return;
		this.db.exec("ALTER TABLE subagent_runs DROP COLUMN mode");
	}

	createRun(input: { id: string; sessionId: string; projectId?: string; task: string; startedAt: string }): void {
		this.db
			.prepare(
				`INSERT INTO subagent_runs (id, session_id, project_id, task, status, turns, started_at)
				 VALUES (?, ?, ?, ?, 'running', 0, ?)`,
			)
			.run(input.id, input.sessionId, input.projectId ?? null, input.task, input.startedAt);
	}

	appendEvent(runId: string, event: SentinelSubagentEvent): void {
		let payload = JSON.stringify(event);
		if (payload.length > MAX_EVENT_BYTES) {
			payload = JSON.stringify({ ...event, text: undefined, output: truncate(event.output), truncated: true });
		}
		this.db
			.prepare("INSERT OR REPLACE INTO subagent_events (run_id, seq, kind, at, payload) VALUES (?, ?, ?, ?, ?)")
			.run(runId, event.seq, event.kind, event.at, payload);
	}

	finishRun(
		runId: string,
		input: { status: SentinelSubagentStatus; turns: number; endedAt: string; result?: string; error?: string },
	): void {
		this.db
			.prepare("UPDATE subagent_runs SET status = ?, turns = ?, ended_at = ?, result = ?, error = ? WHERE id = ?")
			.run(
				input.status,
				input.turns,
				input.endedAt,
				truncate(input.result) ?? null,
				truncate(input.error) ?? null,
				runId,
			);
	}

	/** Newest first, without process steps. */
	listRuns(sessionId: string, limit = 100, offset = 0): SentinelSubagentRun[] {
		const rows = this.db
			.prepare(
				`SELECT id, session_id, task, status, turns, started_at, ended_at, result, error
				 FROM subagent_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?`,
			)
			.all(sessionId, limit, offset) as unknown as RunRow[];
		return rows.map(toRun);
	}

	countRuns(sessionId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS total FROM subagent_runs WHERE session_id = ?")
			.get(sessionId) as unknown as { total: number } | undefined;
		return row?.total ?? 0;
	}

	getRun(id: string): SentinelSubagentRun | undefined {
		const row = this.db
			.prepare(
				`SELECT id, session_id, task, status, turns, started_at, ended_at, result, error
				 FROM subagent_runs WHERE id = ?`,
			)
			.get(id) as unknown as RunRow | undefined;
		return row ? toRun(row) : undefined;
	}

	listEvents(runId: string): SentinelSubagentEvent[] {
		const rows = this.db
			.prepare("SELECT payload FROM subagent_events WHERE run_id = ? ORDER BY seq ASC")
			.all(runId) as unknown as EventRow[];
		const events: SentinelSubagentEvent[] = [];
		for (const row of rows) {
			try {
				events.push(JSON.parse(row.payload) as SentinelSubagentEvent);
			} catch {
				// A corrupt row should not hide the rest of the run.
			}
		}
		return events;
	}

	/** Marks runs left as "running" by a previous process as interrupted. */
	closeOrphanRuns(): number {
		const result = this.db
			.prepare("UPDATE subagent_runs SET status = 'aborted', ended_at = ? WHERE status = 'running'")
			.run(new Date().toISOString());
		return Number(result.changes ?? 0);
	}

	close(): void {
		this.db.close();
	}
}

function truncate(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (value.length <= MAX_EVENT_BYTES) return value;
	return `${value.slice(0, MAX_EVENT_BYTES)}\n…（已截断）`;
}
