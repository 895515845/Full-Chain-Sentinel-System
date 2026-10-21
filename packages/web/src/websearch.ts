/**
 * The Tavily web-search client: /search, /extract and /usage.
 *
 * Like the asset-mapping platforms, the console calls Tavily itself over HTTPS
 * with the operator's key — the agent never holds the key and never shells out
 * to reach the API. Tavily is a general web search engine (not an asset
 * database), so it complements FOFA/Quake/Hunter: it answers "what is publicly
 * written about this target", not "what does the internet expose".
 *
 * The response shapes here were verified against the live API (2025-01):
 * /usage answers `{"key":{usage,limit,…},"account":{current_plan,plan_usage,
 * plan_limit,…}}`, where a `null` key limit means "no per-key cap beyond the
 * plan". Error codes: 401/403 bad key, 429 rate limit, 432 plan limit, 433 key
 * quota — the 4xx quota codes and 5xx are retryable on another key.
 */

import { t } from "./i18n.ts";
import type { SentinelTestResult } from "./protocol.ts";

/** Per-request ceiling. A search under load can take several seconds. */
const REQUEST_TIMEOUT_MS = 30_000;

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
export const TAVILY_USAGE_URL = "https://api.tavily.com/usage";

/** Injected for tests; the real console always uses the global fetch. */
export type WebFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class TavilyError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "TavilyError";
		this.retryable = retryable;
	}
}

/** One search hit, normalized. `content` is Tavily's page excerpt. */
export interface WebSearchHit {
	title: string;
	url: string;
	content: string;
	score: number;
	publishedDate: string;
}

export interface WebSearchResult {
	query: string;
	answer?: string;
	results: WebSearchHit[];
	raw: unknown;
	latencyMs: number;
	/** The key id that served the call, so the tool can report pool rotation. */
	keyId: string;
}

export interface WebSearchOptions {
	key: string;
	keyId: string;
	query: string;
	maxResults?: number;
	depth?: "basic" | "advanced";
	topic?: "general" | "news";
	days?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	searchUrl?: string;
	fetchImpl?: WebFetch;
	signal?: AbortSignal;
}

export interface WebExtractResult {
	urls: string[];
	/** One entry per URL that came back, clipped later by the tool. */
	pages: Array<{ url: string; content: string }>;
	failed: Array<{ url: string; error: string }>;
	raw: unknown;
	latencyMs: number;
	keyId: string;
}

export interface WebExtractOptions {
	key: string;
	keyId: string;
	urls: string[];
	depth?: "basic" | "advanced";
	extractUrl?: string;
	fetchImpl?: WebFetch;
	signal?: AbortSignal;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** One HTTP call with the request timeout combined with the caller's abort. */
async function request(
	fetchImpl: WebFetch,
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
		if (signal?.aborted) throw new TavilyError(t("已取消"), false);
		const reason = timeout.aborted
			? t("请求超时（{seconds} 秒）", { seconds: REQUEST_TIMEOUT_MS / 1000 })
			: t("网络错误");
		const detail = error instanceof Error ? error.message : String(error);
		throw new TavilyError(t("{reason}：{detail}", { reason, detail }), true);
	}
	const body = await response.text().catch(() => "");
	return { status: response.status, body };
}

function parseJson(body: string, status: number): Record<string, unknown> {
	if (!body.trim()) {
		throw new TavilyError(t("接口返回空响应（HTTP {status}）", { status }), status >= 500 || status === 429);
	}
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
	} catch {
		// fall through to the status-based message
	}
	throw new TavilyError(
		t("接口返回的不是 JSON（HTTP {status}）：{body}", { status, body: body.slice(0, 120) }),
		status >= 500,
	);
}

/** Map an HTTP failure to a Chinese message; quota codes retry on another key. */
function httpError(status: number): TavilyError {
	if (status === 401 || status === 403) return new TavilyError(t("API Key 无效或已过期（HTTP 401）"), false);
	if (status === 429) return new TavilyError(t("请求过于频繁（HTTP 429）"), true);
	if (status === 432) return new TavilyError(t("套餐额度已用尽（HTTP 432）"), true);
	if (status === 433) return new TavilyError(t("该 Key 的搜索额度已用尽（HTTP 433）"), true);
	return new TavilyError(t("接口错误（HTTP {status}）", { status }), status >= 500);
}

function clampMaxResults(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.min(Math.max(Math.round(value), 1), 20);
}

function cleanDomains(value: string[] | undefined): string[] {
	return (value ?? []).map((domain) => domain.trim()).filter((domain) => domain.length > 0);
}

export async function searchWeb(options: WebSearchOptions): Promise<WebSearchResult> {
	const started = Date.now();
	const { status, body } = await request(
		options.fetchImpl ?? fetch,
		options.searchUrl ?? TAVILY_SEARCH_URL,
		{
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${options.key}` },
			body: JSON.stringify({
				query: options.query,
				max_results: clampMaxResults(options.maxResults),
				search_depth: options.depth === "advanced" ? "advanced" : "basic",
				topic: options.topic === "news" ? "news" : "general",
				...(options.topic === "news" && typeof options.days === "number" ? { days: Math.round(options.days) } : {}),
				...(cleanDomains(options.includeDomains).length > 0
					? { include_domains: cleanDomains(options.includeDomains) }
					: {}),
				...(cleanDomains(options.excludeDomains).length > 0
					? { exclude_domains: cleanDomains(options.excludeDomains) }
					: {}),
			}),
		},
		options.signal,
	);
	if (status !== 200) throw httpError(status);
	const data = parseJson(body, status);
	const rows = Array.isArray(data.results) ? data.results : [];
	const results = rows.map((row) => {
		const hit = (row ?? {}) as Record<string, unknown>;
		return {
			title: text(hit.title),
			url: text(hit.url),
			content: text(hit.content),
			score: typeof hit.score === "number" ? hit.score : 0,
			publishedDate: text(hit.published_date),
		};
	});
	const answer = text(data.answer);
	return {
		query: text(data.query) || options.query,
		...(answer ? { answer } : {}),
		results,
		raw: data,
		latencyMs: Date.now() - started,
		keyId: options.keyId,
	};
}

export async function extractWeb(options: WebExtractOptions): Promise<WebExtractResult> {
	const urls = options.urls
		.map((url) => url.trim())
		.filter((url) => /^https?:\/\//i.test(url))
		.slice(0, 10);
	if (urls.length === 0) throw new TavilyError(t("urls 必须是 1-10 个 http(s) 地址"), false);
	const started = Date.now();
	const { status, body } = await request(
		options.fetchImpl ?? fetch,
		options.extractUrl ?? TAVILY_EXTRACT_URL,
		{
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${options.key}` },
			body: JSON.stringify({ urls, extract_depth: options.depth === "advanced" ? "advanced" : "basic" }),
		},
		options.signal,
	);
	if (status !== 200) throw httpError(status);
	const data = parseJson(body, status);
	const pages: Array<{ url: string; content: string }> = [];
	for (const row of Array.isArray(data.results) ? data.results : []) {
		const hit = (row ?? {}) as Record<string, unknown>;
		const url = text(hit.url);
		const content = text(hit.raw_content);
		if (url && content) pages.push({ url, content });
	}
	const failed: Array<{ url: string; error: string }> = [];
	for (const row of Array.isArray(data.failed_results) ? data.failed_results : []) {
		const hit = (row ?? {}) as Record<string, unknown>;
		const url = text(hit.url);
		if (url) failed.push({ url, error: text(hit.error) || t("抓取失败") });
	}
	return { urls, pages, failed, raw: data, latencyMs: Date.now() - started, keyId: options.keyId };
}

/** What /usage reports for one key, normalized. */
export interface TavilyKeyUsage {
	plan: string;
	/** Credits used / cap; `null` limit means unlimited. */
	keyUsed: number;
	keyLimit: number | null;
	planUsed: number;
	planLimit: number | null;
}

export interface TavilyUsageOptions {
	key: string;
	usageUrl?: string;
	fetchImpl?: WebFetch;
	signal?: AbortSignal;
}

export async function tavilyUsage(options: TavilyUsageOptions): Promise<TavilyKeyUsage> {
	const { status, body } = await request(
		options.fetchImpl ?? fetch,
		options.usageUrl ?? TAVILY_USAGE_URL,
		{ method: "GET", headers: { authorization: `Bearer ${options.key}` } },
		options.signal,
	);
	if (status !== 200) throw httpError(status);
	const data = parseJson(body, status);
	const key = (data.key ?? {}) as Record<string, unknown>;
	const account = (data.account ?? {}) as Record<string, unknown>;
	const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	const asLimit = (value: unknown): number | null =>
		typeof value === "number" && Number.isFinite(value) ? value : null;
	return {
		plan: text(account.current_plan) || t("未知套餐"),
		keyUsed: asNumber(key.usage),
		keyLimit: asLimit(key.limit),
		planUsed: asNumber(account.plan_usage),
		planLimit: asLimit(account.plan_limit),
	};
}

/**
 * Credits left for one key: the tighter of the key's own cap and the plan cap.
 * A null cap on both sides reads as unlimited, which the pool sorts last among
 * equals but treats as usable.
 */
export function usageRemaining(usage: TavilyKeyUsage): number | null {
	const keyLeft = usage.keyLimit === null ? null : Math.max(0, usage.keyLimit - usage.keyUsed);
	const planLeft = usage.planLimit === null ? null : Math.max(0, usage.planLimit - usage.planUsed);
	if (keyLeft === null && planLeft === null) return null;
	if (keyLeft === null) return planLeft;
	if (planLeft === null) return keyLeft;
	return Math.min(keyLeft, planLeft);
}

/** Probe one key: does it work, and what does the account have left. */
export async function probeTavilyKey(
	options: TavilyUsageOptions,
): Promise<SentinelTestResult & { usage?: TavilyKeyUsage }> {
	const usage = await tavilyUsage(options);
	const left = usageRemaining(usage);
	const quota = `${t("套餐 {plan} · 本套餐已用 {used}", { plan: usage.plan, used: usage.planUsed })}${
		usage.planLimit === null ? "" : ` / ${usage.planLimit}`
	}${left === null ? "" : t(" · 剩余 {left}", { left })}`;
	return { ok: true, message: t("Tavily 连接正常（{quota}）", { quota }), usage };
}
