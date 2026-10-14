/**
 * POC subscriptions: remote zip sources the operator subscribes to.
 *
 * A source is one zip URL plus an optional auth header. Syncing downloads the
 * archive and runs it through the same import path as a manual upload —
 * parsed, deduped by template id, upsert-only. Local templates are never
 * deleted by a sync: the library grows, and removing a template stays a
 * manual decision, so a broken or hijacked source cannot empty the library.
 *
 * One source is special only in how it is created: the console's one-click
 * official sync makes sure a source with `OFFICIAL_SOURCE_ID` exists, pointed
 * at the official nuclei-templates archive, and syncs it. Afterwards it is an
 * ordinary source — the URL can be retargeted at a mirror, the name and
 * interval edited, or the whole source deleted (the button recreates it).
 *
 * Scheduling is one minute-ticker for every source: a source with
 * `intervalHours > 0` syncs when its interval has elapsed (a sync already in
 * flight is never started twice; a missed tick syncs at the next one).
 * Outcomes — including failures — are kept as a short per-source history so
 * the operator can see what the last few syncs actually did.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_ZIP_TOTAL_BYTES } from "./poc-zip.ts";
import type { PocStore } from "./pocs.ts";
import type { ZGPocImportOutcome, ZGPocSource, ZGPocSourceSave, ZGPocSyncRecord } from "./protocol.ts";

/**
 * Download timeout per attempt. Deliberately generous: the official
 * nuclei-templates archive is ~18MB, which is seconds on a fast link and
 * minutes on a slow one, and the size cap already bounds the transfer — so
 * this is a ceiling, not a target.
 */
const FETCH_TIMEOUT_MS = 10 * 60_000;
/** Attempts per sync: the initial try plus one retry on a network error. */
const FETCH_ATTEMPTS = 2;
/** Largest archive a sync accepts, from the zip reader so the two cannot drift. */
const MAX_ZIP_MB = Math.round(MAX_ZIP_TOTAL_BYTES / 1024 / 1024);
/** Sync outcomes kept per source. */
const HISTORY_LIMIT = 5;
/** Bounds of the automatic interval; 0 means manual-only. */
export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 24 * 30;

/**
 * The source the one-click official sync owns. The id is fixed so pressing the
 * button twice reuses one source instead of stacking duplicates.
 */
export const OFFICIAL_SOURCE_ID = "official";
export const OFFICIAL_SOURCE_NAME = "官方 NucleiPOC";
/**
 * The official archive: the main branch, so one stable URL always serves the
 * newest templates (a release asset carries its version in the file name).
 * Measured: 18.4MB zip, 14,110 yaml, about 14,064 importable templates.
 */
export const OFFICIAL_SOURCE_URL = "https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.zip";

/** What is persisted per source (subscriptions.json, 0600). */
interface StoredSource {
	id: string;
	name: string;
	url: string;
	headerName: string;
	headerValue: string;
	intervalHours: number;
	enabled: boolean;
	lastSyncAt: string | null;
	history: ZGPocSyncRecord[];
}

export interface SubscriptionHooks {
	/** A source changed (save/delete/sync finished); consoles refresh the list. */
	onChange(): void;
	/** A sync failed; the runtime decides whether that becomes a DingTalk push. */
	onSyncFailure(source: ZGPocSource, record: ZGPocSyncRecord): void;
}

/** Validate a source URL: http or https only, no credentials in the URL itself. */
export function sourceUrlError(url: string): string | undefined {
	const trimmed = url.trim();
	if (!trimmed) return "URL 不能为空";
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "只支持 http / https URL";
		if (parsed.username || parsed.password) return "URL 里不能带用户名密码，请用认证头";
	} catch {
		return "URL 无法解析";
	}
	return undefined;
}

/** Clamp a requested interval into its usable range; 0 stays manual-only. */
export function clampIntervalHours(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(value)));
}

/** Whether a source is due for an automatic sync at `now`. */
export function isDue(source: ZGPocSource, now = Date.now()): boolean {
	if (!source.enabled || source.intervalHours <= 0) return false;
	if (!source.lastSyncAt) return true;
	const elapsed = now - Date.parse(source.lastSyncAt);
	return elapsed >= source.intervalHours * 3_600_000;
}

function toView(source: StoredSource): ZGPocSource {
	return {
		id: source.id,
		name: source.name,
		url: source.url,
		...(source.headerName ? { headerName: source.headerName } : {}),
		headerSet: Boolean(source.headerName && source.headerValue),
		intervalHours: source.intervalHours,
		enabled: source.enabled,
		lastSyncAt: source.lastSyncAt,
		lastResult: source.history[0] ?? null,
		history: source.history,
	};
}

/**
 * Download the archive. Content-Length beyond the cap aborts before the
 * transfer; a body that grows past it aborts mid-stream.
 */
async function download(url: string, headerName: string, headerValue: string): Promise<Buffer> {
	const headers: Record<string, string> = {};
	if (headerName && headerValue) headers[headerName] = headerValue;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const declared = Number(response.headers.get("content-length") ?? 0);
		if (declared > MAX_ZIP_TOTAL_BYTES) throw new Error(`文件超过 ${MAX_ZIP_MB}MB 上限`);
		const chunks: Uint8Array[] = [];
		let total = 0;
		const reader = response.body?.getReader();
		if (!reader) throw new Error("响应没有内容");
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_ZIP_TOTAL_BYTES) throw new Error(`文件超过 ${MAX_ZIP_MB}MB 上限`);
			chunks.push(value);
		}
		return Buffer.concat(chunks);
	} finally {
		clearTimeout(timer);
	}
}

export class PocSubscriptions {
	private readonly path: string;
	private readonly store: PocStore;
	private readonly hooks: SubscriptionHooks;
	private sources: StoredSource[] = [];
	private readonly running = new Set<string>();
	private ticker: ReturnType<typeof setInterval> | undefined;

	constructor(agentDir: string, store: PocStore, hooks: SubscriptionHooks) {
		this.path = join(agentDir, "subscriptions.json");
		this.store = store;
		this.hooks = hooks;
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { sources?: StoredSource[] };
			this.sources = Array.isArray(parsed.sources) ? parsed.sources : [];
		} catch {
			this.sources = []; // a corrupt file must not take the console down
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify({ sources: this.sources }, null, "\t")}\n`, { mode: 0o600 });
	}

	private record(source: StoredSource, record: ZGPocSyncRecord): void {
		source.history.unshift(record);
		source.history = source.history.slice(0, HISTORY_LIMIT);
	}

	list(): ZGPocSource[] {
		return this.sources.map(toView);
	}

	/**
	 * The source behind the one-click official sync: created on demand, then
	 * reused. The interval stays manual-only because the button is a click, not
	 * a schedule; automatic syncing can be turned on afterwards like any source.
	 */
	ensureOfficial(): { source: ZGPocSource } {
		const existing = this.sources.find((item) => item.id === OFFICIAL_SOURCE_ID);
		if (existing) return { source: toView(existing) };
		const source: StoredSource = {
			id: OFFICIAL_SOURCE_ID,
			name: OFFICIAL_SOURCE_NAME,
			url: OFFICIAL_SOURCE_URL,
			headerName: "",
			headerValue: "",
			intervalHours: 0,
			enabled: true,
			lastSyncAt: null,
			history: [],
		};
		this.sources.push(source);
		this.persist();
		this.hooks.onChange();
		return { source: toView(source) };
	}

	/** Create or update; returns the saved view or a rejection reason. */
	save(input: ZGPocSourceSave): { source: ZGPocSource } | { error: string } {
		const name = input.name.trim();
		if (!name) return { error: "名称不能为空" };
		const url = input.url.trim();
		const urlError = sourceUrlError(url);
		if (urlError) return { error: urlError };
		const headerName = input.headerName?.trim() ?? "";
		if (headerName && !/^[A-Za-z0-9-]+$/.test(headerName)) return { error: "认证头的名称只能是字母、数字与连字符" };

		const intervalHours = clampIntervalHours(input.intervalHours);
		if (input.id) {
			const source = this.sources.find((item) => item.id === input.id);
			if (!source) return { error: "该订阅源不存在" };
			source.name = name;
			source.url = url;
			source.headerName = headerName;
			// An empty value keeps the stored one, so an edit never erases the
			// secret the form cannot echo back.
			if (input.headerValue) source.headerValue = input.headerValue;
			else if (!headerName) source.headerValue = "";
			source.intervalHours = intervalHours;
			source.enabled = input.enabled;
			this.persist();
			this.hooks.onChange();
			return { source: toView(source) };
		}
		const source: StoredSource = {
			id: randomUUID().slice(0, 8),
			name,
			url,
			headerName,
			headerValue: input.headerValue ?? "",
			intervalHours,
			enabled: input.enabled,
			lastSyncAt: null,
			history: [],
		};
		this.sources.push(source);
		this.persist();
		this.hooks.onChange();
		return { source: toView(source) };
	}

	delete(id: string): boolean {
		const before = this.sources.length;
		this.sources = this.sources.filter((item) => item.id !== id);
		if (this.sources.length === before) return false;
		this.persist();
		this.hooks.onChange();
		return true;
	}

	/** Sync one source now. Refuses a second concurrent sync of the same source. */
	async sync(id: string, trigger: "manual" | "auto"): Promise<{ source: ZGPocSource } | { error: string }> {
		const source = this.sources.find((item) => item.id === id);
		if (!source) return { error: "该订阅源不存在" };
		if (this.running.has(id)) return { error: "该订阅源正在同步" };
		this.running.add(id);
		const startedAt = Date.now();
		let outcome: ZGPocImportOutcome | undefined;
		let failure: string | undefined;
		try {
			let bytes: Buffer | undefined;
			let lastError: unknown;
			for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
				try {
					bytes = await download(source.url, source.headerName, source.headerValue);
					break;
				} catch (error) {
					if (controllerIsAbort(error)) throw error;
					lastError = error;
				}
			}
			if (!bytes) throw lastError instanceof Error ? lastError : new Error("下载失败");
			outcome = this.store.import([{ name: "subscription.zip", bytes }]);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		} finally {
			this.running.delete(id);
		}
		const record: ZGPocSyncRecord = {
			at: new Date().toISOString(),
			ok: failure === undefined,
			trigger,
			durationMs: Date.now() - startedAt,
			imported: outcome?.imported ?? 0,
			replaced: outcome?.replaced ?? 0,
			skipped: outcome?.skipped.length ?? 0,
			...(failure ? { error: failure } : {}),
		};
		source.lastSyncAt = record.at;
		this.record(source, record);
		this.persist();
		this.hooks.onChange();
		if (failure !== undefined) this.hooks.onSyncFailure(toView(source), record);
		return { source: toView(source) };
	}

	/** Start the minute-ticker that picks up due automatic sources. */
	start(): void {
		if (this.ticker) return;
		this.ticker = setInterval(() => {
			for (const source of this.sources) {
				if (!isDue(toView(source))) continue;
				void this.sync(source.id, "auto").catch(() => {});
			}
		}, 60_000);
		this.ticker.unref?.();
	}

	stop(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}
}

function controllerIsAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
