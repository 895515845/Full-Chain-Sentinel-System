/**
 * Unit tests for the audit trail's pass-through half: 「自动审批」.
 *
 * The failure mode this file exists for is duplication and silence at once. A
 * call must land in exactly one bucket — if the tool gate records a judged MCP
 * call and this extension records it too, the two tabs double-count; if neither
 * records it, the call vanishes from the audit trail entirely. Every assertion
 * below is therefore about the row count in the store, not about a return value.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeGatekeeperConfig } from "../src/gatekeeper-config.ts";
import { GatekeeperStore } from "../src/gatekeeper-store.ts";
import type { SentinelGatekeeperConfig, SentinelMode } from "../src/protocol.ts";
import { createToolAuditExtension } from "../src/tool-audit.ts";
import type { ToolGateContext } from "../src/tool-gate.ts";
import { createToolGateExtension } from "../src/tool-gate.ts";
import { writeTestModel } from "./model-fixtures.ts";

let root = "";
let agentDir = "";
let store: GatekeeperStore;

const CONFIG: SentinelGatekeeperConfig = {
	mode: "ai",
	timeoutMs: 15_000,
	concurrency: 0,
	mcpTools: { enabled: true, includePlugins: true },
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-tool-audit-"));
	agentDir = join(root, "agent");
	store = new GatekeeperStore(join(root, "gatekeeper.db"));
	writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
	writeGatekeeperConfig(agentDir, CONFIG);
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * The audit handler on its own, plus the gate handler with the same context.
 *
 * Both are needed in most cases: what the audit recorder must skip is decided
 * by what the gate is about to judge, and the only honest way to test that is
 * to run the same event through the same pair of extensions the session mounts.
 */
function handlersFor(mode: SentinelMode): {
	audit: (event: ToolCallEvent) => unknown;
	gate: (event: ToolCallEvent) => Promise<unknown>;
} {
	const context: ToolGateContext = {
		label: () => "主代理",
		modeOf: () => mode,
		projectId: "p1",
		projectName: "项目一",
		sessionId: () => "s1",
	};
	let audit: ((event: ToolCallEvent) => unknown) | undefined;
	let gate: ((event: ToolCallEvent) => Promise<unknown>) | undefined;
	// Stands in for the real judge, including its side effect: a judged call is
	// recorded by the gate itself, approval "ai". Only the row the real guard
	// would have written matters here.
	const gatekeeper = {
		guard: async (input: { tool: string; source: string; sessionId: string | null }) => {
			store.record({
				at: Date.now(),
				projectId: "p1",
				projectName: "项目一",
				sessionId: input.sessionId,
				source: input.source,
				tool: input.tool,
				command: "{}",
				cwd: null,
				approval: "ai",
				decision: "allow",
				latencyMs: 100,
			});
			return { kind: "allow" as const, record: undefined };
		},
	};
	const pi = {
		on: (name: string, fn: (event: unknown) => unknown) => {
			if (name !== "tool_call") return () => {};
			if (fn === undefined) return () => {};
			// Registration order tells the two apart: the gate is registered first
			// by createSessionContext, so the first handler is its handler.
			if (!gate) gate = fn as (event: ToolCallEvent) => Promise<unknown>;
			else if (!audit) audit = fn as (event: ToolCallEvent) => unknown;
			return () => {};
		},
	};
	createToolGateExtension({ gatekeeper: gatekeeper as never, agentDir, context })(pi as never);
	createToolAuditExtension({ store, agentDir, context })(pi as never);
	if (!audit || !gate) throw new Error("the tool_call handlers were not registered");
	return { audit, gate };
}

describe("createToolAuditExtension", () => {
	test("records one row for an unjudged built-in tool", () => {
		const { audit } = handlersFor("auto");
		expect(audit({ toolName: "read", input: { path: "/etc/passwd" } })).toBeUndefined();
		const rows = store.list(undefined).items;
		expect(rows.length).toBe(1);
		expect(rows[0].tool).toBe("read");
		expect(rows[0].approval).toBe("auto");
		expect(rows[0].decision).toBe("allow");
		expect(rows[0].command).toBe('{"path":"/etc/passwd"}');
		expect(rows[0].source).toBe("主代理");
		expect(rows[0].sessionId).toBe("s1");
	});

	test("stays out of bash's way: bash records itself where the answer is known", () => {
		// A row written here would have to guess the 审批模式 verdict, and a
		// rejected command would be filed as an allow.
		const { audit } = handlersFor("review");
		audit({ toolName: "bash", input: { command: "id" } });
		audit({ toolName: "droid_shell", input: { command: "id" } });
		expect(store.list(undefined).total).toBe(0);
	});

	test("does not double-record a call the judge will record", async () => {
		// Both extensions are mounted on one session, so the pair has to agree:
		// the gate records, the audit stays quiet.
		const { audit, gate } = handlersFor("ai");
		const event: ToolCallEvent = {
			toolName: "mcp__plugin-com-sentinel-vshell__execute_command",
			input: { command: "id" },
		};
		await gate(event);
		audit(event);
		expect(store.list(undefined).total).toBe(1);
		expect(store.list(undefined).items[0].approval).toBe("ai");
	});

	test("records an MCP call the judge does not cover, in every mode", () => {
		// With the MCP switch off, the judge never sees these; without this
		// extension they would leave no trace at all.
		writeGatekeeperConfig(agentDir, { ...CONFIG, mcpTools: { enabled: false, includePlugins: true } });
		const { audit } = handlersFor("ai");
		audit({ toolName: "mcp__plugin-com-sentinel-vshell__execute_command", input: { command: "id" } });
		expect(store.list({ approval: ["auto"] }).total).toBe(1);
	});

	test("records a plugin tool that the includePlugins switch leaves out", () => {
		writeGatekeeperConfig(agentDir, { ...CONFIG, mcpTools: { enabled: true, includePlugins: false } });
		const { audit } = handlersFor("ai");
		audit({ toolName: "mcp__plugin-com-sentinel-vshell__execute_command", input: { command: "id" } });
		expect(store.list({ approval: ["auto"] }).total).toBe(1);
	});

	test("records a custom MCP server's tool while the judge is disabled", () => {
		const { audit } = handlersFor("auto");
		audit({ toolName: "mcp__files__read_file", input: { path: "/etc/hosts" } });
		const rows = store.list({ approval: ["auto"] }).items;
		expect(rows.length).toBe(1);
		expect(rows[0].tool).toBe("mcp__files__read_file");
		// The server part is kept: it is what tells a plugin tool from a custom one.
		expect(rows[0].tool.startsWith("mcp__files__")).toBe(true);
	});

	test("never blocks: every call returns undefined", () => {
		const { audit } = handlersFor("review");
		for (const toolName of ["bash", "droid_shell", "read", "write", "edit", "mcp__files__read_file", "tool_search"]) {
			expect(audit({ toolName, input: {} })).toBeUndefined();
		}
	});
});
