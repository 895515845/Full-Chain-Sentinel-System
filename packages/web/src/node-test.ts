/**
 * Batch latency test: how long each node takes to fetch a URL.
 *
 * A TCP handshake to the node's port is cheap and nearly useless: it says the
 * host is reachable, not that the protocol, the cipher, the password or the
 * route work. What the operator wants to know is "does traffic through this node
 * reach the internet, and how fast", so the test does exactly that — every node
 * fetches a URL through its own outbound and the round trip is reported.
 *
 * The mechanism is sing-box's Clash API, which implements the delay endpoint:
 * `GET /proxies/<tag>/delay?url=...` makes sing-box send that request through
 * that outbound and answer with the elapsed milliseconds. That means one
 * throwaway container per batch instead of one per node, and the measurement
 * uses the same engine and the same configuration the sidecar will.
 *
 * The container is deliberately not attached to the console's proxy network: it
 * lives for a few seconds, publishes its API on the host's loopback only, and
 * shares nothing with the running sidecars.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { runDocker } from "./docker.ts";
import { t } from "./i18n.ts";
import type { SentinelProxyNode } from "./protocol.ts";

/** A 204 endpoint: nothing to download, so the number is the round trip. */
export const DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204";

/** Per node. Long enough for a slow mobile node, short enough to notice a dead one. */
export const DEFAULT_TEST_TIMEOUT_MS = 5000;

/** Nodes tested at once. The endpoint is I/O bound on the far side. */
export const DEFAULT_TEST_CONCURRENCY = 8;

/** How long the throwaway container gets to open its API. */
const STARTUP_TIMEOUT_MS = 12000;

export type NodeLatencies = Map<string, number | null>;

/** A free port on the host's loopback, for a Clash API. */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("no port"));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

async function waitForApi(port: number): Promise<boolean> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/version`, {
				signal: AbortSignal.timeout(1000),
			});
			if (response.ok) return true;
		} catch {
			// Not up yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

/** One node's round trip, or null when the request did not come back. */
async function measureOne(port: number, tag: string, url: string, timeoutMs: number): Promise<number | null> {
	const query = new URLSearchParams({ url, timeout: String(timeoutMs) });
	try {
		const response = await fetch(
			`http://127.0.0.1:${port}/proxies/${encodeURIComponent(tag)}/delay?${query.toString()}`,
			// The API answers when the node's own timeout expires; give it a margin so
			// a hung request cannot outlive the batch.
			{ signal: AbortSignal.timeout(timeoutMs + 3000) },
		);
		if (!response.ok) return null;
		const body = (await response.json()) as { delay?: unknown };
		return typeof body.delay === "number" && Number.isFinite(body.delay) ? body.delay : null;
	} catch {
		return null;
	}
}

/** Run `worker` over `items`, at most `limit` at a time, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index] as T);
		}
	});
	await Promise.all(runners);
	return results;
}

/**
 * The configuration the test container runs.
 *
 * No tun inbound and no route rules: nothing is intercepted, the API asks
 * sing-box to dial through one outbound at a time. `direct` is present because a
 * configuration needs somewhere for traffic that matches nothing to go.
 */
export function buildTestConfig(nodes: SentinelProxyNode[], port: number): string {
	const config = {
		log: { level: "warn" },
		experimental: { clash_api: { external_controller: `0.0.0.0:${port}` } },
		outbounds: [...nodes.map((node) => node.outbound), { type: "direct", tag: "direct" }],
	};
	return `${JSON.stringify(config, null, "\t")}\n`;
}

/**
 * Measure every node against `url`.
 *
 * Returns a map of tag to milliseconds (null for a node that failed) or an error
 * when the test could not run at all — a missing image, a container that will not
 * start. A node failing is a result, not an error.
 */
export async function measureNodes(
	nodes: SentinelProxyNode[],
	options: {
		image: string;
		agentDir: string;
		url?: string;
		timeoutMs?: number;
		concurrency?: number;
	},
): Promise<{ latencies?: NodeLatencies; error?: string }> {
	if (nodes.length === 0) return { error: t("订阅里没有节点") };
	const url = options.url?.trim() || DEFAULT_TEST_URL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
	const concurrency = options.concurrency ?? DEFAULT_TEST_CONCURRENCY;

	const port = await freePort();
	const container = `sentinel-nodetest-${randomUUID().slice(0, 8)}`;
	const configPath = join(options.agentDir, "proxy", ".nodetest.json");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, buildTestConfig(nodes, port), { mode: 0o600 });

	let started: { code: number; stderr: string } = { code: 1, stderr: "" };
	try {
		const result = await runDocker([
			"run",
			"-d",
			"--rm",
			"--name",
			container,
			// Loopback only: the API has no authentication, and nothing else needs it.
			"-p",
			`127.0.0.1:${port}:${port}`,
			"-v",
			`${configPath}:/etc/sing-box/config.json:ro`,
			"--entrypoint",
			"sh",
			options.image,
			"-c",
			"exec sing-box run -C /etc/sing-box",
		]);
		started = { code: result.code, stderr: result.stderr.trim() };
		if (result.code !== 0) {
			const missing = /Unable to find image|No such image/i.test(result.stderr);
			return {
				error: missing
					? t("代理镜像 {image} 不存在，先在「环境」页拉取", { image: options.image })
					: t("测速容器启动失败：{error}", { error: started.stderr || t("未知错误") }),
			};
		}
		if (!(await waitForApi(port))) {
			return { error: t("测速容器没有在 {seconds} 秒内就绪", { seconds: STARTUP_TIMEOUT_MS / 1000 }) };
		}
		const measured = await mapLimit(nodes, concurrency, (node) => measureOne(port, node.tag, url, timeoutMs));
		const latencies: NodeLatencies = new Map();
		for (const [index, node] of nodes.entries()) latencies.set(node.tag, measured[index] ?? null);
		return { latencies };
	} finally {
		await runDocker(["rm", "-f", container], { timeoutMs: 15000 });
		rmSync(configPath, { force: true });
	}
}
