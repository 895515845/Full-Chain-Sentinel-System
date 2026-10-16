/**
 * Unit tests for the agent-facing asset tools: which tools exist, what the model
 * is shown, and what the session's query budget does.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import type { AssetSearchOptions, AssetSearchResult } from "../src/asset-platforms.ts";
import {
	type AssetQueryReport,
	type AssetToolContext,
	createAssetTools,
	writeAssetEvidence,
} from "../src/asset-tool.ts";
import type { SentinelAssetPlatform } from "../src/protocol.ts";

let root = "";

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

interface CallResult {
	content: { type?: string; text?: string }[];
	isError?: boolean;
	details?: Record<string, unknown>;
}

type CallableTool = {
	name: string;
	description: string;
	execute: (toolCallId: string, params: never) => Promise<CallResult>;
};

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		host: "one.one.one.one",
		ip: "1.1.1.1",
		port: 80,
		domain: "example.com",
		url: "",
		title: "后台",
		server: "cloudflare",
		protocol: "http",
		os: "",
		org: "Cloudflare, Inc.",
		country: "美国",
		province: "",
		city: "",
		updatedAt: "2026-10-16",
		banner: "HTTP/1.1 409 Conflict",
		...overrides,
	};
}

function result(platform: SentinelAssetPlatform, overrides: Partial<AssetSearchResult> = {}): AssetSearchResult {
	return {
		platform,
		query: "q",
		page: 1,
		size: 20,
		total: 67742,
		records: [record()] as unknown as AssetSearchResult["records"],
		raw: { hello: "world" },
		quota: "本次消耗 0 F 点",
		latencyMs: 42,
		...overrides,
	};
}

interface Harness {
	context: AssetToolContext;
	reports: AssetQueryReport[];
	calls: AssetSearchOptions[];
	spent: number;
	limit: number;
	evidence: Map<string, string>;
	withResult?: AssetSearchResult;
	withError?: Error;
}

/** A context that counts queries and can be told to succeed or throw. */
function harness(options: { limit?: number; evidence?: boolean } = {}): Harness {
	const state: Harness = {
		reports: [],
		calls: [],
		spent: 0,
		limit: options.limit ?? 0,
		evidence: new Map(),
		context: undefined as unknown as AssetToolContext,
	};
	state.context = {
		search: async (searchOptions) => {
			state.calls.push(searchOptions);
			if (state.withError) throw state.withError;
			return state.withResult ?? result(searchOptions.platform);
		},
		keyOf: () => "test-key",
		remaining: () => (state.limit === 0 ? null : Math.max(0, state.limit - state.spent)),
		consume: () => {
			if (state.limit !== 0 && state.spent >= state.limit) return false;
			state.spent += 1;
			return true;
		},
		saveEvidence: (name) => {
			if (options.evidence === false) return undefined;
			const path = `evidence/asset/${name}`;
			state.evidence.set(name, path);
			return path;
		},
		report: (report) => {
			state.reports.push(report);
		},
	};
	return state;
}

function tool(tools: ToolDefinition[], name: string): CallableTool {
	const found = tools.find((entry) => entry.name === name);
	if (!found) throw new Error(`no tool named ${name}`);
	return found as unknown as CallableTool;
}

function textOf(call: CallResult): string {
	return call.content.map((part) => part.text ?? "").join("\n");
}

test("one tool per requested platform, and none for a platform left out", () => {
	const state = harness();
	expect(createAssetTools([], state.context)).toEqual([]);
	const names = createAssetTools(["fofa", "quake", "hunter"], state.context).map((entry) => entry.name);
	expect(names).toEqual(["fofa_search", "quake_search", "hunter_search"]);
	const fofaOnly = createAssetTools(["fofa"], state.context).map((entry) => entry.name);
	expect(fofaOnly).toEqual(["fofa_search"]);
});

test("each tool names its own query dialect in the description", () => {
	const state = harness();
	const tools = createAssetTools(["fofa", "quake", "hunter"], state.context);
	// A model that swaps the dialects gets an empty page, not an error, so the
	// description is the only place the difference can be stated.
	expect(tool(tools, "fofa_search").description).toContain('ip="1.1.1.1"');
	expect(tool(tools, "quake_search").description).toContain('ip:"1.1.1.1"');
	expect(tool(tools, "hunter_search").description).toContain("Hunter has its own query language");
});

test("a successful search renders the fields, the quota and the evidence path", async () => {
	const state = harness({ limit: 5 });
	state.withResult = result("fofa");
	const call = await tool(createAssetTools(["fofa"], state.context), "fofa_search").execute("c1", {
		query: 'ip="1.1.1.1"',
	} as never);
	expect(call.isError).toBeFalsy();
	expect(call.details).toMatchObject({ ok: true, platform: "fofa", total: 67742, count: 1, remaining: 4 });
	const text = textOf(call);
	expect(text).toContain("FOFA 查询");
	expect(text).toContain("命中 67742 条");
	expect(text).toContain("1. 1.1.1.1:80");
	expect(text).toContain("domain=example.com");
	expect(text).toContain("title=后台");
	expect(text).toContain("banner: HTTP/1.1 409 Conflict");
	expect(text).toContain("额度：本次消耗 0 F 点");
	expect(text).toContain("原始响应已写入：evidence/asset/");
	expect(text).toContain("本会话剩余查询次数：4");
	// The page had 1 of 67742, so the model is told how to continue.
	expect(text).toContain("page=2");
	expect(state.reports).toHaveLength(1);
	expect(state.reports[0]).toMatchObject({ platform: "fofa", ok: true, total: 67742, count: 1, latencyMs: 42 });
	expect(state.calls[0]).toMatchObject({ platform: "fofa", key: "test-key", page: 1, size: 20 });
});

test("an empty page says it is not evidence of absence, and repeats the syntax", async () => {
	const state = harness();
	state.withResult = result("quake", { records: [], total: 0 });
	const call = await tool(createAssetTools(["quake"], state.context), "quake_search").execute("c1", {
		query: "domain:nothing.invalid",
	} as never);
	const text = textOf(call);
	expect(call.isError).toBeFalsy();
	expect(text).toContain("（本页没有记录）");
	expect(text).toContain("不能据此断定目标不存在");
	expect(text).toContain('ip:"1.1.1.1"');
});

test("a platform error is surfaced with its own message and the syntax reminder", async () => {
	const state = harness();
	state.withError = new Error("[-700] 账号无效");
	const call = await tool(createAssetTools(["hunter"], state.context), "hunter_search").execute("c1", {
		query: "x",
	} as never);
	expect(call.isError).toBe(true);
	expect(textOf(call)).toContain("[-700] 账号无效");
	// The failing platform is named, and its own syntax is repeated so the model
	// can tell a syntax mistake from a key problem.
	expect(textOf(call)).toContain("奇安信 Hunter 查询失败");
	expect(textOf(call)).toContain('web.title="后台"');
	expect(textOf(call)).toContain("设置 - 资产测绘");
	expect(state.reports[0]).toMatchObject({ platform: "hunter", ok: false, error: "[-700] 账号无效", count: 0 });
});

test("the session budget refuses the query instead of spending the operator's quota", async () => {
	const state = harness({ limit: 2 });
	const search = tool(createAssetTools(["fofa"], state.context), "fofa_search");
	await search.execute("c1", { query: "a" } as never);
	await search.execute("c2", { query: "b" } as never);
	const third = await search.execute("c3", { query: "c" } as never);
	expect(third.isError).toBe(true);
	expect(textOf(third)).toContain("查询预算已用完");
	// The refused call never reached the platform and was not logged as a query.
	expect(state.calls).toHaveLength(2);
	expect(state.reports).toHaveLength(2);
});

test("an empty query is refused before anything is sent", async () => {
	const state = harness();
	const call = await tool(createAssetTools(["fofa"], state.context), "fofa_search").execute("c1", {
		query: "   ",
	} as never);
	expect(call.isError).toBe(true);
	expect(textOf(call)).toContain("query 不能为空");
	expect(state.calls).toHaveLength(0);
});

test("a platform with no key never queries, even if it was mounted", async () => {
	const state = harness();
	state.context.keyOf = () => "";
	const call = await tool(createAssetTools(["fofa"], state.context), "fofa_search").execute("c1", {
		query: "x",
	} as never);
	expect(call.isError).toBe(true);
	expect(textOf(call)).toContain("未配置可用的 API Key");
	expect(state.calls).toHaveLength(0);
});

test("a long page is clipped but the closing notes survive", async () => {
	const state = harness();
	state.withResult = result("quake", {
		total: 500,
		records: Array.from({ length: 100 }, (_, index) =>
			record({ ip: `10.0.0.${index}`, banner: "x".repeat(400), title: "很长的标题".repeat(4) }),
		) as unknown as AssetSearchResult["records"],
	});
	const call = await tool(createAssetTools(["quake"], state.context), "quake_search").execute("c1", {
		query: "x",
		size: 100,
	} as never);
	const text = textOf(call);
	expect(text).toContain("输出已截断");
	// The quota, the evidence path and the "there is more" hint stay outside the clip.
	expect(text).toContain("额度：");
	expect(text).toContain("原始响应已写入：evidence/asset/");
	expect(text).toContain("page=2");
});

test("no evidence path is reported when the write failed", async () => {
	const state = harness({ evidence: false });
	const call = await tool(createAssetTools(["fofa"], state.context), "fofa_search").execute("c1", {
		query: "x",
	} as never);
	expect(textOf(call)).not.toContain("原始响应已写入");
	expect(call.details?.evidencePath).toBeUndefined();
	// The query itself still succeeded and was logged.
	expect(call.isError).toBeFalsy();
	expect(state.reports[0].evidencePath).toBeUndefined();
});

test("writeAssetEvidence writes the raw response and reports a work-relative path", () => {
	root = mkdtempSync(join(tmpdir(), "sentinel-asset-evidence-"));
	const path = writeAssetEvidence(root, "fofa-p1.json", { results: ["x"] });
	expect(path).toBe(join("evidence", "asset", "fofa-p1.json"));
	expect(JSON.parse(readFileSync(join(root, "evidence", "asset", "fofa-p1.json"), "utf8"))).toEqual({
		results: ["x"],
	});
});

test("writeAssetEvidence gives up quietly when the directory cannot be created", () => {
	root = mkdtempSync(join(tmpdir(), "sentinel-asset-evidence-"));
	// A file where the directory should go: mkdir fails, and the query must not.
	const blocker = join(root, "evidence");
	writeFileSync(blocker, "not a directory");
	expect(writeAssetEvidence(root, "fofa-p1.json", {})).toBeUndefined();
});
