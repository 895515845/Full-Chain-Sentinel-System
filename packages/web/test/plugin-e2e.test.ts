/**
 * The plugin center end to end through the console's own WebSocket.
 *
 * The plugin host is real (`startPluginHost`), its Docker is an in-memory
 * runner, and the plugin is a small HTTP server. What is under test is the path
 * the browser takes: get_plugins, install, toggle, logs, uninstall, and the
 * synchronous mount cache the next session is built from.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import { loadSentinelMcpConfig } from "../src/mcp-config.ts";
import { startPluginHost } from "../src/plugin-host/server.ts";
import type { DockerRunner } from "../src/plugin-host/types.ts";
import type { SentinelServerMessage } from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";

const DIGEST = "c".repeat(64);
const TOKEN = "sph_e2e";
const PLUGIN_ID = "com.example.recon";

interface FakeState {
	containers: Map<string, { running: boolean; exitCode: number; restartCount: number }>;
	hostPort: number;
}

function fakeDocker(state: FakeState): DockerRunner {
	const image = `ghcr.io/example/recon@sha256:${DIGEST}`;
	return async (args) => {
		const [command] = args;
		if (command === "pull") return { code: 0, stdout: "", stderr: "" };
		if (command === "version") return { code: 0, stdout: "27.0.0\n", stderr: "" };
		if (command === "image") return { code: 0, stdout: JSON.stringify([image]), stderr: "" };
		if (command === "rm") {
			state.containers.delete(args[args.length - 1] ?? "");
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "create") {
			const name = args[args.indexOf("--name") + 1] ?? "";
			state.containers.set(name, { running: false, exitCode: 0, restartCount: 0 });
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "start") {
			const name = args[args.length - 1] ?? "";
			const container = state.containers.get(name);
			if (!container) return { code: 1, stdout: "", stderr: "no such container" };
			container.running = true;
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "stop") {
			const container = state.containers.get(args[args.length - 1] ?? "");
			if (container) container.running = false;
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "rename") {
			const from = args[1] ?? "";
			const to = args[2] ?? "";
			const container = state.containers.get(from);
			if (!container) return { code: 1, stdout: "", stderr: "no such container" };
			state.containers.delete(from);
			state.containers.set(to, container);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "port") return { code: 0, stdout: `127.0.0.1:${state.hostPort}\n`, stderr: "" };
		if (command === "inspect") {
			const container = state.containers.get(args[args.length - 1] ?? "");
			if (!container) return { code: 1, stdout: "", stderr: "no such object" };
			return {
				code: 0,
				stdout: JSON.stringify({
					State: {
						Running: container.running,
						Status: container.running ? "running" : "exited",
						ExitCode: container.exitCode,
					},
					RestartCount: container.restartCount,
				}),
				stderr: "",
			};
		}
		if (command === "logs") return { code: 0, stdout: "plugin says hello\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
}

function startFakePlugin(): Promise<{ server: Server; port: number }> {
	return new Promise((resolve, reject) => {
		const server = createServer((request: IncomingMessage, response: ServerResponse) => {
			if (request.url === "/healthz") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"ok":true}');
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address !== "object" || !address) {
				reject(new Error("no address"));
				return;
			}
			resolve({ server, port: address.port });
		});
	});
}

const manifest = {
	schema: 1,
	id: PLUGIN_ID,
	name: "侦察工具集",
	version: "0.1.0",
	description: "e2e",
	author: "github:someone",
	source: "https://github.com/someone/recon",
	license: "MIT",
	image: `ghcr.io/example/recon@sha256:${DIGEST}`,
	mcp: { transport: "http", port: 7801, path: "/mcp", startupTimeoutMs: 3000 },
	permissions: { network: "bridge" },
	locality: "any",
	healthcheck: { path: "/healthz", intervalMs: 200, timeoutMs: 1000 },
};

let root = "";
let agentDir = "";
let hostDir = "";
let pluginServer: Server | undefined;
let pluginHost: Awaited<ReturnType<typeof startPluginHost>> | undefined;
let consoleServer: { url: string; close: () => void } | undefined;
let ws: WebSocket | undefined;
let localHostId = "";
const incoming: SentinelServerMessage[] = [];
const waiters: Array<(message: SentinelServerMessage) => boolean> = [];

function dispatch(message: SentinelServerMessage): void {
	incoming.push(message);
	for (const waiter of [...waiters]) {
		if (!waiter(message)) continue;
		waiters.splice(waiters.indexOf(waiter), 1);
	}
}

function waitFor(
	predicate: (message: SentinelServerMessage) => boolean,
	timeoutMs = 20000,
): Promise<SentinelServerMessage> {
	const already = incoming.find(predicate);
	if (already) return Promise.resolve(already);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
		const waiter = (message: SentinelServerMessage): boolean => {
			if (!predicate(message)) return false;
			clearTimeout(timer);
			resolve(message);
			return true;
		};
		waiters.push(waiter);
	});
}

function send(message: Record<string, unknown>): void {
	ws?.send(JSON.stringify(message));
}

type PluginsMessage = Extract<SentinelServerMessage, { type: "plugins" }>;

function nextPlugins(): Promise<PluginsMessage> {
	incoming.length = 0;
	return waitFor((message): message is PluginsMessage => message.type === "plugins") as Promise<PluginsMessage>;
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "sentinel-plugin-e2e-"));
	agentDir = join(root, "agent");
	hostDir = join(root, "plugin-host");
	process.env.SENTINEL_PLUGIN_HOST_DIR = hostDir;
	mkdirSync(hostDir, { recursive: true });

	const fake = await startFakePlugin();
	pluginServer = fake.server;
	pluginHost = await startPluginHost({
		dataDir: hostDir,
		token: TOKEN,
		mode: "local",
		port: 0,
		docker: { runner: fakeDocker({ containers: new Map(), hostPort: fake.port }) },
		log: () => {},
	});
	writeFileSync(
		join(hostDir, "host.json"),
		JSON.stringify({ version: 1, token: TOKEN, port: pluginHost.port, pid: process.pid, startedAt: 1 }),
	);

	const started = await startSentinelServer({ cwd: root, agentDir, host: "127.0.0.1", port: 0, auth: false });
	consoleServer = started;
	ws = new WebSocket(`${started.url.replace("http://", "ws://")}/ws`);
	ws.on("message", (data) => dispatch(JSON.parse(String(data)) as SentinelServerMessage));
	await new Promise<void>((resolve, reject) => {
		ws?.once("open", () => resolve());
		ws?.once("error", reject);
	});
});

afterAll(async () => {
	ws?.close();
	consoleServer?.close();
	await pluginHost?.close();
	if (pluginServer) await new Promise<void>((resolve) => pluginServer?.close(() => resolve()));
	delete process.env.SENTINEL_PLUGIN_HOST_DIR;
	rmSync(root, { recursive: true, force: true });
});

test("discovers the local host and shows no plugins", async () => {
	const pending = nextPlugins();
	send({ type: "get_plugins" });
	const message = await pending;
	localHostId = message.view.hosts[0]?.id ?? "";
	expect(message.view.hosts.map((host) => host.local)).toEqual([true]);
	expect(message.view.plugins).toEqual([]);
	expect(message.view.problems).toEqual([]);
});

test("reads an uploaded plugin package before installing", async () => {
	const pending = waitFor((message) => message.type === "plugin_manifest");
	send({
		type: "inspect_plugin_package",
		name: "plugin.json",
		data: Buffer.from(JSON.stringify(manifest)).toString("base64"),
	});
	const message = await pending;
	expect(message.type).toBe("plugin_manifest");
	if (message.type !== "plugin_manifest") return;
	expect(message.manifest.id).toBe(PLUGIN_ID);
	expect(message.source).toBe("plugin.json");
});

test("installs a plugin and mounts it on the next session", async () => {
	const pending = nextPlugins();
	send({
		type: "install_plugin",
		hostId: localHostId,
		manifest,
		allowHostNetwork: false,
		allowPrivileged: false,
		config: {},
	});
	const message = await pending;
	expect(message.view.plugins).toHaveLength(1);
	expect(message.view.plugins[0]?.state).toBe("running");
	expect(message.view.plugins[0]?.enabled).toBe(true);

	const config = loadSentinelMcpConfig(agentDir);
	expect(config.servers.map((server) => server.name)).toEqual(["plugin-com-example-recon"]);
	// The MCP client's own default is 60s; a plugin gets the manifest budget instead.
	expect(config.servers[0]?.config.timeout).toBe(300);

	// The settings-side action is audited; the session transcript only covers tool calls.
	const audit = readFileSync(join(agentDir, "plugin-audit.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { action: string; ok: boolean; pluginId?: string; detail?: unknown });
	const install = audit.find((entry) => entry.action === "install");
	expect(install).toMatchObject({ ok: true, pluginId: PLUGIN_ID });
	expect(JSON.stringify(install?.detail)).not.toContain("secret");
});

test("switching the plugin off removes it from the mount cache", async () => {
	const list = await requestPlugins();
	const plugin = list.view.plugins[0];
	expect(plugin).toBeDefined();
	if (!plugin) return;
	const pending = nextPlugins();
	send({ type: "set_plugin_enabled", hostId: plugin.hostId, pluginId: plugin.manifest.id, enabled: false });
	await pending;
	expect(loadSentinelMcpConfig(agentDir).servers).toEqual([]);
});

test("reads logs and uninstalls", async () => {
	const list = await requestPlugins();
	const plugin = list.view.plugins[0];
	expect(plugin).toBeDefined();
	if (!plugin) return;
	send({ type: "get_plugin_logs", hostId: plugin.hostId, pluginId: plugin.manifest.id });
	const logs = await waitFor((message) => message.type === "plugin_logs");
	expect(logs.type === "plugin_logs" ? logs.logs : "").toContain("plugin says hello");

	const pending = nextPlugins();
	send({ type: "uninstall_plugin", hostId: plugin.hostId, pluginId: plugin.manifest.id, purge: false });
	const message = await pending;
	expect(message.view.plugins).toEqual([]);
});

async function requestPlugins(): Promise<PluginsMessage> {
	const pending = nextPlugins();
	send({ type: "get_plugins" });
	return pending;
}
