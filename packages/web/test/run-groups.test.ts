/**
 * Unit tests for the chat page's transcript shape: how messages group into runs
 * and when a run folds into its single "过程" row.
 *
 * The case that used to break: a compaction leaves the kept stretch with no
 * prompt in front of it, so the old rule ("only a run with a prompt folds") left
 * that stretch expanded with no row to close it.
 */

import { expect, test } from "vitest";
import { formatTokens, groupRuns, messageKey, runDigest, runFoldState } from "../webui/src/transcript.ts";
import type { AgentMessageView, ContentBlockView } from "../webui/src/types.ts";

const text = (value: string): ContentBlockView[] => [{ type: "text", text: value }];
const user = (value: string, timestamp: number): AgentMessageView => ({
	role: "user",
	content: text(value),
	timestamp,
});
const assistant = (
	value: string,
	timestamp: number,
	extra: Partial<{ errorMessage: string; stopReason: string }> = {},
) =>
	({
		role: "assistant",
		content: text(value),
		timestamp,
		...extra,
	}) as AgentMessageView;
const toolResult = (timestamp: number): AgentMessageView => ({
	role: "toolResult",
	toolCallId: `t${timestamp}`,
	toolName: "bash",
	content: text("output"),
	timestamp,
});
const marker = (summary: string, tokensBefore: number): AgentMessageView => ({
	role: "compactionSummary",
	summary,
	tokensBefore,
});

/** Fold state of one group, with nothing expanded and no run in flight. */
function fold(groups: ReturnType<typeof groupRuns>, index: number, expanded: string[] = [], streaming = false) {
	return runFoldState({ groups, index, streaming, expanded: new Set(expanded) });
}

test("groupRuns puts a prompt and its output in one run", () => {
	const groups = groupRuns([user("侦察 10.10.10.5", 1000), toolResult(2000), assistant("发现 22/80", 3000)]);
	expect(groups).toHaveLength(1);
	expect(groups[0].prompt).toMatchObject({ role: "user" });
	expect(groups[0].body).toHaveLength(2);
	expect(fold(groups, 0)).toEqual({ collapsed: true, digest: "1 次工具调用 · 2.0s" });
	expect(fold(groups, 0, [groups[0].key])).toEqual({ collapsed: false, digest: "1 次工具调用 · 2.0s" });
});

test("groupRuns keeps a compaction marker as its own group and folds what follows it", () => {
	const groups = groupRuns([
		user("侦察 10.10.10.5", 1000),
		assistant("开放 22/80", 2000),
		marker("已侦察 10.10.10.5", 42000),
		toolResult(3000),
		assistant("继续扫描 443", 4000),
	]);

	expect(groups.map((group) => group.marker?.role ?? group.prompt?.role ?? "head")).toEqual([
		"user",
		"compactionSummary",
		"head",
	]);
	// The marker never folds: it is the boundary, not a process step.
	expect(fold(groups, 1)).toBeUndefined();
	// The kept stretch folds even though its prompt is gone, and it still reports
	// its own elapsed time, measured from its first message.
	expect(fold(groups, 2)).toEqual({ collapsed: true, digest: "1 次工具调用 · 1.0s" });
});

test("groupRuns starts a new stretch after each marker", () => {
	const groups = groupRuns([
		user("a", 1000),
		marker("m1", 10),
		assistant("b", 2000),
		marker("m2", 20),
		assistant("c", 3000),
	]);
	expect(groups).toHaveLength(5);
	expect(groups[3].marker).toMatchObject({ summary: "m2" });
	expect(groups[4].body).toHaveLength(1);
});

test("runFoldState keeps failures and the run in flight visible", () => {
	const failed = groupRuns([user("a", 1000), assistant("出错了", 2000, { errorMessage: "boom" })]);
	expect(fold(failed, 0)).toBeUndefined();

	const aborted = groupRuns([user("a", 1000), assistant("中断", 2000, { stopReason: "aborted" })]);
	expect(fold(aborted, 0)).toBeUndefined();

	const running = groupRuns([user("a", 1000), assistant("进行中", 2000)]);
	expect(fold(running, 0, [], true)).toBeUndefined();
	// The same run folds once it settles.
	expect(fold(running, 0, [], false)).toEqual({ collapsed: true, digest: "1.0s" });

	// A run that ends on a tool result has not said anything yet.
	const silent = groupRuns([user("a", 1000), toolResult(2000)]);
	expect(fold(silent, 0)).toBeUndefined();
});

test("a run ending on a loop-guard notice still folds", () => {
	const notice = (timestamp: number): AgentMessageView => ({
		role: "custom",
		customType: "zg-loop-guard",
		content: text("【输出重复】上一次输出陷入了重复，已被提前中止。"),
		timestamp,
	});
	// The stutter nudge lands after the run settled: the aborted assistant before
	// it was a deliberate cut, and the notice card already explains it — the run
	// must fold instead of leaving every tool call expanded.
	const stuttered = groupRuns([
		user("侦察", 1000),
		toolResult(1500),
		assistant("进展如下", 2000, { stopReason: "aborted" }),
		notice(2500),
	]);
	const state = fold(stuttered, 0);
	expect(state).toEqual({ collapsed: true, digest: "1 次工具调用 · 1.5s" });
	expect(fold(stuttered, 0, [stuttered[0].key])).toEqual({ collapsed: false, digest: "1 次工具调用 · 1.5s" });

	// A notice without any substantive message in front of it still does not fold
	// (nothing to fold into a row).
	const bare = groupRuns([user("a", 1000), notice(2000)]);
	expect(fold(bare, 0)).toBeUndefined();

	// A real failure stays visible even with a notice after it.
	const broken = groupRuns([user("a", 1000), assistant("出错了", 2000, { errorMessage: "boom" }), notice(2500)]);
	expect(fold(broken, 0)).toBeUndefined();
});

test("runDigest counts thinking rounds and measures a stretch without a prompt", () => {
	const thinking = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "..." }, ...text("结论")],
		timestamp: 3000,
	} as AgentMessageView;
	const digest = runDigest(user("a", 1000), [thinking]);
	expect(digest).toBe("1 段思考 · 2.0s");
	expect(runDigest(undefined, [toolResult(1000), assistant("done", 4000)])).toBe("1 次工具调用 · 3.0s");
	// Nothing to report at all: the row still renders, with an empty digest.
	expect(runDigest(undefined, [toolResult(1000)])).toBe("1 次工具调用");
});

test("messageKey and formatTokens stay stable", () => {
	expect(messageKey({ role: "user", timestamp: 1000 })).toBe("user:1000");
	expect(messageKey({ role: "custom" })).toContain("custom:");
	expect(formatTokens(999)).toBe("999");
	expect(formatTokens(1500)).toBe("1.5k");
	expect(formatTokens(2500000)).toBe("2.5M");
});
