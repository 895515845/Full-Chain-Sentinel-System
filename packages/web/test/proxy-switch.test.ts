/**
 * Switching a project's node on a running sidecar.
 *
 * The point of the feature is that no container is recreated, so what is pinned
 * here is the control path itself: the request goes to the right port with the
 * sidecar's secret, the choice is recorded either way, and a sidecar that is not
 * there is not treated as an error.
 *
 * The Clash API is stood in for by a local HTTP server, because the thing being
 * tested is the conversation, not sing-box.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { listProjects, setProjectProxy } from "../src/projects.ts";
import type { SentinelProxySettings } from "../src/protocol.ts";
import { AUTO_NODE_TAG, saveProxy } from "../src/proxy.ts";
import { switchableNode, switchProjectNode } from "../src/proxy-switch.ts";
import { readClashApi, writeProjectProxyConfig } from "../src/singbox.ts";

const roots: string[] = [];
const servers: Server[] = [];

function setup(): string {
	const root = mkdtempSync(join(tmpdir(), "sentinel-switch-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NODES = [
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

function settingsOf(overrides: Partial<SentinelProxySettings> = {}): SentinelProxySettings {
	return {
		mode: "subscription",
		simple: { type: "socks5", server: "", port: 0, username: "", password: "", tls: false },
		nodes: NODES,
		nodeTag: "香港",
		image: "",
		testUrl: "https://www.gstatic.com/generate_204",
		routePrivateDirect: true,
		...overrides,
	};
}

/** A subscription profile plus a project pointing at it. */
function projectWithProfile(agentDir: string): { projectId: string; proxyId: string } {
	const saved = saveProxy(agentDir, {
		name: "机场",
		mode: "subscription",
		subscriptionUrl: "https://example.com/sub",
		subscriptionUserAgent: "sing-box",
		subscriptionIntervalHours: 0,
		nodeTag: "香港",
		simple: { type: "socks5", server: "", port: 0, username: "", password: "", tls: false },
		routePrivateDirect: true,
	});
	if (!saved.proxy) throw new Error(saved.error ?? "未保存");
	const file = JSON.parse(JSON.stringify(saved.proxies)) as { proxies: Array<Record<string, unknown>> };
	file.proxies[0]!.nodes = NODES;
	writeFileSync(join(agentDir, "proxies.json"), JSON.stringify(file), { mode: 0o600 });

	// A project record is enough: the switch never touches the container.
	const projects = join(agentDir, "projects.json");
	writeFileSync(
		projects,
		JSON.stringify({
			projects: [
				{
					id: "p1",
					name: "靶场",
					workDir: join(agentDir, "work"),
					container: "sentinel-p1",
					proxyId: saved.proxy.id,
					createdAt: new Date().toISOString(),
				},
			],
			lastActiveProjectId: "p1",
		}),
		{ mode: 0o600 },
	);
	return { projectId: "p1", proxyId: saved.proxy.id };
}

/** A stand-in for the sidecar's Clash API; records what it was asked. */
async function fakeApi(options: { status?: number } = {}): Promise<{ port: number; calls: string[]; auth: string[] }> {
	const calls: string[] = [];
	const auth: string[] = [];
	const server = createServer((request, response) => {
		calls.push(`${request.method} ${request.url}`);
		auth.push(String(request.headers.authorization ?? ""));
		response.writeHead(options.status ?? 204).end();
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("API 未启动");
	return { port: address.port, calls, auth };
}

test("a node switch is a PUT to the sidecar's selector, with its secret", async () => {
	const agentDir = setup();
	const { projectId } = projectWithProfile(agentDir);
	const api = await fakeApi();
	// The configuration the sidecar was created with carries the port and secret.
	const written = await writeProjectProxyConfig(agentDir, projectId, settingsOf());
	expect(written.ok).toBe(true);
	const clash = readClashApi((written as { path: string }).path);
	expect(clash?.port).toBeGreaterThan(0);
	expect(clash?.secret).toMatch(/^[0-9a-f]{32}$/);
	// Point the config at the stand-in so the switch talks to it.
	writeFileSync(
		(written as { path: string }).path,
		JSON.stringify({
			experimental: { clash_api: { external_controller: `0.0.0.0:${api.port}`, secret: "s3cret" } },
			outbounds: [],
		}),
		{ mode: 0o600 },
	);

	const project = listProjects(agentDir).projects[0]!;
	const result = await switchProjectNode(agentDir, project, "日本", async () => ({
		port: api.port,
		secret: "s3cret",
	}));
	expect(result).toEqual({ applied: true });
	expect(api.calls).toEqual(["PUT /proxies/proxy"]);
	expect(api.auth[0]).toBe("Bearer s3cret");
});

test("a sidecar that is not running is not an error, the choice just waits", async () => {
	const agentDir = setup();
	const { projectId } = projectWithProfile(agentDir);
	const written = await writeProjectProxyConfig(agentDir, projectId, settingsOf());
	// Nothing listens on the port the configuration names.
	const clash = readClashApi((written as { path: string }).path);
	expect(clash).toBeDefined();
	const project = listProjects(agentDir).projects[0]!;
	// Docker answers nothing for a container that is not running.
	expect(await switchProjectNode(agentDir, project, "日本", async () => undefined)).toEqual({ applied: false });
});

test("a sidecar that answers 400 means the tag is unknown, which is worth reporting", async () => {
	const agentDir = setup();
	const { projectId } = projectWithProfile(agentDir);
	const api = await fakeApi({ status: 400 });
	const written = await writeProjectProxyConfig(agentDir, projectId, settingsOf());
	writeFileSync(
		(written as { path: string }).path,
		JSON.stringify({
			experimental: { clash_api: { external_controller: `0.0.0.0:${api.port}`, secret: "s3cret" } },
			outbounds: [],
		}),
		{ mode: 0o600 },
	);
	const project = listProjects(agentDir).projects[0]!;
	const result = await switchProjectNode(agentDir, project, "日本", async () => ({
		port: api.port,
		secret: "s3cret",
	}));
	expect(result.applied).toBe(false);
	expect(result.error).toContain("不认识");
});

test("only a subscription with more than one choice can switch", async () => {
	const agentDir = setup();
	const { projectId } = projectWithProfile(agentDir);
	// A profile with a single exit has nothing to switch between.
	const simple = saveProxy(agentDir, {
		name: "本机",
		mode: "simple",
		simple: { type: "socks5", server: "127.0.0.1", port: 7890, username: "", password: "", tls: false },
		subscriptionUrl: "",
		subscriptionUserAgent: "",
		subscriptionIntervalHours: 0,
		nodeTag: "",
		routePrivateDirect: true,
	});
	if (!simple.proxy) throw new Error("未保存");
	setProjectProxy(agentDir, projectId, simple.proxy.id);
	const project = listProjects(agentDir).projects.find((entry) => entry.id === projectId)!;
	const result = await switchProjectNode(agentDir, project, "日本");
	expect(result.error).toContain("只有一个出口");
});

test("auto is a choice, a stale node is not", () => {
	const proxy = {
		id: "p",
		name: "p",
		mode: "subscription" as const,
		simple: { type: "socks5" as const, server: "", port: 0, username: "", password: "", tls: false },
		subscription: null,
		nodes: NODES,
		nodeTag: "香港",
		skipped: [],
		routePrivateDirect: true,
		createdAt: 0,
	};
	expect(switchableNode(proxy, AUTO_NODE_TAG)).toBe(true);
	expect(switchableNode(proxy, "日本")).toBe(true);
	expect(switchableNode(proxy, "已删除")).toBe(false);
	expect(switchableNode(null, AUTO_NODE_TAG)).toBe(true);
});

test("the generated configuration keeps the control port across a rewrite", async () => {
	const agentDir = setup();
	const first = await writeProjectProxyConfig(agentDir, "p1", settingsOf());
	const port = readClashApi((first as { path: string }).path)?.port;
	// A second write (a project being brought up again) must not move the port: the
	// running sidecar is published on it.
	const second = await writeProjectProxyConfig(agentDir, "p1", settingsOf({ nodeTag: "日本" }));
	const path = (second as { path: string }).path;
	expect(readClashApi(path)?.port).toBe(port);
	// The rewrite did happen — the selector now defaults to the new node — while
	// the control port stayed where the running sidecar expects it.
	const config = JSON.parse(readFileSync(path, "utf-8")) as { outbounds: Array<Record<string, unknown>> };
	expect(config.outbounds.find((entry) => entry.tag === "proxy")).toMatchObject({ default: "日本" });
	expect(config).toHaveProperty("experimental.clash_api.secret");
});
