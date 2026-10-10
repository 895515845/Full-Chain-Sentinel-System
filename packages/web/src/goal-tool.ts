/**
 * The goal tools the main agent calls while a persistent goal is running.
 *
 * Three tools, and each one closes a hole that prose cannot:
 *
 * - `goal_progress` is the only source of the progress the next round is built
 *   from. Without it the driver falls back to the closing paragraph of the round,
 *   which is written for the operator and usually has no todo list in it.
 * - `goal_complete` is the only way a goal ends successfully. It demands evidence,
 *   a verdict per acceptance criterion, and an explicit statement about the hub,
 *   so "done" is a claim that can be checked against what actually happened.
 * - `goal_blocked` is the only way the model can report being stuck, and it only
 *   takes effect once the same blocker has held for three rounds. One bad round
 *   is not a blocker.
 *
 * The tools never mutate the goal themselves: they validate, then hand the change
 * to the runtime through `GoalPort`, which owns persistence and the driver.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BLOCKED_STREAK_LIMIT } from "./goal.ts";
import type { ZGGoal, ZGGoalCompletion, ZGGoalCriterionResult, ZGGoalProgress } from "./protocol.ts";

/** What the runtime has to provide for the tools to work on a live goal. */
export interface GoalPort {
	/** The goal in force for the calling session, if any. */
	current(): ZGGoal | undefined;
	/** Findings submitted to the hub since this goal started. */
	submitted(): number;
	progress(progress: ZGGoalProgress): void;
	complete(completion: ZGGoalCompletion): void;
	/** Records the claim and reports how long the same blocker has held. */
	blocked(reason: string, evidence: string[]): { streak: number; accepted: boolean };
}

const goalIdSchema = Type.Optional(
	Type.String({
		description: "目标 ID，必须与续跑提示中给出的 ID 一致（填错会被拒绝，防止陈旧调用）",
	}),
);

const progressSchema = Type.Object({
	goal_id: goalIdSchema,
	done: Type.Array(Type.String(), { description: "本轮新完成的进展，逐条写" }),
	todo: Type.Array(Type.String(), { description: "下一轮要做的待办，逐条写" }),
	blockers: Type.Optional(Type.Array(Type.String(), { description: "当前阻塞项" })),
});

const criteriaSchema = Type.Array(
	Type.Object({
		criterion: Type.String({ description: "验收标准原文，必须与目标里的写法一致" }),
		met: Type.Boolean({ description: "该条是否已满足；只要有一条为 false 就不能声明目标完成" }),
		evidence: Type.String({ description: "该条的判定依据：命令、文件路径或输出摘要" }),
	}),
	{ description: "操作员填写了验收标准时必填，且必须逐条覆盖、顺序一致" },
);

const findingsSchema = Type.Object({
	submitted: Type.Number({
		minimum: 0,
		description: "本目标期间已提交到漏洞中枢的记录条数；必须与实际提交数一致",
	}),
	note: Type.Optional(
		Type.String({ description: "submitted 为 0 时必填：说明为何没有可提交的发现（复核范围与结论）" }),
	),
});

const completeSchema = Type.Object({
	goal_id: goalIdSchema,
	summary: Type.String({ description: "目标达成的结论：做了什么、结论是什么" }),
	evidence: Type.Array(Type.String(), {
		description: "关键证据：命令与输出摘要、容器文件路径、中枢记录编号",
	}),
	findings: findingsSchema,
	criteria: Type.Optional(criteriaSchema),
});

const blockedSchema = Type.Object({
	goal_id: goalIdSchema,
	reason: Type.String({ description: "阻塞原因：缺少什么条件、试过哪些办法都没用" }),
	evidence: Type.Array(Type.String(), { description: "证明阻塞的证据：报错原文、命令与输出" }),
});

/** Result details shared by the three tools, so the transcript can show them uniformly. */
interface GoalToolDetails {
	ok: boolean;
	goalId?: string;
	streak?: number;
	error?: string;
}

function failure(text: string, error: string): AgentToolResult<GoalToolDetails> {
	return { content: [{ type: "text", text }], details: { ok: false, error }, isError: true };
}

/** Compare criterion text the way a model copies it: ignore numbering and spacing. */
function sameCriterion(left: string, right: string): boolean {
	const normalize = (value: string): string =>
		value
			.replace(/^[-*\d.、)\s]+/, "")
			.replace(/\s+/g, "")
			.trim();
	return normalize(left) === normalize(right);
}

export function createGoalTools(port: GoalPort): ToolDefinition[] {
	/** Every tool starts here: no goal, a stale id, or a finished goal is refused. */
	const requireActive = (goalId: string | undefined): { goal: ZGGoal } | { error: string } => {
		const goal = port.current();
		if (!goal) {
			return { error: "当前会话没有持续目标。持续目标由操作员在输入框上方点「持续目标」启动。" };
		}
		if (goalId && goalId !== goal.id) {
			return { error: `目标 ID 不匹配：当前目标 ID 是 ${goal.id}，收到 ${goalId}。请使用当前目标的 ID。` };
		}
		if (goal.status !== "active") {
			const label = goal.status === "completed" ? "已完成" : goal.status === "blocked" ? "已阻塞" : "已暂停";
			return { error: `目标已${label}，不能继续调用目标工具。等操作员处理或新建目标。` };
		}
		return { goal };
	};

	const progress = defineTool({
		name: "goal_progress",
		label: "Update goal progress",
		description:
			"Record what this round finished and what is left, before the round ends. The next automatic round is built from this list, so an empty update means the next round starts blind. Only usable while a persistent goal is running.",
		promptSnippet: "Record the progress of the current goal round (done / todo / blockers)",
		promptGuidelines: [
			"Call goal_progress before finishing a goal round, listing what this round completed and what remains",
			"Keep goal_progress items concrete: a host, a port, a file, a check that still has to run",
		],
		parameters: progressSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<GoalToolDetails>> {
			const active = requireActive(params.goal_id);
			if ("error" in active) return failure(active.error, "no-goal");
			const update: ZGGoalProgress = {
				done: params.done.map((item) => item.trim()).filter(Boolean),
				todo: params.todo.map((item) => item.trim()).filter(Boolean),
				blockers: (params.blockers ?? []).map((item) => item.trim()).filter(Boolean),
			};
			port.progress(update);
			const round = active.goal.rounds[active.goal.rounds.length - 1];
			return {
				content: [
					{
						type: "text",
						text: `目标进度已更新：已完成 ${update.done.length} 项，待办 ${update.todo.length} 项${
							update.blockers.length > 0 ? `，阻塞 ${update.blockers.length} 项` : ""
						}。当前第 ${round?.index ?? 0} 轮，自动续跑已用 ${active.goal.roundsUsed}/${active.goal.roundLimit} 轮。`,
					},
				],
				details: { ok: true, goalId: active.goal.id },
			};
		},
	});

	const complete = defineTool({
		name: "goal_complete",
		label: "Complete goal",
		description:
			"Declare the persistent goal achieved. Requires a conclusion, evidence, a verdict per acceptance criterion, and an explicit statement of how many findings were submitted to the hub. The call is refused when the evidence does not line up with what actually happened, so resolve the mismatch instead of restating the claim.",
		promptSnippet: "Declare the current persistent goal achieved, with evidence and per-criterion verdicts",
		promptGuidelines: [
			"Submit every validated finding with vuln_submit before calling goal_complete, and state the real count in findings.submitted",
			"Answer every acceptance criterion of the goal with its own evidence when calling goal_complete",
			"Never call goal_complete for partial progress: use goal_progress and keep working",
		],
		parameters: completeSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<GoalToolDetails>> {
			const active = requireActive(params.goal_id);
			if ("error" in active) return failure(active.error, "no-goal");
			const goal = active.goal;

			const evidence = params.evidence.map((item) => item.trim()).filter(Boolean);
			if (evidence.length === 0) {
				return failure("证据不能为空：请给出命令与输出摘要、容器文件路径或中枢记录编号。", "no-evidence");
			}

			// The hub statement is checked against the records the runtime actually
			// saw: understating hides a finding, overstating claims work never done.
			const submitted = port.submitted();
			const declared = Math.max(0, Math.round(params.findings.submitted));
			if (declared !== submitted) {
				const text =
					declared < submitted
						? `本目标期间漏洞中枢已记录 ${submitted} 条来自本目标的发现，findings.submitted 必须是 ${submitted}（不能少报）。`
						: `你声明已提交 ${declared} 条，但本目标期间漏洞中枢只记录了 ${submitted} 条。请先用 vuln_submit 提交，或把 findings.submitted 改为 ${submitted} 并说明。`;
				return failure(text, "findings-mismatch");
			}
			const findingsNote = params.findings.note?.trim() ?? "";
			if (submitted === 0 && !findingsNote) {
				return failure(
					"未发现可提交的漏洞时，findings.note 必须说明依据（复核了哪些范围、为什么没有发现）。",
					"no-findings-note",
				);
			}

			// Acceptance criteria: filled-in criteria are a contract, not a hint.
			const criteria: ZGGoalCriterionResult[] = [];
			if (goal.criteria.length > 0) {
				const given = params.criteria ?? [];
				if (given.length !== goal.criteria.length) {
					return failure(
						`验收标准必须逐条对照：目标有 ${goal.criteria.length} 条，收到 ${given.length} 条。请按顺序逐条填写：\n${goal.criteria
							.map((item, index) => `  ${index + 1}. ${item}`)
							.join("\n")}`,
						"criteria-missing",
					);
				}
				for (const [index, expected] of goal.criteria.entries()) {
					const actual = given[index];
					if (!actual || !sameCriterion(actual.criterion, expected)) {
						return failure(
							`第 ${index + 1} 条验收标准应原样填写：${expected}（收到 ${actual?.criterion ?? "（空）"}）。`,
							"criteria-mismatch",
						);
					}
					if (!actual.met) {
						return failure(
							`验收标准第 ${index + 1} 条「${expected}」未满足，不能声明目标完成。请继续推进；确实卡住就用 goal_blocked 说明。`,
							"criteria-unmet",
						);
					}
					if (!actual.evidence.trim()) {
						return failure(`验收标准第 ${index + 1} 条「${expected}」缺少判定依据。`, "criteria-no-evidence");
					}
					criteria.push({
						criterion: expected,
						met: true,
						evidence: actual.evidence.trim(),
					});
				}
			}

			const at = Date.now();
			const completion: ZGGoalCompletion = {
				summary: params.summary.trim(),
				evidence,
				submitted,
				findingsNote,
				criteria,
				at,
			};
			port.complete(completion);
			return {
				content: [
					{
						type: "text",
						text: `目标已完成：${completion.summary}\n证据 ${evidence.length} 条${
							criteria.length > 0 ? `，验收标准 ${criteria.length} 条全部满足` : ""
						}，中枢记录 ${submitted} 条。自动续跑已停止。`,
					},
				],
				details: { ok: true, goalId: goal.id },
			};
		},
	});

	const blocked = defineTool({
		name: "goal_blocked",
		label: "Report goal blocked",
		description:
			"Report that the goal cannot be advanced. It only stops the goal once the same blocker has been reported three rounds running; before that the goal keeps running and the answer tells you which attempt this was. Use it when a missing condition really blocks progress, not when a step was merely hard.",
		promptSnippet: "Report that the current persistent goal is blocked by an external condition",
		promptGuidelines: [
			"Call goal_blocked only after trying alternatives in the same round, and state what was tried",
			"The same blocker has to be reported three rounds in a row before the goal actually stops",
		],
		parameters: blockedSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<GoalToolDetails>> {
			const active = requireActive(params.goal_id);
			if ("error" in active) return failure(active.error, "no-goal");
			const reason = params.reason.trim();
			if (!reason) return failure("阻塞原因不能为空。", "no-reason");
			const evidence = params.evidence.map((item) => item.trim()).filter(Boolean);
			if (evidence.length === 0) return failure("阻塞必须给出证据：报错原文、命令与输出。", "no-evidence");

			const { streak, accepted } = port.blocked(reason, evidence);
			if (!accepted) {
				return {
					content: [
						{
							type: "text",
							text: `已记录同一阻塞第 ${streak} 次（连续 ${BLOCKED_STREAK_LIMIT} 轮才会停止目标）。目标仍在进行中：请换一种思路继续推进，不要重复调用本工具。`,
						},
					],
					details: { ok: true, goalId: active.goal.id, streak },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `目标已标记为阻塞（同一阻塞连续 ${streak} 轮）：${reason}\n自动续跑已停止，等操作员处理。`,
					},
				],
				details: { ok: true, goalId: active.goal.id, streak },
			};
		},
	});

	return [progress, complete, blocked];
}
