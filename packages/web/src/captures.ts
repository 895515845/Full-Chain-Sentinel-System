/**
 * The HTTP evidence store: requests and responses that prove how the target's
 * API behaves — imported from HAR or Burp exports, or captured on the device.
 *
 * App-pentest findings lean on these records (越权对比、重放、参数篡改 all quote
 * them), so they are queryable by host and free text, and each row keeps the raw
 * request/response verbatim. Storage is the agent directory (`captures.db`),
 * project-scoped like the vulnerability hub.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openSqliteDatabase, type SqliteDatabase, type SqliteValue } from "./sqlite.ts";

export function capturesDbPath(agentDir: string): string {
	return join(agentDir, "captures.db");
}

export interface HttpEntry {
	id: string;
	projectId: string;
	source: string;
	method: string;
	url: string;
	host: string;
	path: string;
	status: number | null;
	requestHeaders: string;
	requestBody: string;
	responseHeaders: string;
	responseBody: string;
	createdAt: string;
}

export interface HttpEntrySummary {
	id: string;
	method: string;
	url: string;
	host: string;
	path: string;
	status: number | null;
	createdAt: string;
}

export interface CaptureImportResult {
	imported: number;
	skipped: number;
	source: string;
}

/** One request/response pair before it is assigned an id and a project. */
export interface HttpEntryInput {
	method: string;
	url: string;
	status: number | null;
	requestHeaders: string;
	requestBody: string;
	responseHeaders: string;
	responseBody: string;
}

/** One entry body cap: a 50MB response has no business in a searchable store. */
const MAX_BODY = 256 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS http_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  req_headers TEXT NOT NULL DEFAULT '',
  req_body TEXT NOT NULL DEFAULT '',
  res_headers TEXT NOT NULL DEFAULT '',
  res_body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_http_entries_project ON http_entries(project_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_http_entries_host ON http_entries(project_id, host);
`;

const SCHEMA_WITHOUT_META = SCHEMA.replace(/\nCREATE INDEX[^;]+;/g, "");

interface Row {
	id: string;
	project_id: string;
	source: string;
	method: string;
	url: string;
	host: string;
	path: string;
	status: number | null;
	req_headers: string;
	req_body: string;
	res_headers: string;
	res_body: string;
	created_at: string;
}

function toEntry(row: Row): HttpEntry {
	return {
		id: row.id,
		projectId: row.project_id,
		source: row.source,
		method: row.method,
		url: row.url,
		host: row.host,
		path: row.path,
		status: row.status ?? null,
		requestHeaders: row.req_headers,
		requestBody: row.req_body,
		responseHeaders: row.res_headers,
		responseBody: row.res_body,
		createdAt: row.created_at,
	};
}

function clip(text: string | undefined | null): string {
	const value = text ?? "";
	if (value.length <= MAX_BODY) return value;
	return value.slice(0, MAX_BODY);
}

function hostAndPath(url: string): { host: string; path: string } {
	try {
		const parsed = new URL(url);
		return { host: parsed.host, path: parsed.pathname + parsed.search };
	} catch {
		return { host: "", path: url };
	}
}

export class CaptureStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		// Databases created before indexes existed still upgrade cleanly.
		try {
			this.db.exec(SCHEMA);
		} catch {
			this.db.exec(SCHEMA_WITHOUT_META);
		}
	}

	private insert(entry: Omit<HttpEntry, "id" | "createdAt">): void {
		this.db
			.prepare(
				"INSERT INTO http_entries (id, project_id, source, method, url, host, path, status, req_headers, req_body, res_headers, res_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				randomUUID(),
				entry.projectId,
				entry.source,
				entry.method,
				entry.url,
				entry.host,
				entry.path,
				entry.status,
				entry.requestHeaders,
				entry.requestBody,
				entry.responseHeaders,
				entry.responseBody,
				new Date().toISOString(),
			);
	}

	/** Import a HAR document (JSON string). Returns how many entries landed. */
	importHar(projectId: string, source: string, text: string): CaptureImportResult {
		const har = JSON.parse(text) as {
			log?: { entries?: Array<Record<string, unknown>> };
		};
		const entries = har.log?.entries ?? [];
		let imported = 0;
		let skipped = 0;
		for (const entry of entries) {
			try {
				const request = (entry.request ?? {}) as {
					method?: unknown;
					url?: unknown;
					headers?: Array<{ name?: unknown; value?: unknown }>;
					postData?: { text?: unknown };
				};
				const response = (entry.response ?? {}) as {
					status?: unknown;
					headers?: Array<{ name?: unknown; value?: unknown }>;
					content?: { text?: unknown };
				};
				const url = String(request.url ?? "");
				if (!url) {
					skipped += 1;
					continue;
				}
				const { host, path } = hostAndPath(url);
				this.insert({
					projectId,
					source,
					method: String(request.method ?? "GET"),
					url,
					host,
					path,
					status: typeof response.status === "number" ? response.status : null,
					requestHeaders: (request.headers ?? [])
						.map((header) => `${header.name ?? ""}: ${header.value ?? ""}`)
						.join("\n"),
					requestBody: clip(typeof request.postData?.text === "string" ? request.postData.text : ""),
					responseHeaders: (response.headers ?? [])
						.map((header) => `${header.name ?? ""}: ${header.value ?? ""}`)
						.join("\n"),
					responseBody: clip(typeof response.content?.text === "string" ? response.content.text : ""),
				});
				imported += 1;
			} catch {
				skipped += 1;
			}
		}
		return { imported, skipped, source };
	}

	/**
	 * Import a Burp Suite "Save items" XML export. Request/response bodies are
	 * base64 when the `base64` attribute is set. The export is flat and regular,
	 * so a block-wise extraction avoids pulling an XML parser into the bundle.
	 */
	importBurp(projectId: string, source: string, xml: string): CaptureImportResult {
		const items = xml.split(/<item>/i).slice(1);
		let imported = 0;
		let skipped = 0;
		for (const block of items) {
			const cut = block.indexOf("</item>");
			const body = cut >= 0 ? block.slice(0, cut) : block;
			const pick = (tag: string): string => {
				const match = body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
				return match ? match[1] : "";
			};
			const b64 = (tag: string): string => {
				const match = body.match(new RegExp(`<${tag}[^>]*base64="true"[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
				if (!match) return pick(tag);
				try {
					return Buffer.from(match[1].trim(), "base64").toString("utf-8");
				} catch {
					return match[1];
				}
			};
			const url = pick("url").trim();
			const method = (pick("method") || "GET").trim().toUpperCase();
			if (!url) {
				skipped += 1;
				continue;
			}
			const { host, path } = hostAndPath(url);
			const status = Number(pick("status")) || null;
			this.insert({
				projectId,
				source,
				method,
				url,
				host,
				path,
				status,
				requestHeaders: "",
				requestBody: clip(b64("request")),
				responseHeaders: "",
				responseBody: clip(b64("response")),
			});
			imported += 1;
		}
		return { imported, skipped, source };
	}

	/** Import a raw HTTP request/response dump: `###` lines separate the entries. */
	importText(projectId: string, source: string, text: string): CaptureImportResult {
		let imported = 0;
		let skipped = 0;
		const blocks = text
			.split(/\n={3,}|\n-{3,}\n(?=GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS )/g)
			.map((block) => block.trim())
			.filter(Boolean);
		for (const block of blocks) {
			const requestHead = block.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) (\S+) ?(\S*)/);
			if (!requestHead) {
				skipped += 1;
				continue;
			}
			const method = requestHead[1];
			const target = requestHead[2];
			const hostMatch = block.match(/^[Hh]ost:\s*(\S+)/m);
			const host = hostMatch?.[1] ?? "";
			const url = target.startsWith("http") ? target : `${host ? `http://${host}` : ""}${target}`;
			const { host: parsedHost, path } = hostAndPath(url);
			this.insert({
				projectId,
				source,
				method,
				url,
				host: parsedHost,
				path,
				status: null,
				requestHeaders: block,
				requestBody: "",
				responseHeaders: "",
				responseBody: "",
			});
			imported += 1;
		}
		return { imported, skipped, source };
	}

	/**
	 * Insert entries produced by a parser (tshark HTTP JSON, the iOS NSURLSession
	 * logger) instead of a HAR/Burp export. Bodies are capped per row, the same
	 * way the importers clip them.
	 */
	importEntries(projectId: string, source: string, entries: HttpEntryInput[]): CaptureImportResult {
		let imported = 0;
		let skipped = 0;
		for (const entry of entries) {
			if (!entry.url) {
				skipped += 1;
				continue;
			}
			const { host, path } = hostAndPath(entry.url);
			this.insert({
				projectId,
				source,
				method: entry.method || "GET",
				url: entry.url,
				host,
				path,
				status: entry.status,
				requestHeaders: entry.requestHeaders ?? "",
				requestBody: clip(entry.requestBody),
				responseHeaders: entry.responseHeaders ?? "",
				responseBody: clip(entry.responseBody),
			});
			imported += 1;
		}
		return { imported, skipped, source };
	}

	list(projectId: string, filter: { host?: string; q?: string; limit?: number } = {}): HttpEntrySummary[] {
		const conditions: string[] = ["project_id = ?"];
		const params: SqliteValue[] = [projectId];
		if (filter.host?.trim()) {
			conditions.push("host LIKE ?");
			params.push(`%${filter.host.trim()}%`);
		}
		if (filter.q?.trim()) {
			const needle = `%${filter.q.trim().toLowerCase()}%`;
			conditions.push(
				"(LOWER(url) LIKE ? OR LOWER(method) LIKE ? OR LOWER(path) LIKE ? OR LOWER(res_body) LIKE ? OR LOWER(req_body) LIKE ?)",
			);
			params.push(needle, needle, needle, needle, needle);
		}
		const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
		const rows = this.db
			.prepare(
				`SELECT id, project_id, source, method, url, host, path, status, req_headers, req_body, res_headers, res_body, created_at
				 FROM http_entries WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id LIMIT ${limit}`,
			)
			.all(...params) as Row[];
		return rows.map((row) => ({
			id: row.id,
			method: row.method,
			url: row.url,
			host: row.host,
			path: row.path,
			status: row.status ?? null,
			createdAt: row.created_at,
		}));
	}

	get(id: string, projectId: string): HttpEntry | undefined {
		const row = this.db.prepare("SELECT * FROM http_entries WHERE id = ? AND project_id = ?").get(id, projectId) as
			| Row
			| undefined;
		return row ? toEntry(row) : undefined;
	}

	count(projectId: string): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM http_entries WHERE project_id = ?").get(projectId) as
			| { n: number }
			| undefined;
		return Number(row?.n ?? 0);
	}

	/** Purge a project's entries (删除项目连带删除，同漏洞中枢). */
	purgeProject(projectId: string): number {
		const result = this.db.prepare("DELETE FROM http_entries WHERE project_id = ?").run(projectId);
		return Number(result.changes ?? 0);
	}

	close(): void {
		this.db.close();
	}
}
