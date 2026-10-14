/**
 * The business-modeling hub: OpenAPI documents the agent produced from a target.
 *
 * Modeling runs inside an ordinary conversation — the operator presses 业务建模
 * and the agent gets two extra tools for as long as the run lasts. This module
 * owns everything that outlives that run: the document, the business entities
 * the agent inferred, the audit trail, and the export.
 *
 * Storage is one SQLite database in the agent directory, not in the project work
 * directory, for the same reason the vulnerability hub lives there: the work
 * directory is mounted into the container, and one `rm` would take the records
 * with it.
 *
 * Every run is a new record. Re-modeling a site produces a second document
 * rather than overwriting the first, so the operator can compare coverage
 * between attempts; nothing here ever merges two runs together.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as toYaml } from "yaml";
import type {
	ZGApiModel,
	ZGApiModelEntity,
	ZGApiModelEvent,
	ZGApiModelField,
	ZGApiModelFilters,
	ZGApiModelRelation,
	ZGApiModelStatus,
	ZGApiModelSummary,
} from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteValue } from "./sqlite.ts";

/** Largest document accepted, measured on the serialized JSON. */
const MAX_DOC_BYTES = 512 * 1024;

/**
 * Endpoints one document may hold. A real site is a few hundred; this is a
 * runaway guard, not a design limit.
 */
const MAX_PATHS = 5_000;

/** Business entities one run may record. */
const MAX_ENTITIES = 200;
const MAX_FIELDS_PER_ENTITY = 200;
const MAX_RELATIONS_PER_ENTITY = 50;

/** Longest title kept; the page shows it in one row. */
const MAX_TITLE_LENGTH = 80;

/** Operations per path item, per the OpenAPI specification. */
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const STATUSES: readonly ZGApiModelStatus[] = ["modeling", "done", "manual", "failed"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_models (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  session_path TEXT,
  title TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  openapi TEXT NOT NULL,
  entities TEXT NOT NULL DEFAULT '[]',
  path_count INTEGER NOT NULL DEFAULT 0,
  operation_count INTEGER NOT NULL DEFAULT 0,
  entity_count INTEGER NOT NULL DEFAULT 0,
  submissions INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);
-- The page lists newest first, always scoped to the project on screen.
CREATE INDEX IF NOT EXISTS idx_api_models_project ON api_models(project_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_api_models_created ON api_models(created_at DESC, id);
CREATE TABLE IF NOT EXISTS api_model_events (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  path_count INTEGER,
  operation_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_model_events ON api_model_events(model_id, id);
`;

interface ApiModelRow {
	id: string;
	project_id: string | null;
	session_id: string | null;
	session_path: string | null;
	title: string;
	target: string;
	status: string;
	openapi: string;
	entities: string;
	path_count: number;
	operation_count: number;
	entity_count: number;
	submissions: number;
	error: string | null;
	created_at: string;
	updated_at: string;
	done_at: string | null;
}

interface ApiModelEventRow {
	at: string;
	kind: string;
	note: string | null;
	path_count: number | null;
	operation_count: number | null;
}

/** A list row: the document body is deliberately absent, as in the POC library. */
type ApiModelSummaryRow = Omit<ApiModelRow, "openapi" | "entities">;

export function apiModelsDbPath(agentDir: string): string {
	return join(agentDir, "apimodels.db");
}

/** Operations in a `paths` object, which is what the page counts as endpoints. */
export function countOperations(paths: unknown): number {
	if (!paths || typeof paths !== "object") return 0;
	let operations = 0;
	for (const item of Object.values(paths as Record<string, unknown>)) {
		if (!item || typeof item !== "object") continue;
		for (const key of Object.keys(item as Record<string, unknown>)) {
			if ((HTTP_METHODS as readonly string[]).includes(key.toLowerCase())) operations += 1;
		}
	}
	return operations;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What is wrong with a document, phrased for the model that has to fix it. An
 * empty list means it is acceptable. The checks are the ones that decide whether
 * a Swagger tool can open the file at all; style is not enforced.
 */
export function validateOpenApiDocument(doc: unknown): string[] {
	if (!isPlainObject(doc)) return ["文档必须是一个 JSON 对象。"];
	const problems: string[] = [];
	const version = doc.openapi;
	if (typeof version !== "string" || !version.trim()) {
		problems.push('缺少 openapi 字段：必须是 "3.0.0" 这类 3.x 版本号（本控制台只接受 OpenAPI 3.x）。');
	} else if (!/^3\./.test(version.trim())) {
		problems.push(`openapi 版本 ${version} 不受支持：必须是 3.x（例如 "3.0.3"）。`);
	}
	if (!isPlainObject(doc.info)) {
		problems.push("缺少 info 对象：至少要写 info.title 与 info.version。");
	} else {
		if (typeof doc.info.title !== "string" || !doc.info.title.trim()) problems.push("info.title 不能为空。");
		if (typeof doc.info.version !== "string" || !doc.info.version.trim()) problems.push("info.version 不能为空。");
	}
	if (!isPlainObject(doc.paths)) {
		problems.push("缺少 paths 对象：没有接口时也要写空的 paths: {}。");
	} else {
		const keys = Object.keys(doc.paths);
		if (keys.length > MAX_PATHS) {
			problems.push(`接口数量 ${keys.length} 超过上限 ${MAX_PATHS}：请拆分或只保留已确认的接口。`);
		}
		const badPath = keys.find((key) => !key.startsWith("/"));
		if (badPath !== undefined) problems.push(`paths 的键必须以 / 开头：${badPath} 不合法。`);
	}
	if (doc.components !== undefined && !isPlainObject(doc.components)) problems.push("components 必须是对象。");
	return problems;
}

/**
 * Fold a partial submission into the document already stored. `paths` is merged
 * per path item and `components` per section, which is what lets a large site be
 * delivered in batches: each call replaces exactly the endpoints it names and
 * leaves the rest of the draft alone.
 */
export function mergeOpenApiDraft(
	base: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...base, ...patch };
	if (patch.paths !== undefined) {
		const existing = isPlainObject(base.paths) ? base.paths : {};
		next.paths = { ...existing, ...(patch.paths as Record<string, unknown>) };
	}
	if (patch.components !== undefined) {
		const existing = isPlainObject(base.components) ? base.components : {};
		const incoming = patch.components as Record<string, unknown>;
		const merged: Record<string, unknown> = { ...existing };
		for (const [section, entries] of Object.entries(incoming)) {
			const before = isPlainObject(existing[section]) ? (existing[section] as Record<string, unknown>) : {};
			merged[section] = isPlainObject(entries) ? { ...before, ...entries } : entries;
		}
		next.components = merged;
	}
	return next;
}

/** Drop a 【…】 prefix and trailing punctuation, the way the hub treats titles. */
export function normalizeModelTitle(text: string): string {
	return text
		.replace(/^\s*【[^】]*】\s*/, "")
		.replace(/[\s。；;，,、.]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_TITLE_LENGTH);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * The business entities a submission carries. Entries without a name are
 * reported rather than dropped silently: an unnamed entity is a model mistake
 * the caller can fix, and a silently discarded one is a document that lies.
 */
export function normalizeEntities(input: unknown): { entities: ZGApiModelEntity[]; errors: string[] } {
	if (input === undefined) return { entities: [], errors: [] };
	if (!Array.isArray(input)) return { entities: [], errors: ["entities 必须是数组。"] };
	const errors: string[] = [];
	const entities: ZGApiModelEntity[] = [];
	for (const [index, raw] of input.entries()) {
		if (!isPlainObject(raw)) {
			errors.push(`entities[${index}] 不是对象。`);
			continue;
		}
		const name = text(raw.name);
		if (!name) {
			errors.push(`entities[${index}] 缺少 name。`);
			continue;
		}
		if (entities.length >= MAX_ENTITIES) {
			errors.push(`业务实体数量超过上限 ${MAX_ENTITIES}，多余的已忽略。`);
			break;
		}
		const fields: ZGApiModelField[] = [];
		if (raw.fields !== undefined) {
			if (!Array.isArray(raw.fields)) errors.push(`实体「${name}」的 fields 必须是数组。`);
			else {
				for (const field of raw.fields.slice(0, MAX_FIELDS_PER_ENTITY)) {
					if (!isPlainObject(field) || !text(field.name)) continue;
					fields.push({
						name: text(field.name),
						...(text(field.type) ? { type: text(field.type) } : {}),
						...(text(field.description) ? { description: text(field.description) } : {}),
					});
				}
			}
		}
		const relations: ZGApiModelRelation[] = [];
		if (raw.relations !== undefined) {
			if (!Array.isArray(raw.relations)) errors.push(`实体「${name}」的 relations 必须是数组。`);
			else {
				for (const relation of raw.relations.slice(0, MAX_RELATIONS_PER_ENTITY)) {
					if (!isPlainObject(relation) || !text(relation.target)) continue;
					relations.push({
						target: text(relation.target),
						...(text(relation.kind) ? { kind: text(relation.kind) } : {}),
						...(text(relation.description) ? { description: text(relation.description) } : {}),
					});
				}
			}
		}
		entities.push({
			name,
			...(text(raw.description) ? { description: text(raw.description) } : {}),
			...(fields.length > 0 ? { fields } : {}),
			...(relations.length > 0 ? { relations } : {}),
		});
	}
	return { entities, errors };
}

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function toModel(row: ApiModelRow): ZGApiModel {
	return {
		id: row.id,
		projectId: row.project_id,
		sessionId: row.session_id,
		sessionPath: row.session_path,
		title: row.title,
		target: row.target,
		status: (STATUSES as readonly string[]).includes(row.status) ? (row.status as ZGApiModelStatus) : "failed",
		openapi: parseJson<Record<string, unknown>>(row.openapi, {}),
		entities: parseJson<ZGApiModelEntity[]>(row.entities, []),
		pathCount: row.path_count,
		operationCount: row.operation_count,
		submissions: row.submissions,
		...(row.error ? { error: row.error } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		doneAt: row.done_at,
	};
}

function toSummary(row: ApiModelSummaryRow, entityCount: number): ZGApiModelSummary {
	return {
		id: row.id,
		projectId: row.project_id,
		sessionId: row.session_id,
		sessionPath: row.session_path,
		title: row.title,
		target: row.target,
		status: (STATUSES as readonly string[]).includes(row.status) ? (row.status as ZGApiModelStatus) : "failed",
		pathCount: row.path_count,
		operationCount: row.operation_count,
		submissions: row.submissions,
		...(row.error ? { error: row.error } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		doneAt: row.done_at,
		entityCount,
	};
}

export interface ApiModelBeginInput {
	projectId: string | null;
	sessionId: string | null;
	sessionPath: string | null;
	title?: string;
	target?: string;
}

export interface ApiModelSubmitInput {
	/** Whole document, replacing the draft. */
	openapi?: unknown;
	/** Path items merged into the draft, keyed by path. */
	paths?: unknown;
	/** Component sections merged into the draft. */
	components?: unknown;
	/** Business entities; when given, the whole list replaces the stored one. */
	entities?: unknown;
	target?: string;
	title?: string;
	note?: string;
}

/**
 * Either the stored run, or the reasons the submission was refused. `model` is
 * present whenever something was stored; `errors` is fatal only when it is not.
 */
export type ApiModelSubmitResult = { model?: ZGApiModel; errors?: string[] };

export class ApiModelStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.db.close();
	}

	/** Open a run. The record exists before the agent submits anything, so the page can show work in progress. */
	beginRun(input: ApiModelBeginInput, now = new Date()): ZGApiModel {
		const stamp = now.toISOString();
		const id = `api-${randomUUID()}`;
		const title = normalizeModelTitle(input.title ?? "") || "业务建模";
		this.db
			.prepare(
				"INSERT INTO api_models (id, project_id, session_id, session_path, title, target, status, openapi, entities, path_count, operation_count, submissions, created_at, updated_at, done_at) " +
					"VALUES (?, ?, ?, ?, ?, ?, 'modeling', ?, '[]', 0, 0, 0, ?, ?, NULL)",
			)
			.run(
				id,
				input.projectId,
				input.sessionId,
				input.sessionPath,
				title,
				input.target?.trim() ?? "",
				JSON.stringify({ openapi: "3.0.3", info: { title, version: "1.0.0" }, paths: {} }),
				stamp,
				stamp,
			);
		this.recordEvent(id, "created", stamp);
		return this.get(id) as ZGApiModel;
	}

	/**
	 * Store one submission. A document that fails validation is refused whole:
	 * nothing is written, and the reasons go back to the model. Entities and the
	 * target/title are applied only after the document passes, so a rejected call
	 * cannot half-update a record.
	 */
	submit(id: string, input: ApiModelSubmitInput, now = new Date()): ApiModelSubmitResult {
		const row = this.db.prepare("SELECT * FROM api_models WHERE id = ?").get(id) as unknown as
			| ApiModelRow
			| undefined;
		if (!row) return { errors: [`没有 id 为 ${id} 的业务建模记录。`] };

		const base = parseJson<Record<string, unknown>>(row.openapi, {});
		let next: Record<string, unknown>;
		if (input.openapi !== undefined) {
			if (!isPlainObject(input.openapi)) return { errors: ["openapi 必须是 JSON 对象（整份文档）。"] };
			next = input.openapi;
			// A whole-document submission still merges the patch fields on top, so a
			// model that sends the document and one more path in the same call is
			// understood instead of half-applied.
			if (input.paths !== undefined || input.components !== undefined) {
				if (input.paths !== undefined && !isPlainObject(input.paths)) return { errors: ["paths 必须是对象。"] };
				if (input.components !== undefined && !isPlainObject(input.components)) {
					return { errors: ["components 必须是对象。"] };
				}
				next = mergeOpenApiDraft(next, {
					...(input.paths !== undefined ? { paths: input.paths } : {}),
					...(input.components !== undefined ? { components: input.components } : {}),
				});
			}
		} else if (input.paths !== undefined || input.components !== undefined) {
			if (input.paths !== undefined && !isPlainObject(input.paths)) return { errors: ["paths 必须是对象。"] };
			if (input.components !== undefined && !isPlainObject(input.components))
				return { errors: ["components 必须是对象。"] };
			next = mergeOpenApiDraft(base, {
				...(input.paths !== undefined ? { paths: input.paths } : {}),
				...(input.components !== undefined ? { components: input.components } : {}),
			});
		} else {
			next = base;
		}

		const problems = validateOpenApiDocument(next);
		if (problems.length > 0) return { errors: problems };

		const serialized = JSON.stringify(next);
		if (serialized.length > MAX_DOC_BYTES) {
			return {
				errors: [
					`文档过大（${Math.round(serialized.length / 1024)}KB，上限 ${Math.round(MAX_DOC_BYTES / 1024)}KB）：请分片提交，或删掉没有验证过的示例。`,
				],
			};
		}

		const entities = input.entities !== undefined ? normalizeEntities(input.entities) : undefined;
		const stamp = now.toISOString();
		const title = input.title !== undefined ? normalizeModelTitle(input.title) : "";
		const target = input.target?.trim() ?? "";
		const pathCount = isPlainObject(next.paths) ? Object.keys(next.paths).length : 0;
		this.db
			.prepare(
				"UPDATE api_models SET openapi = ?, entities = COALESCE(?, entities), entity_count = COALESCE(?, entity_count), title = CASE WHEN ? = '' THEN title ELSE ? END, " +
					"target = CASE WHEN ? = '' THEN target ELSE ? END, path_count = ?, operation_count = ?, submissions = submissions + 1, updated_at = ? WHERE id = ?",
			)
			.run(
				serialized,
				entities ? JSON.stringify(entities.entities) : null,
				entities ? entities.entities.length : null,
				title,
				title,
				target,
				target,
				pathCount,
				countOperations(next.paths),
				stamp,
				id,
			);
		this.recordEvent(id, "submitted", stamp, input.note?.trim() || undefined);
		// Entity problems are reported without refusing the document: the endpoints
		// are already stored, and the model can resubmit the entity list alone.
		const model = this.get(id) as ZGApiModel;
		return entities && entities.errors.length > 0 ? { model, errors: entities.errors } : { model };
	}

	/** Close a run. Only the agent's own declaration and the operator's two ways out land here. */
	finish(
		id: string,
		status: "done" | "manual" | "failed",
		options: { note?: string; error?: string } = {},
		now = new Date(),
	): ZGApiModel | undefined {
		const row = this.db.prepare("SELECT * FROM api_models WHERE id = ?").get(id) as unknown as
			| ApiModelRow
			| undefined;
		if (!row) return undefined;
		const stamp = now.toISOString();
		this.db
			.prepare("UPDATE api_models SET status = ?, error = ?, updated_at = ?, done_at = ? WHERE id = ?")
			.run(status, options.error ?? null, stamp, stamp, id);
		this.recordEvent(
			id,
			status === "done" ? "done" : status === "manual" ? "manual" : "failed",
			stamp,
			options.note?.trim() || options.error,
		);
		return this.get(id);
	}

	get(id: string): ZGApiModel | undefined {
		const row = this.db.prepare("SELECT * FROM api_models WHERE id = ?").get(id) as unknown as
			| ApiModelRow
			| undefined;
		return row ? toModel(row) : undefined;
	}

	/**
	 * The requested records in the requested order, skipping ids that no longer
	 * exist — an attachment recorded before a delete must not fail the session.
	 */
	getMany(ids: readonly string[]): ZGApiModel[] {
		return ids.flatMap((id) => {
			const model = this.get(id);
			return model ? [model] : [];
		});
	}

	/** Runs of one project (or every project when the filter is absent), newest first. */
	list(filters: ZGApiModelFilters = {}): ZGApiModelSummary[] {
		const conditions: string[] = [];
		const params: SqliteValue[] = [];
		if (filters.projectId) {
			conditions.push("project_id = ?");
			params.push(filters.projectId);
		}
		if (filters.status) {
			conditions.push("status = ?");
			params.push(filters.status);
		}
		if (filters.search?.trim()) {
			const needle = `%${filters.search.trim().toLowerCase()}%`;
			conditions.push("(LOWER(title) LIKE ? OR LOWER(target) LIKE ?)");
			params.push(needle, needle);
		}
		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const rows = this.db
			.prepare(
				`SELECT id, project_id, session_id, session_path, title, target, status, path_count, operation_count, entity_count, submissions, error, created_at, updated_at, done_at FROM api_models${where} ORDER BY created_at DESC, id LIMIT 500`,
			)
			.all(...params) as unknown as (ApiModelSummaryRow & { entity_count: number })[];
		return rows.map((row) => toSummary(row, row.entity_count));
	}

	/** The audit trail of one run, oldest first. */
	events(id: string): ZGApiModelEvent[] {
		const rows = this.db
			.prepare(
				"SELECT at, kind, note, path_count, operation_count FROM api_model_events WHERE model_id = ? ORDER BY id",
			)
			.all(id) as unknown as ApiModelEventRow[];
		return rows.map((row) => ({
			at: row.at,
			kind: row.kind as ZGApiModelEvent["kind"],
			...(row.note ? { note: row.note } : {}),
			...(row.path_count !== null ? { pathCount: row.path_count } : {}),
			...(row.operation_count !== null ? { operationCount: row.operation_count } : {}),
		}));
	}

	delete(id: string): boolean {
		const row = this.db.prepare("SELECT 1 AS ok FROM api_models WHERE id = ?").get(id);
		if (!row) return false;
		this.db.prepare("DELETE FROM api_model_events WHERE model_id = ?").run(id);
		this.db.prepare("DELETE FROM api_models WHERE id = ?").run(id);
		return true;
	}

	/** Runs a deleted project takes with it. Returns how many records went away. */
	purgeProject(projectId: string): number {
		const rows = this.db.prepare("SELECT id FROM api_models WHERE project_id = ?").all(projectId) as unknown as {
			id: string;
		}[];
		for (const row of rows) this.delete(row.id);
		return rows.length;
	}

	countProject(projectId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM api_models WHERE project_id = ?")
			.get(projectId) as unknown as {
			n: number;
		};
		return row?.n ?? 0;
	}

	private recordEvent(modelId: string, kind: ZGApiModelEvent["kind"], at: string, note?: string): void {
		const row = this.db
			.prepare("SELECT path_count, operation_count FROM api_models WHERE id = ?")
			.get(modelId) as unknown as { path_count: number; operation_count: number } | undefined;
		this.db
			.prepare(
				"INSERT INTO api_model_events (model_id, at, kind, note, path_count, operation_count) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(modelId, at, kind, note ?? null, row?.path_count ?? null, row?.operation_count ?? null);
	}
}

/** A file name that survives a download directory: ASCII slug plus the record id. */
export function apiModelExportName(model: ZGApiModel, format: "json" | "yaml"): string {
	const slug = (model.title || model.target || "api-model")
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${slug || "api-model"}-${model.id.slice(4, 12)}.${format === "yaml" ? "yaml" : "json"}`;
}

/** The document as a downloadable file, in the format the operator asked for. */
export function buildApiModelExport(model: ZGApiModel, format: "json" | "yaml"): { filename: string; text: string } {
	return {
		filename: apiModelExportName(model, format),
		text: format === "yaml" ? toYaml(model.openapi) : `${JSON.stringify(model.openapi, null, 2)}\n`,
	};
}

/**
 * The endpoint index of one document: one line per operation, sorted by path then
 * method. This is what the attached-records catalog shows the model — paths and
 * summaries only, no parameters or schemas.
 */
export function endpointsOf(doc: Record<string, unknown>): Array<{ method: string; path: string; summary: string }> {
	const paths = isPlainObject(doc.paths) ? doc.paths : {};
	const endpoints: Array<{ method: string; path: string; summary: string }> = [];
	for (const [path, item] of Object.entries(paths)) {
		if (!isPlainObject(item)) continue;
		for (const [key, value] of Object.entries(item)) {
			const method = key.toLowerCase();
			if (!(HTTP_METHODS as readonly string[]).includes(method) || !isPlainObject(value)) continue;
			const summary = typeof value.summary === "string" ? value.summary : "";
			const operationId = typeof value.operationId === "string" ? value.operationId : "";
			endpoints.push({ method, path, summary: summary || operationId });
		}
	}
	return endpoints.sort(
		(left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
	);
}
