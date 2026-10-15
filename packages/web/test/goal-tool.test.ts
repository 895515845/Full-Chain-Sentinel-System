/**
 * Unit tests for the goal tools the main agent calls.
 *
 * These tools are the only way a goal can end, so the tests are mostly about
 * refusals: a stale goal id, a completion without evidence, a hub count that does
 * not match what was actually submitted, an acceptance criterion answered with a
 * "met" that has nothing behind it, and a blocker that has not held long enough.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { blockGoal, createGoal, finishRound, recordBlocker, startRound } from "../src/goal.ts";
import { createGoalTools, type GoalPort } from "../src/goal-tool.ts";
import type { SentinelGoal, SentinelGoalCompletion, SentinelGoalProgress } from "../src/protocol.ts";

interface CallResult {
	content: { type?: string; text?: string }[];
	isError?: boolean;
}

/** The tools take more arguments than a test needs; only the first two matter. */
type CallableTool = {
	name: string;
	execute: (toolCallId: string, params: never) => Promise<CallResult>;
};

interface FakeState {
	goal: SentinelGoal | undefined;
	submitted: number;
	progress: SentinelGoalProgress[];
	completions: SentinelGoalCompletion[];
	blockers: { reason: string; evidence: string[] }[];
}

/**
 * A port backed by the real state machine: the runtime owns persistence and the
 * driver, so the fake only has to do what the runtime does — hand the change to
 * the state machine and remember it.
 */
function fakePort(goal: SentinelGoal | undefined): { state: FakeState; tools: ToolDefinition[] } {
	const state: FakeState = { goal, submitted: 0, progress: [], completions: [], blockers: [] };
	const port: GoalPort = {
		current: () => state.goal,
		submitted: () => state.submitted,
		progress: (progress) => {
			state.progress.push(progress);
		},
		complete: (completion) => {
			state.completions.push(completion);
		},
		blocked: (reason, evidence) => {
			state.blockers.push({ reason, evidence });
			const live = state.goal;
			if (!live) return { streak: 0, accepted: false };
			const result = recordBlocker(live, reason, Date.now());
			state.goal = result.accepted
				? blockGoal(result.goal, reason, evidence, result.streak, Date.now())
				: result.goal;
			return { streak: result.streak, accepted: result.accepted };
		},
	};
	return { state, tools: createGoalTools(port) };
}

function liveGoal(criteria: string[] = []): SentinelGoal {
	return startRound(
		createGoal({
			id: "goal-live",
			objective: "对 10.10.10.5 完成侦察",
			criteria,
			roundLimit: 5,
			baseline: { input: 0, output: 0, total: 0, cost: null },
			at: 1000,
		}),
		"initial",
		1000,
	);
}

/** Close the round and open the next one, the way the driver does per settle. */
function nextRound(state: FakeState, at: number): void {
	if (!state.goal) return;
	const closed = finishRound(state.goal, {
		at,
		toolCalls: 2,
		usage: { input: 1, output: 1, total: 2, cost: null },
		outcome: "continued",
	});
	state.goal = startRound(closed, "continue", at);
}

async function call(tools: ToolDefinition[], name: string, params: Record<string, unknown>): Promise<CallResult> {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`tool ${name} is not mounted`);
	return await (tool as unknown as CallableTool).execute("call-1", params as never);
}

function textOf(result: CallResult): string {
	return result.content
		.map((block) => block.text ?? "")
		.join("")
		.trim();
}

test("the goal tools refuse to work without a live goal", async () => {
	const { tools } = fakePort(undefined);
	for (const [name, params] of [
		["goal_progress", { done: [], todo: [] }],
		["goal_complete", { summary: "x", evidence: ["y"], findings: { submitted: 0, note: "z" } }],
		["goal_blocked", { reason: "x", evidence: ["y"] }],
	] as const) {
		const result = await call(tools, name, params);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("没有持续目标");
	}
});

test("a stale goal id is refused and names the live one", async () => {
	const { tools } = fakePort(liveGoal());
	const result = await call(tools, "goal_progress", { goal_id: "goal-old", done: ["x"], todo: [] });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("goal-live");
	expect(textOf(result)).toContain("goal-old");
});

test("goal_progress trims its lists and reports the round budget", async () => {
	const { state, tools } = fakePort(liveGoal());
	const result = await call(tools, "goal_progress", {
		done: [" 端口扫描完成 ", "   "],
		todo: ["确认服务版本"],
		blockers: ["  等待凭据  "],
	});
	expect(result.isError).toBeUndefined();
	expect(textOf(result)).toContain("目标进度已更新");
	expect(state.progress[0]).toEqual({
		done: ["端口扫描完成"],
		todo: ["确认服务版本"],
		blockers: ["等待凭据"],
	});
	expect(textOf(result)).toContain("已用 0/5 轮");
});

test("goal_complete refuses a claim with no evidence", async () => {
	const { state, tools } = fakePort(liveGoal());
	const result = await call(tools, "goal_complete", {
		summary: "做完了",
		evidence: ["  "],
		findings: { submitted: 0, note: "没有发现" },
	});
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("证据不能为空");
	expect(state.completions).toHaveLength(0);
});

test("goal_complete checks the hub statement against what was submitted", async () => {
	const { state, tools } = fakePort(liveGoal());
	state.submitted = 2;
	const under = await call(tools, "goal_complete", {
		summary: "做完了",
		evidence: ["nmap 输出"],
		findings: { submitted: 1, note: "" },
	});
	expect(under.isError).toBe(true);
	expect(textOf(under)).toContain("不能少报");

	const over = await call(tools, "goal_complete", {
		summary: "做完了",
		evidence: ["nmap 输出"],
		findings: { submitted: 5 },
	});
	expect(over.isError).toBe(true);
	expect(textOf(over)).toContain("只记录了 2 条");
	expect(state.completions).toHaveLength(0);

	const right = await call(tools, "goal_complete", {
		summary: "做完了",
		evidence: ["nmap 输出"],
		findings: { submitted: 2 },
	});
	expect(right.isError).toBeUndefined();
	expect(state.completions[0].submitted).toBe(2);
});

test("goal_complete with no findings has to say why there were none", async () => {
	const { tools } = fakePort(liveGoal());
	const bare = await call(tools, "goal_complete", {
		summary: "做完了",
		evidence: ["nmap 输出"],
		findings: { submitted: 0 },
	});
	expect(bare.isError).toBe(true);
	expect(textOf(bare)).toContain("findings.note");

	const explained = await call(tools, "goal_complete", {
		summary: "做完了",
		evidence: ["nmap 输出"],
		findings: { submitted: 0, note: "全端口扫描后只发现默认配置，没有可利用点" },
	});
	expect(explained.isError).toBeUndefined();
	expect(textOf(explained)).toContain("目标已完成");
});

test("goal_complete answers every acceptance criterion, in order, with evidence", async () => {
	const { state, tools } = fakePort(liveGoal(["端口已确认", "问题已提交"]));
	const base = { summary: "做完了", evidence: ["nmap 输出"], findings: { submitted: 0, note: "无发现" } };

	const short = await call(tools, "goal_complete", {
		...base,
		criteria: [{ criterion: "端口已确认", met: true, evidence: "nmap" }],
	});
	expect(textOf(short)).toContain("目标有 2 条，收到 1 条");

	const wrongOrder = await call(tools, "goal_complete", {
		...base,
		criteria: [
			{ criterion: "问题已提交", met: true, evidence: "hub-1" },
			{ criterion: "端口已确认", met: true, evidence: "nmap" },
		],
	});
	expect(textOf(wrongOrder)).toContain("第 1 条验收标准应原样填写");

	const unmet = await call(tools, "goal_complete", {
		...base,
		criteria: [
			{ criterion: "端口已确认", met: true, evidence: "nmap" },
			{ criterion: "问题已提交", met: false, evidence: "没找到" },
		],
	});
	expect(unmet.isError).toBe(true);
	expect(textOf(unmet)).toContain("未满足，不能声明目标完成");

	const noEvidence = await call(tools, "goal_complete", {
		...base,
		criteria: [
			{ criterion: "端口已确认", met: true, evidence: "nmap" },
			{ criterion: "问题已提交", met: true, evidence: " " },
		],
	});
	expect(textOf(noEvidence)).toContain("缺少判定依据");
	expect(state.completions).toHaveLength(0);

	// Numbering in the criterion text is tolerated, because the model copies it.
	const done = await call(tools, "goal_complete", {
		...base,
		criteria: [
			{ criterion: "1. 端口已确认", met: true, evidence: "nmap 输出" },
			{ criterion: "2、问题已提交", met: true, evidence: "hub-3" },
		],
	});
	expect(done.isError).toBeUndefined();
	expect(textOf(done)).toContain("验收标准 2 条全部满足");
	expect(state.completions[0].criteria.map((item) => item.criterion)).toEqual(["端口已确认", "问题已提交"]);
});

test("goal_blocked only stops the goal once the same blocker has held three rounds", async () => {
	const { state, tools } = fakePort(liveGoal());
	const claim = { reason: "缺少有效凭据", evidence: ["curl 返回 401"] };

	const first = await call(tools, "goal_blocked", claim);
	expect(first.isError).toBeUndefined();
	expect(textOf(first)).toContain("第 1 次");
	expect(textOf(first)).toContain("目标仍在进行中");
	expect(state.goal?.status).toBe("active");

	nextRound(state, 2000);
	const second = await call(tools, "goal_blocked", claim);
	expect(textOf(second)).toContain("第 2 次");
	expect(state.goal?.status).toBe("active");

	nextRound(state, 3000);
	const third = await call(tools, "goal_blocked", claim);
	expect(textOf(third)).toContain("目标已标记为阻塞");
	expect(state.goal?.status).toBe("blocked");
	expect(state.blockers).toHaveLength(3);

	// Once blocked, the goal tools refuse: the operator has to resume it.
	const after = await call(tools, "goal_progress", { done: ["x"], todo: [] });
	expect(after.isError).toBe(true);
	expect(textOf(after)).toContain("已阻塞");
});

test("a blocker with no reason or no evidence is refused outright", async () => {
	const { state, tools } = fakePort(liveGoal());
	const noReason = await call(tools, "goal_blocked", { reason: "  ", evidence: ["x"] });
	expect(textOf(noReason)).toContain("阻塞原因不能为空");
	const noEvidence = await call(tools, "goal_blocked", { reason: "缺少凭据", evidence: [] });
	expect(textOf(noEvidence)).toContain("阻塞必须给出证据");
	expect(state.blockers).toHaveLength(0);
	expect(state.goal?.status).toBe("active");
});

test("the goal tools stop working once the goal is completed", async () => {
	const { state, tools } = fakePort(liveGoal());
	await call(tools, "goal_complete", {
		summary: "做完了",
		evidence: ["nmap 输出"],
		findings: { submitted: 0, note: "无发现" },
	});
	state.goal = { ...(state.goal as SentinelGoal), status: "completed" };
	const result = await call(tools, "goal_progress", { done: ["x"], todo: [] });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("已完成");
});
