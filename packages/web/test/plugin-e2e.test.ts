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

const TOKEN = "sph_e2e";
const PLUGIN_ID = "com.example.recon";

interface FakeState {
	containers: Map<string, { running: boolean; exitCode: number; restartCount: number }>;
	hostPort: number;
}

function fakeDocker(state: FakeState): DockerRunner {
	return async (args) => {
		const [command] = args;
		if (command === "pull") return { code: 0, stdout: "", stderr: "" };
		if (command === "version") return { code: 0, stdout: "27.0.0\n", stderr: "" };
		if (command === "build") return { code: 0, stdout: "built", stderr: "" };
		if (command === "rmi") return { code: 0, stdout: "", stderr: "" };
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
			if (request.url === "/ui/index.html") {
				response.writeHead(200, { "content-type": "text/html" });
				response.end("<!doctype html><title>plugin ui</title><p>hello from the plugin</p>");
				return;
			}
			if (request.url === "/mcp" && request.method === "POST") {
				let body = "";
				request.on("data", (chunk: Buffer) => {
					body += chunk.toString();
				});
				request.on("end", () => {
					const message = JSON.parse(body) as { id?: number; method?: string; params?: { name?: string } };
					const result =
						message.method === "initialize"
							? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake", version: "1" } }
							: { content: [{ type: "text", text: `called ${message.params?.name ?? "?"}` }], _meta: {} };
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
				});
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
	build: { dockerfile: "Dockerfile", context: "." },
	mcp: { transport: "http", port: 7801, path: "/mcp", startupTimeoutMs: 3000 },
	permissions: { network: "bridge" },
	locality: "any",
	healthcheck: { path: "/healthz", intervalMs: 200, timeoutMs: 1000 },
	ui: { entry: "/ui/index.html", title: "侦察面板", protocol: 1 },
};

/** Minimal stored-entry zip for the install package. */
function buildZip(files: Array<{ name: string; data: Buffer }>): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name, "utf8");
		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(file.data.length, 18);
		local.writeUInt32LE(file.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);
		locals.push(Buffer.concat([local, file.data]));

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(file.data.length, 20);
		central.writeUInt32LE(file.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		centrals.push(central);

		offset += local.length + file.data.length;
	}
	const directory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(directory.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, eocd]);
}

const PACKAGE = buildZip([
	{ name: "Dockerfile", data: Buffer.from("FROM scratch\n") },
	{ name: "plugin.json", data: Buffer.from(JSON.stringify(manifest)) },
]).toString("base64");

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
	const zip = buildZip([
		{ name: "Dockerfile", data: Buffer.from("FROM scratch\n") },
		{ name: "plugin.json", data: Buffer.from(JSON.stringify(manifest)) },
	]);
	send({ type: "inspect_plugin_package", name: "recon.zip", data: zip.toString("base64") });
	const message = await pending;
	expect(message.type).toBe("plugin_manifest");
	if (message.type !== "plugin_manifest") return;
	expect(message.manifest.id).toBe(PLUGIN_ID);
	expect(message.source).toBe("recon.zip");
});

test("installs a plugin and mounts it on the next session", async () => {
	const pending = nextPlugins();
	send({
		type: "install_plugin",
		hostId: localHostId,
		manifest,
		package: PACKAGE,
		allowBuild: true,
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

test("a plugin that declares ui.sidebar is visible by default and can be hidden", async () => {
	const initial = await requestPlugins();
	expect(initial.view.plugins[0]?.pinned).toBe(true);

	const hide = nextPlugins();
	send({ type: "set_plugin_sidebar", hostId: localHostId, pluginId: PLUGIN_ID, pinned: false });
	const after = await hide;
	expect(after.view.plugins[0]?.pinned).toBe(false);

	const show = nextPlugins();
	send({ type: "set_plugin_sidebar", hostId: localHostId, pluginId: PLUGIN_ID, pinned: true });
	const restored = await show;
	expect(restored.view.plugins[0]?.pinned).toBe(true);
});

test("serves the plugin frontend through a capability URL", async () => {
	const opened = waitFor((message) => message.type === "plugin_ui_opened");
	send({ type: "plugin_ui_open", hostId: localHostId, pluginId: PLUGIN_ID });
	const grant = await opened;
	if (grant.type !== "plugin_ui_opened") return;

	const response = await fetch(
		`${consoleServer?.url ?? ""}/plugin-ui/${grant.token}/${localHostId}/${PLUGIN_ID}/index.html`,
	);
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("hello from the plugin");
	expect(response.headers.get("access-control-allow-origin")).toBe("*");

	const denied = await fetch(
		`${consoleServer?.url ?? ""}/plugin-ui/not-a-token/${localHostId}/${PLUGIN_ID}/index.html`,
	);
	expect(denied.status).toBe(404);
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

test("answers bridge calls from the plugin frontend", async () => {
	const list = await requestPlugins();
	const plugin = list.view.plugins[0];
	expect(plugin).toBeDefined();
	if (!plugin) return;

	const call = waitFor((message) => message.type === "plugin_ui_result" && message.requestId === "r1");
	send({
		type: "plugin_ui_call",
		requestId: "r1",
		hostId: plugin.hostId,
		pluginId: plugin.manifest.id,
		method: "tool.call",
		params: { name: "hello_echo", arguments: { text: "hi" } },
	});
	const message = await call;
	expect(message.type).toBe("plugin_ui_result");
	if (message.type !== "plugin_ui_result") return;
	expect(message.ok).toBe(true);
	const result = message.result as { content: Array<{ text: string }>; isError: boolean };
	expect(result.content[0]?.text).toBe("called hello_echo");

	const store = waitFor((entry) => entry.type === "plugin_ui_result" && entry.requestId === "r2");
	send({
		type: "plugin_ui_call",
		requestId: "r2",
		hostId: plugin.hostId,
		pluginId: plugin.manifest.id,
		method: "storage.set",
		params: { key: "lastRun", value: "r-1" },
	});
	const stored = await store;
	expect(stored.type === "plugin_ui_result" ? stored.ok : false).toBe(true);

	const get = waitFor((entry) => entry.type === "plugin_ui_result" && entry.requestId === "r3");
	send({
		type: "plugin_ui_call",
		requestId: "r3",
		hostId: plugin.hostId,
		pluginId: plugin.manifest.id,
		method: "storage.get",
		params: { key: "lastRun" },
	});
	const read = await get;
	expect(read.type === "plugin_ui_result" ? read.result : null).toBe("r-1");

	const denied = waitFor((entry) => entry.type === "plugin_ui_result" && entry.requestId === "r4");
	send({
		type: "plugin_ui_call",
		requestId: "r4",
		hostId: plugin.hostId,
		pluginId: plugin.manifest.id,
		method: "host.exec",
		params: {},
	});
	const refused = await denied;
	expect(refused.type === "plugin_ui_result" ? refused.ok : true).toBe(false);
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
