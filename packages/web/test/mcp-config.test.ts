/**
 * Unit tests for the custom MCP server store: normalization, the 0600 file, the
 * stdio host-execution gate, and the `loadConfig` a session receives.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	deleteMcpServer,
	isMcpServerMounted,
	loadSentinelMcpConfig,
	mcpConfigView,
	mcpServersJsonPath,
	normalizeMcpServersFile,
	readMcpServers,
	recordMcpStatus,
	saveMcpServer,
	updateMcpServerRecord,
	validateMcpServerInput,
} from "../src/mcp-config.ts";
import { defaultPermissions, writePermissionsConfig } from "../src/permissions.ts";
import type { SentinelMcpServerInput } from "../src/protocol.ts";

let root = "";

function freshAgentDir(): string {
	root = mkdtempSync(join(tmpdir(), "sentinel-mcp-"));
	return root;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function stdioInput(overrides: Partial<SentinelMcpServerInput> = {}): SentinelMcpServerInput {
	return {
		name: "filesystem",
		enabled: true,
		transport: "stdio",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"],
		env: { LOG_LEVEL: "info" },
		cwd: "",
		url: "",
		headers: {},
		description: "文件系统服务器",
		exposure: "codemode",
		timeout: null,
		hostExecAcknowledged: true,
		...overrides,
	};
}

function httpInput(overrides: Partial<SentinelMcpServerInput> = {}): SentinelMcpServerInput {
	return {
		...stdioInput(),
		name: "docs",
		transport: "http",
		command: "",
		args: [],
		env: {},
		url: "https://example.com/mcp",
		headers: { Authorization: "Bearer token" },
		...overrides,
	};
}

describe("normalizeMcpServersFile", () => {
	test("keeps every named entry complete, dropping only the nameless", () => {
		const file = normalizeMcpServersFile({
			servers: [
				{ name: "ok", transport: "stdio", command: "run", args: ["a", 2], env: { A: "1", B: 2 } },
				{ command: "nameless" },
				{ name: "bad name", command: "run" },
				"not an object",
			],
		});
		// An unusable name survives, so the page can show it and the editor can fix it;
		// loadSentinelMcpConfig is what refuses to hand it to a session.
		expect(file.servers.map((server) => server.name)).toEqual(["ok", "bad name"]);
		const [ok] = file.servers;
		expect(ok.args).toEqual(["a"]);
		expect(ok.env).toEqual({ A: "1" });
		expect(ok.exposure).toBe("codemode");
		expect(ok.enabled).toBe(true);
		expect(ok.hostExecAcknowledged).toBe(false);
		expect(ok.status).toEqual({ at: null, ok: true });
	});

	test("treats a URL as HTTP when the transport field is missing", () => {
		const file = normalizeMcpServersFile({ servers: [{ name: "remote", url: "https://example.com/mcp" }] });
		expect(file.servers[0].transport).toBe("http");
	});

	test("keeps only the first of two names that share a tool namespace", () => {
		const file = normalizeMcpServersFile({
			servers: [
				{ name: "work-files", command: "a" },
				{ name: "work_files", command: "b" },
			],
		});
		expect(file.servers.map((server) => server.name)).toEqual(["work-files"]);
	});

	test("reads a bad timeout and status as their empty values", () => {
		const file = normalizeMcpServersFile({
			servers: [{ name: "x", command: "a", timeout: "soon", status: { at: "yesterday", ok: "yes" } }],
		});
		expect(file.servers[0].timeout).toBeNull();
		expect(file.servers[0].status).toEqual({ at: null, ok: true });
	});

	test("keeps a legacy sse entry as sse instead of re-reading it as HTTP", () => {
		const file = normalizeMcpServersFile({
			servers: [
				{ name: "old", type: "sse", url: "https://example.com/sse" },
				// pi's alias for the same transport this store writes as `http`.
				{ name: "alias", type: "streamable-http", url: "https://example.com/mcp" },
			],
		});
		expect(file.servers.map((server) => server.transport)).toEqual(["sse", "http"]);
	});
});

describe("validateMcpServerInput", () => {
	test("requires a usable name", () => {
		expect(validateMcpServerInput(stdioInput({ name: "" }))).toContain("请填写服务器名称");
		expect(validateMcpServerInput(stdioInput({ name: "bad name" }))).toContain("只能");
	});

	test("refuses a stdio command the operator has not accepted", () => {
		expect(validateMcpServerInput(stdioInput({ hostExecAcknowledged: false }))).toContain("风险确认");
	});

	test("requires a command for stdio and a URL for HTTP", () => {
		expect(validateMcpServerInput(stdioInput({ command: " " }))).toContain("命令");
		expect(validateMcpServerInput(httpInput({ url: "" }))).toContain("URL");
		expect(validateMcpServerInput(httpInput({ url: "example.com/mcp" }))).toContain("url must be");
	});

	test("accepts a complete stdio, HTTP, and SSE entry", () => {
		expect(validateMcpServerInput(stdioInput())).toBeUndefined();
		expect(validateMcpServerInput(httpInput())).toBeUndefined();
		expect(validateMcpServerInput(httpInput({ transport: "sse", url: "https://example.com/sse" }))).toBeUndefined();
	});

	test("requires a URL for the SSE transport too", () => {
		expect(validateMcpServerInput(httpInput({ transport: "sse", url: "  " }))).toBe("SSE 服务器需要填写 URL");
	});
});

describe("saveMcpServer", () => {
	test("writes a 0600 file and returns the view", () => {
		const agentDir = freshAgentDir();
		const view = saveMcpServer(agentDir, stdioInput());
		expect(statSync(mcpServersJsonPath(agentDir)).mode & 0o777).toBe(0o600);
		expect(view.servers).toHaveLength(1);
		expect(view.servers[0].target).toBe("npx -y @modelcontextprotocol/server-filesystem /work");
		expect(view.mounted).toBe(1);
		expect(view.permissionOn).toBe(true);
		// The permission file does not exist yet, which reads as the full defaults.
		expect(JSON.parse(readFileSync(mcpServersJsonPath(agentDir), "utf8")).servers[0].name).toBe("filesystem");
	});

	test("replaces by name and keeps the previous status", () => {
		const agentDir = freshAgentDir();
		saveMcpServer(agentDir, stdioInput());
		recordMcpStatus(agentDir, "filesystem", { at: 1234, ok: false, error: "boom" });
		const view = saveMcpServer(agentDir, stdioInput({ description: "改过的描述" }));
		expect(view.servers).toHaveLength(1);
		expect(view.servers[0].description).toBe("改过的描述");
		expect(view.servers[0].status).toEqual({ at: 1234, ok: false, error: "boom" });
	});

	test("refuses to write over a file it cannot parse", () => {
		const agentDir = freshAgentDir();
		writeFileSync(mcpServersJsonPath(agentDir), "{ not json");
		expect(() => saveMcpServer(agentDir, stdioInput())).toThrow("无法解析");
		expect(readFileSync(mcpServersJsonPath(agentDir), "utf8")).toBe("{ not json");
	});

	test("reports the permission switch, which decides whether anything mounts", () => {
		const agentDir = freshAgentDir();
		saveMcpServer(agentDir, stdioInput());
		const defaults = defaultPermissions();
		writePermissionsConfig(agentDir, { ...defaults, main: { ...defaults.main, mcp: false } });
		const view = mcpConfigView(agentDir);
		expect(view.permissionOn).toBe(false);
		// The server is still mountable on its own terms; the page says the switch is off.
		expect(view.mounted).toBe(1);
	});
});

describe("deleteMcpServer and updateMcpServerRecord", () => {
	test("removes by name and is quiet about a name that is not stored", () => {
		const agentDir = freshAgentDir();
		saveMcpServer(agentDir, stdioInput());
		expect(deleteMcpServer(agentDir, "filesystem").servers).toHaveLength(0);
		expect(deleteMcpServer(agentDir, "filesystem").servers).toHaveLength(0);
	});

	test("applies an enabled/exposure change made through the extension manager", () => {
		const agentDir = freshAgentDir();
		saveMcpServer(agentDir, stdioInput());
		updateMcpServerRecord(agentDir, "filesystem", { enabled: false, exposure: "direct" });
		const [server] = readMcpServers(agentDir).servers;
		expect([server.enabled, server.exposure]).toEqual([false, "direct"]);
		expect(() => updateMcpServerRecord(agentDir, "missing", { enabled: true })).toThrow("未定义");
	});
});

describe("isMcpServerMounted", () => {
	test("needs the switch, and the host-execution acknowledgment for stdio", () => {
		const agentDir = freshAgentDir();
		saveMcpServer(agentDir, stdioInput());
		// The file is hand-edited to clear the acknowledgment, which a save would refuse.
		const path = mcpServersJsonPath(agentDir);
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		parsed.servers[0].hostExecAcknowledged = false;
		writeFileSync(path, JSON.stringify(parsed));
		const [server] = readMcpServers(agentDir).servers;
		expect(isMcpServerMounted(server)).toBe(false);
		expect(mcpConfigView(agentDir).mounted).toBe(0);
	});

	test("does not ask an HTTP server for the acknowledgment", () => {
		const agentDir = freshAgentDir();
		saveMcpServer(agentDir, httpInput());
		const [server] = readMcpServers(agentDir).servers;
		expect(server.hostExecAcknowledged).toBe(false);
		expect(isMcpServerMounted(server)).toBe(true);
	});

	test("mounts an sse entry, which needs no host-execution acknowledgment", () => {
		const agentDir = freshAgentDir();
		writeFileSync(
			mcpServersJsonPath(agentDir),
			JSON.stringify({
				servers: [{ name: "old", type: "sse", url: "https://example.com/sse", hostExecAcknowledged: true }],
			}),
		);
		const [server] = readMcpServers(agentDir).servers;
		expect(server.transport).toBe("sse");
		expect(isMcpServerMounted(server)).toBe(true);
		expect(mcpConfigView(agentDir).mounted).toBe(1);
	});
});

describe("loadSentinelMcpConfig", () => {
	test("hands a session the stored servers in the extension's shape", () => {
		const agentDir = freshAgentDir();
		saveMcpServer(agentDir, stdioInput());
		saveMcpServer(agentDir, httpInput({ timeout: 30, exposure: "direct", description: "文档" }));
		const loaded = loadSentinelMcpConfig(agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.servers.map((server) => [server.name, server.scope, server.source])).toEqual([
			["filesystem", "global", mcpServersJsonPath(agentDir)],
			["docs", "global", mcpServersJsonPath(agentDir)],
		]);
		expect(loaded.servers[0].config).toEqual({
			enabled: true,
			exposure: "codemode",
			description: "文件系统服务器",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"],
			env: { LOG_LEVEL: "info" },
		});
		expect(loaded.servers[1].config).toEqual({
			enabled: true,
			exposure: "direct",
			description: "文档",
			timeout: 30,
			url: "https://example.com/mcp",
			headers: { Authorization: "Bearer token" },
		});
	});

	test("keeps a disabled server in the list, so it can be enabled again", () => {
		const agentDir = freshAgentDir();
		saveMcpServer(agentDir, stdioInput({ enabled: false }));
		const loaded = loadSentinelMcpConfig(agentDir);
		expect(loaded.servers).toHaveLength(1);
		expect(loaded.servers[0].config.enabled).toBe(false);
	});

	test("reports an entry the file holds but the validator rejects", () => {
		const agentDir = freshAgentDir();
		writeFileSync(
			mcpServersJsonPath(agentDir),
			JSON.stringify({ servers: [{ name: "broken", transport: "stdio", command: "  " }] }),
		);
		const loaded = loadSentinelMcpConfig(agentDir);
		expect(loaded.servers).toEqual([]);
		expect(loaded.errors[0]).toContain('server "broken"');
	});

	test("hands an sse entry to the extension as an sse config, not as HTTP", () => {
		const agentDir = freshAgentDir();
		writeFileSync(
			mcpServersJsonPath(agentDir),
			JSON.stringify({ servers: [{ name: "old", type: "sse", url: "https://example.com/sse" }] }),
		);
		const loaded = loadSentinelMcpConfig(agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.servers[0].config).toMatchObject({ type: "sse", url: "https://example.com/sse" });
	});
});
