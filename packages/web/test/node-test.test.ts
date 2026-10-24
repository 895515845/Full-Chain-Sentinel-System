/**
 * Batch latency test and scheduled refresh.
 *
 * Two things are pinned here. First, that the measurement is *through* each node
 * rather than a socket connect — that is the whole point of the feature, and the
 * Clash API's delay endpoint is what makes it possible. Second, that the timer
 * refreshes only what is due, keeps the previous nodes when a provider is down,
 * and never touches a profile that has no schedule.
 *
 * Docker is not involved: `measureNodes` is what talks to a container, and the
 * tests inject a stand-in so the bookkeeping can be checked on its own.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildTestConfig } from "../src/node-test.ts";
import type { SentinelProxyNode } from "../src/protocol.ts";
import { proxiesPath, readProxies, saveProxy, testProxyNodes } from "../src/proxy.ts";
import { dueSubscriptions, normalizeIntervalHours, SubscriptionScheduler } from "../src/subscription-scheduler.ts";

const roots: string[] = [];

function setup(): string {
	const root = mkdtempSync(join(tmpdir(), "sentinel-node-test-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nodes(): SentinelProxyNode[] {
	return [
		{
			tag: "香港",
			name: "香港",
			protocol: "trojan",
			outbound: { type: "trojan", tag: "香港", server: "a", server_port: 1 },
		},
		{
			tag: "日本",
			name: "日本",
			protocol: "trojan",
			outbound: { type: "trojan", tag: "日本", server: "b", server_port: 2 },
		},
	];
}

/** Seed a subscription profile with cached nodes, the way a read would. */
function subscriptionProfile(agentDir: string, options: { intervalHours?: number; updatedAt?: number } = {}): string {
	const saved = saveProxy(agentDir, {
		name: "机场",
		mode: "subscription",
		subscriptionUrl: "https://example.com/sub",
		subscriptionUserAgent: "sing-box",
		subscriptionIntervalHours: options.intervalHours ?? 0,
		nodeTag: "香港",
		simple: { type: "socks5", server: "", port: 0, username: "", password: "", tls: false },
		outbound: "",
		routePrivateDirect: true,
	});
	if (!saved.proxy) throw new Error(saved.error ?? "未保存");
	const file = readProxies(agentDir);
	writeFileSync(
		proxiesPath(agentDir),
		JSON.stringify({
			...file,
			proxies: file.proxies.map((entry) => ({
				...entry,
				nodes: nodes(),
				subscription: { ...entry.subscription!, updatedAt: options.updatedAt ?? Date.now() },
			})),
		}),
		{ mode: 0o600 },
	);
	return saved.proxy.id;
}

test("the test configuration carries every node plus the API", () => {
	const config = JSON.parse(buildTestConfig(nodes(), 12345)) as {
		experimental: { clash_api: { external_controller: string } };
		outbounds: Array<Record<string, unknown>>;
	};
	// The API is what measures per outbound; without it there is nothing to ask.
	expect(config.experimental.clash_api.external_controller).toBe("0.0.0.0:12345");
	expect(config.outbounds.map((entry) => entry.tag)).toEqual(["香港", "日本", "direct"]);
	// No tun, no route rules: nothing is intercepted, the API dials on request.
	expect(config).not.toHaveProperty("inbounds");
});

test("measuring stores each node's round trip and remembers the URL", async () => {
	const agentDir = setup();
	const id = subscriptionProfile(agentDir);
	const asked: { url?: string; tags: string[] } = { tags: [] };
	const tested = await testProxyNodes(agentDir, id, "https://example.org/generate_204", async (list, options) => {
		asked.url = options.url;
		asked.tags = list.map((node) => node.tag);
		return {
			latencies: new Map([
				["香港", 42],
				["日本", null],
			]),
		};
	});
	expect(tested.error).toBeUndefined();
	expect(asked.url).toBe("https://example.org/generate_204");
	expect(asked.tags).toEqual(["香港", "日本"]);
	// A node that timed out keeps a null: "tested and failed" is not "untested".
	const stored = readProxies(agentDir).proxies.find((entry) => entry.id === id);
	expect(stored?.nodes.map((node) => node.latencyMs)).toEqual([42, null]);
	expect(stored?.nodes.every((node) => typeof node.testedAt === "number")).toBe(true);
	expect(readProxies(agentDir).testUrl).toBe("https://example.org/generate_204");
});

test("a failed test reports why and leaves the nodes alone", async () => {
	const agentDir = setup();
	const id = subscriptionProfile(agentDir);
	const tested = await testProxyNodes(agentDir, id, "", async () => ({ error: "代理镜像不存在" }));
	expect(tested.error).toContain("镜像");
	const stored = readProxies(agentDir).proxies.find((entry) => entry.id === id);
	expect(stored?.nodes.every((node) => node.latencyMs === undefined)).toBe(true);
});

test("only subscription profiles with a schedule are due", () => {
	const now = 1_700_000_000_000;
	const profile = (over: Record<string, unknown>) =>
		({
			id: "p",
			name: "p",
			mode: "subscription",
			simple: { type: "socks5", server: "", port: 0, username: "", password: "", tls: false },
			outbound: "",
			nodes: [],
			nodeTag: "",
			skipped: [],
			routePrivateDirect: true,
			createdAt: 0,
			subscription: {
				url: "https://example.com/sub",
				userAgent: "sing-box",
				updatedAt: now,
				error: null,
				intervalHours: 6,
				...over,
			},
			...over,
		}) as never;

	expect(dueSubscriptions([profile({})], now + 3600_000)).toHaveLength(0);
	expect(dueSubscriptions([profile({})], now + 6 * 3600_000)).toHaveLength(1);
	// Off means off.
	expect(dueSubscriptions([profile({ intervalHours: 0 })], now + 100 * 3600_000)).toHaveLength(0);
	// A profile that is not a subscription has nothing to refresh.
	expect(dueSubscriptions([profile({ mode: "simple" })], now + 100 * 3600_000)).toHaveLength(0);
});

test("the interval is clamped to what the timer can act on", () => {
	expect(normalizeIntervalHours(6)).toBe(6);
	expect(normalizeIntervalHours("6")).toBe(0);
	expect(normalizeIntervalHours(7)).toBe(0);
	expect(normalizeIntervalHours(-1)).toBe(0);
	expect(normalizeIntervalHours(undefined)).toBe(0);
});

test("the interval survives a save and shows up in the stored profile", () => {
	const agentDir = setup();
	const id = subscriptionProfile(agentDir, { intervalHours: 12 });
	expect(readProxies(agentDir).proxies.find((entry) => entry.id === id)?.subscription?.intervalHours).toBe(12);
	// Re-saving without touching the schedule keeps it.
	const saved = saveProxy(agentDir, {
		id,
		name: "机场改名",
		mode: "subscription",
		subscriptionUrl: "https://example.com/sub",
		subscriptionUserAgent: "sing-box",
		subscriptionIntervalHours: 12,
		nodeTag: "香港",
		simple: { type: "socks5", server: "", port: 0, username: "", password: "", tls: false },
		outbound: "",
		routePrivateDirect: true,
	});
	expect(saved.proxy?.subscription?.intervalHours).toBe(12);
	// And the cached nodes survive the rename, because the URL did not change.
	expect(saved.proxy?.nodes).toHaveLength(2);
	expect(JSON.parse(readFileSync(proxiesPath(agentDir), "utf-8")).proxies[0].name).toBe("机场改名");
});

test("a due subscription is refreshed by the tick, and the page is told once", async () => {
	const agentDir = setup();
	// A provider serving two nodes in the envelope providers actually use.
	const links = [
		`ss://${Buffer.from("aes-256-gcm:pw").toString("base64url")}@1.1.1.1:8388#%E9%A6%99%E6%B8%AF`,
		"trojan://pw@2.2.2.2:443#tokyo",
	].join("\n");
	const server: Server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end(Buffer.from(links, "utf-8").toString("base64"));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("订阅服务器未启动");

	try {
		const id = subscriptionProfile(agentDir, { intervalHours: 6, updatedAt: Date.now() - 7 * 3600_000 });
		const file = readProxies(agentDir);
		writeFileSync(
			proxiesPath(agentDir),
			JSON.stringify({
				...file,
				proxies: file.proxies.map((entry) => ({
					...entry,
					subscription: { ...entry.subscription!, url: `http://127.0.0.1:${address.port}/sub` },
				})),
			}),
			{ mode: 0o600 },
		);

		let notified = 0;
		const scheduler = new SubscriptionScheduler(agentDir, () => {
			notified += 1;
		});
		expect(await scheduler.tick()).toBe(1);
		// The page is told once, not once per profile.
		expect(notified).toBe(1);
		const refreshed = readProxies(agentDir).proxies.find((entry) => entry.id === id);
		expect(refreshed?.nodes.map((node) => node.name)).toEqual(["香港", "tokyo"]);
		expect(refreshed?.subscription?.updatedAt).toBeGreaterThan(Date.now() - 60_000);

		// Not due again straight away.
		expect(await scheduler.tick()).toBe(0);
		expect(notified).toBe(1);
	} finally {
		server.close();
	}
});

test("a refresh that fails keeps the working nodes and records the error", async () => {
	const agentDir = setup();
	// Nothing listens on this port: the provider is down.
	const id = subscriptionProfile(agentDir, { intervalHours: 1, updatedAt: Date.now() - 2 * 3600_000 });
	const file = readProxies(agentDir);
	writeFileSync(
		proxiesPath(agentDir),
		JSON.stringify({
			...file,
			proxies: file.proxies.map((entry) => ({
				...entry,
				subscription: { ...entry.subscription!, url: "http://127.0.0.1:1/sub" },
			})),
		}),
		{ mode: 0o600 },
	);

	const scheduler = new SubscriptionScheduler(agentDir, () => {});
	expect(await scheduler.tick()).toBe(1);
	const after = readProxies(agentDir).proxies.find((entry) => entry.id === id);
	// The nodes that already work stay: a provider outage is not a console outage.
	expect(after?.nodes).toHaveLength(2);
	expect(after?.subscription?.error).toBeTruthy();
});
