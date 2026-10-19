/**
 * Global supervision audit, stored in SQLite next to the other console DBs.
 *
 * The live floating window is per conversation, but 工作台 → 监督 has to list
 * every conversation that was ever armed, including ones no longer loaded. That
 * is why episodes, logs and advice live here rather than only in session JSONL.
 * Full tool output is not duplicated: it stays in the session file and is read
 * by `callId` on demand.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	SentinelSupervisorAdvice,
	SentinelSupervisorAuditItem,
	SentinelSupervisorAuditPage,
	SentinelSupervisorCall,
	SentinelSupervisorDetail,
	SentinelSupervisorEpisode,
	SentinelSupervisorLog,
	SentinelSupervisorMode,
	SentinelSupervisorProgress,
	SentinelSupervisorStatus,
	SentinelSupervisorStrategy,
} from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

export function supervisorDbPath(agentDir: string): string {
	return `${agentDir}/supervisor.db`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS supervisor_sessions (
  session_id TEXT PRIMARY KEY,
  session_path TEXT,
  session_name TEXT NOT NULL,
  project_id TEXT,
  project_name TEXT,
  mode TEXT NOT NULL,
  delivery TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'steady',
  strategy_custom_id TEXT,
  strategy_name TEXT NOT NULL DEFAULT '',
  strategy_instructions TEXT NOT NULL DEFAULT '',
  strategy_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  armed_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  phase TEXT NOT NULL DEFAULT 'unknown',
  intent TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT 'unknown',
  episode_count INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  advice_count INTEGER NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supervisor_updated ON supervisor_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervisor_project ON supervisor_sessions(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS supervisor_episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  phase TEXT NOT NULL,
  intent TEXT NOT NULL,
  progress TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  error TEXT,
  duration_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supervisor_episode_session ON supervisor_episodes(session_id, seq DESC);

CREATE TABLE IF NOT EXISTS supervisor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supervisor_event_session ON supervisor_events(session_id, at DESC);

CREATE TABLE IF NOT EXISTS supervisor_advice (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  delivery TEXT NOT NULL,
  status TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_supervisor_advice_session ON supervisor_advice(session_id, at DESC);
`;

interface SessionRow {
	session_id: string;
	session_path: string | null;
	session_name: string;
	project_id: string | null;
	project_name: string | null;
	mode: string;
	delivery: string;
	strategy: string;
	strategy_custom_id: string | null;
	strategy_name: string;
	strategy_instructions: string;
	strategy_note: string;
	status: string;
	armed_at: number;
	started_at: number | null;
	ended_at: number | null;
	phase: string;
	intent: string;
	progress: string;
	episode_count: number;
	call_count: number;
	advice_count: number;
	tokens_input: number;
	tokens_output: number;
	tokens_total: number;
	last_error: string | null;
	updated_at: number;
}

interface EpisodeRow {
	payload_json: string;
}

interface EventRow {
	at: number;
	kind: string;
	text: string;
}

interface AdviceRow {
	id: string;
	session_id: string;
	episode_id: string;
	at: number;
	delivery: string;
	status: string;
	text: string;
	sent_at: number | null;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assertStrategy(value: string): SentinelSupervisorStrategy {
	return value === "validation" || value === "offensive" || value === "stealth" ? value : "steady";
}

function auditItem(row: SessionRow): SentinelSupervisorAuditItem {
	return {
		sessionId: row.session_id,
		sessionPath: row.session_path,
		sessionName: row.session_name,
		projectId: row.project_id,
		projectName: row.project_name,
		mode: row.mode === "intervene" ? "intervene" : "observe",
		delivery: row.delivery === "auto" ? "auto" : "confirm",
		strategy: assertStrategy(row.strategy),
		strategyCustomId: row.strategy_custom_id,
		strategyName: row.strategy_name,
		strategyInstructions: row.strategy_instructions ?? "",
		strategyNote: row.strategy_note ?? "",
		status: (["waiting", "running", "stopped", "error"] as const).includes(row.status as SentinelSupervisorStatus)
			? (row.status as SentinelSupervisorStatus)
			: "error",
		armedAt: row.armed_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		updatedAt: row.updated_at,
		episodeCount: row.episode_count,
		callCount: row.call_count,
		phase: row.phase,
		intent: row.intent,
		progress: (["advancing", "stalled", "looping", "unknown"] as const).includes(
			row.progress as SentinelSupervisorProgress,
		)
			? (row.progress as SentinelSupervisorProgress)
			: "unknown",
		adviceCount: row.advice_count,
		usage: {
			input: row.tokens_input,
			output: row.tokens_output,
			total: row.tokens_total,
		},
		lastError: row.last_error,
	};
}

function episodeRecord(raw: string): { episode: SentinelSupervisorEpisode; calls: SentinelSupervisorCall[] } {
	try {
		const parsed = JSON.parse(raw) as { episode?: SentinelSupervisorEpisode; calls?: SentinelSupervisorCall[] };
		if (!parsed.episode) throw new Error("missing episode");
		return { episode: parsed.episode, calls: Array.isArray(parsed.calls) ? parsed.calls : [] };
	} catch {
		throw new Error("监督 episode 数据损坏");
	}
}

function adviceRecord(row: AdviceRow): SentinelSupervisorAdvice {
	return {
		id: row.id,
		sessionId: row.session_id,
		episodeId: row.episode_id,
		at: row.at,
		delivery: row.delivery === "auto" ? "auto" : "confirm",
		status: (["pending", "sent", "ignored"] as const).includes(row.status as SentinelSupervisorAdvice["status"])
			? (row.status as SentinelSupervisorAdvice["status"])
			: "pending",
		text: row.text,
		sentAt: row.sent_at,
	};
}

export interface SupervisorAuditQuery {
	page?: number;
	pageSize?: number;
	projectId?: string;
	search?: string;
	mode?: SentinelSupervisorMode;
	progress?: SentinelSupervisorProgress;
	strategy?: SentinelSupervisorStrategy;
	customStrategyId?: string;
}

function ensureColumn(db: SqliteDatabase, table: string, column: string, definition: string): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name?: string }>;
	if (columns.some((entry) => entry.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export class SupervisorStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(SCHEMA);
		// Existing supervisor.db files predate the strategy columns.
		ensureColumn(this.db, "supervisor_sessions", "strategy", "TEXT NOT NULL DEFAULT 'steady'");
		ensureColumn(this.db, "supervisor_sessions", "strategy_custom_id", "TEXT");
		ensureColumn(this.db, "supervisor_sessions", "strategy_name", "TEXT NOT NULL DEFAULT ''");
		ensureColumn(this.db, "supervisor_sessions", "strategy_instructions", "TEXT NOT NULL DEFAULT ''");
		ensureColumn(this.db, "supervisor_sessions", "strategy_note", "TEXT NOT NULL DEFAULT ''");
	}

	upsertSession(item: SentinelSupervisorAuditItem): void {
		this.db
			.prepare(
				`INSERT INTO supervisor_sessions (
					session_id, session_path, session_name, project_id, project_name, mode, delivery, strategy,
					strategy_custom_id, strategy_name, strategy_instructions, strategy_note, status, armed_at,
					started_at, ended_at, phase, intent, progress, episode_count, call_count, advice_count,
					tokens_input, tokens_output, tokens_total, last_error, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_id) DO UPDATE SET
					session_path=excluded.session_path,
					session_name=excluded.session_name,
					project_id=excluded.project_id,
					project_name=excluded.project_name,
					mode=excluded.mode,
					delivery=excluded.delivery,
					strategy=excluded.strategy,
					strategy_custom_id=excluded.strategy_custom_id,
					strategy_name=excluded.strategy_name,
					strategy_instructions=excluded.strategy_instructions,
					strategy_note=excluded.strategy_note,
					status=excluded.status,
					armed_at=excluded.armed_at,
					started_at=excluded.started_at,
					ended_at=excluded.ended_at,
					phase=excluded.phase,
					intent=excluded.intent,
					progress=excluded.progress,
					episode_count=excluded.episode_count,
					call_count=excluded.call_count,
					advice_count=excluded.advice_count,
					tokens_input=excluded.tokens_input,
					tokens_output=excluded.tokens_output,
					tokens_total=excluded.tokens_total,
					last_error=excluded.last_error,
					updated_at=excluded.updated_at`,
			)
			.run(
				item.sessionId,
				item.sessionPath,
				item.sessionName,
				item.projectId,
				item.projectName,
				item.mode,
				item.delivery,
				item.strategy,
				item.strategyCustomId,
				item.strategyName,
				item.strategyInstructions,
				item.strategyNote,
				item.status,
				item.armedAt,
				item.startedAt,
				item.endedAt,
				item.phase,
				item.intent,
				item.progress,
				item.episodeCount,
				item.callCount,
				item.adviceCount,
				item.usage.input,
				item.usage.output,
				item.usage.total,
				item.lastError,
				item.updatedAt,
			);
	}

	insertEpisode(input: { episode: SentinelSupervisorEpisode; calls: SentinelSupervisorCall[] }): void {
		const { episode, calls } = input;
		this.db
			.prepare(
				`INSERT OR REPLACE INTO supervisor_episodes (
					id, session_id, seq, at, trigger, phase, intent, progress, model,
					input_tokens, output_tokens, total_tokens, error, duration_ms, payload_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				episode.id,
				episode.sessionId,
				episode.seq,
				episode.at,
				episode.trigger,
				episode.phase,
				episode.intent,
				episode.progress,
				episode.model,
				episode.usage?.input ?? null,
				episode.usage?.output ?? null,
				episode.usage?.total ?? null,
				episode.error,
				episode.durationMs,
				JSON.stringify({ episode, calls }),
			);
	}

	appendLog(sessionId: string, log: SentinelSupervisorLog): void {
		this.db
			.prepare("INSERT INTO supervisor_events (session_id, at, kind, text) VALUES (?, ?, ?, ?)")
			.run(sessionId, log.at, log.kind, log.text);
		// The floating window only needs the tail; keep the table bounded per session.
		this.db
			.prepare(
				`DELETE FROM supervisor_events WHERE session_id = ? AND id NOT IN (
					SELECT id FROM supervisor_events WHERE session_id = ? ORDER BY id DESC LIMIT 500
				)`,
			)
			.run(sessionId, sessionId);
	}

	insertAdvice(advice: SentinelSupervisorAdvice): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO supervisor_advice
					(id, session_id, episode_id, at, delivery, status, text, sent_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				advice.id,
				advice.sessionId,
				advice.episodeId,
				advice.at,
				advice.delivery,
				advice.status,
				advice.text,
				advice.sentAt,
			);
	}

	setAdviceStatus(id: string, status: SentinelSupervisorAdvice["status"], sentAt: number | null): void {
		this.db.prepare("UPDATE supervisor_advice SET status = ?, sent_at = ? WHERE id = ?").run(status, sentAt, id);
	}

	listLogs(sessionId: string, limit = 100): SentinelSupervisorLog[] {
		const rows = this.db
			.prepare("SELECT at, kind, text FROM supervisor_events WHERE session_id = ? ORDER BY id DESC LIMIT ?")
			.all(sessionId, limit) as unknown as EventRow[];
		return rows.reverse().map((entry) => ({ at: entry.at, kind: entry.kind, text: entry.text }));
	}

	getPendingAdvice(sessionId: string): SentinelSupervisorAdvice | null {
		const row = this.db
			.prepare(
				"SELECT * FROM supervisor_advice WHERE session_id = ? AND status = 'pending' ORDER BY at DESC LIMIT 1",
			)
			.get(sessionId) as AdviceRow | undefined;
		return row ? adviceRecord(row) : null;
	}

	getAdvice(id: string): SentinelSupervisorAdvice | null {
		const row = this.db.prepare("SELECT * FROM supervisor_advice WHERE id = ?").get(id) as AdviceRow | undefined;
		return row ? adviceRecord(row) : null;
	}

	listSessions(query: SupervisorAuditQuery = {}): SentinelSupervisorAuditPage {
		const page = Math.max(1, Math.round(query.page ?? 1));
		const pageSize = Math.min(100, Math.max(1, Math.round(query.pageSize ?? 30)));
		const clauses: string[] = [];
		const values: Array<string | number> = [];
		if (query.projectId) {
			clauses.push("project_id = ?");
			values.push(query.projectId);
		}
		if (query.search?.trim()) {
			clauses.push("(session_name LIKE ? OR project_name LIKE ? OR intent LIKE ? OR strategy_name LIKE ?)");
			const like = `%${query.search.trim()}%`;
			values.push(like, like, like, like);
		}
		if (query.mode) {
			clauses.push("mode = ?");
			values.push(query.mode);
		}
		if (query.progress) {
			clauses.push("progress = ?");
			values.push(query.progress);
		}
		if (query.strategy) {
			clauses.push("strategy = ?");
			values.push(query.strategy);
		}
		if (query.customStrategyId) {
			clauses.push("strategy_custom_id = ?");
			values.push(query.customStrategyId);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const count = this.db.prepare(`SELECT COUNT(*) AS n FROM supervisor_sessions ${where}`).get(...values) as
			| { n?: number }
			| undefined;
		const stats = this.db
			.prepare(
				`SELECT
					COUNT(*) AS total,
					SUM(CASE WHEN progress = 'advancing' THEN 1 ELSE 0 END) AS advancing,
					SUM(CASE WHEN progress = 'stalled' THEN 1 ELSE 0 END) AS stalled,
					SUM(CASE WHEN progress = 'looping' THEN 1 ELSE 0 END) AS looping,
					SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
					SUM(CASE WHEN EXISTS (
						SELECT 1 FROM supervisor_advice a
						WHERE a.session_id = supervisor_sessions.session_id AND a.status = 'pending'
					) THEN 1 ELSE 0 END) AS pending_advice
				FROM supervisor_sessions ${where}`,
			)
			.get(...values) as
			| {
					total?: number;
					advancing?: number;
					stalled?: number;
					looping?: number;
					stopped?: number;
					pending_advice?: number;
			  }
			| undefined;
		const rows = this.db
			.prepare(`SELECT * FROM supervisor_sessions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
			.all(...values, pageSize, (page - 1) * pageSize) as unknown as SessionRow[];
		return {
			items: rows.map(auditItem),
			total: num(count?.n),
			page,
			pageSize,
			stats: {
				total: num(stats?.total),
				advancing: num(stats?.advancing),
				stalled: num(stats?.stalled),
				looping: num(stats?.looping),
				stopped: num(stats?.stopped),
				pendingAdvice: num(stats?.pending_advice),
			},
		};
	}

	getDetail(sessionId: string): SentinelSupervisorDetail | null {
		const row = this.db.prepare("SELECT * FROM supervisor_sessions WHERE session_id = ?").get(sessionId) as
			| SessionRow
			| undefined;
		if (!row) return null;
		const episodeRows = this.db
			.prepare("SELECT payload_json FROM supervisor_episodes WHERE session_id = ? ORDER BY seq ASC")
			.all(sessionId) as unknown as EpisodeRow[];
		const eventRows = this.db
			.prepare("SELECT at, kind, text FROM supervisor_events WHERE session_id = ? ORDER BY id ASC")
			.all(sessionId) as unknown as EventRow[];
		const adviceRows = this.db
			.prepare("SELECT * FROM supervisor_advice WHERE session_id = ? ORDER BY at ASC")
			.all(sessionId) as unknown as AdviceRow[];
		return {
			session: auditItem(row),
			episodes: episodeRows.map((entry) => episodeRecord(entry.payload_json).episode),
			logs: eventRows.map((entry) => ({ at: entry.at, kind: entry.kind, text: entry.text })),
			advice: adviceRows.map(adviceRecord),
		};
	}

	deleteSession(sessionId: string): void {
		this.db.prepare("DELETE FROM supervisor_sessions WHERE session_id = ?").run(sessionId);
		this.db.prepare("DELETE FROM supervisor_episodes WHERE session_id = ?").run(sessionId);
		this.db.prepare("DELETE FROM supervisor_events WHERE session_id = ?").run(sessionId);
		this.db.prepare("DELETE FROM supervisor_advice WHERE session_id = ?").run(sessionId);
	}

	deleteProject(projectId: string): void {
		const rows = this.db
			.prepare("SELECT session_id FROM supervisor_sessions WHERE project_id = ?")
			.all(projectId) as unknown as Array<{ session_id: string }>;
		for (const row of rows) this.deleteSession(row.session_id);
	}

	close(): void {
		this.db.close();
	}
}
