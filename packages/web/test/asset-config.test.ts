/**
 * Unit tests for the asset-mapping configuration: normalization, the 0600 file,
 * the write-only key, and the rule that only a verified platform is usable.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	assetConfigView,
	assetsJsonPath,
	isPlatformUsable,
	MAX_ASSET_SESSION_QUERY_LIMIT,
	normalizeAssetConfig,
	readAssetConfig,
	recordAssetStatus,
	saveAssetPlatform,
	setAssetQueryLimit,
	usablePlatforms,
	writeAssetConfig,
} from "../src/asset-config.ts";

let root = "";

function freshAgentDir(): string {
	root = mkdtempSync(join(tmpdir(), "sentinel-assets-"));
	return root;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

/** Mark one platform as probed and working. */
function verify(agentDir: string, platform: "fofa" | "quake" | "hunter"): void {
	recordAssetStatus(agentDir, platform, { at: Date.now(), ok: true, quota: "剩余 1 点" });
}

describe("normalizeAssetConfig", () => {
	test("a missing or unreadable file reads as nothing configured", () => {
		const agentDir = freshAgentDir();
		const config = readAssetConfig(agentDir);
		expect(config.platforms.fofa).toEqual({ enabled: false, key: "", status: { at: null, ok: true } });
		expect(usablePlatforms(agentDir)).toEqual([]);
	});

	test("a corrupt file reads as nothing configured rather than throwing", () => {
		const agentDir = freshAgentDir();
		writeFileSync(assetsJsonPath(agentDir), "{ not json");
		expect(readAssetConfig(agentDir).sessionQueryLimit).toBe(0);
	});

	test("clamps the query limit into range and treats negatives as unlimited", () => {
		expect(normalizeAssetConfig({ sessionQueryLimit: -5 }).sessionQueryLimit).toBe(0);
		expect(normalizeAssetConfig({ sessionQueryLimit: 12.7 }).sessionQueryLimit).toBe(12);
		expect(normalizeAssetConfig({ sessionQueryLimit: 10 ** 9 }).sessionQueryLimit).toBe(
			MAX_ASSET_SESSION_QUERY_LIMIT,
		);
		expect(normalizeAssetConfig({ sessionQueryLimit: "40" }).sessionQueryLimit).toBe(0);
	});

	test("drops an unknown platform and coerces a missing switch to off", () => {
		const config = normalizeAssetConfig({
			platforms: { fofa: { enabled: true, key: " k " }, shodan: { enabled: true, key: "x" } },
		});
		expect(config.platforms.fofa).toEqual({ enabled: true, key: "k", status: { at: null, ok: true } });
		expect(config.platforms.quake.enabled).toBe(false);
		expect(Object.keys(config.platforms).sort()).toEqual(["fofa", "hunter", "quake"]);
	});
});

describe("writeAssetConfig", () => {
	test("writes 0600 so the plaintext key is not world-readable", () => {
		const agentDir = freshAgentDir();
		writeAssetConfig(agentDir, normalizeAssetConfig({}));
		const mode = statSync(assetsJsonPath(agentDir)).mode & 0o777;
		expect(mode).toBe(0o600);
		expect(JSON.parse(readFileSync(assetsJsonPath(agentDir), "utf8")).version).toBe(1);
	});
});

describe("saveAssetPlatform", () => {
	test("key null keeps the stored key and a new value replaces it", () => {
		const agentDir = freshAgentDir();
		saveAssetPlatform(agentDir, { id: "fofa", enabled: true, key: "first" });
		// The password field is sent untouched on an unrelated save.
		saveAssetPlatform(agentDir, { id: "fofa", enabled: false, key: null });
		expect(readAssetConfig(agentDir).platforms.fofa.key).toBe("first");
		saveAssetPlatform(agentDir, { id: "fofa", enabled: true, key: "second" });
		expect(readAssetConfig(agentDir).platforms.fofa.key).toBe("second");
	});

	test("an empty string clears the stored key", () => {
		const agentDir = freshAgentDir();
		saveAssetPlatform(agentDir, { id: "quake", enabled: true, key: "k" });
		const view = saveAssetPlatform(agentDir, { id: "quake", enabled: true, key: "" });
		expect(view.platforms.find((platform) => platform.id === "quake")?.hasKey).toBe(false);
	});

	test("the view never carries the key itself", () => {
		const agentDir = freshAgentDir();
		const view = saveAssetPlatform(agentDir, { id: "hunter", enabled: true, key: "super-secret" });
		expect(JSON.stringify(view)).not.toContain("super-secret");
		expect(view.platforms.find((platform) => platform.id === "hunter")?.hasKey).toBe(true);
	});
});

describe("usability", () => {
	test("enabled and keyed is not enough: the platform must be verified", () => {
		const agentDir = freshAgentDir();
		saveAssetPlatform(agentDir, { id: "fofa", enabled: true, key: "k" });
		expect(usablePlatforms(agentDir)).toEqual([]);
		expect(assetConfigView(agentDir).usable).toBe(0);
		verify(agentDir, "fofa");
		expect(usablePlatforms(agentDir)).toEqual(["fofa"]);
		expect(assetConfigView(agentDir).usable).toBe(1);
	});

	test("a failed probe removes the platform from the tool set again", () => {
		const agentDir = freshAgentDir();
		saveAssetPlatform(agentDir, { id: "quake", enabled: true, key: "k" });
		verify(agentDir, "quake");
		expect(usablePlatforms(agentDir)).toEqual(["quake"]);
		recordAssetStatus(agentDir, "quake", { at: Date.now(), ok: false, error: "令牌无效" });
		expect(usablePlatforms(agentDir)).toEqual([]);
	});

	test("a platform switched off or unkeyed contributes nothing", () => {
		const agentDir = freshAgentDir();
		saveAssetPlatform(agentDir, { id: "hunter", enabled: true, key: "k" });
		verify(agentDir, "hunter");
		saveAssetPlatform(agentDir, { id: "hunter", enabled: false, key: null });
		expect(usablePlatforms(agentDir)).toEqual([]);
		const config = readAssetConfig(agentDir);
		expect(isPlatformUsable(config, "hunter")).toBe(false);
	});

	test("the platform order is fixed, whatever order they were configured in", () => {
		const agentDir = freshAgentDir();
		for (const id of ["hunter", "fofa", "quake"] as const) {
			saveAssetPlatform(agentDir, { id, enabled: true, key: "k" });
			verify(agentDir, id);
		}
		expect(usablePlatforms(agentDir)).toEqual(["fofa", "quake", "hunter"]);
	});
});

describe("setAssetQueryLimit", () => {
	test("stores a limit and reports it back", () => {
		const agentDir = freshAgentDir();
		expect(setAssetQueryLimit(agentDir, 25).sessionQueryLimit).toBe(25);
		expect(readAssetConfig(agentDir).sessionQueryLimit).toBe(25);
		expect(setAssetQueryLimit(agentDir, 0).sessionQueryLimit).toBe(0);
	});
});

describe("recordAssetStatus", () => {
	test("keeps the quota and the error so the settings page can show both", () => {
		const agentDir = freshAgentDir();
		saveAssetPlatform(agentDir, { id: "fofa", enabled: true, key: "k" });
		recordAssetStatus(agentDir, "fofa", {
			at: 1700000000000,
			ok: false,
			error: "[-700] 账号无效",
			quota: "剩余 0 点",
		});
		const status = assetConfigView(agentDir).platforms.find((platform) => platform.id === "fofa")?.status;
		expect(status).toEqual({ at: 1700000000000, ok: false, error: "[-700] 账号无效", quota: "剩余 0 点" });
	});
});

describe("a corrupt file is never overwritten", () => {
	test("recording a status leaves an unparseable file alone", () => {
		const agentDir = freshAgentDir();
		// A half-written file still holds the operator's keys; a status line is not
		// worth losing them, so the write is skipped rather than based on the
		// lenient empty read.
		writeFileSync(assetsJsonPath(agentDir), '{ "platforms": { "fofa": { "key": "keep-me" }');
		recordAssetStatus(agentDir, "fofa", { at: Date.now(), ok: false, error: "boom" });
		expect(readFileSync(assetsJsonPath(agentDir), "utf8")).toContain("keep-me");
	});

	test("an explicit save refuses instead of replacing the keys", () => {
		const agentDir = freshAgentDir();
		writeFileSync(assetsJsonPath(agentDir), "not json at all");
		expect(() => saveAssetPlatform(agentDir, { id: "fofa", enabled: true, key: "new" })).toThrow("无法解析");
		expect(() => setAssetQueryLimit(agentDir, 10)).toThrow("无法解析");
		expect(readFileSync(assetsJsonPath(agentDir), "utf8")).toBe("not json at all");
	});
});
