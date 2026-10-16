/**
 * The three asset-mapping platform clients: FOFA, 360 Quake, 奇安信 Hunter.
 *
 * Each platform is an internet-wide search engine for exposed assets. The
 * console calls them itself, over HTTPS, with the operator's key — the agent
 * never holds the key and never shells out to reach these APIs.
 *
 * Three things differ per platform and are easy to get wrong, so each is handled
 * in one place rather than at the call site:
 *
 * - **Query encoding.** FOFA takes standard base64 in `qbase64`; Hunter takes
 *   base64url with the padding stripped in `search`. One shared helper would
 *   break one of the two, so there are two named encoders.
 * - **Error shape.** FOFA reports `{"error":true,"errmsg":"[-700] 账号无效"}`,
 *   Quake answers HTTP 401 with a `/quake/login` body, Hunter answers
 *   `{"code":401,"message":"令牌过期"}`. All three become one
 *   `AssetPlatformError` with a Chinese message.
 * - **Metering.** Every platform bills queries. Quake rate-limits hard enough
 *   that two back-to-back calls already return `q3005`, so calls to one platform
 *   are serialized and rate-limit answers are retried with a delay.
 */

import type { SentinelAssetPlatform, SentinelTestResult } from "./protocol.ts";

/** One page's default and ceiling. Every platform accepts at least 100. */
export const DEFAULT_ASSET_PAGE_SIZE = 20;
export const MAX_ASSET_PAGE_SIZE = 100;

/** Longest banner kept per record in the model's answer; the raw response is on disk. */
export const MAX_BANNER_CHARS = 400;

/** Per-request ceiling. Quake can take several seconds under load. */
const REQUEST_TIMEOUT_MS = 25_000;

/** How many times a rate-limited call is retried, and how long to wait between tries. */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = [1_500, 4_000];

/** Injected for tests; the real console always uses the global fetch. */
export type AssetFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Where one platform lives. Endpoints are overridable so tests can serve them locally. */
export interface AssetPlatformMeta {
	id: SentinelAssetPlatform;
	label: string;
	searchUrl: string;
	/** Endpoint that reports the account and its remaining quota. */
	accountUrl: string;
	/** Query syntax reminder, shown to the model in the tool's error output. */
	syntax: string;
	/** Console page the operator reads for the full query language. */
	docUrl: string;
	/** Extra constraint the tool description has to state, when a platform has one. */
	note?: string;
}

export const ASSET_PLATFORM_META: Record<SentinelAssetPlatform, AssetPlatformMeta> = {
	fofa: {
		id: "fofa",
		label: "FOFA",
		searchUrl: "https://fofa.info/api/v1/search/all",
		accountUrl: "https://fofa.info/api/v1/info/my",
		syntax: 'FOFA 语法，如 ip="1.1.1.1"、domain="example.com"、title="后台"、body="login"、port="8080"',
		docUrl: "https://fofa.info/api",
	},
	quake: {
		id: "quake",
		label: "360 Quake",
		searchUrl: "https://quake.360.net/api/v3/search/quake_service",
		accountUrl: "https://quake.360.net/api/v3/user/info",
		syntax: 'Quake 语法，如 ip:"1.1.1.1"、domain:"example.com"、title:"后台"、port:8080、service:"http"',
		docUrl: "https://quake.360.net/quake/#/help",
	},
	hunter: {
		id: "hunter",
		label: "奇安信 Hunter",
		searchUrl: "https://hunter.qianxin.com/openApi/search",
		accountUrl: "https://hunter.qianxin.com/openApi/userInfo",
		syntax: 'Hunter 语法，如 ip="1.1.1.1"、domain="example.com"、web.title="后台"、port="8080"',
		docUrl: "https://hunter.qianxin.com/home/help",
		// Verified against the live API: page_size=5 answers 400 页大小不合法.
		note: "Hunter 的 page_size 只接受 1 / 10 / 20 / 50 / 100，其它值会被向上取到最近的合法值。",
	},
};

/** FOFA wants standard base64 in `qbase64`. */
export function encodeFofaQuery(query: string): string {
	return Buffer.from(query, "utf-8").toString("base64");
}

/** Hunter wants base64url with the padding stripped in `search`. */
export function encodeHunterQuery(query: string): string {
	return Buffer.from(query, "utf-8").toString("base64url").replace(/=+$/, "");
}

/**
 * One platform call failed. `retryable` marks the metering answers that are
 * worth waiting out; a bad key or a syntax error is not retried, because trying
 * again spends another query on the same rejection.
 */
export class AssetPlatformError extends Error {
	readonly platform: SentinelAssetPlatform;
	readonly retryable: boolean;

	constructor(platform: SentinelAssetPlatform, message: string, retryable: boolean) {
		super(message);
		this.name = "AssetPlatformError";
		this.platform = platform;
		this.retryable = retryable;
	}
}

/** A record normalized across the three platforms; empty string means "not reported". */
export interface AssetRecord {
	host: string;
	ip: string;
	port: number | null;
	domain: string;
	url: string;
	title: string;
	server: string;
	protocol: string;
	os: string;
	org: string;
	country: string;
	province: string;
	city: string;
	updatedAt: string;
	/** Response banner or HTTP header block, clipped for the model's answer. */
	banner: string;
}

export interface AssetSearchResult {
	platform: SentinelAssetPlatform;
	query: string;
	page: number;
	size: number;
	/** Total matches the platform reports, which is usually far more than returned. */
	total: number;
	records: AssetRecord[];
	/** Full response body, for the evidence file written next to the project. */
	raw: unknown;
	/** Quota line when this response carried one. */
	quota?: string;
	/** The platform's own syntax hint, when it returns one (Hunter does). */
	syntaxHint?: string;
	latencyMs: number;
}

export interface AssetSearchOptions {
	platform: SentinelAssetPlatform;
	key: string;
	query: string;
	page?: number;
	size?: number;
	fetchImpl?: AssetFetch;
	/** Endpoint override, for tests. */
	searchUrl?: string;
	signal?: AbortSignal;
}

export interface AssetProbeOptions {
	platform: SentinelAssetPlatform;
	key: string;
	fetchImpl?: AssetFetch;
	accountUrl?: string;
	signal?: AbortSignal;
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

function clipBanner(value: unknown): string {
	const banner = text(value).replace(/\r\n/g, "\n").trim();
	if (banner.length <= MAX_BANNER_CHARS) return banner;
	return `${banner.slice(0, MAX_BANNER_CHARS)}…（已截断）`;
}

function emptyRecord(): AssetRecord {
	return {
		host: "",
		ip: "",
		port: null,
		domain: "",
		url: "",
		title: "",
		server: "",
		protocol: "",
		os: "",
		org: "",
		country: "",
		province: "",
		city: "",
		updatedAt: "",
		banner: "",
	};
}

function asPort(value: unknown): number | null {
	const port = typeof value === "number" ? value : Number.parseInt(text(value), 10);
	return Number.isFinite(port) && port > 0 ? port : null;
}

/** The page sizes Hunter accepts; anything else is rejected with 页大小不合法. */
export const HUNTER_PAGE_SIZES: readonly number[] = [1, 10, 20, 50, 100];

/**
 * Round a requested size up to the nearest size Hunter accepts. Rounding up
 * rather than down keeps the caller's intent ("at least this many"); 100 is the
 * ceiling, so a larger request lands there.
 */
export function hunterPageSize(size: number): number {
	for (const allowed of HUNTER_PAGE_SIZES) {
		if (size <= allowed) return allowed;
	}
	return HUNTER_PAGE_SIZES[HUNTER_PAGE_SIZES.length - 1] ?? 100;
}

/** Clamp a page number and page size into what every platform accepts. */
export function clampPage(page: unknown, size: unknown): { page: number; size: number } {
	const rawPage = typeof page === "number" && Number.isFinite(page) ? Math.floor(page) : 1;
	const rawSize = typeof size === "number" && Number.isFinite(size) ? Math.floor(size) : DEFAULT_ASSET_PAGE_SIZE;
	return {
		page: Math.max(1, rawPage),
		size: Math.min(Math.max(1, rawSize), MAX_ASSET_PAGE_SIZE),
	};
}

/**
 * Calls to one platform run one at a time. Quake answers `q3005` (调用API过于
 * 频繁) to concurrent requests, and all three meter queries, so a burst from a
 * model that fired several searches at once would spend quota on rejections.
 */
const platformQueues = new Map<SentinelAssetPlatform, Promise<unknown>>();

function enqueue<T>(platform: SentinelAssetPlatform, task: () => Promise<T>): Promise<T> {
	const previous = platformQueues.get(platform) ?? Promise.resolve();
	// Run the next task whether the previous one resolved or rejected; only the
	// ordering matters, and the stored chain swallows the rejection so a failed
	// call cannot surface as an unhandled rejection.
	const next = previous.then(task, task);
	platformQueues.set(
		platform,
		next.catch(() => undefined),
	);
	return next;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("已取消"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("已取消"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Run a task, retrying the metering rejections with a growing delay. */
async function withRetry<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
		try {
			return await task();
		} catch (error) {
			lastError = error;
			const retryable = error instanceof AssetPlatformError && error.retryable;
			if (!retryable || attempt === RATE_LIMIT_RETRIES) throw error;
			await delay(RATE_LIMIT_BACKOFF_MS[attempt] ?? 4_000, signal);
		}
	}
	throw lastError;
}

/** One HTTP call with the request timeout combined with the caller's abort. */
async function request(
	platform: SentinelAssetPlatform,
	fetchImpl: AssetFetch,
	url: string,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetchImpl(url, { ...init, signal: combined });
	} catch (error) {
		if (signal?.aborted) throw new AssetPlatformError(platform, "已取消", false);
		const reason = timeout.aborted ? `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）` : "网络错误";
		const detail = error instanceof Error ? error.message : String(error);
		throw new AssetPlatformError(platform, `${reason}：${detail}`, true);
	}
	const body = await response.text().catch(() => "");
	return { status: response.status, body };
}

/** Parse a JSON body, naming the platform in the failure. */
function parseJson(platform: SentinelAssetPlatform, body: string, status: number): unknown {
	if (!body.trim()) {
		throw new AssetPlatformError(platform, `接口返回空响应（HTTP ${status}）`, status >= 500 || status === 429);
	}
	try {
		return JSON.parse(body) as unknown;
	} catch {
		// Quake answers a bad token with an HTML/plain redirect to /quake/login.
		if (body.includes("/quake/login")) {
			throw new AssetPlatformError(platform, "令牌无效或已过期（Quake 返回登录跳转）", false);
		}
		throw new AssetPlatformError(platform, `接口返回的不是 JSON（HTTP ${status}）：${body.slice(0, 120)}`, false);
	}
}

function isRateLimitText(value: string): boolean {
	return /q3005|频率|过于频繁|too many|rate.?limit|429/i.test(value);
}

// ---------------------------------------------------------------------------
// FOFA
// ---------------------------------------------------------------------------

/**
 * The fields requested from FOFA, in the order the positional `results` arrays
 * arrive. A fixed list keeps the mapping deterministic: FOFA answers with arrays
 * aligned to `fields`, so an omitted field would shift every later column.
 */
export const FOFA_FIELDS = [
	"host",
	"ip",
	"port",
	"domain",
	"title",
	"server",
	"protocol",
	"country",
	"province",
	"city",
	"org",
	"os",
	"updated_at",
] as const;

function fofaRecord(row: unknown[]): AssetRecord {
	const record = emptyRecord();
	const at = (index: number): string => text(row[index]);
	record.host = at(0);
	record.ip = at(1);
	record.port = asPort(at(2));
	record.domain = at(3);
	record.title = at(4);
	record.server = at(5);
	record.protocol = at(6);
	record.country = at(7);
	record.province = at(8);
	record.city = at(9);
	record.org = at(10);
	record.os = at(11);
	record.updatedAt = at(12);
	// `host` is either a hostname or a full URL depending on the query mode.
	record.url = /^https?:\/\//i.test(record.host) ? record.host : "";
	return record;
}

function parseFofa(
	body: string,
	status: number,
): {
	total: number;
	records: AssetRecord[];
	raw: unknown;
	quota?: string;
} {
	const data = parseJson("fofa", body, status) as {
		error?: boolean;
		errmsg?: string;
		size?: number;
		results?: unknown[];
		consumed_fpoint?: number;
	};
	if (data.error) {
		const message = data.errmsg ?? "FOFA 拒绝了这次查询";
		throw new AssetPlatformError("fofa", message, isRateLimitText(message));
	}
	if (!Array.isArray(data.results)) {
		throw new AssetPlatformError("fofa", `FOFA 返回结构异常：${body.slice(0, 120)}`, false);
	}
	const records = data.results.filter((row): row is unknown[] => Array.isArray(row)).map((row) => fofaRecord(row));
	const quota = typeof data.consumed_fpoint === "number" ? `本次消耗 ${data.consumed_fpoint} F 点` : undefined;
	return {
		total: typeof data.size === "number" ? data.size : records.length,
		records,
		raw: data,
		...(quota ? { quota } : {}),
	};
}

async function searchFofa(options: AssetSearchOptions, page: number, size: number): Promise<AssetSearchResult> {
	const meta = ASSET_PLATFORM_META.fofa;
	const url = new URL(options.searchUrl ?? meta.searchUrl);
	url.searchParams.set("key", options.key);
	url.searchParams.set("qbase64", encodeFofaQuery(options.query));
	url.searchParams.set("size", String(size));
	url.searchParams.set("page", String(page));
	url.searchParams.set("fields", FOFA_FIELDS.join(","));
	const started = Date.now();
	const { status, body } = await request(
		"fofa",
		options.fetchImpl ?? fetch,
		url.toString(),
		{ method: "GET" },
		options.signal,
	);
	const parsed = parseFofa(body, status);
	return {
		platform: "fofa",
		query: options.query,
		page,
		size,
		total: parsed.total,
		records: parsed.records,
		raw: parsed.raw,
		...(parsed.quota ? { quota: parsed.quota } : {}),
		latencyMs: Date.now() - started,
	};
}

// ---------------------------------------------------------------------------
// 360 Quake
// ---------------------------------------------------------------------------

function quakeRecord(row: unknown): AssetRecord {
	const record = emptyRecord();
	if (!row || typeof row !== "object") return record;
	const item = row as {
		ip?: unknown;
		port?: unknown;
		hostname?: unknown;
		domain?: unknown;
		org?: unknown;
		transport?: unknown;
		time?: unknown;
		location?: Record<string, unknown>;
		service?: Record<string, unknown>;
		components?: unknown[];
	};
	record.ip = text(item.ip);
	record.port = asPort(item.port);
	record.host = text(item.hostname);
	record.domain = text(item.domain);
	record.org = text(item.org);
	record.protocol = text(item.transport);
	record.updatedAt = text(item.time);
	const location = item.location ?? {};
	// The Chinese names are what the operator expects; the English ones are the
	// fallback for records outside mainland China.
	record.country = text(location.country_cn) || text(location.country_en);
	record.province = text(location.province_cn) || text(location.province_en);
	record.city = text(location.city_cn) || text(location.city_en);
	if (!record.org) record.org = text(location.isp) || text(location.owner);
	const service = item.service ?? {};
	record.banner = clipBanner(service.response);
	record.server = text(service.name) || text(service.version);
	if (!record.server && Array.isArray(item.components) && item.components.length > 0) {
		const component = item.components[0] as { product_name_cn?: unknown; product_name_en?: unknown };
		record.server = text(component.product_name_cn) || text(component.product_name_en);
	}
	return record;
}

function parseQuake(
	body: string,
	status: number,
): {
	total: number;
	records: AssetRecord[];
	raw: unknown;
	quota?: string;
} {
	const data = parseJson("quake", body, status) as {
		code?: unknown;
		message?: string;
		data?: unknown;
		meta?: { pagination?: { total?: number } };
	};
	// Quake reports success as the number 0 and failures as strings like "q3005".
	if (String(data.code) !== "0") {
		const message = data.message ?? "Quake 拒绝了这次查询";
		throw new AssetPlatformError("quake", message, isRateLimitText(String(data.code)) || isRateLimitText(message));
	}
	if (!Array.isArray(data.data)) {
		throw new AssetPlatformError("quake", `Quake 返回结构异常：${body.slice(0, 120)}`, false);
	}
	const records = data.data.map((row) => quakeRecord(row));
	const total = data.meta?.pagination?.total;
	return {
		total: typeof total === "number" ? total : records.length,
		records,
		raw: data,
	};
}

async function searchQuake(options: AssetSearchOptions, page: number, size: number): Promise<AssetSearchResult> {
	const meta = ASSET_PLATFORM_META.quake;
	const url = options.searchUrl ?? meta.searchUrl;
	const started = Date.now();
	const { status, body } = await request(
		"quake",
		options.fetchImpl ?? fetch,
		url,
		{
			method: "POST",
			headers: { "content-type": "application/json", "X-QuakeToken": options.key },
			// No `include`: the banner and component list are the useful parts, and
			// `include` rejects field names that are not filterable (a `title` entry
			// fails the whole call with q2001).
			body: JSON.stringify({ query: options.query, start: (page - 1) * size, size }),
		},
		options.signal,
	);
	const parsed = parseQuake(body, status);
	return {
		platform: "quake",
		query: options.query,
		page,
		size,
		total: parsed.total,
		records: parsed.records,
		raw: parsed.raw,
		latencyMs: Date.now() - started,
	};
}

// ---------------------------------------------------------------------------
// 奇安信 Hunter
// ---------------------------------------------------------------------------

function hunterRecord(row: unknown): AssetRecord {
	const record = emptyRecord();
	if (!row || typeof row !== "object") return record;
	const item = row as Record<string, unknown>;
	record.ip = text(item.ip);
	record.port = asPort(item.port);
	record.domain = text(item.domain);
	record.url = text(item.url);
	record.title = text(item.web_title);
	record.server = text(item.header_server);
	record.protocol = text(item.protocol);
	record.os = text(item.os);
	record.org = text(item.company) || text(item.isp) || text(item.as_org);
	record.country = text(item.country);
	record.province = text(item.province);
	record.city = text(item.city);
	record.updatedAt = text(item.updated_at);
	record.banner = clipBanner(item.banner) || clipBanner(item.header);
	if (!record.host) record.host = record.domain || record.ip;
	return record;
}

function parseHunter(
	body: string,
	status: number,
): {
	total: number;
	records: AssetRecord[];
	raw: unknown;
	quota?: string;
	syntaxHint?: string;
} {
	const data = parseJson("hunter", body, status) as {
		code?: number;
		message?: string;
		data?: {
			total?: number;
			arr?: unknown[];
			rest_quota?: number;
			consume_quota?: number;
			syntax_prompt?: string[];
		};
	};
	if (data.code !== 200) {
		const message = data.message ?? "Hunter 拒绝了这次查询";
		throw new AssetPlatformError(
			"hunter",
			`${message}（code ${data.code}）`,
			data.code === 429 || isRateLimitText(message),
		);
	}
	const payload = data.data ?? {};
	if (!Array.isArray(payload.arr)) {
		throw new AssetPlatformError("hunter", `Hunter 返回结构异常：${body.slice(0, 120)}`, false);
	}
	const records = payload.arr.map((row) => hunterRecord(row));
	const quota =
		typeof payload.rest_quota === "number"
			? `本次消耗 ${payload.consume_quota ?? "?"} 点，剩余 ${payload.rest_quota} 点`
			: undefined;
	const syntaxHint = Array.isArray(payload.syntax_prompt) ? payload.syntax_prompt.slice(0, 3).join("；") : undefined;
	return {
		total: typeof payload.total === "number" ? payload.total : records.length,
		records,
		raw: data,
		...(quota ? { quota } : {}),
		...(syntaxHint ? { syntaxHint } : {}),
	};
}

async function searchHunter(options: AssetSearchOptions, page: number, size: number): Promise<AssetSearchResult> {
	const meta = ASSET_PLATFORM_META.hunter;
	const url = new URL(options.searchUrl ?? meta.searchUrl);
	url.searchParams.set("api-key", options.key);
	url.searchParams.set("search", encodeHunterQuery(options.query));
	url.searchParams.set("page", String(page));
	url.searchParams.set("page_size", String(size));
	url.searchParams.set("is_web", "1");
	const started = Date.now();
	const { status, body } = await request(
		"hunter",
		options.fetchImpl ?? fetch,
		url.toString(),
		{ method: "GET" },
		options.signal,
	);
	const parsed = parseHunter(body, status);
	return {
		platform: "hunter",
		query: options.query,
		page,
		size,
		total: parsed.total,
		records: parsed.records,
		raw: parsed.raw,
		...(parsed.quota ? { quota: parsed.quota } : {}),
		...(parsed.syntaxHint ? { syntaxHint: parsed.syntaxHint } : {}),
		latencyMs: Date.now() - started,
	};
}

/**
 * Search one platform. Calls are serialized per platform and rate-limit answers
 * are retried, so a model that fires several searches at once still spends its
 * quota on results rather than on rejections.
 */
export function searchAssets(options: AssetSearchOptions): Promise<AssetSearchResult> {
	const { page, size } = clampPage(options.page, options.size);
	// Hunter rejects a size it does not have in its list, so the request and the
	// reported page size both use the snapped value.
	const effective = options.platform === "hunter" ? hunterPageSize(size) : size;
	return enqueue(options.platform, () =>
		withRetry(() => {
			if (options.platform === "fofa") return searchFofa(options, page, effective);
			if (options.platform === "quake") return searchQuake(options, page, effective);
			return searchHunter(options, page, effective);
		}, options.signal),
	);
}

// ---------------------------------------------------------------------------
// Account probe
// ---------------------------------------------------------------------------

/** One account probe: whether the key works, and what the account has left. */
export function probeAssetPlatform(options: AssetProbeOptions): Promise<SentinelTestResult & { quota?: string }> {
	return enqueue(options.platform, () => withRetry(() => probeOnce(options), options.signal));
}

async function probeOnce(options: AssetProbeOptions): Promise<SentinelTestResult & { quota?: string }> {
	const meta = ASSET_PLATFORM_META[options.platform];
	const fetchImpl = options.fetchImpl ?? fetch;
	const signal = options.signal;
	if (options.platform === "fofa") {
		const url = new URL(options.accountUrl ?? meta.accountUrl);
		url.searchParams.set("key", options.key);
		const { status, body } = await request("fofa", fetchImpl, url.toString(), { method: "GET" }, signal);
		const data = parseJson("fofa", body, status) as {
			error?: boolean;
			errmsg?: string;
			fofa_point?: number;
			remain_free_point?: number;
			isvip?: boolean;
			vip_level?: number;
		};
		if (data.error)
			throw new AssetPlatformError("fofa", data.errmsg ?? "FOFA 拒绝了这次查询", isRateLimitText(data.errmsg ?? ""));
		const quota = `免费点 ${data.remain_free_point ?? "?"} · F 点 ${data.fofa_point ?? "?"}${
			data.isvip ? ` · VIP${data.vip_level ?? ""}` : ""
		}`;
		return { ok: true, message: `FOFA 连接正常（${quota}）`, quota };
	}
	if (options.platform === "quake") {
		const url = options.accountUrl ?? meta.accountUrl;
		const { status, body } = await request(
			"quake",
			fetchImpl,
			url,
			{ method: "GET", headers: { "X-QuakeToken": options.key } },
			signal,
		);
		const data = parseJson("quake", body, status) as {
			code?: unknown;
			message?: string;
			data?: { month_remaining_credit?: number; credit?: number; baned?: boolean; ban_status?: string };
		};
		if (String(data.code) !== "0") {
			throw new AssetPlatformError("quake", data.message ?? "Quake 拒绝了这次请求", false);
		}
		const payload = data.data ?? {};
		if (payload.baned) {
			return { ok: false, message: `Quake 账号已被封禁：${payload.ban_status ?? "未知原因"}` };
		}
		const quota = `本月剩余额度 ${payload.month_remaining_credit ?? "?"} 点 · 总额度 ${payload.credit ?? "?"}`;
		return { ok: true, message: `360 Quake 连接正常（${quota}）`, quota };
	}
	const url = new URL(options.accountUrl ?? meta.accountUrl);
	url.searchParams.set("api-key", options.key);
	const { status, body } = await request("hunter", fetchImpl, url.toString(), { method: "GET" }, signal);
	const data = parseJson("hunter", body, status) as {
		code?: number;
		message?: string;
		data?: { rest_free_point?: number; day_free_point?: number; rest_equity_point?: number };
	};
	if (data.code !== 200) {
		throw new AssetPlatformError("hunter", `${data.message ?? "Hunter 拒绝了这次请求"}（code ${data.code}）`, false);
	}
	const payload = data.data ?? {};
	const quota = `免费点 ${payload.rest_free_point ?? "?"} / 每日 ${payload.day_free_point ?? "?"} · 权益点 ${payload.rest_equity_point ?? "?"}`;
	return { ok: true, message: `奇安信 Hunter 连接正常（${quota}）`, quota };
}

/** The syntax reminder for one platform, used in tool output and error text. */
export function assetSyntaxHint(platform: SentinelAssetPlatform): string {
	return ASSET_PLATFORM_META[platform].syntax;
}
