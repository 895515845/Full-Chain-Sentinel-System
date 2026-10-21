/**
 * Unit tests for the three platform clients.
 *
 * A local HTTP server plays FOFA, Quake and Hunter, so the request shape (which
 * parameter carries the query, how it is encoded, which header carries the
 * token), the response mapping, the error translation, the retry and the
 * per-platform serialization are all pinned without spending a real query.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
	AssetPlatformError,
	assetEndpoint,
	clampPage,
	encodeFofaQuery,
	encodeHunterQuery,
	FOFA_FIELDS,
	HUNTER_PAGE_SIZES,
	hunterPageSize,
	MAX_BANNER_CHARS,
	probeAssetPlatform,
	searchAssets,
} from "../src/asset-platforms.ts";

interface Seen {
	url: string;
	method: string;
	token: string | undefined;
	body: string;
}

let server: Server;
let base = "";
let seen: Seen[] = [];
/** Concurrency the server is currently serving, and the high-water mark. */
let inFlight = 0;
let maxInFlight = 0;
/** Answers handed out per path, popped in order; the last one repeats. */
let scripted: Record<string, Array<{ status?: number; body: string; contentType?: string }>> = {};

function json(value: unknown): string {
	return JSON.stringify(value);
}

function nextAnswer(path: string): { status: number; body: string; contentType: string } {
	const queue = scripted[path];
	const entry = queue && queue.length > 1 ? queue.shift() : queue?.[0];
	if (!entry) return { status: 404, body: "not found", contentType: "text/plain" };
	return { status: entry.status ?? 200, body: entry.body, contentType: entry.contentType ?? "application/json" };
}

beforeAll(async () => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const path = (req.url ?? "").split("?")[0];
			seen.push({
				url: req.url ?? "",
				method: req.method ?? "",
				token: req.headers["x-quaketoken"] as string | undefined,
				body,
			});
			const answer = nextAnswer(path);
			// A small delay so overlapping requests would actually overlap.
			setTimeout(() => {
				inFlight -= 1;
				res.writeHead(answer.status, { "content-type": answer.contentType });
				res.end(answer.body);
			}, 15);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reset(script: Record<string, Array<{ status?: number; body: string; contentType?: string }>>): void {
	seen = [];
	scripted = script;
	maxInFlight = 0;
}

function queryOf(request: Seen): URLSearchParams {
	return new URL(`http://x${request.url}`).searchParams;
}

test("encodeFofaQuery uses standard base64 and encodeHunterQuery uses unpadded base64url", () => {
	// A query with characters that differ between the two alphabets.
	const query = 'title="a b" && body="??>>"';
	expect(encodeFofaQuery(query)).toBe(Buffer.from(query, "utf8").toString("base64"));
	const hunter = encodeHunterQuery(query);
	expect(hunter).not.toContain("=");
	expect(hunter).not.toContain("+");
	expect(hunter).not.toContain("/");
	expect(Buffer.from(hunter, "base64url").toString("utf8")).toBe(query);
	// The two encodings really are different: this is the bug a shared helper caused.
	expect(encodeFofaQuery(query)).not.toBe(hunter);
});

test("assetEndpoint appends the platform path under a custom base prefix", () => {
	expect(assetEndpoint("https://fofa.info/api/v1/search/all", "https://proxy.example/fofa/")).toBe(
		"https://proxy.example/fofa/api/v1/search/all",
	);
	expect(assetEndpoint("https://quake.360.net/api/v3/user/info", "https://proxy.example")).toBe(
		"https://proxy.example/api/v3/user/info",
	);
	// No custom value means the official endpoint, unchanged.
	expect(assetEndpoint("https://hunter.qianxin.com/openApi/search", "")).toBe(
		"https://hunter.qianxin.com/openApi/search",
	);
});

test("clampPage keeps a page at 1 or more and a size within the ceiling", () => {
	expect(clampPage(undefined, undefined)).toEqual({ page: 1, size: 20 });
	expect(clampPage(0, 0)).toEqual({ page: 1, size: 1 });
	expect(clampPage(3, 500)).toEqual({ page: 3, size: 100 });
	expect(clampPage(2.9, 10.4)).toEqual({ page: 2, size: 10 });
});

test("hunterPageSize rounds up to a size Hunter accepts", () => {
	// Verified against the live API: page_size=5 answers 400 页大小不合法.
	expect(HUNTER_PAGE_SIZES).toEqual([1, 10, 20, 50, 100]);
	expect(hunterPageSize(1)).toBe(1);
	expect(hunterPageSize(3)).toBe(10);
	expect(hunterPageSize(10)).toBe(10);
	expect(hunterPageSize(11)).toBe(20);
	expect(hunterPageSize(100)).toBe(100);
	expect(hunterPageSize(5000)).toBe(100);
});

test("Hunter's snapped page size is what the request and the result both use", async () => {
	reset({
		"/hunter": [
			{
				body: json({
					code: 200,
					message: "success",
					data: { total: 26, rest_quota: 499, consume_quota: 1, arr: [{ ip: "1.1.1.1", port: 80 }] },
				}),
			},
		],
	});
	const result = await searchAssets({
		platform: "hunter",
		key: "k",
		query: "x",
		size: 3,
		searchUrl: `${base}/hunter`,
	});
	expect(queryOf(seen[0]).get("page_size")).toBe("10");
	expect(result.size).toBe(10);
});

test("a banner longer than the ceiling is clipped for the model", async () => {
	reset({
		"/quake": [
			{
				body: json({
					code: 0,
					data: [
						{
							ip: "1.1.1.1",
							port: 80,
							location: {},
							service: { response: `HTTP/1.1 200 OK\r\n${"X-Pad: filler\r\n".repeat(60)}` },
						},
					],
					meta: { pagination: { total: 1 } },
				}),
			},
		],
	});
	const result = await searchAssets({ platform: "quake", key: "t", query: "x", searchUrl: `${base}/quake` });
	const banner = result.records[0].banner;
	expect(banner).toContain("已截断");
	expect(banner.length).toBeLessThan(MAX_BANNER_CHARS + 20);
	// CRLF is normalized, so the model never sees stray carriage returns.
	expect(banner).not.toContain("\r");
	// The full text is still in the raw response that goes to the evidence file.
	expect(JSON.stringify(result.raw)).toContain("filler");
});

test("FOFA sends the query as standard base64 and maps the positional fields", async () => {
	reset({
		"/fofa": [
			{
				body: json({
					error: false,
					size: 67742,
					page: 1,
					results: [
						[
							"https://a.example.com",
							"1.1.1.1",
							"443",
							"example.com",
							"后台",
							"nginx",
							"https",
							"CN",
							"北京",
							"北京",
							"示例公司",
							"Linux",
							"2026-01-01",
						],
						["b.example.com", "2.2.2.2", "80", "example.com", "", "", "http", "", "", "", "", "", ""],
					],
					consumed_fpoint: 0,
				}),
			},
		],
	});
	const result = await searchAssets({ platform: "fofa", key: "k", query: 'ip="1.1.1.1"', searchUrl: `${base}/fofa` });
	const request = seen[0];
	const params = queryOf(request);
	expect(request.method).toBe("GET");
	expect(params.get("key")).toBe("k");
	expect(params.get("qbase64")).toBe(encodeFofaQuery('ip="1.1.1.1"'));
	expect(params.get("fields")).toBe(FOFA_FIELDS.join(","));
	expect(params.get("size")).toBe("20");
	expect(params.get("page")).toBe("1");
	expect(result.total).toBe(67742);
	expect(result.records[0]).toMatchObject({
		host: "https://a.example.com",
		ip: "1.1.1.1",
		port: 443,
		domain: "example.com",
		title: "后台",
		server: "nginx",
		protocol: "https",
		country: "CN",
		org: "示例公司",
		os: "Linux",
		updatedAt: "2026-01-01",
		// A full URL in `host` is also the url; a bare hostname is not.
		url: "https://a.example.com",
	});
	expect(result.records[1]).toMatchObject({ url: "", port: 80 });
	expect(result.quota).toBe("本次消耗 0 F 点");
});

test("a custom base URL prefixes the platform's API path", async () => {
	reset({
		"/proxy/fofa/api/v1/search/all": [
			{
				body: json({
					error: false,
					size: 1,
					page: 1,
					results: [
						[
							"a.example.com",
							"1.1.1.1",
							"443",
							"example.com",
							"",
							"a",
							"https",
							"",
							"",
							"",
							"CN",
							"北京",
							"北京",
						],
					],
					consumed_fpoint: 0,
				}),
			},
		],
	});
	await searchAssets({
		platform: "fofa",
		key: "k",
		query: 'ip="1.1.1.1"',
		baseUrl: `${base}/proxy/fofa`,
	});
	expect(seen[0].url).toContain("/proxy/fofa/api/v1/search/all");
});

test("the custom base URL applies to all three search clients", async () => {
	reset({
		"/proxy/fofa/api/v1/search/all": [{ body: json({ error: false, size: 0, results: [] }) }],
		"/proxy/quake/api/v3/search/quake_service": [
			{ body: json({ code: 0, data: [], meta: { pagination: { total: 0 } } }) },
		],
		"/proxy/hunter/openApi/search": [{ body: json({ code: 200, data: { total: 0, arr: [] } }) }],
	});
	for (const platform of ["fofa", "quake", "hunter"] as const) {
		await searchAssets({
			platform,
			key: "k",
			query: "x",
			baseUrl: `${base}/proxy/${platform}`,
		});
	}
	expect(seen.map((request) => new URL(`http://x${request.url}`).pathname)).toEqual([
		"/proxy/fofa/api/v1/search/all",
		"/proxy/quake/api/v3/search/quake_service",
		"/proxy/hunter/openApi/search",
	]);
});

test("FOFA turns error:true into the platform's own message", async () => {
	reset({ "/fofa": [{ body: json({ error: true, errmsg: "[-700] 账号无效" }) }] });
	await expect(searchAssets({ platform: "fofa", key: "bad", query: "x", searchUrl: `${base}/fofa` })).rejects.toThrow(
		"[-700] 账号无效",
	);
});

test("Quake posts the query with the token header and maps location, service and components", async () => {
	reset({
		"/quake": [
			{
				body: json({
					code: 0,
					message: "Successful.",
					data: [
						{
							ip: "1.1.1.1",
							port: 80,
							hostname: "one.one.one.one",
							domain: "example.com",
							org: "",
							transport: "tcp",
							time: "2026-10-16T07:29:19.064Z",
							location: {
								country_en: "United States",
								country_cn: "美国",
								province_cn: "",
								city_cn: "",
								isp: "Cloudflare, Inc.",
							},
							service: { name: "http", response: "HTTP/1.1 409 Conflict\r\nServer: cloudflare\r\n" },
							components: [],
						},
					],
					meta: { pagination: { total: 705369 } },
				}),
			},
		],
	});
	const result = await searchAssets({
		platform: "quake",
		key: "tok",
		query: 'ip:"1.1.1.1"',
		page: 3,
		size: 10,
		searchUrl: `${base}/quake`,
	});
	const request = seen[0];
	expect(request.method).toBe("POST");
	expect(request.token).toBe("tok");
	expect(JSON.parse(request.body)).toEqual({ query: 'ip:"1.1.1.1"', start: 20, size: 10 });
	expect(result.total).toBe(705369);
	expect(result.records[0]).toMatchObject({
		ip: "1.1.1.1",
		port: 80,
		host: "one.one.one.one",
		domain: "example.com",
		protocol: "tcp",
		// location.isp fills in when org is empty, and the Chinese name wins.
		org: "Cloudflare, Inc.",
		country: "美国",
		server: "http",
		updatedAt: "2026-10-16T07:29:19.064Z",
	});
	expect(result.records[0].banner).toContain("Server: cloudflare");
});

test("Quake falls back to the component name when the service has none", async () => {
	reset({
		"/quake": [
			{
				body: json({
					code: 0,
					data: [
						{
							ip: "3.3.3.3",
							port: 8080,
							location: {},
							service: {},
							components: [{ product_name_cn: "宝塔面板" }],
						},
					],
					meta: { pagination: { total: 1 } },
				}),
			},
		],
	});
	const result = await searchAssets({ platform: "quake", key: "tok", query: "x", searchUrl: `${base}/quake` });
	expect(result.records[0].server).toBe("宝塔面板");
	expect(result.total).toBe(1);
});

test("Quake answers a bad token with a login redirect, which is not retried", async () => {
	reset({ "/quake": [{ status: 401, body: "/quake/login", contentType: "text/plain" }] });
	const error = await searchAssets({ platform: "quake", key: "bad", query: "x", searchUrl: `${base}/quake` }).catch(
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(AssetPlatformError);
	expect((error as AssetPlatformError).retryable).toBe(false);
	expect((error as Error).message).toContain("令牌无效或已过期");
	expect(seen.length).toBe(1);
});

test("Quake retries the q3005 rate-limit answer once and returns the second response", async () => {
	reset({
		"/quake": [
			{ body: json({ code: "q3005", message: "调用API过于频繁" }) },
			{
				body: json({
					code: 0,
					data: [{ ip: "4.4.4.4", port: 22, location: {}, service: {} }],
					meta: { pagination: { total: 1 } },
				}),
			},
		],
	});
	const result = await searchAssets({ platform: "quake", key: "tok", query: "x", searchUrl: `${base}/quake` });
	expect(seen.length).toBe(2);
	expect(result.records[0].ip).toBe("4.4.4.4");
});

test("Hunter sends the query as unpadded base64url and maps its own field names", async () => {
	reset({
		"/hunter": [
			{
				body: json({
					code: 200,
					message: "success",
					data: {
						total: 42,
						consume_quota: 1,
						rest_quota: 499,
						syntax_prompt: ['ip 语法：ip="1.1.1.1"', "domain 语法", "port 语法", "ignored"],
						arr: [
							{
								ip: "1.1.1.1",
								port: 8880,
								domain: "",
								url: "http://1.1.1.1:8880",
								web_title: "301 Moved Permanently",
								header_server: "cloudflare",
								protocol: "http",
								os: "",
								company: "",
								isp: "Cloudflare, Inc.",
								as_org: "CLOUDFLARENET",
								country: "美国",
								province: "",
								city: "",
								updated_at: "2026-10-16",
								banner: "HTTP/1.1 400 Bad Request Server: cloudflare",
							},
						],
					},
				}),
			},
		],
	});
	const result = await searchAssets({
		platform: "hunter",
		key: "k",
		query: 'ip="1.1.1.1"',
		searchUrl: `${base}/hunter`,
	});
	const params = queryOf(seen[0]);
	expect(params.get("api-key")).toBe("k");
	expect(params.get("search")).toBe(encodeHunterQuery('ip="1.1.1.1"'));
	expect(params.get("page_size")).toBe("20");
	expect(params.get("is_web")).toBe("1");
	expect(result.total).toBe(42);
	expect(result.records[0]).toMatchObject({
		ip: "1.1.1.1",
		port: 8880,
		url: "http://1.1.1.1:8880",
		title: "301 Moved Permanently",
		server: "cloudflare",
		// company is empty, so isp fills in and as_org is the last resort.
		org: "Cloudflare, Inc.",
		country: "美国",
	});
	expect(result.records[0].host).toBe("1.1.1.1");
	expect(result.quota).toBe("本次消耗 1 点，剩余 499 点");
	// Only the first three hints are kept; the raw response holds the rest.
	expect(result.syntaxHint).toBe('ip 语法：ip="1.1.1.1"；domain 语法；port 语法');
});

test("Hunter reports a rejected key with its code", async () => {
	reset({ "/hunter": [{ body: json({ code: 401, data: null, message: "令牌过期" }) }] });
	await expect(
		searchAssets({ platform: "hunter", key: "bad", query: "x", searchUrl: `${base}/hunter` }),
	).rejects.toThrow("令牌过期（code 401）");
});

test("calls to one platform are serialized, so a burst cannot trip its rate limit", async () => {
	reset({
		"/quake": [
			{
				body: json({
					code: 0,
					data: [{ ip: "1.1.1.1", port: 80, location: {}, service: {} }],
					meta: { pagination: { total: 1 } },
				}),
			},
		],
	});
	await Promise.all([
		searchAssets({ platform: "quake", key: "t", query: "a", searchUrl: `${base}/quake` }),
		searchAssets({ platform: "quake", key: "t", query: "b", searchUrl: `${base}/quake` }),
		searchAssets({ platform: "quake", key: "t", query: "c", searchUrl: `${base}/quake` }),
	]);
	expect(seen.length).toBe(3);
	expect(maxInFlight).toBe(1);
});

test("probe reads each platform's own quota fields", async () => {
	reset({
		"/fofa-account": [
			{ body: json({ error: false, remain_free_point: 5000, fofa_point: 1775, isvip: true, vip_level: 2 }) },
		],
		"/quake-account": [
			{ body: json({ code: 0, data: { month_remaining_credit: 39366, credit: 39366, baned: false } }) },
		],
		"/hunter-account": [
			{ body: json({ code: 200, data: { rest_free_point: 499, day_free_point: 500, rest_equity_point: 2932 } }) },
		],
	});
	const fofa = await probeAssetPlatform({ platform: "fofa", key: "k", accountUrl: `${base}/fofa-account` });
	expect(fofa.ok).toBe(true);
	expect(fofa.quota).toBe("免费点 5000 · F 点 1775 · VIP2");
	const quake = await probeAssetPlatform({ platform: "quake", key: "k", accountUrl: `${base}/quake-account` });
	expect(quake.message).toContain("本月剩余额度 39366 点");
	const hunter = await probeAssetPlatform({ platform: "hunter", key: "k", accountUrl: `${base}/hunter-account` });
	expect(hunter.message).toContain("免费点 499 / 每日 500");
});

test("a probe sends the account request under the custom base URL", async () => {
	reset({
		"/proxy/hunter/openApi/userInfo": [
			{ body: json({ code: 200, data: { rest_free_point: 499, day_free_point: 500 } }) },
		],
	});
	const result = await probeAssetPlatform({
		platform: "hunter",
		key: "k",
		baseUrl: `${base}/proxy/hunter`,
	});
	expect(result.ok).toBe(true);
	expect(seen[0].url).toContain("/proxy/hunter/openApi/userInfo");
});

test("probe reports a banned Quake account and a rejected key as failures", async () => {
	reset({
		"/quake-account": [{ body: json({ code: 0, data: { baned: true, ban_status: "违规调用" } }) }],
		"/fofa-account": [{ body: json({ error: true, errmsg: "[-700] 账号无效" }) }],
	});
	const banned = await probeAssetPlatform({ platform: "quake", key: "k", accountUrl: `${base}/quake-account` });
	expect(banned.ok).toBe(false);
	expect(banned.message).toContain("违规调用");
	await expect(
		probeAssetPlatform({ platform: "fofa", key: "bad", accountUrl: `${base}/fofa-account` }),
	).rejects.toThrow("[-700] 账号无效");
});
