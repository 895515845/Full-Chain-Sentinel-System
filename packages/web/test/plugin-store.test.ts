/**
 * The console side of the plugin state: which hosts exist, which plugins are
 * switched on, and the one synchronous read session creation depends on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadSentinelMcpConfig } from "../src/mcp-config.ts";
import { saveHost } from "../src/plugin-service.ts";
import {
	effectivePluginHosts,
	pluginMountEntries,
	pluginSidebarHidden,
	recordPluginHostStatus,
	rememberPluginStates,
	setPluginEnabled,
	setPluginSidebarHidden,
} from "../src/plugin-store.ts";

let root = "";
let agentDir = "";
let pluginHostDir = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-plugin-store-"));
	agentDir = join(root, "agent");
	pluginHostDir = join(root, "plugin-host");
	mkdirSync(agentDir, { recursive: true });
	process.env.SENTINEL_PLUGIN_HOST_DIR = pluginHostDir;
});

afterEach(() => {
	delete process.env.SENTINEL_PLUGIN_HOST_DIR;
	rmSync(root, { recursive: true, force: true });
});

describe("plugin hosts", () => {
	test("saves a loopback host and rejects plain HTTP elsewhere", () => {
		const view = saveHost(agentDir, { name: "本机", url: "http://127.0.0.1:7800", token: "sph_x" });
		expect(view.url).toBe("http://127.0.0.1:7800");
		expect(() => saveHost(agentDir, { name: "VPS", url: "http://1.2.3.4:7800", token: "sph_x" })).toThrow(/HTTPS/);
	});

	test("discovers a local plugin host from its state file", () => {
		mkdirSync(pluginHostDir, { recursive: true });
		writeFileSync(
			join(pluginHostDir, "host.json"),
			JSON.stringify({ version: 1, port: 17800, token: "sph_local", pid: 1, startedAt: 1 }),
		);
		const hosts = effectivePluginHosts(agentDir);
		expect(hosts.some((host) => host.local && host.url === "http://127.0.0.1:17800")).toBe(true);
	});
});

describe("local host status", () => {
	test("a discovered host keeps its own status line", () => {
		mkdirSync(pluginHostDir, { recursive: true });
		writeFileSync(
			join(pluginHostDir, "host.json"),
			JSON.stringify({ version: 1, port: 17800, token: "sph_local", pid: 1, startedAt: 1 }),
		);
		const host = effectivePluginHosts(agentDir).find((entry) => entry.local);
		expect(host).toBeDefined();
		if (!host) return;
		recordPluginHostStatus(agentDir, host.id, true, { at: 7, ok: false, error: "down" });
		const again = effectivePluginHosts(agentDir).find((entry) => entry.local);
		expect(again?.status).toMatchObject({ ok: false, error: "down" });
	});
});

describe("corrupt state", () => {
	test("refuses to overwrite a plugins.json it cannot parse", () => {
		writeFileSync(join(agentDir, "plugins.json"), "{not json");
		expect(() => saveHost(agentDir, { name: "x", url: "http://127.0.0.1:1", token: "t" })).toThrow(/无法解析/);
	});
});

describe("mount entries", () => {
	test("a running, enabled plugin becomes an MCP server entry", () => {
		const host = saveHost(agentDir, { name: "本机", url: "http://127.0.0.1:7800", token: "sph_x" });
		rememberPluginStates(agentDir, [{ hostId: host.id, pluginId: "com.example.recon", state: "running" }]);

		const entries = pluginMountEntries(agentDir);
		expect(entries).toEqual([
			{
				serverName: "plugin-com-example-recon",
				url: "http://127.0.0.1:7800/plugins/com.example.recon/mcp",
				token: "sph_x",
				timeoutSeconds: 300,
			},
		]);
	});

	test("switching the plugin off removes the entry without stopping it", () => {
		const host = saveHost(agentDir, { name: "本机", url: "http://127.0.0.1:7800", token: "sph_x" });
		rememberPluginStates(agentDir, [{ hostId: host.id, pluginId: "com.example.recon", state: "running" }]);
		setPluginEnabled(agentDir, host.id, "com.example.recon", false);
		expect(pluginMountEntries(agentDir)).toEqual([]);
	});

	test("a stopped plugin is not mounted", () => {
		const host = saveHost(agentDir, { name: "本机", url: "http://127.0.0.1:7800", token: "sph_x" });
		rememberPluginStates(agentDir, [{ hostId: host.id, pluginId: "com.example.recon", state: "stopped" }]);
		expect(pluginMountEntries(agentDir)).toEqual([]);
	});
});

describe("session config", () => {
	test("the MCP loader appends plugins with the token as a header", () => {
		const host = saveHost(agentDir, { name: "本机", url: "http://127.0.0.1:7800", token: "sph_x" });
		rememberPluginStates(agentDir, [{ hostId: host.id, pluginId: "com.example.recon", state: "running" }]);
		const config = loadSentinelMcpConfig(agentDir);
		expect(config.errors).toEqual([]);
		expect(config.servers).toHaveLength(1);
		const server = config.servers[0];
		expect(server.name).toBe("plugin-com-example-recon");
		expect(server.config).toMatchObject({
			url: "http://127.0.0.1:7800/plugins/com.example.recon/mcp",
			headers: { authorization: "Bearer sph_x" },
			exposure: "direct",
			enabled: true,
			timeout: 300,
		});
	});
});

test("sidebar hides persist per host and plugin", () => {
	expect(pluginSidebarHidden(agentDir, "host-a", "com.example.recon")).toBe(false);
	setPluginSidebarHidden(agentDir, "host-a", "com.example.recon", true);
	expect(pluginSidebarHidden(agentDir, "host-a", "com.example.recon")).toBe(true);
	expect(pluginSidebarHidden(agentDir, "host-b", "com.example.recon")).toBe(false);
	setPluginSidebarHidden(agentDir, "host-a", "com.example.recon", false);
	expect(pluginSidebarHidden(agentDir, "host-a", "com.example.recon")).toBe(false);
});
