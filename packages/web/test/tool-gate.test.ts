/**
 * Unit tests for the tool-call gate: which calls it judges, and what it does
 * with each verdict.
 *
 * The interesting failure mode is silence. A gate that decides not to judge
 * looks exactly like a gate that allowed the call, so every switch — mode,
 * MCP on/off, plugins in/out — is asserted by watching whether the judge was
 * consulted at all, not just by the return value.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Gatekeeper, JudgeCallResult } from "../src/gatekeeper.ts";
import { parseGateVerdict, Gatekeeper as RealGatekeeper } from "../src/gatekeeper.ts";
import { writeGatekeeperConfig } from "../src/gatekeeper-config.ts";
import { GatekeeperStore } from "../src/gatekeeper-store.ts";
import type { SentinelGatekeeperConfig } from "../src/protocol.ts";
import {
	createToolGateExtension,
	isPluginTool,
	mcpToolServer,
	shouldJudgeTool,
	stringifyToolArgs,
} from "../src/tool-gate.ts";
import { writeTestModel } from "./model-fixtures.ts";

let root = "";
let agentDir = "";
let store: GatekeeperStore;

/** Switches live in gatekeeper.json; the mode comes from the session, not the file. */
const CONFIG: SentinelGatekeeperConfig = {
	mode: "ai",
	timeoutMs: 15_000,
	concurrency: 0,
	mcpTools: { enabled: true, includePlugins: true },
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-tool-gate-"));
	agentDir = join(root, "agent");
	store = new GatekeeperStore(join(root, "gatekeeper.db"));
	writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
	writeGatekeeperConfig(agentDir, CONFIG);
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

/** Answers with a fixed line and counts how often it was asked. */
function stubbed(): { gatekeeper: Gatekeeper; calls: () => number } {
	const gatekeeper = new RealGatekeeper(store, { onDecision: () => {} }, agentDir);
	let count = 0;
	gatekeeper.call = async (_config, _input, _signal): Promise<JudgeCallResult> => {
		count += 1;
		const raw = "ALLOW";
		return { verdict: parseGateVerdict(raw), raw };
	};
	return { gatekeeper, calls: () => count };
}

describe("tool names", () => {
	test("splits an MCP tool name into its server", () => {
		expect(mcpToolServer("mcp__plugin-com-sentinel-vshell__execute_command")).toBe("plugin-com-sentinel-vshell");
		expect(mcpToolServer("mcp__files__read_file")).toBe("files");
	});

	test("does not mistake built-in tools for MCP ones", () => {
		for (const name of ["bash", "read", "write", "edit", "vuln_submit", "mcp_", "mcp__noseparator"]) {
			expect(mcpToolServer(name)).toBeNull();
		}
	});

	test("recognizes plugin-host servers by their prefix", () => {
		expect(isPluginTool("mcp__plugin-com-sentinel-vshell__execute_command")).toBe(true);
		expect(isPluginTool("mcp__files__read_file")).toBe(false);
		expect(isPluginTool("bash")).toBe(false);
	});
});

describe("shouldJudgeTool", () => {
	test("judges MCP calls in ai mode only", () => {
		const toolName = "mcp__files__read_file";
		expect(shouldJudgeTool({ toolName, mode: "ai", config: CONFIG })).toBe(true);
		for (const mode of ["auto", "review"] as const) {
			expect(shouldJudgeTool({ toolName, mode, config: CONFIG })).toBe(false);
		}
	});

	test("leaves bash alone: it is judged at its own entrance", () => {
		expect(shouldJudgeTool({ toolName: "bash", mode: "ai", config: CONFIG })).toBe(false);
		expect(shouldJudgeTool({ toolName: "droid_shell", mode: "ai", config: CONFIG })).toBe(false);
	});

	test("honors the master switch", () => {
		const config = { ...CONFIG, mcpTools: { enabled: false, includePlugins: true } };
		expect(shouldJudgeTool({ toolName: "mcp__files__read_file", mode: "ai", config })).toBe(false);
	});

	test("plugins need the second switch, custom MCP servers do not", () => {
		const config = { ...CONFIG, mcpTools: { enabled: true, includePlugins: false } };
		expect(shouldJudgeTool({ toolName: "mcp__files__read_file", mode: "ai", config })).toBe(true);
		expect(
			shouldJudgeTool({ toolName: "mcp__plugin-com-sentinel-vshell__execute_command", mode: "ai", config }),
		).toBe(false);
	});
});

describe("stringifyToolArgs", () => {
	test("keeps the JSON shape the judge is told to expect", () => {
		expect(stringifyToolArgs({ host_id: "h1", command: "id" })).toBe('{"host_id":"h1","command":"id"}');
		expect(stringifyToolArgs(undefined)).toBe("{}");
	});

	test("survives an argument object JSON cannot represent", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(typeof stringifyToolArgs(cyclic)).toBe("string");
	});
});

describe("createToolGateExtension", () => {
	/** Register the extension against a fake pi and return its tool_call handler. */
	function handlerFor(
		gatekeeper: Gatekeeper,
	): (event: {
		toolName: string;
		input: Record<string, unknown>;
	}) => Promise<{ block?: boolean; reason?: string } | undefined> {
		let handler: ((event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>) | undefined;
		const pi = {
			on: (name: string, fn: (event: unknown) => Promise<unknown>) => {
				if (name === "tool_call") handler = fn;
				return () => {};
			},
		};
		createToolGateExtension({
			gatekeeper,
			agentDir,
			context: {
				label: () => "主代理",
				modeOf: () => "ai",
				projectId: "p1",
				projectName: "项目",
				sessionId: () => "s1",
			},
		})(pi as never);
		if (!handler) throw new Error("tool_call handler was not registered");
		return handler;
	}

	test("allows a call the judge allows, and records it", async () => {
		const { gatekeeper, calls } = stubbed();
		const outcome = await handlerFor(gatekeeper)({
			toolName: "mcp__plugin-com-sentinel-vshell__execute_command",
			input: { host_id: "h1", command: "id" },
		});
		expect(outcome).toBeUndefined();
		expect(calls()).toBe(1);
		const record = store.list(undefined).items[0];
		expect(record.tool).toBe("mcp__plugin-com-sentinel-vshell__execute_command");
		expect(record.source).toBe("主代理");
		expect(record.command).toContain('"command":"id"');
	});

	test("blocks with the reason the model then reads", async () => {
		const { gatekeeper } = stubbed();
		gatekeeper.call = async (): Promise<JudgeCallResult> => ({
			verdict: { decision: "block", reason: "删除业务数据，命中第 4 条" },
			raw: "BLOCK:删除业务数据，命中第 4 条",
		});
		const outcome = await handlerFor(gatekeeper)({
			toolName: "mcp__plugin-com-sentinel-vshell__delete_file",
			input: { host_id: "h1", path: "/data/orders" },
		});
		expect(outcome?.block).toBe(true);
		expect(outcome?.reason).toContain("守门员拦截");
		expect(outcome?.reason).toContain("删除业务数据");
	});

	test("allows through when the judge fails, and records the failure", async () => {
		const { gatekeeper } = stubbed();
		gatekeeper.call = async () => {
			throw new Error("端点返回 500");
		};
		const outcome = await handlerFor(gatekeeper)({
			toolName: "mcp__files__read_file",
			input: { path: "/etc/hosts" },
		});
		expect(outcome).toBeUndefined();
		expect(store.list(undefined).items[0].decision).toBe("failed");
	});

	test("never asks the judge about bash", async () => {
		const { gatekeeper, calls } = stubbed();
		await handlerFor(gatekeeper)({ toolName: "bash", input: { command: "id" } });
		expect(calls()).toBe(0);
		expect(store.list(undefined).total).toBe(0);
	});

	test("never asks the judge when the switch is off", async () => {
		writeGatekeeperConfig(agentDir, { ...CONFIG, mcpTools: { enabled: false, includePlugins: true } });
		const { gatekeeper, calls } = stubbed();
		await handlerFor(gatekeeper)({ toolName: "mcp__files__read_file", input: { path: "/etc/hosts" } });
		expect(calls()).toBe(0);
	});

	test("skips plugin tools unless they are included", async () => {
		writeGatekeeperConfig(agentDir, { ...CONFIG, mcpTools: { enabled: true, includePlugins: false } });
		const { gatekeeper, calls } = stubbed();
		await handlerFor(gatekeeper)({ toolName: "mcp__plugin-com-sentinel-vshell__execute_command", input: {} });
		expect(calls()).toBe(0);
	});
});
