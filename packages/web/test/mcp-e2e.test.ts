/**
 * The MCP settings page end to end: the real console server, the real WebSocket
 * protocol, and real MCP servers of all three transports on loopback.
 *
 * The three servers are deliberately minimal and hand-written rather than taken
 * from a library: what is under test is the console's own wiring (save, probe,
 * mount count, delete, and the file it owns), so the servers only have to answer
 * `initialize` and `tools/list` the way each transport says to.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import type {
	SentinelMcpConfigView,
	SentinelMcpServerInput,
	SentinelMcpTestResult,
	SentinelMcpTransport,
	SentinelServerMessage,
} from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";

const STDIO_TOOL = "stdio_tool";
const HTTP_TOOL = "http_tool";
const SSE_TOOL = "sse_tool";

let tempRoot = "";
let agentDir = "";
let serverUrl = "";
let closeServer: (() => void) | undefined;
let ws: WebSocket | undefined;

const incoming: SentinelServerMessage[] = [];
const pending: Array<(message: SentinelServerMessage) => boolean> = [];

function dispatch(message: SentinelServerMessage): void {
	incoming.push(message);
	for (const predicate of [...pending]) {
		if (!predicate(message)) continue;
		pending.splice(pending.indexOf(predicate), 1);
	}
}

function send(message: Record<string, unknown>): void {
	ws?.send(JSON.stringify(message));
}

/** Wait for the first message that matches, looking at what already arrived first. */
async function waitFor<T extends SentinelServerMessage>(
	predicate: (message: SentinelServerMessage) => message is T,
	timeoutMs = 30_000,
): Promise<T> {
	const already = incoming.find(predicate);
	if (already) return already;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for a console message")), timeoutMs);
		pending.push((message) => {
			if (!predicate(message)) return false;
			clearTimeout(timer);
			resolve(message);
			return true;
		});
	});
}

function drain(): void {
	incoming.length = 0;
}

/** The config view carried by the next `mcp_servers` message after `action`. */
async function afterConfig(action: () => void): Promise<SentinelMcpConfigView> {
	drain();
	action();
	const message = await waitFor(
		(candidate): candidate is Extract<SentinelServerMessage, { type: "mcp_servers" }> =>
			candidate.type === "mcp_servers",
	);
	return message.config;
}

async function errorFrom(action: () => void): Promise<string> {
	drain();
	action();
	const message = await waitFor(
		(candidate): candidate is Extract<SentinelServerMessage, { type: "error" }> => candidate.type === "error",
	);
	return message.message;
}

function serverInput(
	name: string,
	transport: SentinelMcpTransport,
	overrides: Partial<SentinelMcpServerInput> = {},
): SentinelMcpServerInput {
	return {
		name,
		enabled: true,
		transport,
		command: "",
		args: [],
		env: {},
		cwd: "",
		url: "",
		headers: {},
		description: "",
		exposure: "codemode",
		timeout: null,
		hostExecAcknowledged: false,
		...overrides,
	};
}

/** Answer the two requests a connect makes, for every transport. */
function answer(method: string, params: { protocolVersion?: string } | undefined, tool: string): unknown {
	if (method === "initialize") {
		return {
			protocolVersion: params?.protocolVersion ?? "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "fake", version: "1.0.0" },
		};
	}
	if (method === "tools/list") return { tools: [{ name: tool, inputSchema: { type: "object" } }] };
	return {};
}

/**
 * A stdio MCP server: newline-delimited JSON-RPC on stdin/stdout, which is what
 * `StdioTransport` speaks. Written to the temp dir so the test owns its lifetime.
 */
function writeStdioServer(): string {
	const path = join(tempRoot, "stdio-mcp.mjs");
	writeFileSync(
		path,
		`let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (!line.trim()) continue;
		const message = JSON.parse(line);
		if (message.id === undefined) continue;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "stdio-fake", version: "1.0.0" },
					}
				: message.method === "tools/list"
					? { tools: [{ name: "${STDIO_TOOL}", inputSchema: { type: "object" } }] }
					: {};
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
	}
});
`,
	);
	return path;
}

/** A streamable HTTP MCP server: one JSON-RPC message per POST, answered inline. */
async function startHttpServer(): Promise<string> {
	const origin = await listenHttp(async (request, response) => {
		if (request.method === "GET") {
			// 405 is how a server says "no server-to-client stream"; the transport then stops asking.
			response.writeHead(405).end();
			return;
		}
		if (request.method === "DELETE") {
			response.writeHead(200).end();
			return;
		}
		const body = await readBody(request);
		const message = JSON.parse(body) as { id?: unknown; method?: string; params?: { protocolVersion?: string } };
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: answer(message.method ?? "", message.params, HTTP_TOOL),
			}),
		);
	});
	return `${origin}/mcp`;
}

/**
 * A legacy HTTP+SSE MCP server: the GET stream names the POST endpoint, and every
 * reply comes back on that same stream.
 */
async function startSseServer(): Promise<string> {
	let origin = "";
	const streams: ServerResponse[] = [];
	origin = await listenHttp(async (request, response) => {
		if (request.method === "GET") {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			streams.push(response);
			response.write(`event: endpoint\ndata: ${origin}/message?sessionId=abc\n\n`);
			return;
		}
		const body = await readBody(request);
		response.writeHead(202).end();
		const message = JSON.parse(body) as { id?: unknown; method?: string; params?: { protocolVersion?: string } };
		if (message.id === undefined) return;
		const payload = {
			jsonrpc: "2.0",
			id: message.id,
			result: answer(message.method ?? "", message.params, SSE_TOOL),
		};
		streams.at(-1)?.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
	});
	return `${origin}/sse`;
}

async function readBody(request: AsyncIterable<unknown>): Promise<string> {
	let body = "";
	for await (const chunk of request) body += String(chunk);
	return body;
}

async function listenHttp(
	handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<string> {
	const server = createServer((request, response) => {
		void handler(request, response).catch((error: unknown) => {
			response.writeHead(500).end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	const origin = `http://127.0.0.1:${address.port}`;
	openServers.push(server);
	return origin;
}

const openServers: ReturnType<typeof createServer>[] = [];

let stdioPath = "";
let httpUrl = "";
let sseUrl = "";

beforeAll(async () => {
	tempRoot = mkdtempSync(join(tmpdir(), "sentinel-mcp-e2e-"));
	agentDir = join(tempRoot, "agent");
	stdioPath = writeStdioServer();
	httpUrl = await startHttpServer();
	sseUrl = await startSseServer();
	const started = await startSentinelServer({
		cwd: tempRoot,
		agentDir,
		host: "127.0.0.1",
		port: 0,
		auth: false,
	});
	closeServer = started.close;
	serverUrl = started.url;
	ws = new WebSocket(serverUrl.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => dispatch(JSON.parse(String(data)) as SentinelServerMessage));
	await new Promise<void>((resolve, reject) => {
		ws?.once("open", () => resolve());
		ws?.once("error", reject);
	});
});

afterAll(() => {
	ws?.close();
	closeServer?.();
	for (const server of openServers.splice(0)) server.close();
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test("a fresh console shows an empty list and the file it owns", async () => {
	const config = await afterConfig(() => send({ type: "get_mcp_servers" }));
	expect(config.servers).toEqual([]);
	expect(config.mounted).toBe(0);
	expect(config.permissionOn).toBe(true);
	expect(config.path).toBe(join(agentDir, "mcp-servers.json"));
});

test("refuses a stdio server the operator has not acknowledged", async () => {
	const message = await errorFrom(() =>
		send({
			type: "save_mcp_server",
			server: serverInput("local", "stdio", { command: process.execPath, args: [stdioPath] }),
		}),
	);
	expect(message).toContain("风险确认");
	const config = await afterConfig(() => send({ type: "get_mcp_servers" }));
	expect(config.servers).toEqual([]);
});

test("refuses an incomplete entry and a bad name", async () => {
	expect(await errorFrom(() => send({ type: "save_mcp_server", server: serverInput("nourl", "http") }))).toContain(
		"URL",
	);
	expect(
		await errorFrom(() =>
			send({ type: "save_mcp_server", server: serverInput("bad name", "http", { url: httpUrl }) }),
		),
	).toContain("名称");
});

test("saves one server of each transport and mounts all three", async () => {
	const afterStdio = await afterConfig(() =>
		send({
			type: "save_mcp_server",
			server: serverInput("local", "stdio", {
				command: process.execPath,
				args: [stdioPath],
				env: { MARKER: "one" },
				hostExecAcknowledged: true,
			}),
		}),
	);
	expect(afterStdio.servers.map((server) => server.name)).toEqual(["local"]);
	expect(afterStdio.mounted).toBe(1);
	expect(afterStdio.servers[0].target).toBe(`${process.execPath} ${stdioPath}`);
	expect(afterStdio.servers[0].env).toEqual({ MARKER: "one" });

	const afterHttp = await afterConfig(() =>
		send({ type: "save_mcp_server", server: serverInput("remote", "http", { url: httpUrl }) }),
	);
	expect(afterHttp.mounted).toBe(2);

	const afterSse = await afterConfig(() =>
		send({ type: "save_mcp_server", server: serverInput("legacy", "sse", { url: sseUrl }) }),
	);
	expect(afterSse.servers.map((server) => server.transport)).toEqual(["stdio", "http", "sse"]);
	expect(afterSse.servers[2].target).toBe(sseUrl);
	expect(afterSse.mounted).toBe(3);
});

test("keeps the file private and stores the transport the page wrote", () => {
	const path = join(agentDir, "mcp-servers.json");
	expect(statSync(path).mode & 0o777).toBe(0o600);
	const file = JSON.parse(readFileSync(path, "utf8")) as { servers: Array<Record<string, unknown>> };
	expect(file.servers.map((server) => server.name)).toEqual(["local", "remote", "legacy"]);
	// The SSE entry is stored as SSE, not folded into HTTP.
	expect(file.servers[2]).toMatchObject({ transport: "sse", url: sseUrl });
});

test("connects to the stdio server and reports the tool it offers", async () => {
	drain();
	send({ type: "test_mcp_server", name: "local" });
	const message = await waitFor(
		(candidate): candidate is Extract<SentinelServerMessage, { type: "mcp_test_result" }> =>
			candidate.type === "mcp_test_result",
	);
	const result = message.result as SentinelMcpTestResult;
	expect(result.state).toBe("connected");
	expect(result.ok).toBe(true);
	expect(result.tools).toEqual([STDIO_TOOL]);
});

test("connects to the streamable HTTP server", async () => {
	drain();
	send({ type: "test_mcp_server", name: "remote" });
	const message = await waitFor(
		(candidate): candidate is Extract<SentinelServerMessage, { type: "mcp_test_result" }> =>
			candidate.type === "mcp_test_result",
	);
	expect(message.result.state).toBe("connected");
	expect(message.result.tools).toEqual([HTTP_TOOL]);
});

test("connects to the legacy HTTP+SSE server", async () => {
	drain();
	send({ type: "test_mcp_server", name: "legacy" });
	const message = await waitFor(
		(candidate): candidate is Extract<SentinelServerMessage, { type: "mcp_test_result" }> =>
			candidate.type === "mcp_test_result",
	);
	expect(message.result.state).toBe("connected");
	expect(message.result.ok).toBe(true);
	expect(message.result.tools).toEqual([SSE_TOOL]);
});

test("records each outcome on the row so it survives a reload", async () => {
	const config = await afterConfig(() => send({ type: "get_mcp_servers" }));
	for (const server of config.servers) {
		expect(server.status.ok).toBe(true);
		expect(server.status.at).toBeGreaterThan(0);
		expect(server.status.tools).toBe(1);
	}
});

test("probes a draft without saving it", async () => {
	drain();
	send({
		type: "test_mcp_server",
		name: "unsaved",
		draft: serverInput("unsaved", "http", { url: httpUrl }),
	});
	const message = await waitFor(
		(candidate): candidate is Extract<SentinelServerMessage, { type: "mcp_test_result" }> =>
			candidate.type === "mcp_test_result",
	);
	expect(message.result.state).toBe("connected");
	expect(message.result.tools).toEqual([HTTP_TOOL]);
	const config = await afterConfig(() => send({ type: "get_mcp_servers" }));
	expect(config.servers.map((server) => server.name)).toEqual(["local", "remote", "legacy"]);
});

test("reports a stdio draft that is missing its acknowledgment instead of running it", async () => {
	drain();
	send({
		type: "test_mcp_server",
		name: "unacked",
		draft: serverInput("unacked", "stdio", { command: process.execPath, args: [stdioPath] }),
	});
	const message = await waitFor(
		(candidate): candidate is Extract<SentinelServerMessage, { type: "mcp_test_result" }> =>
			candidate.type === "mcp_test_result",
	);
	expect(message.result.state).toBe("failed");
	expect(message.result.message).toContain("风险确认");
});

test("reports a server that is not there", async () => {
	drain();
	send({ type: "test_mcp_server", name: "ghost" });
	const message = await waitFor(
		(candidate): candidate is Extract<SentinelServerMessage, { type: "mcp_test_result" }> =>
			candidate.type === "mcp_test_result",
	);
	expect(message.result.state).toBe("failed");
	expect(message.result.message).toContain("未找到");
});

test("records a failure when the endpoint cannot be reached", async () => {
	// A port that was just bound and released, so the connection is refused at once instead of
	// hanging. The probe has to report that, not throw.
	const probe = createServer(() => {});
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));

	const dead = await afterConfig(() =>
		send({ type: "save_mcp_server", server: serverInput("dead", "sse", { url: `http://127.0.0.1:${port}/sse` }) }),
	);
	expect(dead.mounted).toBe(4);
	drain();
	send({ type: "test_mcp_server", name: "dead" });
	const message = await waitFor(
		(candidate): candidate is Extract<SentinelServerMessage, { type: "mcp_test_result" }> =>
			candidate.type === "mcp_test_result",
	);
	expect(message.result.state).toBe("failed");
	expect(message.result.ok).toBe(false);
	const config = await afterConfig(() => send({ type: "get_mcp_servers" }));
	const row = config.servers.find((server) => server.name === "dead");
	expect(row?.status.ok).toBe(false);
	expect(row?.status.error).toBeTruthy();
});

test("a disabled server stays in the list but stops being mounted", async () => {
	const config = await afterConfig(() =>
		send({ type: "save_mcp_server", server: serverInput("remote", "http", { url: httpUrl, enabled: false }) }),
	);
	expect(config.servers.map((server) => server.name)).toEqual(["local", "remote", "legacy", "dead"]);
	expect(config.mounted).toBe(3);
});

test("deletes one server, and deleting a name that is gone is a no-op", async () => {
	const config = await afterConfig(() => send({ type: "delete_mcp_server", name: "dead" }));
	expect(config.servers.map((server) => server.name)).toEqual(["local", "remote", "legacy"]);

	// A second tab, or a row that another tab already removed, must not fail: the goal state is
	// the one being asked for, and it already holds.
	const again = await afterConfig(() => send({ type: "delete_mcp_server", name: "ghost" }));
	expect(again.servers.map((server) => server.name)).toEqual(["local", "remote", "legacy"]);
});

test("the permissions page can switch one server off, and the MCP page reads the same field", async () => {
	// Put the set in a known state first: the switch is the subject here, so it must not
	// depend on what an earlier test left behind.
	const before = await afterConfig(() => send({ type: "set_mcp_server_enabled", name: "remote", enabled: true }));
	expect(before.mounted).toBe(3);
	expect(before.servers.map((server) => server.name)).toEqual(["local", "remote", "legacy"]);

	const off = await afterConfig(() => send({ type: "set_mcp_server_enabled", name: "remote", enabled: false }));
	expect(off.mounted).toBe(2);
	// Both views come from one field, so the MCP page cannot disagree with the permissions page.
	expect(off.servers.find((server) => server.name === "remote")?.enabled).toBe(false);
	// The entry itself is untouched: same target, same transport, still listed.
	expect(off.servers.map((server) => server.name)).toEqual(["local", "remote", "legacy"]);
	expect(off.servers[1].url).toBe(httpUrl);

	const on = await afterConfig(() => send({ type: "set_mcp_server_enabled", name: "remote", enabled: true }));
	expect(on.mounted).toBe(3);
	expect(on.servers[1].enabled).toBe(true);

	expect(await errorFrom(() => send({ type: "set_mcp_server_enabled", name: "ghost", enabled: true }))).toContain(
		"未定义",
	);
});

test("the 权限 → MCP switch drives the page's warning without dropping the list", async () => {
	drain();
	send({ type: "get_permissions" });
	const permissions = await waitFor(
		(candidate): candidate is Extract<SentinelServerMessage, { type: "permissions" }> =>
			candidate.type === "permissions",
	);
	const stored = permissions.config;

	drain();
	send({ type: "save_permissions", config: { ...stored, main: { ...stored.main, mcp: false } } });
	await waitFor((candidate) => candidate.type === "permissions");
	const off = await afterConfig(() => send({ type: "get_mcp_servers" }));
	expect(off.permissionOn).toBe(false);
	// The entries stay listed and stay "mountable": the switch gates mounting, not the list.
	expect(off.servers.map((server) => server.name)).toEqual(["local", "remote", "legacy"]);

	drain();
	send({ type: "save_permissions", config: stored });
	await waitFor((candidate) => candidate.type === "permissions");
	const on = await afterConfig(() => send({ type: "get_mcp_servers" }));
	expect(on.permissionOn).toBe(true);
});
