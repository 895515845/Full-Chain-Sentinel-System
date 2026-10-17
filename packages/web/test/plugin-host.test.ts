/**
 * The plugin host end to end, with Docker replaced by an in-memory runner.
 *
 * The runner is the only fake: everything above it (manifest validation, install
 * policy, health gating, the reverse proxy, the artifact path rules) is the
 * production code. That matters because the dangerous decisions all live above
 * Docker: whether host networking was approved, whether a digest matched, and
 * whether a path can escape the plugin's directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startPluginHost } from "../src/plugin-host/server.ts";
import { readPluginRecord } from "../src/plugin-host/store.ts";
import type { DockerRunner } from "../src/plugin-host/types.ts";

const DIGEST = "b".repeat(64);
const IMAGE = `ghcr.io/example/recon@sha256:${DIGEST}`;
const TOKEN = "sph_test_token";

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: 1,
		id: "com.example.recon",
		name: "侦察工具集",
		version: "0.1.0",
		description: "测试用",
		author: "github:someone",
		source: "https://github.com/someone/recon",
		license: "MIT",
		image: IMAGE,
		mcp: { transport: "http", port: 7801, path: "/mcp", startupTimeoutMs: 3000 },
		permissions: { network: "bridge" },
		locality: "any",
		healthcheck: { path: "/healthz", intervalMs: 50, timeoutMs: 500, retries: 3 },
		...overrides,
	};
}

interface FakeDockerState {
	containers: Map<string, { running: boolean; exitCode: number; restartCount: number }>;
	hostPort: number;
	calls: string[];
}

function fakeRunner(state: FakeDockerState): DockerRunner {
	return async (args) => {
		state.calls.push(args.join(" "));
		const [command] = args;
		if (command === "pull") return { code: 0, stdout: "pulled", stderr: "" };
		if (command === "version") return { code: 0, stdout: "27.0.0\n", stderr: "" };
		if (command === "image") return { code: 0, stdout: JSON.stringify([IMAGE]), stderr: "" };
		if (command === "rm") {
			const name = args[args.length - 1];
			state.containers.delete(name);
			return { code: 0, stdout: name, stderr: "" };
		}
		if (command === "create") {
			const name = args[args.indexOf("--name") + 1];
			state.containers.set(name, { running: false, exitCode: 0, restartCount: 0 });
			return { code: 0, stdout: `${name}\n`, stderr: "" };
		}
		if (command === "start") {
			const name = args[args.length - 1];
			const container = state.containers.get(name);
			if (!container) return { code: 1, stdout: "", stderr: "no such container" };
			container.running = true;
			return { code: 0, stdout: name, stderr: "" };
		}
		if (command === "stop") {
			const name = args[args.length - 1];
			const container = state.containers.get(name);
			if (container) container.running = false;
			return { code: 0, stdout: name, stderr: "" };
		}
		if (command === "port") return { code: 0, stdout: `127.0.0.1:${state.hostPort}\n`, stderr: "" };
		if (command === "rename") {
			const from = args[1] ?? "";
			const to = args[2] ?? "";
			const container = state.containers.get(from);
			if (!container) return { code: 1, stdout: "", stderr: "no such container" };
			state.containers.delete(from);
			state.containers.set(to, container);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "inspect") {
			const name = args[args.length - 1];
			const container = state.containers.get(name);
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
		if (command === "logs") return { code: 0, stdout: "plugin log line\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
}

/** The plugin under test: answers health, echoes MCP requests, and records received headers. */
function startFakePlugin(): Promise<{
	server: Server;
	port: number;
	seen: string[];
	state: { failHealth: boolean };
}> {
	return new Promise((resolve, reject) => {
		const seen: string[] = [];
		const state = { failHealth: false };
		const server = createServer((request, response) => {
			if (request.url === "/healthz") {
				const status = state.failHealth ? 500 : 200;
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: !state.failHealth }));
				return;
			}
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				seen.push(`${request.method ?? ""} ${request.url ?? ""} auth=${request.headers.authorization ?? "none"}`);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ echoed: body, path: request.url }));
			});
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address !== "object" || !address) {
				reject(new Error("no address"));
				return;
			}
			resolve({ server, port: address.port, seen, state });
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

let root = "";
let plugin: { server: Server; port: number; seen: string[]; state: { failHealth: boolean } } | undefined;
let host: Awaited<ReturnType<typeof startPluginHost>> | undefined;
let dockerState: FakeDockerState;

function auth(init: RequestInit = {}): RequestInit {
	return { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${TOKEN}` } };
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${host?.url ?? ""}${path}`, auth(init));
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sentinel-plugin-host-"));
	plugin = await startFakePlugin();
	dockerState = { containers: new Map(), hostPort: plugin.port, calls: [] };
	host = await startPluginHost({
		dataDir: join(root, "host"),
		token: TOKEN,
		mode: "local",
		port: 0,
		docker: { runner: fakeRunner(dockerState) },
		log: () => {},
	});
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	if (plugin) await closeServer(plugin.server);
	plugin = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("plugin host API", () => {
	test("rejects a request without the bearer token", async () => {
		const response = await fetch(`${host?.url ?? ""}/v1/plugins`);
		expect(response.status).toBe(401);
	});

	test("installs a plugin, waits for health, and reports it running", async () => {
		const install = await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest() }),
		});
		expect(install.status).toBe(200);
		const body = (await install.json()) as { plugin: { state: string; healthy: boolean; hostPort: number } };
		expect(body.plugin.state).toBe("running");
		expect(body.plugin.healthy).toBe(true);
		expect(body.plugin.hostPort).toBe(plugin?.port);

		const list = (await (await api("/v1/plugins")).json()) as { plugins: Array<{ manifest: { id: string } }> };
		expect(list.plugins.map((entry) => entry.manifest.id)).toEqual(["com.example.recon"]);

		// The container was created with the declared limits and the loopback mapping.
		const create = dockerState.calls.find((call) => call.startsWith("create "));
		expect(create).toContain("--cpus 1");
		expect(create).toContain("--memory 512m");
		expect(create).toContain("-p 127.0.0.1::7801");
		expect(create).not.toContain("--privileged");
	});

	test("refuses host networking without explicit approval", async () => {
		const response = await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest({ permissions: { network: "host" } }) }),
		});
		expect(response.status).toBe(403);
	});

	test("refuses a capability outside the allowlist", async () => {
		const response = await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest({ permissions: { network: "bridge", capAdd: ["SYS_ADMIN"] } }) }),
		});
		expect(response.status).toBe(400);
	});

	test("refuses a remote-only plugin on a local host", async () => {
		const response = await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest({ locality: "remote-only" }) }),
		});
		expect(response.status).toBe(409);
	});

	test("refuses a tag-only image", async () => {
		const response = await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest({ image: "ghcr.io/example/recon:latest" }) }),
		});
		expect(response.status).toBe(400);
	});

	test("proxies MCP without leaking the host token", async () => {
		await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest() }),
		});
		const response = await api("/plugins/com.example.recon/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { path: string };
		expect(body.path).toBe("/mcp");
		expect(plugin?.seen.at(-1)).toContain("auth=none");
	});

	test("stops serving MCP when the plugin is stopped", async () => {
		await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest() }),
		});
		const stopped = await api("/v1/plugins/com.example.recon/stop", { method: "POST" });
		expect(stopped.status).toBe(200);
		const proxied = await api("/plugins/com.example.recon/mcp", { method: "POST", body: "{}" });
		expect(proxied.status).toBe(503);
	});

	test("keeps a stored secret when a config update omits it", async () => {
		const withConfig = manifest({
			config: [{ key: "API_KEY", label: "Key", type: "secret", required: true }],
		});
		await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: withConfig, config: { API_KEY: "first" } }),
		});
		const createdBefore = dockerState.calls.filter((call) => call.startsWith("create ")).length;
		const update = await api("/v1/plugins/com.example.recon/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ values: {} }),
		});
		expect(update.status).toBe(200);
		const body = (await update.json()) as { plugin: { configured: string[] } };
		expect(body.plugin.configured).toEqual(["API_KEY"]);
		// A config change is a redeploy, because env is fixed when the container is created.
		expect(dockerState.calls.filter((call) => call.startsWith("create ")).length).toBe(createdBefore + 1);
	});

	test("a failed upgrade leaves the previous version installed", async () => {
		await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest({ version: "0.1.0" }) }),
		});
		const removalsBefore = dockerState.calls.filter(
			(call) => call === "rm -f sentinel-plugin-com-example-recon",
		).length;
		if (plugin) plugin.state.failHealth = true;
		const upgrade = await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest({ version: "0.2.0" }) }),
		});
		expect(upgrade.status).toBe(502);
		// The canonical container still exists and the candidate was cleaned up.
		expect(dockerState.containers.has("sentinel-plugin-com-example-recon")).toBe(true);
		expect(dockerState.containers.has("sentinel-plugin-com-example-recon-next")).toBe(false);
		const stored = readPluginRecord(join(root, "host"), "com.example.recon");
		expect(stored?.manifest.version).toBe("0.1.0");
		// The old container was never removed: only the candidate's failure cleanup ran.
		expect(dockerState.calls.filter((call) => call === "rm -f sentinel-plugin-com-example-recon").length).toBe(
			removalsBefore,
		);
	});

	test("reports a container that keeps restarting as failed", async () => {
		await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest() }),
		});
		// The fake reports RestartCount 0 by default; simulate a crash loop by editing its state.
		const name = [...dockerState.containers.keys()][0];
		const container = dockerState.containers.get(name ?? "");
		if (container) container.restartCount = 6;
		const list = (await (await api("/v1/plugins")).json()) as { plugins: Array<{ state: string }> };
		expect(list.plugins[0]?.state).toBe("failed");
	});

	test("stores secrets and never returns their values", async () => {
		const withConfig = manifest({
			config: [
				{ key: "API_KEY", label: "Key", type: "secret", required: true },
				{ key: "RATE", label: "速率", type: "number", required: false },
			],
		});
		const install = await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: withConfig, config: { API_KEY: "super-secret", RATE: "100" } }),
		});
		expect(install.status).toBe(200);
		const body = (await install.json()) as { plugin: { configured: string[]; values: Record<string, string> } };
		expect(body.plugin.configured).toEqual(["API_KEY", "RATE"]);
		// A secret is reported as configured, never as a value; other fields are readable.
		expect(body.plugin.values).toEqual({ RATE: "100" });
		expect(JSON.stringify(body)).not.toContain("super-secret");

		const stored = readPluginRecord(join(root, "host"), "com.example.recon");
		expect(stored?.manifest.config[0]?.type).toBe("secret");
	});

	test("rejects a required secret that was not provided", async () => {
		const withConfig = manifest({
			config: [{ key: "API_KEY", label: "Key", type: "secret", required: true }],
		});
		const response = await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: withConfig }),
		});
		expect(response.status).toBe(400);
	});

	test("lists and downloads artifacts inside the plugin directory only", async () => {
		await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest() }),
		});
		const artifacts = join(root, "host", "plugins", "com.example.recon", "artifacts");
		mkdirSync(join(artifacts, "run-1"), { recursive: true });
		writeFileSync(join(artifacts, "run-1", "result.txt"), "evidence");

		const listed = (await (await api("/v1/plugins/com.example.recon/artifacts")).json()) as {
			artifacts: Array<{ path: string; size: number }>;
		};
		expect(listed.artifacts).toEqual([{ path: "run-1/result.txt", size: 8 }]);

		const download = await api("/v1/plugins/com.example.recon/artifacts?path=run-1/result.txt");
		expect(download.status).toBe(200);
		expect(await download.text()).toBe("evidence");

		const traversal = await api("/v1/plugins/com.example.recon/artifacts?path=../../host.json");
		expect(traversal.status).toBe(404);
	});

	test("uninstalls and leaves data behind unless purge is asked for", async () => {
		await api("/v1/plugins", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ manifest: manifest() }),
		});
		const response = await api("/v1/plugins/com.example.recon", { method: "DELETE" });
		expect(response.status).toBe(200);
		expect(readPluginRecord(join(root, "host"), "com.example.recon")).toBeNull();
	});

	test("reports the host's Docker version and mode", async () => {
		const response = await api("/v1/host");
		const body = (await response.json()) as { mode: string; docker: { ok: boolean; version?: string } };
		expect(body.mode).toBe("local");
		expect(body.docker).toEqual({ ok: true, version: "27.0.0" });
	});
});
