/**
 * Unit tests for the sub-agent process shape.
 *
 * The server stores a run as a flat, append-only event list, and the panel has
 * to turn that into turns with one row per tool call. What these pin: a
 * `tool_start`/`tool_end` pair folds into a single row (with the duration the
 * server now records), a `turn` marker closes the turn whose events came before
 * it, and whatever trails the last marker is the turn still in flight.
 */

import { expect, test } from "vitest";
import {
	buildTurns,
	durationOf,
	formatMs,
	plainText,
	type ToolStep,
	toolSummary,
} from "../webui/src/subagent-process.ts";
import type { SentinelSubagentEvent, SentinelSubagentRun } from "../webui/src/types.ts";

function step(
	seq: number,
	at: number,
	kind: SentinelSubagentEvent["kind"],
	extra: Partial<SentinelSubagentEvent> = {},
): SentinelSubagentEvent {
	return { seq, kind, at, ...extra };
}

test("a tool call folds into one row, with its duration and outcome", () => {
	const turns = buildTurns([
		step(1, 1000, "tool_start", { toolName: "bash", toolCallId: "a", args: { command: "nmap -sV 10.0.0.1" } }),
		step(2, 4200, "tool_end", { toolName: "bash", toolCallId: "a", output: "22/tcp open ssh", durationMs: 3200 }),
		step(3, 5000, "tool_start", { toolName: "bash", toolCallId: "b", args: { command: "sleep 999" } }),
		step(4, 9000, "turn", { text: "第 1 轮" }),
	]);

	expect(turns).toHaveLength(1);
	const turn = turns[0];
	expect(turn?.index).toBe(1);
	expect(turn?.steps).toHaveLength(2);
	expect(turn?.tools).toBe(2);
	expect(turn?.failures).toBe(0);
	expect(turn?.durationMs).toBe(8000);

	const [done, running] = turn?.steps as [ToolStep, ToolStep];
	expect(done).toMatchObject({
		kind: "tool",
		name: "bash",
		summary: "nmap -sV 10.0.0.1",
		output: "22/tcp open ssh",
		isError: false,
		running: false,
		durationMs: 3200,
	});
	// A call whose end has not arrived is the step being executed right now.
	expect(running).toMatchObject({ name: "bash", running: true, output: "" });
});

test("a turn marker closes the turn before it; the tail is the turn in flight", () => {
	const turns = buildTurns([
		step(1, 100, "text", { text: "开始侦察" }),
		step(2, 200, "turn", { text: "第 1 轮" }),
		step(3, 300, "tool_start", { toolName: "read", toolCallId: "a", args: { path: "/work/a.txt" } }),
		step(4, 400, "tool_end", { toolName: "read", toolCallId: "a", output: "boom", isError: true, durationMs: 100 }),
		step(5, 500, "turn", { text: "第 2 轮" }),
		step(6, 600, "text", { text: "继续" }),
	]);

	expect(turns.map((turn) => turn.index)).toEqual([1, 2, 3]);
	// The read pair is one row, so the second turn holds a single step.
	expect(turns.map((turn) => turn.steps.length)).toEqual([1, 1, 1]);
	expect(turns[0]?.tools).toBe(0);
	expect(turns[1]?.failures).toBe(1);
	expect(turns[1]?.durationMs).toBe(200);
	expect(turns[2]?.durationMs).toBe(0);
});

test("an unpaired tool end is still shown, and thinking and status notes survive", () => {
	const turns = buildTurns([
		step(1, 100, "thinking", { text: "先看端口" }),
		step(2, 200, "tool_end", { toolName: "grep", toolCallId: "orphan", output: "3 hits", isError: false }),
		step(3, 300, "status", { status: "running", note: "已达轮次上限（15），中止子代理" }),
	]);

	expect(turns).toHaveLength(1);
	expect(turns[0]?.steps.map((entry) => entry.kind)).toEqual(["thinking", "tool", "status"]);
	const tool = turns[0]?.steps[1] as ToolStep;
	expect(tool).toMatchObject({ name: "grep", running: false, output: "3 hits" });
	expect(turns[0]?.steps[2]).toMatchObject({ kind: "status", note: "已达轮次上限（15），中止子代理" });
});

test("a tool row reads as the argument that carries the point of the call", () => {
	expect(toolSummary("bash", { command: "cd /work && nmap -sV 10.0.0.1\nsecond line" }, "", "done")).toBe(
		"cd /work && nmap -sV 10.0.0.1",
	);
	expect(toolSummary("read", { path: "/work/recon.txt" }, "", "done")).toBe("/work/recon.txt");
	expect(toolSummary("grep", { pattern: "password", path: "/work/src" }, "", "done")).toBe("password /work/src");
	// A tool nobody listed falls back to its first scalar argument, not to JSON.
	expect(toolSummary("mcp__custom__ping", { host: "10.0.0.1", retries: 3 }, "", "done")).toBe("10.0.0.1");
	// A call with no arguments says where it got to, or what it returned.
	expect(toolSummary("ping", undefined, "line one\nstill running", "running")).toBe("still running");
	expect(toolSummary("ping", undefined, "first line\nrest", "done")).toBe("first line");
	expect(toolSummary("bash", { command: "x".repeat(200) }, "", "done")).toHaveLength(131);
});

test("collapsed prose drops the markdown that would read as noise", () => {
	expect(plainText("## 侦察结果\n\n- **22/tcp** open `ssh`\n```bash\nnmap -sV\n```")).toBe(
		"侦察结果\n\n22/tcp open ssh\nnmap -sV",
	);
});

test("durations read in the unit that fits, and a running run has none", () => {
	expect(formatMs(420)).toBe("420ms");
	expect(formatMs(3200)).toBe("3.2s");
	expect(formatMs(83_000)).toBe("1m23s");
	expect(formatMs(Number.NaN)).toBe("");
	const run: SentinelSubagentRun = {
		id: "r1",
		sessionId: "s1",
		task: "recon",
		status: "running",
		turns: 1,
		startedAt: "2026-01-01T00:00:00.000Z",
	};
	expect(durationOf(run)).toBe("");
	expect(durationOf({ ...run, endedAt: "2026-01-01T00:01:23.000Z" })).toBe("1m23s");
});
