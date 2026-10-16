/**
 * Unit tests for `probeMcpServer`: the one-shot connection the console's
 * 设置 → MCP page uses to check a server before it is saved.
 *
 * The probe reuses `McpServerConnection`, so these tests drive it with the same
 * in-memory transport the extension tests use: no process is spawned and no
 * network is touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonRpcMessage, LATEST_PROTOCOL_VERSION, type McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerEntry } from "../src/extensions/mcp/config.ts";
import { probeMcpServer } from "../src/extensions/mcp/probe.ts";

const servers: InMemoryTransport[] = [];
let root = "";

afterEach(() => {
	for (const server of servers.splice(0)) void server.close();
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function agentDir(): string {
	if (!root) root = mkdtempSync(join(tmpdir(), "pi-mcp-probe-"));
	return root;
}

function entry(config: McpServerEntry["config"] = { command: "fake" }): McpServerEntry {
	return { name: "fake", config, source: "test", scope: "global" };
}

/** In-memory server that answers `initialize` and `tools/list` with the given tools. */
function fakeServer(options: {
	tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
	instructions?: string;
	resources?: number;
	fail?: boolean;
}): McpTransport {
	const pair = createInMemoryTransportPair();
	servers.push(pair.server);
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const ok = (result: unknown): JsonRpcMessage => ({ jsonrpc: "2.0", id: message.id, result });
		const fail = (code: number, text: string): JsonRpcMessage => ({
			jsonrpc: "2.0",
			id: message.id,
			error: { code, message: text },
		});
		let response: JsonRpcMessage;
		if (options.fail) {
			response = fail(-32000, "server exploded");
		} else if (message.method === "initialize") {
			response = ok({
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: options.resources ? { tools: {}, resources: {} } : { tools: {} },
				serverInfo: { name: "fake", version: "1.0.0" },
				...(options.instructions ? { instructions: options.instructions } : {}),
			});
		} else if (message.method === "tools/list") {
			response = ok({
				tools: (options.tools ?? []).map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema ?? { type: "object" },
				})),
			});
		} else if (message.method === "resources/list") {
			response = ok({
				resources: Array.from({ length: options.resources ?? 0 }, (_value, index) => ({
					uri: `fake://${index}`,
					name: `r${index}`,
				})),
			});
		} else if (message.method === "resources/templates/list") {
			response = ok({ resourceTemplates: [] });
		} else {
			response = fail(-32601, "Method not found");
		}
		queueMicrotask(() => void pair.server.send(response));
	});
	void pair.server.start();
	return pair.client;
}

describe("probeMcpServer", () => {
	it("reports a connected server with its tools and instructions", async () => {
		const transport = fakeServer({
			tools: [{ name: "read_file" }, { name: "write_file" }],
			resources: 2,
			instructions: "Use these to touch files.",
		});
		const result = await probeMcpServer(entry(), {
			cwd: agentDir(),
			createTransport: () => transport,
			logPath: join(agentDir(), "mcp.log"),
		});
		expect(result.ok).toBe(true);
		expect(result.state).toBe("connected");
		expect(result.tools).toEqual(["read_file", "write_file"]);
		expect(result.resources).toBe(2);
		expect(result.instructions).toBe("Use these to touch files.");
		expect(result.message).toContain("2 个工具");
		expect(result.message).toContain("2 个资源");
	});

	it("reports a server with no tools as connected", async () => {
		const result = await probeMcpServer(entry(), {
			cwd: agentDir(),
			createTransport: () => fakeServer({}),
			logPath: join(agentDir(), "mcp.log"),
		});
		expect(result.ok).toBe(true);
		expect(result.tools).toEqual([]);
	});

	it("turns a failed connection into a result rather than throwing", async () => {
		const result = await probeMcpServer(entry(), {
			cwd: agentDir(),
			createTransport: () => fakeServer({ fail: true }),
			logPath: join(agentDir(), "mcp.log"),
		});
		expect(result.ok).toBe(false);
		expect(result.state).toBe("failed");
		expect(result.message).toContain("连接失败");
		expect(result.detail).toContain("server exploded");
	});

	it("gives up on a server that never answers", async () => {
		// A transport that accepts the message and drops it, which is what a hung
		// stdio server looks like from here.
		const pair = createInMemoryTransportPair();
		servers.push(pair.server);
		await pair.server.start();
		const result = await probeMcpServer(entry(), {
			cwd: agentDir(),
			createTransport: () => pair.client,
			logPath: join(agentDir(), "mcp.log"),
			timeoutMs: 150,
		});
		expect(result.ok).toBe(false);
		expect(result.state).toBe("failed");
		expect(result.message).toContain("连接超时");
	});

	it("reports a bad config value as a failed connection", async () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
		const missing = "${PI_MCP_PROBE_MISSING}";
		const result = await probeMcpServer(entry({ command: "fake", env: { TOKEN: missing } }), {
			cwd: agentDir(),
			logPath: join(agentDir(), "mcp.log"),
			timeoutMs: 1000,
		});
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("PI_MCP_PROBE_MISSING");
	});
});
