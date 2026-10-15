/**
 * Unit tests for business modeling: the two tools, the per-session state, the
 * loadout rule, and the two markers.
 *
 * The invariant these tests exist for: the model always knows modeling exists,
 * but never starts it on its own. That rests on two things, and each is checked
 * here — both tools declare `defaultActive: true` and open their description and
 * guidelines by saying not to call them unless the operator asked, and the first
 * submission opens a run while `api_model_done` still refuses without one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
	createApiModelAttachTools,
	createApiModelTools,
	type ModelingAttachPort,
	type ModelingPort,
} from "../src/apimodel-tool.ts";
import { ApiModelStore } from "../src/apimodels.ts";
import {
	buildModelingAttachMessage,
	buildModelingBrief,
	buildModelingCatalog,
	buildModelingEndMessage,
	MODELING_ATTACH_CUSTOM_TYPE,
	MODELING_ATTACH_MESSAGE_CUSTOM_TYPE,
	MODELING_MESSAGE_CUSTOM_TYPE,
	MODELING_STATE_CUSTOM_TYPE,
	MODELING_TOOLS,
	modelingAttachFromEntry,
	modelingRunFromEntry,
	modelingState,
	modelingToolLoadout,
	readModelingAttach,
	readModelingRun,
} from "../src/modeling.ts";

interface CallResult {
	content: { type?: string; text?: string }[];
	isError?: boolean;
	details?: Record<string, unknown>;
}

type CallableTool = {
	name: string;
	defaultActive?: boolean;
	description?: string;
	promptGuidelines?: string[];
	execute: (toolCallId: string, params: never) => Promise<CallResult>;
};

function toolOf(tools: ToolDefinition[], name: string): CallableTool {
	const found = tools.find((tool) => tool.name === name);
	if (!found) throw new Error(`tool ${name} is not mounted`);
	return found as unknown as CallableTool;
}

function textOf(result: CallResult): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

let dir: string;
let counter = 0;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "zg-modeling-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** The port's submit, backed by the real store, the way the runtime wires it. */
function submitInto(store: ApiModelStore, runId: () => string): ModelingPort["submit"] {
	return (input) => {
		const result = store.submit(runId(), input);
		const model = result.model;
		if (!model) return { ok: false, errors: result.errors ?? ["提交失败。"] };
		return {
			ok: true,
			pathCount: model.pathCount,
			operationCount: model.operationCount,
			entityCount: model.entities.length,
			warnings: result.errors ?? [],
		};
	};
}

/**
 * A port backed by the real store, the way the runtime wires it: the store owns
 * the document and the counters, the port only translates.
 */
function harness(): {
	store: ApiModelStore;
	tools: ToolDefinition[];
	run: { runId: string; target: string };
	done: string[];
} {
	const store = new ApiModelStore(join(dir, `modeling-${counter++}.db`));
	const run = store.beginRun({ projectId: "p1", sessionId: "s1", sessionPath: null, title: "商城" });
	const live: { runId: string; target: string } | undefined = { runId: run.id, target: "" };
	const done: string[] = [];
	const port: ModelingPort = {
		current: () => live,
		ensureRun: () => live,
		submit: submitInto(store, () => live.runId),
		done: (summary) => {
			done.push(summary);
		},
	};
	return { store, tools: createApiModelTools(port), run: live, done };
}

test("both tools are declared everywhere, and say when not to call them", () => {
	const { tools } = harness();
	for (const name of MODELING_TOOLS) {
		const tool = toolOf(tools, name);
		expect(tool.defaultActive).toBe(true);
		// The guard is the wording, not the absence of the tool: the description and
		// the first guideline both tell the model not to call it unasked.
		expect(tool.description).toContain("if the user does not need business modeling, do not call this tool");
		expect(tool.promptGuidelines?.[0]).toContain("do not call this tool");
	}
	expect(tools.map((tool) => tool.name)).toEqual([...MODELING_TOOLS]);
});

test("the loadout rule always carries the two run tools and toggles the read tool", () => {
	const base = ["read", "bash", "edit", "write", "session_title"];
	// Whatever the session state, the run tools are in the set: that is what lets
	// the operator start modeling by asking for it in the conversation.
	expect(modelingToolLoadout(base, false)).toEqual([...base, ...MODELING_TOOLS]);
	expect(modelingToolLoadout(base, true)).toEqual([...base, ...MODELING_TOOLS, "api_model_read"]);
	// A loadout that already carries them is not duplicated, and the rest keeps its order.
	expect(modelingToolLoadout([...base, ...MODELING_TOOLS], false)).toEqual([...base, ...MODELING_TOOLS]);
	// A loadout restored from an older transcript (which declared them off) gets them back.
	expect(modelingToolLoadout(["read"], false)).toEqual(["read", ...MODELING_TOOLS]);
	// A stale loadout from an older transcript cannot keep the read tool alive.
	expect(modelingToolLoadout([...base, "api_model_read"], false)).toEqual([...base, ...MODELING_TOOLS]);
});

test("a submission with no run opens one, and the record shows it", async () => {
	const store = new ApiModelStore(join(dir, `modeling-open-${counter++}.db`));
	let live: { runId: string; target: string } | undefined;
	const port: ModelingPort = {
		current: () => live,
		ensureRun: () => {
			if (live) return live;
			const record = store.beginRun({ projectId: "p1", sessionId: "s1", sessionPath: null, title: "商城" });
			live = { runId: record.id, target: "" };
			return live;
		},
		submit: submitInto(store, () => {
			if (!live) throw new Error("submit ran before ensureRun opened the run");
			return live.runId;
		}),
		done: () => {
			throw new Error("done must not be reached");
		},
	};
	const tools = createApiModelTools(port);
	const result = await toolOf(tools, "api_model_submit").execute("call-1", {
		paths: { "/a": { get: {} } },
		target: "https://shop.example.com",
	} as never);
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("路径 1 个");
	const records = store.list({ projectId: "p1" });
	expect(records).toHaveLength(1);
	expect(records[0].status).toBe("modeling");
	expect(records[0].submissions).toBe(1);
	expect(records[0].target).toBe("https://shop.example.com");
});

test("api_model_done refuses without a live run", async () => {
	const store = new ApiModelStore(join(dir, `modeling-orphan-${counter++}.db`));
	const port: ModelingPort = {
		current: () => undefined,
		ensureRun: () => {
			throw new Error("ensureRun must not be reached by done");
		},
		submit: () => {
			throw new Error("submit must not be reached");
		},
		done: () => {
			throw new Error("done must not be reached");
		},
	};
	const orphaned = createApiModelTools(port);
	const done = await toolOf(orphaned, "api_model_done").execute("call-2", { summary: "完成" } as never);
	expect(done.isError).toBe(true);
	expect(textOf(done)).toContain("没有进行中的业务建模");
	expect(store.list({ projectId: "p1" })).toEqual([]);
	expect(orphaned.length).toBe(2);
});

test("a whole document submitted through the tool is stored and counted", async () => {
	const { tools, store, run } = harness();
	const result = await toolOf(tools, "api_model_submit").execute("call-1", {
		openapi: { openapi: "3.0.3", info: { title: "商城", version: "1.0.0" }, paths: { "/a": { get: {}, post: {} } } },
		target: "https://shop.example.com",
		entities: [{ name: "订单", relations: [{ target: "用户" }] }],
	} as never);
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("路径 1 个，操作 2 个，业务实体 1 个");
	const stored = store.get(run.runId) as NonNullable<ReturnType<ApiModelStore["get"]>>;
	expect(stored.target).toBe("https://shop.example.com");
	expect(stored.entities[0].name).toBe("订单");
});

test("shards merge into one document, and an empty document says so", async () => {
	const { tools, store, run } = harness();
	const submit = toolOf(tools, "api_model_submit");
	await submit.execute("call-1", { paths: { "/users": { get: {} } } } as never);
	const second = await submit.execute("call-2", { paths: { "/orders": { get: {}, post: {} } } } as never);
	expect(textOf(second)).toContain("路径 2 个，操作 3 个");
	const stored = store.get(run.runId) as NonNullable<ReturnType<ApiModelStore["get"]>>;
	expect(Object.keys(stored.openapi.paths as Record<string, unknown>)).toEqual(["/users", "/orders"]);

	// An empty skeleton is accepted, but on a document with no operations yet the
	// tool tells the model to keep going rather than treating it as done.
	const fresh = harness();
	const skeleton = await toolOf(fresh.tools, "api_model_submit").execute("call-1", {
		components: { schemas: { User: { type: "object" } } },
	} as never);
	expect(skeleton.isError).toBeFalsy();
	expect(textOf(skeleton)).toContain("还没有任何接口");
});

test("a refused document comes back with the reasons to fix", async () => {
	const { tools, store, run } = harness();
	const result = await toolOf(tools, "api_model_submit").execute("call-1", {
		openapi: { openapi: "2.0", info: {}, paths: { users: {} } },
	} as never);
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("提交被拒绝");
	expect(textOf(result)).toContain("openapi 版本 2.0 不受支持");
	expect(textOf(result)).toContain("info.title 不能为空");
	expect(textOf(result)).toContain("paths 的键必须以 / 开头");
	expect(store.get(run.runId)?.submissions).toBe(0);
});

test("entity problems are warnings, not a refusal", async () => {
	const { tools } = harness();
	const result = await toolOf(tools, "api_model_submit").execute("call-1", {
		paths: { "/a": { get: {} } },
		entities: [{ description: "没有名字" }],
	} as never);
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("路径 1 个");
	expect(textOf(result)).toContain("entities[0] 缺少 name");
});

test("the done tool needs a summary and reports it once", async () => {
	const { tools, done } = harness();
	const empty = await toolOf(tools, "api_model_done").execute("call-1", { summary: "   " } as never);
	expect(empty.isError).toBe(true);
	expect(done).toEqual([]);

	const result = await toolOf(tools, "api_model_done").execute("call-2", {
		summary: "覆盖用户与订单，支付未覆盖",
	} as never);
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("业务建模已结束");
	expect(done).toEqual(["覆盖用户与订单，支付未覆盖"]);
});

test("the run survives on the branch, and null clears it", () => {
	const entry = {
		type: "custom",
		customType: MODELING_STATE_CUSTOM_TYPE,
		data: { runId: "api-1", target: "https://a", startedAt: 5 },
	};
	expect(readModelingRun([{ type: "message" }, entry])).toEqual({ runId: "api-1", target: "https://a", startedAt: 5 });
	// The last entry wins: appending null is how a run ends.
	expect(readModelingRun([entry, { type: "custom", customType: MODELING_STATE_CUSTOM_TYPE, data: null }])).toBeNull();
	expect(readModelingRun([{ type: "custom", customType: "zg-mode", data: { mode: "auto" } }])).toBeNull();
	// A foreign or malformed entry never starts a run.
	expect(
		readModelingRun([{ type: "custom", customType: MODELING_STATE_CUSTOM_TYPE, data: { target: "x" } }]),
	).toBeNull();
	expect(modelingRunFromEntry(undefined)).toBeUndefined();
	expect(modelingRunFromEntry("nope")).toBeUndefined();
	expect(modelingRunFromEntry(null)).toBeNull();
	expect(modelingRunFromEntry({ runId: "api-2" })).toEqual({
		runId: "api-2",
		target: "",
		startedAt: expect.any(Number),
	});
});

test("the brief names both tools and the discipline; the closing marker says how it ended", () => {
	const brief = buildModelingBrief("https://shop.example.com", "商城项目");
	expect(brief.startsWith("【业务建模】")).toBe(true);
	expect(brief).toContain("https://shop.example.com");
	expect(brief).toContain("api_model_submit");
	expect(brief).toContain("api_model_done");
	expect(brief).toContain("目标不明确时先问操作员一句");
	expect(brief).toContain("不要把真实凭据");

	// Without an explicit target the project and the conversation are the source.
	const scoped = buildModelingBrief("", "商城项目");
	expect(scoped).toContain("以当前项目「商城项目」和本次会话里已经确认的目标为准");

	const closed = buildModelingEndMessage({
		status: "done",
		pathCount: 4,
		operationCount: 9,
		entityCount: 3,
		note: "覆盖订单",
	});
	expect(closed.startsWith("【业务建模 · 结束】")).toBe(true);
	expect(closed).toContain("已记录 4 个路径 / 9 个操作 / 3 个业务实体");
	expect(closed).toContain("覆盖订单");
	expect(MODELING_MESSAGE_CUSTOM_TYPE).toBe("zg-modeling");
});

test("the snapshot state carries the live counters", () => {
	const state = modelingState(
		{ runId: "api-1", target: "https://a", startedAt: 0 },
		{
			title: "商城",
			pathCount: 2,
			operationCount: 5,
			entityCount: 1,
		},
	);
	expect(state).toEqual({
		runId: "api-1",
		title: "商城",
		target: "https://a",
		startedAt: "1970-01-01T00:00:00.000Z",
		pathCount: 2,
		operationCount: 5,
		entityCount: 1,
	});
});

test("the attach state rides the branch like the run state does", () => {
	const attach = { type: "custom", customType: MODELING_ATTACH_CUSTOM_TYPE, data: { ids: ["api-1", "api-2"], at: 5 } };
	expect(readModelingAttach([attach])).toEqual({ ids: ["api-1", "api-2"], at: 5 });
	// The last entry wins; appending null clears.
	expect(
		readModelingAttach([attach, { type: "custom", customType: MODELING_ATTACH_CUSTOM_TYPE, data: null }]),
	).toBeNull();
	// Garbage never attaches anything: an empty or malformed list is not a state.
	expect(
		readModelingAttach([{ type: "custom", customType: MODELING_ATTACH_CUSTOM_TYPE, data: { ids: [] } }]),
	).toBeNull();
	expect(
		readModelingAttach([{ type: "custom", customType: MODELING_ATTACH_CUSTOM_TYPE, data: { ids: "api-1" } }]),
	).toBeNull();
	expect(modelingAttachFromEntry({ ids: ["api-1", 5, "api-2"] })).toEqual({
		ids: ["api-1", "api-2"],
		at: expect.any(Number),
	});
});

test("the catalog is an index: paths and entities, no parameters, and it names the read tool", () => {
	const catalog = buildModelingCatalog([
		{
			id: "api-1",
			title: "商城前台",
			target: "https://shop.example.com",
			pathCount: 2,
			operationCount: 3,
			endpoints: [
				{ method: "get", path: "/api/users", summary: "用户列表" },
				{ method: "post", path: "/api/users", summary: "" },
			],
			entities: [
				{
					name: "用户",
					description: "登录主体",
					fields: [{ name: "id" }, { name: "status" }],
					relations: [{ target: "订单", kind: "1:N" }],
				},
			],
		},
	]);
	expect(catalog).toContain("## 商城前台（https://shop.example.com） [id: api-1]");
	expect(catalog).toContain("- GET /api/users — 用户列表");
	expect(catalog).toContain("- POST /api/users");
	expect(catalog).toContain("- 用户：登录主体（字段：id, status）；关系：1:N 订单");
	expect(catalog).toContain("api_model_read");
	// The endpoint lines carry no invented parameter detail — only what the document's summaries say.
	expect(catalog.split("## ")[1]?.split("业务实体")[0]).not.toContain("password");
});

test("a stack of huge records is truncated, not dropped into the context whole", () => {
	const catalog = buildModelingCatalog(
		Array.from({ length: 40 }, (_, index) => ({
			id: `api-${index}`,
			title: `记录 ${index}`,
			target: "",
			pathCount: 200,
			operationCount: 200,
			endpoints: Array.from({ length: 200 }, (__, endpoint) => ({
				method: "get",
				path: `/api/mod${index}/res${endpoint}`,
				summary: "一行说明".repeat(8),
			})),
			entities: [],
		})),
	);
	expect(catalog.length).toBeLessThan(20_000);
	expect(catalog).toContain("目录过长已截断");
	expect(catalog.endsWith("不要凭目录猜字段。")).toBe(true);
});

test("the attach marker names the records and the removal marker states the removal", () => {
	expect(buildModelingAttachMessage(["商城前台", "后台接口"])).toContain("已带入 2 份");
	expect(buildModelingAttachMessage(["商城前台"])).toContain("商城前台");
	expect(MODELING_ATTACH_MESSAGE_CUSTOM_TYPE).toBe("zg-modeling-attach");
	expect(MODELING_ATTACH_CUSTOM_TYPE).toBe("zg-modeling-attach-state");
});

test("modeling on a session with attached records briefs an incremental run", () => {
	const plain = buildModelingBrief("", "商城项目");
	expect(plain).not.toContain("增量建模");
	const incremental = buildModelingBrief("", "商城项目", [{ title: "商城前台", pathCount: 187 }]);
	expect(incremental).toContain("增量建模");
	expect(incremental).toContain("已带有 1 份此前还原的建模记录（商城前台 187 路径）");
	expect(incremental).toContain("不要从零重做");
});

test("the read tool lists, reads, and refuses what is not attached", async () => {
	const attached = [
		{ id: "api-1", title: "商城前台" },
		{ id: "api-2", title: "后台接口" },
	];
	const port: ModelingAttachPort = {
		attached: () => attached,
		read: (id) =>
			id === "api-1"
				? {
						title: "商城前台",
						document: {
							openapi: "3.0.3",
							info: { title: "x", version: "1" },
							paths: { "/a": { get: { summary: "y" } } },
						},
						entities: [{ name: "用户" }],
					}
				: undefined,
	};
	const read = toolOf(createApiModelAttachTools(port), "api_model_read");
	expect(read.defaultActive).toBe(false);

	const list = await read.execute("call-1", {} as never);
	expect(list.isError).toBeFalsy();
	expect(textOf(list)).toContain("已带入 2 份建模记录");
	expect(textOf(list)).toContain("[id: api-2]");

	const full = await read.execute("call-2", { id: "api-1" } as never);
	expect(textOf(full)).toContain("3.0.3");
	expect(textOf(full)).toContain("/a");
	// A record another conversation attached is not readable here.
	const stranger = await read.execute("call-3", { id: "api-3" } as never);
	expect(stranger.isError).toBe(true);
	expect(textOf(stranger)).toContain("不在本会话带入的记录里");

	const empty = createApiModelAttachTools({ attached: () => [], read: () => undefined });
	const none = await toolOf(empty, "api_model_read").execute("call-4", {} as never);
	expect(none.isError).toBe(true);
	expect(textOf(none)).toContain("没有带入业务建模记录");
});
