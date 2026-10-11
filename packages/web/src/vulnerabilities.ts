/**
 * Vulnerability hub: the permanent record of findings.
 *
 * The agent submits findings while it works; the operator reviews them on the
 * hub page. Records are project-scoped, numbered inside their project, and never
 * edited by the agent after submission — only the operator moves a record's
 * status, which is what keeps "the model believes it" and "someone reproduced
 * it" distinguishable.
 *
 * Storage is one SQLite database in the agent directory, not in the project work
 * directory: the work directory is mounted into the container, and a bash command
 * could otherwise read or rewrite the hub.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	ZGVulnEvidence,
	ZGVulnerability,
	ZGVulnFilters,
	ZGVulnNote,
	ZGVulnReview,
	ZGVulnSeverity,
	ZGVulnStats,
	ZGVulnStatus,
	ZGVulnSummary,
	ZGVulnUpdate,
} from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteValue } from "./sqlite.ts";

export const ZG_VULN_SEVERITIES: readonly ZGVulnSeverity[] = ["critical", "high", "medium", "low", "info"];
export const ZG_VULN_STATUSES: readonly ZGVulnStatus[] = ["pending", "confirmed", "false_positive", "fixed"];

/** Chinese labels, used by the Markdown export and the notification. */
export const ZG_VULN_SEVERITY_LABELS: Record<ZGVulnSeverity, string> = {
	critical: "严重",
	high: "高危",
	medium: "中危",
	low: "低危",
	info: "信息",
};

export const ZG_VULN_STATUS_LABELS: Record<ZGVulnStatus, string> = {
	pending: "待确认",
	confirmed: "已确认",
	false_positive: "误报",
	fixed: "已修复",
};

/** Highest score first, so a report and the page agree on the order. */
export function severityRank(severity: ZGVulnSeverity): number {
	return ZG_VULN_SEVERITIES.length - ZG_VULN_SEVERITIES.indexOf(severity);
}

/**
 * The severity bucket a CVSS base score belongs to. Used to flag a record whose
 * five-level label disagrees with its own score instead of silently trusting one.
 */
export function severityForCvss(cvss: number): ZGVulnSeverity {
	if (cvss >= 9) return "critical";
	if (cvss >= 7) return "high";
	if (cvss >= 4) return "medium";
	if (cvss > 0) return "low";
	return "info";
}

export function isSeverityMismatch(severity: ZGVulnSeverity, cvss: number): boolean {
	return severityForCvss(cvss) !== severity;
}

/** Human-readable id prefix derived from the project name, e.g. "E2E-PROJECT". */
export function vulnPrefix(projectName: string): string {
	const slug = projectName
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 20);
	return slug || "VULN";
}

export function vulnLabel(prefix: string, number: number): string {
	return `${prefix}-${String(number).padStart(4, "0")}`;
}

export interface ZGVulnCreateInput {
	projectId: string;
	projectName: string;
	sessionId?: string;
	/** Who submitted it, e.g. "主代理" or "子代理 <runId>". */
	source: string;
	title: string;
	severity: ZGVulnSeverity;
	cvss: number;
	cvssVector?: string;
	target: string;
	category?: string;
	description: string;
	/** Raw request or packet, verbatim. */
	packet: string;
	repro?: string;
	remediation?: string;
	references?: string[];
	evidence?: ZGVulnEvidence[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vulnerabilities (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  number INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  session_id TEXT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  cvss REAL NOT NULL,
  cvss_vector TEXT,
  status TEXT NOT NULL,
  target TEXT NOT NULL,
  category TEXT,
  description TEXT NOT NULL,
  packet TEXT NOT NULL,
  repro TEXT,
  remediation TEXT,
  refs TEXT,
  review TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vulnerability_evidence (
  vuln_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  command TEXT,
  output TEXT,
  path TEXT,
  note TEXT,
  PRIMARY KEY (vuln_id, seq)
);
CREATE TABLE IF NOT EXISTS vulnerability_notes (
  vuln_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  status_from TEXT,
  status_to TEXT,
  PRIMARY KEY (vuln_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_vulns_project ON vulnerabilities(project_id, number DESC);
CREATE INDEX IF NOT EXISTS idx_vulns_label ON vulnerabilities(project_id, label);
`;

interface VulnRow {
	id: string;
	label: string;
	number: number;
	project_id: string;
	project_name: string;
	session_id: string | null;
	source: string;
	title: string;
	severity: string;
	cvss: number;
	cvss_vector: string | null;
	status: string;
	target: string;
	category: string | null;
	description: string;
	packet: string;
	repro: string | null;
	remediation: string | null;
	refs: string | null;
	review: string | null;
	created_at: string;
	updated_at: string;
}

interface EvidenceRow {
	kind: string;
	command: string | null;
	output: string | null;
	path: string | null;
	note: string | null;
}

interface NoteRow {
	at: string;
	author: string;
	text: string;
	status_from: string | null;
	status_to: string | null;
}

function optional(value: string | null | undefined): string | undefined {
	return value === null || value === undefined || value === "" ? undefined : value;
}

/** `%` and `_` in an operator filter must match literally. */
function likePattern(value: string): string {
	return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function parseReferences(raw: string | null): string[] | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			const items = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
			return items.length > 0 ? items : undefined;
		}
	} catch {
		// A hand-edited row falls back to the raw text.
	}
	return [raw];
}

export function vulnerabilityDbPath(agentDir: string): string {
	return `${agentDir}/vulnerabilities.db`;
}

/** Zeroed counts, used when no project is selected. */
export function emptyVulnStats(): ZGVulnStats {
	return {
		total: 0,
		bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
		byStatus: { pending: 0, confirmed: 0, false_positive: 0, fixed: 0 },
	};
}

export class VulnerabilityStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.addReviewColumn();
	}

	/** Databases created before the reviewer existed have no review column. */
	private addReviewColumn(): void {
		const columns = this.db.prepare("PRAGMA table_info(vulnerabilities)").all() as unknown as Array<{ name: string }>;
		if (columns.some((column) => column.name === "review")) return;
		this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN review TEXT");
	}

	/** Next sequence number inside one project; the hub is single-process, so no race. */
	private nextNumber(projectId: string): number {
		const row = this.db
			.prepare("SELECT COALESCE(MAX(number), 0) AS last FROM vulnerabilities WHERE project_id = ?")
			.get(projectId) as unknown as { last: number } | undefined;
		return Number(row?.last ?? 0) + 1;
	}

	create(input: ZGVulnCreateInput): ZGVulnerability {
		const id = randomUUID();
		const number = this.nextNumber(input.projectId);
		const prefix = vulnPrefix(input.projectName);
		const label = vulnLabel(prefix, number);
		const now = new Date().toISOString();
		// Fresh submissions start queued for the reviewer LLM; it calibrates the
		// agent's self-assigned rating asynchronously at the hub layer.
		const review: ZGVulnReview = { state: "queued", at: Date.now() };
		this.db
			.prepare(
				`INSERT INTO vulnerabilities (
					id, label, number, project_id, project_name, session_id, source, title, severity, cvss,
					cvss_vector, status, target, category, description, packet, repro, remediation, refs, review,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				label,
				number,
				input.projectId,
				input.projectName,
				input.sessionId ?? null,
				input.source,
				input.title,
				input.severity,
				input.cvss,
				input.cvssVector ?? null,
				input.target,
				input.category ?? null,
				input.description,
				input.packet,
				input.repro ?? null,
				input.remediation ?? null,
				input.references && input.references.length > 0 ? JSON.stringify(input.references) : null,
				JSON.stringify(review),
				now,
				now,
			);
		const evidence = input.evidence ?? [];
		for (const [index, item] of evidence.entries()) {
			this.db
				.prepare(
					`INSERT INTO vulnerability_evidence (vuln_id, seq, kind, command, output, path, note)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					index + 1,
					item.kind,
					item.command ?? null,
					item.output ?? null,
					item.path ?? null,
					item.note ?? null,
				);
		}
		this.appendNote(id, {
			author: "agent",
			text: `由 ${input.source} 提交`,
		});
		const created = this.get(id);
		if (!created) throw new Error("漏洞记录写入失败");
		return created;
	}

	get(id: string): ZGVulnerability | undefined {
		const row = this.db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(id) as unknown as
			| VulnRow
			| undefined;
		if (!row) return undefined;
		const evidence = this.db
			.prepare(
				"SELECT kind, command, output, path, note FROM vulnerability_evidence WHERE vuln_id = ? ORDER BY seq ASC",
			)
			.all(id) as unknown as EvidenceRow[];
		const notes = this.db
			.prepare(
				"SELECT at, author, text, status_from, status_to FROM vulnerability_notes WHERE vuln_id = ? ORDER BY seq ASC",
			)
			.all(id) as unknown as NoteRow[];
		return toVulnerability(row, evidence, notes);
	}

	/** Look up by id or by the human-readable label, always inside one project. */
	find(projectId: string, idOrLabel: string): ZGVulnerability | undefined {
		const trimmed = idOrLabel.trim();
		const byLabel = this.db
			.prepare("SELECT id FROM vulnerabilities WHERE project_id = ? AND label = ? COLLATE NOCASE")
			.get(projectId, trimmed) as unknown as { id: string } | undefined;
		const found =
			byLabel ??
			(this.db.prepare("SELECT id FROM vulnerabilities WHERE id = ?").get(trimmed) as unknown as
				| { id: string }
				| undefined);
		return found ? this.get(found.id) : undefined;
	}

	/**
	 * Apply the reviewer LLM's verdict. Only a still-pending record with a
	 * queued review is calibrated — anything the operator already touched is
	 * out of the machine's hands. The change rides the same timeline as every
	 * other edit, authored as "system".
	 */
	applyReview(
		id: string,
		verdict: {
			severity: ZGVulnSeverity;
			cvss: number;
			cvssVector?: string;
			dubious: boolean;
			reason: string;
			model: string;
		},
	): ZGVulnerability | undefined {
		const existing = this.get(id);
		if (!existing) return undefined;
		if (existing.status !== "pending" || existing.review.state !== "queued") return existing;
		const review: ZGVulnReview = {
			state: "done",
			severity: verdict.severity,
			cvss: verdict.cvss,
			...(verdict.cvssVector ? { cvssVector: verdict.cvssVector } : {}),
			verdict: verdict.dubious ? "dubious" : "solid",
			reason: verdict.reason,
			model: verdict.model,
			at: Date.now(),
		};
		this.db
			.prepare(
				"UPDATE vulnerabilities SET severity = ?, cvss = ?, cvss_vector = ?, review = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				verdict.severity,
				verdict.cvss,
				verdict.cvssVector ?? existing.cvssVector ?? null,
				JSON.stringify(review),
				new Date().toISOString(),
				id,
			);
		const changes = [
			`等级 ${ZG_VULN_SEVERITY_LABELS[existing.severity]} → ${ZG_VULN_SEVERITY_LABELS[verdict.severity]}`,
			`CVSS ${existing.cvss.toFixed(1)} → ${verdict.cvss.toFixed(1)}`,
		];
		this.appendNote(id, {
			author: "system",
			text: `LLM 评审${verdict.dubious ? "（存疑）" : ""}：${changes.join("，")}。${verdict.reason}`,
		});
		return this.get(id);
	}

	/** The reviewer could not produce a verdict; keep the agent's values, keep the reason. */
	markReviewFailed(id: string, error: string): void {
		const existing = this.get(id);
		if (!existing || existing.review.state !== "queued") return;
		const review: ZGVulnReview = { state: "failed", error, at: Date.now() };
		this.db.prepare("UPDATE vulnerabilities SET review = ? WHERE id = ?").run(JSON.stringify(review), id);
	}

	/** Manual retry: a failed (or stuck queued) review goes back to the queue. */
	requeueReview(id: string): boolean {
		const existing = this.get(id);
		if (!existing) return false;
		if (existing.review.state !== "failed" && existing.review.state !== "queued") return false;
		this.db
			.prepare("UPDATE vulnerabilities SET review = ? WHERE id = ?")
			.run(JSON.stringify({ state: "queued", at: Date.now() } satisfies ZGVulnReview), id);
		return true;
	}

	/** Records still waiting for the reviewer, oldest first (crash recovery). */
	queuedReviewIds(projectId?: string): string[] {
		const rows = (projectId
			? this.db
					.prepare(
						"SELECT id FROM vulnerabilities WHERE project_id = ? AND review IS NOT NULL AND json_extract(review, '$.state') = 'queued' ORDER BY number ASC",
					)
					.all(projectId)
			: this.db
					.prepare(
						"SELECT id FROM vulnerabilities WHERE review IS NOT NULL AND json_extract(review, '$.state') = 'queued' ORDER BY number ASC",
					)
					.all()) as unknown as Array<{ id: string }>;
		return rows.map((row) => row.id);
	}

	list(projectId: string, filters: ZGVulnFilters = {}): ZGVulnSummary[] {
		const conditions = ["project_id = ?"];
		const params: SqliteValue[] = [projectId];
		if (filters.status) {
			conditions.push("status = ?");
			params.push(filters.status);
		}
		if (filters.severity) {
			conditions.push("severity = ?");
			params.push(filters.severity);
		}
		if (filters.dubious) {
			conditions.push("json_extract(review, '$.verdict') = 'dubious'");
		}
		if (filters.target?.trim()) {
			conditions.push("target LIKE ? ESCAPE '\\'");
			params.push(likePattern(filters.target.trim()));
		}
		if (filters.search?.trim()) {
			const pattern = likePattern(filters.search.trim());
			conditions.push(
				"(label LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR COALESCE(category, '') LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')",
			);
			params.push(pattern, pattern, pattern, pattern);
		}
		const rows = this.db
			.prepare(`SELECT * FROM vulnerabilities WHERE ${conditions.join(" AND ")} ORDER BY number DESC`)
			.all(...params) as unknown as VulnRow[];
		return rows.map((row) => {
			const { packet: _packet, evidence: _evidence, notes: _notes, ...summary } = toVulnerability(row, [], []);
			return summary;
		});
	}

	stats(projectId: string): ZGVulnStats {
		const bySeverity = emptyVulnStats().bySeverity;
		const byStatus = emptyVulnStats().byStatus;
		const severityRows = this.db
			.prepare("SELECT severity, COUNT(*) AS count FROM vulnerabilities WHERE project_id = ? GROUP BY severity")
			.all(projectId) as unknown as Array<{ severity: string; count: number }>;
		for (const row of severityRows) {
			if (row.severity in bySeverity) bySeverity[row.severity as ZGVulnSeverity] = Number(row.count);
		}
		const statusRows = this.db
			.prepare("SELECT status, COUNT(*) AS count FROM vulnerabilities WHERE project_id = ? GROUP BY status")
			.all(projectId) as unknown as Array<{ status: string; count: number }>;
		for (const row of statusRows) {
			if (row.status in byStatus) byStatus[row.status as ZGVulnStatus] = Number(row.count);
		}
		return {
			total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
			bySeverity,
			byStatus,
		};
	}

	/**
	 * Apply an operator edit. The timeline records what actually changed, so a
	 * record's history explains its current state without a separate audit log.
	 */
	update(id: string, patch: ZGVulnUpdate): ZGVulnerability | undefined {
		const existing = this.get(id);
		if (!existing) return undefined;
		const severity = patch.severity ?? existing.severity;
		const cvss = patch.cvss ?? existing.cvss;
		const status = patch.status ?? existing.status;
		const changes: string[] = [];
		if (status !== existing.status) {
			changes.push(`状态 ${ZG_VULN_STATUS_LABELS[existing.status]} → ${ZG_VULN_STATUS_LABELS[status]}`);
		}
		if (severity !== existing.severity) {
			changes.push(`等级 ${existing.severity} → ${severity}`);
		}
		if (cvss !== existing.cvss) {
			changes.push(`CVSS ${existing.cvss} → ${cvss}`);
		}
		const note = patch.note?.trim();
		if (note) changes.push(note);
		if (changes.length === 0) return existing;

		this.db
			.prepare(
				"UPDATE vulnerabilities SET severity = ?, cvss = ?, status = ?, updated_at = ?, review = ? WHERE id = ?",
			)
			.run(
				severity,
				cvss,
				status,
				new Date().toISOString(),
				// The operator acted before the reviewer did: their decision outranks
				// the machine's, so the pending review is skipped for good.
				existing.review.state === "queued"
					? JSON.stringify({ ...existing.review, state: "skipped" })
					: JSON.stringify(existing.review),
				id,
			);
		this.appendNote(id, {
			author: "operator",
			text: changes.join("；"),
			...(status !== existing.status ? { statusFrom: existing.status, statusTo: status } : {}),
		});
		return this.get(id);
	}

	private appendNote(
		id: string,
		note: { author: ZGVulnNote["author"]; text: string; statusFrom?: ZGVulnStatus; statusTo?: ZGVulnStatus },
	): void {
		const row = this.db
			.prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM vulnerability_notes WHERE vuln_id = ?")
			.get(id) as unknown as { last: number } | undefined;
		this.db
			.prepare(
				`INSERT INTO vulnerability_notes (vuln_id, seq, at, author, text, status_from, status_to)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				Number(row?.last ?? 0) + 1,
				new Date().toISOString(),
				note.author,
				note.text,
				note.statusFrom ?? null,
				note.statusTo ?? null,
			);
	}

	delete(id: string): boolean {
		const existing = this.db.prepare("SELECT id FROM vulnerabilities WHERE id = ?").get(id) as unknown as
			| { id: string }
			| undefined;
		if (!existing) return false;
		this.db.prepare("DELETE FROM vulnerability_evidence WHERE vuln_id = ?").run(id);
		this.db.prepare("DELETE FROM vulnerability_notes WHERE vuln_id = ?").run(id);
		this.db.prepare("DELETE FROM vulnerabilities WHERE id = ?").run(id);
		return true;
	}

	countByProject(projectId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS count FROM vulnerabilities WHERE project_id = ?")
			.get(projectId) as unknown as { count: number } | undefined;
		return Number(row?.count ?? 0);
	}

	/** Deleting a project deletes its findings: they cannot outlive their target scope. */
	deleteByProject(projectId: string): number {
		const ids = this.db
			.prepare("SELECT id FROM vulnerabilities WHERE project_id = ?")
			.all(projectId) as unknown as Array<{
			id: string;
		}>;
		for (const row of ids) {
			this.db.prepare("DELETE FROM vulnerability_evidence WHERE vuln_id = ?").run(row.id);
			this.db.prepare("DELETE FROM vulnerability_notes WHERE vuln_id = ?").run(row.id);
		}
		this.db.prepare("DELETE FROM vulnerabilities WHERE project_id = ?").run(projectId);
		return ids.length;
	}

	close(): void {
		this.db.close();
	}
}

/** The stored review JSON, defensively parsed: a corrupt value reads as skipped. */
function normalizeReview(raw: string | null): ZGVulnReview {
	if (!raw) return { state: "skipped", at: 0 };
	try {
		const value = JSON.parse(raw) as Partial<ZGVulnReview>;
		if (value.state !== "queued" && value.state !== "done" && value.state !== "failed" && value.state !== "skipped") {
			return { state: "skipped", at: 0 };
		}
		return {
			state: value.state,
			...(value.severity ? { severity: value.severity } : {}),
			...(typeof value.cvss === "number" ? { cvss: value.cvss } : {}),
			...(typeof value.cvssVector === "string" ? { cvssVector: value.cvssVector } : {}),
			...(value.verdict ? { verdict: value.verdict } : {}),
			...(typeof value.reason === "string" ? { reason: value.reason } : {}),
			...(typeof value.model === "string" ? { model: value.model } : {}),
			...(typeof value.error === "string" ? { error: value.error } : {}),
			at: typeof value.at === "number" ? value.at : 0,
		};
	} catch {
		return { state: "skipped", at: 0 };
	}
}

function toVulnerability(row: VulnRow, evidence: EvidenceRow[], notes: NoteRow[]): ZGVulnerability {
	const severity = row.severity as ZGVulnSeverity;
	const cvss = Number(row.cvss);
	return {
		id: row.id,
		review: normalizeReview(row.review),
		label: row.label,
		number: Number(row.number),
		projectId: row.project_id,
		projectName: row.project_name,
		...(optional(row.session_id) ? { sessionId: row.session_id as string } : {}),
		source: row.source,
		title: row.title,
		severity,
		cvss,
		...(optional(row.cvss_vector) ? { cvssVector: row.cvss_vector as string } : {}),
		status: row.status as ZGVulnStatus,
		target: row.target,
		...(optional(row.category) ? { category: row.category as string } : {}),
		description: row.description,
		packet: row.packet,
		...(optional(row.repro) ? { repro: row.repro as string } : {}),
		...(optional(row.remediation) ? { remediation: row.remediation as string } : {}),
		...(parseReferences(row.refs) ? { references: parseReferences(row.refs) as string[] } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		evidence: evidence.map((item) => ({
			kind: item.kind === "file" ? "file" : "command",
			...(optional(item.command) ? { command: item.command as string } : {}),
			...(optional(item.output) ? { output: item.output as string } : {}),
			...(optional(item.path) ? { path: item.path as string } : {}),
			...(optional(item.note) ? { note: item.note as string } : {}),
		})),
		notes: notes.map((item) => ({
			at: item.at,
			author: item.author as ZGVulnNote["author"],
			text: item.text,
			...(optional(item.status_from) ? { statusFrom: item.status_from as ZGVulnStatus } : {}),
			...(optional(item.status_to) ? { statusTo: item.status_to as ZGVulnStatus } : {}),
		})),
		severityMismatch: isSeverityMismatch(severity, cvss),
	};
}
