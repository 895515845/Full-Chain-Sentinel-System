/**
 * Render smoke test for the sub-agent panel.
 *
 * The panel turns a run's flat event list into turns, rows, tabs and a filter.
 * A mistake in that shape (an unpaired tool end, an empty transcript, a call
 * still running) shows up as a crash or as missing text rather than as a type
 * error, and the panel has no other coverage because the console is not rendered
 * in the node test suite. So render it to static markup and read what came out.
 *
 * It lives next to the component rather than in `test/`: the root TypeScript
 * project has no JSX, so only the webui project can type-check a file that
 * imports a `.tsx` module.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { ZGSubagentEvent, ZGSubagentRun } from "../types.ts";
import { SubagentPanel } from "./SubagentPanel.tsx";

function run(overrides: Partial<ZGSubagentRun> = {}): ZGSubagentRun {
	return {
		id: "run-1",
		sessionId: "session-1",
		task: "recon the second target",
		status: "running",
		turns: 1,
		startedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function render(runs: ZGSubagentRun[], transcripts: Record<string, ZGSubagentEvent[]>): string {
	return renderToStaticMarkup(
		createElement(SubagentPanel, {
			runs,
			transcripts,
			onLoad: () => undefined,
			onAbort: () => undefined,
			onSteer: () => undefined,
		}),
	);
}

test("a live run renders its turns, tool rows and the step being executed", () => {
	const events: ZGSubagentEvent[] = [
		{ seq: 1, kind: "status", at: 100, status: "running", note: "子代理启动" },
		{ seq: 2, kind: "thinking", at: 200, text: "先看端口" },
		{ seq: 20, kind: "text", at: 250, text: "- 先记录目标\n- 再看端口" },
		{
			seq: 3,
			kind: "tool_start",
			at: 300,
			toolName: "bash",
			toolCallId: "a",
			args: { command: "nmap -sV 10.0.0.1" },
		},
		{
			seq: 4,
			kind: "tool_end",
			at: 3500,
			toolName: "bash",
			toolCallId: "a",
			output: "22/tcp open ssh",
			durationMs: 3200,
		},
		{ seq: 5, kind: "text", at: 3600, text: "## 继续\n\n下一步看 web 服务" },
		{ seq: 6, kind: "tool_start", at: 3700, toolName: "read", toolCallId: "b", args: { path: "/work/notes.txt" } },
		{
			seq: 7,
			kind: "tool_start",
			at: 3800,
			toolName: "bash",
			toolCallId: "c",
			args: { command: "curl -s http://10.0.0.1/" },
		},
		{
			seq: 8,
			kind: "tool_end",
			at: 4000,
			toolName: "bash",
			toolCallId: "c",
			output: "curl: (7) Failed to connect",
			isError: true,
			durationMs: 200,
		},
	];
	const html = render([run()], { "run-1": events });

	// The list on the left, the detail on the right.
	expect(html).toContain("recon the second target");
	expect(html).toContain("运行中");
	// One rail, one turn header with its own statistics.
	expect(html).toContain("subagent-process");
	expect(html).toContain("第 1 轮");
	expect(html).toContain("3 个工具");
	// A row reads as the tool and the argument that carries its point.
	expect(html).toContain("nmap -sV 10.0.0.1");
	expect(html).toContain("3.2s");
	expect(html).toContain("/work/notes.txt");
	// The call still running is the one left open, and its output is awaited.
	expect(html).toContain("等待输出…");
	// Thinking folds to its size, and prose folds to a clamped summary.
	expect(html).toContain("思考 · 4 字");
	// Earlier prose folds to a clamped summary; the latest one stays open.
	expect(html).toContain("sa-text-clamp");
	expect(html).toContain("sa-text open");
	// A failed step is marked on its row, counted on the tab and reachable from
	// the process toolbar.
	expect(html).toContain("sa-tool error");
	expect(html).toContain("1 个失败");
	expect(html).toContain("跳到第一个失败");
	expect(html).toContain("只看失败");
});

test("a finished run opens on its result, and the process is one tab away", () => {
	const events: ZGSubagentEvent[] = [
		{ seq: 1, kind: "tool_start", at: 100, toolName: "bash", toolCallId: "a", args: { command: "id" } },
		{
			seq: 2,
			kind: "tool_end",
			at: 200,
			toolName: "bash",
			toolCallId: "a",
			output: "uid=0(root)",
			isError: true,
			durationMs: 100,
		},
		{ seq: 3, kind: "turn", at: 300, text: "第 1 轮" },
	];
	const finished = run({ status: "done", endedAt: "2026-01-01T00:01:23.000Z", result: "## 结论\n\n未发现可用入口" });
	const html = render([finished], { "run-1": events });

	expect(html).toContain("已完成");
	expect(html).toContain("1m23s");
	// The result tab is what opens for a finished run.
	expect(html).toContain("未发现可用入口");
	// Its failure is still visible from there, on the process tab.
	expect(html).toContain("1 个失败");
	expect(html).not.toContain("跳到第一个失败");
});

test("a run with no process loaded yet says so instead of rendering an empty list", () => {
	const html = render([run()], {});
	expect(html).toContain("暂无过程记录");
});

test("with no dispatches the panel explains what would fill it", () => {
	const html = render([], {});
	expect(html).toContain("spawn_agent");
});
