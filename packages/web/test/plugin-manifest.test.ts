/**
 * The manifest is the whole plugin contract, so its parser is tested at the
 * boundaries the installer relies on: a digest, a source link, and a config
 * form that the console can render without guessing.
 */

import { describe, expect, test } from "vitest";
import {
	parsePluginManifest,
	pluginConfigEnv,
	pluginKey,
	pluginMemoryBytes,
	pluginServerName,
	validatePluginConfig,
} from "../src/plugin-manifest.ts";

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: 1,
		id: "com.example.recon",
		name: "侦察工具集",
		version: "0.1.0",
		description: "subfinder 与 naabu",
		author: "github:someone",
		source: "https://github.com/someone/sentinel-plugin-recon",
		license: "MIT",
		build: { dockerfile: "Dockerfile", context: "." },
		mcp: { transport: "http", port: 7801, path: "/mcp" },
		permissions: { network: "bridge" },
		locality: "any",
		...overrides,
	};
}

describe("parsePluginManifest", () => {
	test("fills every default and keeps the declared fields", () => {
		const result = parsePluginManifest(validManifest());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.manifest.id).toBe("com.example.recon");
		expect(result.manifest.mcp).toEqual({
			transport: "http",
			port: 7801,
			path: "/mcp",
			startupTimeoutMs: 20000,
			requestTimeoutMs: 300000,
		});
		expect(result.manifest.build).toEqual({ dockerfile: "Dockerfile", context: ".", args: {} });
		expect(result.manifest.permissions).toEqual({ network: "bridge", capAdd: [], privileged: false });
		expect(result.manifest.resources).toEqual({ cpus: 1, memory: "512m", pidsLimit: 256 });
		expect(result.manifest.healthcheck.path).toBe("/healthz");
		expect(result.manifest.artifacts.path).toBe("/artifacts");
	});

	test("rejects the old image field", () => {
		const result = parsePluginManifest(validManifest({ image: `ghcr.io/someone/recon@sha256:${"a".repeat(64)}` }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toContain("不再支持 image");
	});

	test("rejects a build path that leaves the package", () => {
		for (const overrides of [
			{ build: { dockerfile: "/Dockerfile", context: "." } },
			{ build: { dockerfile: "../Dockerfile", context: "." } },
			{ build: { dockerfile: "Dockerfile", context: "../" } },
			{ build: { dockerfile: ".", context: "." } },
		]) {
			expect(parsePluginManifest(validManifest(overrides)).ok, JSON.stringify(overrides)).toBe(false);
		}
	});

	test("rejects a missing source, because only open plugins are distributed", () => {
		const result = parsePluginManifest(validManifest({ source: "" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toContain("source");
	});

	test("rejects an id that is not reverse-DNS", () => {
		for (const id of ["recon", "Com.Example.Recon", "com..recon", "com.example.recon!"]) {
			const result = parsePluginManifest(validManifest({ id }));
			expect(result.ok, id).toBe(false);
		}
	});

	test("rejects a non-semver version", () => {
		for (const version of ["1", "0.1", "v0.1.0", "0.1.0.0"]) {
			expect(parsePluginManifest(validManifest({ version })).ok, version).toBe(false);
		}
	});

	test("rejects config keys the shell could not receive", () => {
		const result = parsePluginManifest(
			validManifest({ config: [{ key: "api-key", label: "Key", type: "secret", required: true }] }),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toContain("config.key");
	});

	test("rejects an enum without options and a default outside them", () => {
		const missing = parsePluginManifest(
			validManifest({ config: [{ key: "MODE", label: "模式", type: "enum", required: true }] }),
		);
		expect(missing.ok).toBe(false);

		const outside = parsePluginManifest(
			validManifest({
				config: [{ key: "MODE", label: "模式", type: "enum", required: false, default: "c", options: ["a", "b"] }],
			}),
		);
		expect(outside.ok).toBe(false);
	});

	test("rejects duplicate config keys", () => {
		const result = parsePluginManifest(
			validManifest({
				config: [
					{ key: "TOKEN", label: "A", type: "string", required: false },
					{ key: "TOKEN", label: "B", type: "string", required: false },
				],
			}),
		);
		expect(result.ok).toBe(false);
	});

	test("caps cpus above the host policy", () => {
		const result = parsePluginManifest(validManifest({ resources: { cpus: 8 } }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toContain("resources.cpus");
	});

	test("rejects a memory string that is not a Docker size", () => {
		expect(parsePluginManifest(validManifest({ resources: { memory: "a lot" } })).ok).toBe(false);
		expect(parsePluginManifest(validManifest({ resources: { memory: "1G" } })).ok).toBe(true);
	});

	test("rejects stdio and sse, which the plugin author must convert to HTTP", () => {
		for (const transport of ["stdio", "sse"]) {
			const result = parsePluginManifest(validManifest({ mcp: { transport, port: 7801, path: "/mcp" } }));
			expect(result.ok, transport).toBe(false);
			if (result.ok) continue;
			expect(result.errors.join("\n")).toContain("streamable HTTP");
		}
	});

	test("bounds requestTimeoutMs and keeps a valid one", () => {
		const tooSmall = parsePluginManifest(
			validManifest({ mcp: { transport: "http", port: 7801, path: "/mcp", requestTimeoutMs: 1000 } }),
		);
		expect(tooSmall.ok).toBe(false);
		const tooLarge = parsePluginManifest(
			validManifest({ mcp: { transport: "http", port: 7801, path: "/mcp", requestTimeoutMs: 3600000 } }),
		);
		expect(tooLarge.ok).toBe(false);
		const valid = parsePluginManifest(
			validManifest({ mcp: { transport: "http", port: 7801, path: "/mcp", requestTimeoutMs: 600000 } }),
		);
		expect(valid.ok && valid.manifest.mcp.requestTimeoutMs).toBe(600000);
	});

	test("accepts an optional frontend and defaults its title", () => {
		const result = parsePluginManifest(validManifest({ ui: { entry: "/ui/index.html", protocol: 1 } }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.manifest.ui).toEqual({
			entry: "/ui/index.html",
			title: "侦察工具集",
			protocol: 1,
		});
		expect(parsePluginManifest(validManifest()).ok).toBe(true);
		const without = parsePluginManifest(validManifest());
		expect(without.ok && without.manifest.ui).toBeNull();
	});

	test("rejects a frontend entry that is not an absolute html path", () => {
		for (const entry of ["ui/index.html", "/ui/app.js", "/ui/../index.html", "/ui/index html.html"]) {
			const result = parsePluginManifest(validManifest({ ui: { entry, protocol: 1 } }));
			expect(result.ok, entry).toBe(false);
		}
	});

	test("rejects an unknown bridge protocol and direct network access", () => {
		expect(parsePluginManifest(validManifest({ ui: { entry: "/ui/index.html", protocol: 2 } })).ok).toBe(false);
		expect(
			parsePluginManifest(validManifest({ ui: { entry: "/ui/index.html", protocol: 1, network: true } })).ok,
		).toBe(false);
	});

	test("rejects a relative artifacts path", () => {
		expect(parsePluginManifest(validManifest({ artifacts: { path: "artifacts" } })).ok).toBe(false);
	});

	test("reports every problem at once", () => {
		const result = parsePluginManifest(validManifest({ id: "", version: "", license: "" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.length).toBeGreaterThanOrEqual(3);
	});
});

describe("derived names", () => {
	test("server names keep the MCP character set", () => {
		expect(pluginServerName("com.example.recon")).toBe("plugin-com-example-recon");
		expect(pluginServerName("io.acme.scan_v2")).toBe("plugin-io-acme-scan-v2");
		expect(pluginServerName("com.example.recon")).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	test("a plugin key is unique per host", () => {
		expect(pluginKey("vps-1", "com.example.recon")).toBe("vps-1/com.example.recon");
	});

	test("memory sizes convert to bytes", () => {
		expect(pluginMemoryBytes("512m")).toBe(512 * 1024 * 1024);
		expect(pluginMemoryBytes("1g")).toBe(1024 * 1024 * 1024);
		expect(pluginMemoryBytes("1024")).toBeNull();
	});
});

describe("pluginConfigEnv", () => {
	const fields = [
		{
			key: "RATE",
			label: "速率",
			type: "number" as const,
			required: false,
			default: null,
			options: [],
			description: "",
		},
		{
			key: "API_KEY",
			label: "Key",
			type: "secret" as const,
			required: true,
			default: null,
			options: [],
			description: "",
		},
	];

	test("prefixes keys and skips empty values", () => {
		expect(pluginConfigEnv(fields, { RATE: "100" })).toEqual({ PLUGIN_RATE: "100" });
	});
});

describe("validatePluginConfig", () => {
	const fields = [
		{
			key: "RATE",
			label: "速率",
			type: "number" as const,
			required: false,
			default: null,
			options: [],
			description: "",
		},
		{
			key: "API_KEY",
			label: "Key",
			type: "secret" as const,
			required: true,
			default: null,
			options: [],
			description: "",
		},
		{
			key: "MODE",
			label: "模式",
			type: "enum" as const,
			required: false,
			default: null,
			options: ["fast", "safe"],
			description: "",
		},
	];

	test("accepts a complete save", () => {
		expect(validatePluginConfig(fields, { RATE: "100", API_KEY: "k", MODE: "fast" })).toBeUndefined();
	});

	test("refuses unknown keys", () => {
		expect(validatePluginConfig(fields, { OTHER: "x" })).toContain("未知");
	});

	test("requires a missing secret unless the stored one is kept", () => {
		expect(validatePluginConfig(fields, { RATE: "1" })).toContain("不能为空");
		expect(validatePluginConfig(fields, { RATE: "1" }, { keepSecrets: new Set(["API_KEY"]) })).toBeUndefined();
	});

	test("rejects a number that does not parse and an enum outside its options", () => {
		expect(validatePluginConfig(fields, { API_KEY: "k", RATE: "fast" })).toContain("数字");
		expect(validatePluginConfig(fields, { API_KEY: "k", MODE: "turbo" })).toContain("选择");
	});
});
