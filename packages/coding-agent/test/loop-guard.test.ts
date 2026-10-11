import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import {
	canonicalizeArguments,
	RepeatChain,
	StutterDetector,
	wildcardToRegExp,
} from "../src/extensions/loop-guard/detect.ts";
import loopGuardExtension, { LOOP_GUARD_CUSTOM_TYPE } from "../src/extensions/loop-guard/index.ts";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		timestamp: Date.now(),
	};
}

function createContext(): ExtensionContext {
	return {
		mode: "print",
		hasUI: false,
		ui: {} as ExtensionContext["ui"],
		cwd: process.cwd(),
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
		compact: vi.fn(),
		getSystemPrompt: () => "",
	};
}

type Handler = (event: never, ctx: ExtensionContext) => unknown;

/** What the extension can return from a handler, narrowed enough for assertions. */
interface Emitted {
	continue?: boolean;
	entries?: { customType?: string; content?: string; display?: boolean; details?: unknown }[];
	message?: AssistantMessage;
}

/** A `pi.sendMessage` call, as the extension makes it. */
type SentMessage = [
	{ customType?: string; content?: string; display?: boolean; details?: unknown },
	{ triggerTurn?: boolean } | undefined,
];

function createApi(): {
	api: ExtensionAPI;
	sendMessage: ReturnType<typeof vi.fn>;
	emit: (event: string, payload: unknown, ctx: ExtensionContext) => Promise<Emitted>;
} {
	const handlers = new Map<string, Handler[]>();
	const sendMessage = vi.fn();
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		sendMessage,
	} as unknown as ExtensionAPI;
	const emit = async (event: string, payload: unknown, ctx: ExtensionContext): Promise<Emitted> => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			const value = await handler(payload as never, ctx);
			if (value !== undefined) result = value;
		}
		return (result ?? {}) as Emitted;
	};
	return { api, sendMessage, emit };
}

/** Stream a message's text in small chunks, the way the provider does. */
async function stream(
	emit: (event: string, payload: unknown, ctx: ExtensionContext) => Promise<Emitted>,
	message: AssistantMessage,
	ctx: ExtensionContext,
): Promise<void> {
	const full = (message.content[0] as { text: string }).text;
	for (let length = 8; length < full.length; length += 8) {
		(message.content[0] as { text: string }).text = full.slice(0, length);
		await emit("message_update", { type: "message_update", message }, ctx);
	}
	(message.content[0] as { text: string }).text = full;
	await emit("message_update", { type: "message_update", message }, ctx);
}

describe("StutterDetector", () => {
	test("trips on a line repeated with blank lines between the repeats", () => {
		const detector = new StutterDetector();
		const text = `分析结果如下：\n\n${"Kingston.\n\n".repeat(10)}`;
		expect(detector.push(text)).toEqual({
			kind: "lines",
			preview: "Kingston.",
			count: 6,
			offset: "分析结果如下：\n\n".length,
		});
	});

	test("trips on a cycle that never reaches a newline", () => {
		const detector = new StutterDetector();
		const text = `前缀说明。${"**(c".repeat(200)}`;
		const signal = detector.push(text);
		expect(signal?.kind).toBe("cycle");
		expect(signal?.count).toBeGreaterThanOrEqual(12);
	});

	test("leaves ordinary prose alone", () => {
		const detector = new StutterDetector();
		const text = [
			"先看 swagger，再看登录接口。",
			"",
			"curl -s http://10.0.0.1/api/query",
			"返回 200，但 body 是空的。",
			"接着试 /api/dynamic。",
		].join("\n");
		expect(detector.push(text)).toBeUndefined();
	});

	test("reset clears the run", () => {
		const detector = new StutterDetector();
		detector.push("same\nsame\nsame\n");
		detector.reset();
		expect(detector.push("same\nsame\nsame\nsame\nsame\n")).toBeUndefined();
	});
});

describe("RepeatChain", () => {
	test("reports the configured thresholds and resets on a different call", () => {
		const chain = new RepeatChain();
		expect(chain.observe("bash", { command: "ls" })).toBeUndefined();
		expect(chain.observe("bash", { command: "ls" })).toBeUndefined();
		expect(chain.observe("bash", { command: "ls" })).toEqual({
			count: 3,
			canonical: '{"command":"ls"}',
			detailed: false,
		});
		expect(chain.observe("bash", { command: "ls" })).toBeUndefined();
		expect(chain.observe("bash", { command: "ls" })?.detailed).toBe(true);
		expect(chain.observe("bash", { command: "id" })).toBeUndefined();
		expect(chain.observe("bash", { command: "id" })).toBeUndefined();
		expect(chain.observe("bash", { command: "id" })?.count).toBe(3);
	});

	test("compares arguments independently of key order", () => {
		const chain = new RepeatChain();
		chain.observe("bash", { command: "ls", timeout: 5 });
		chain.observe("bash", { timeout: 5, command: "ls" });
		expect(chain.observe("bash", { timeout: 5, command: "ls" })?.count).toBe(3);
		expect(canonicalizeArguments({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
	});

	test("untracked tools are transparent", () => {
		const chain = new RepeatChain({ thresholds: [3], include: [], exclude: ["vuln_*"] });
		chain.observe("bash", { command: "ls" });
		chain.observe("bash", { command: "ls" });
		chain.observe("vuln_list", { target: "10.0.0.1" });
		chain.observe("vuln_list", { target: "10.0.0.1" });
		expect(chain.observe("bash", { command: "ls" })?.count).toBe(3);
	});

	test("wildcard patterns match the whole tool name", () => {
		expect(wildcardToRegExp("vuln_*").test("vuln_submit")).toBe(true);
		expect(wildcardToRegExp("vuln_*").test("x_vuln_submit")).toBe(false);
	});
});

describe("loop-guard extension", () => {
	test("aborts a stuttering stream, trims the tail, and nudges with a new run", async () => {
		const { api, sendMessage, emit } = createApi();
		loopGuardExtension(api);
		const ctx = createContext();
		const message = assistantMessage(`分析结果如下：\n\n${"Kingston.\n\n".repeat(10)}`);

		await emit("message_start", { type: "message_start", message }, ctx);
		await stream(emit, message, ctx);
		expect(ctx.abort).toHaveBeenCalledTimes(1);

		const ended = await emit("message_end", { type: "message_end", message }, ctx);
		const trimmed = (ended.message?.content ?? []).map((block) => ("text" in block ? block.text : "")).join("");
		expect(trimmed).not.toContain("Kingston.");
		expect(trimmed).toContain("分析结果如下：");
		expect(trimmed).toContain("[输出因重复被中止，尾部已截断]");

		// The nudge is not a boundary draft: an aborted run ignores those.
		expect((await emit("turn_end", { type: "turn_end", entries: [], context: {} }, ctx)).entries).toBeUndefined();

		await emit("agent_settled", { type: "agent_settled", aborted: true }, ctx);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const [draft, options] = sendMessage.mock.calls[0] as SentMessage;
		expect(draft.customType).toBe(LOOP_GUARD_CUSTOM_TYPE);
		expect(draft.content).toContain("【输出重复】");
		expect(draft.display).toBe(true);
		expect(options?.triggerTurn).toBe(true);
	});

	test("stops starting new runs after three nudges", async () => {
		const { api, sendMessage, emit } = createApi();
		loopGuardExtension(api);
		const ctx = createContext();
		const triggers: boolean[] = [];
		for (let round = 0; round < 4; round += 1) {
			const message = assistantMessage(`第 ${round} 轮：\n${"loop.\n".repeat(10)}`);
			await emit("message_start", { type: "message_start", message }, ctx);
			await stream(emit, message, ctx);
			await emit("message_end", { type: "message_end", message }, ctx);
			await emit("agent_settled", { type: "agent_settled", aborted: true }, ctx);
			const call = sendMessage.mock.calls.at(-1) as SentMessage | undefined;
			triggers.push(call?.[1]?.triggerTurn === true);
		}
		expect(triggers).toEqual([true, true, true, false]);
	});

	test("reminds on a repeated tool call at the turn boundary", async () => {
		const { api, emit } = createApi();
		loopGuardExtension(api);
		const ctx = createContext();
		const call = { type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: { command: "ls" } };
		await emit("tool_execution_start", call, ctx);
		await emit("tool_execution_start", call, ctx);
		expect((await emit("turn_end", { type: "turn_end", entries: [], context: {} }, ctx)).entries).toBeUndefined();
		await emit("tool_execution_start", call, ctx);

		const boundary = await emit("turn_end", { type: "turn_end", entries: [], context: {} }, ctx);
		expect(boundary.continue).toBeUndefined();
		expect(boundary.entries).toHaveLength(1);
		expect(boundary.entries?.[0].content).toContain("【重复工具调用】");
		expect(boundary.entries?.[0].details).toEqual({
			kind: "repeat",
			tool: "bash",
			count: 3,
			arguments: '{"command":"ls"}',
		});
	});

	test("an operator prompt resets the tool chain", async () => {
		const { api, emit } = createApi();
		loopGuardExtension(api);
		const ctx = createContext();
		const call = { type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: { command: "ls" } };
		await emit("tool_execution_start", call, ctx);
		await emit("tool_execution_start", call, ctx);
		await emit("message_start", { type: "message_start", message: { role: "user" } }, ctx);
		await emit("tool_execution_start", call, ctx);
		expect((await emit("turn_end", { type: "turn_end", entries: [], context: {} }, ctx)).entries).toBeUndefined();
	});
});
