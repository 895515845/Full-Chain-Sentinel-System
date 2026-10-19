/**
 * The floating window is the only live surface for supervision. These static
 * assertions pin the parts an operator must always see: state, mode, a pending
 * advice card, recent calls, logs, and the explicit stop control.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SupervisorFloatingWindow } from "./SupervisorFloatingWindow.tsx";
import type { SentinelSupervisorAdvice, SentinelSupervisorView } from "../types.ts";

function view(overrides: Partial<SentinelSupervisorView> = {}): SentinelSupervisorView {
	return {
		sessionId: "s1",
		sessionPath: "/tmp/s1.jsonl",
		sessionName: "测试会话",
		projectId: "p1",
		projectName: "项目一",
		mode: "intervene",
		delivery: "confirm",
		strategy: "offensive",
		strategyCustomId: null,
		strategyName: "红队推进",
		strategyInstructions: "",
		strategyNote: "优先看横向",
		status: "running",
		armedAt: 1,
		startedAt: 2,
		endedAt: null,
		model: { entryId: "m1", entryName: "监督模型", modelId: "supervisor-model", followedMain: false },
		state: {
			phase: "vuln_mapping",
			intent: "重复测试 /api/user 的 SQLi",
			progress: "looping",
			tested: [],
			deadEnds: ["/api/user?id 的 SQLi"],
			newEvidence: [],
			openQuestions: [],
			nextCandidates: [],
			duplicateSignals: [],
		},
		episodeCount: 1,
		callCount: 20,
		lastEpisodeAt: 3,
		lastCallAt: 4,
		usage: { input: 10, output: 5, total: 15 },
		lastError: null,
		running: false,
		pendingAdvice: null,
		recentCalls: [
			{
				callId: "c1",
				at: 4,
				tool: "bash",
				args: "curl /api/user?id=1",
				status: "ok",
				durationMs: 10,
				outputBytes: 100,
				outputHash: "h",
				outputHead: "HTTP/1.1 200 OK",
				outputTail: "",
				httpStatus: 200,
				newEndpoints: [],
				newParams: [],
				newEvidence: false,
				signals: ["http:200"],
			},
		],
		logs: [{ at: 4, kind: "trigger", text: "开始分析" }],
		...overrides,
	};
}

function advice(overrides: Partial<SentinelSupervisorAdvice> = {}): SentinelSupervisorAdvice {
	return {
		id: "adv1",
		sessionId: "s1",
		episodeId: "ep1",
		at: 5,
		delivery: "confirm",
		status: "pending",
		text: "【监督建议 · 非操作员指令】\n不要重复：SQLi",
		sentAt: null,
		...overrides,
	};
}

function render(current: SentinelSupervisorView): string {
	return renderToStaticMarkup(
		<SupervisorFloatingWindow
			view={current}
			episodes={[
				{
					id: "ep1",
					sessionId: "s1",
					seq: 1,
					at: 3,
					trigger: "duplicate",
					phase: "vuln_mapping",
					intent: "重复测试 SQLi",
					actions: [],
					outcomes: ["响应无差异"],
					tested: [],
					deadEnds: ["SQLi"],
					newEvidence: [],
					openQuestions: [],
					nextCandidates: [],
					duplicateSignals: [],
					progress: "looping",
					confidence: 0.8,
					advice: null,
					model: "stub",
					usage: { input: 1, output: 1, total: 2 },
					error: null,
					durationMs: 10,
				},
			]}
			logs={[{ at: 4, kind: "episode", text: "episode 完成" }]}
			onHide={() => {}}
			onStop={() => {}}
			onRunNow={() => {}}
			onSetMode={() => {}}
			onSetStrategy={() => {}}
			customStrategies={[]}
			onOpenCall={() => {}}
			onSendAdvice={() => {}}
			onIgnoreAdvice={() => {}}
		/>,
	);
}

describe("SupervisorFloatingWindow", () => {
	test("shows the live state, mode buttons and the explicit stop control", () => {
		const html = render(view());
		expect(html).toContain("监督");
		expect(html).toContain("漏洞验证");
		expect(html).toContain("循环");
		expect(html).toContain("红队推进");
		expect(html).toContain("优先看横向");
		expect(html).toContain("观察");
		expect(html).toContain("介入 · 自动");
		expect(html).toContain("介入 · 确认");
		expect(html).toContain("停止监督");
		expect(html).toContain("收起");
		expect(html).toContain("完整输出");
	});

	test("a pending advice renders send and ignore actions", () => {
		const html = render(view({ pendingAdvice: advice() }));
		expect(html).toContain("待确认的监督建议");
		expect(html).toContain("发送给 Agent");
		expect(html).toContain("忽略");
	});

	test("a stopped view says so and still offers the log", () => {
		const html = render(view({ status: "stopped", endedAt: 9 }));
		expect(html).toContain("已停止");
		expect(html).toContain("episode 完成");
	});

	test("intervention events are visible without opening the log tab", () => {
		const html = render(
			view({
				logs: [{ at: 5, kind: "advice-sent", text: "监督建议已自动发送给主 Agent" }],
			}),
		);
		expect(html).toContain("最近介入");
		expect(html).toContain("已发送");
		expect(html).toContain("监督建议已自动发送给主 Agent");
	});
});
