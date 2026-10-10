/**
 * The persistent goal bar of the chat page.
 *
 * A goal runs unattended, so the bar has to answer four questions at a glance:
 * is it running, how much of the round budget is left, what has it cost, and what
 * did the last round report. The timeline below the head is the audit trail: one
 * entry per round with its own duration, tool calls, and conclusion, plus the
 * completion evidence or the blocker that stopped it.
 */

import { useEffect, useState } from "react";
import { formatTokens } from "../transcript.ts";
import type { ZGGoalRound, ZGGoalView } from "../types.ts";

/** Status chip text. Mirrors the server's labels, including the pause reason. */
function statusLabel(goal: ZGGoalView): string {
	if (goal.status === "active") return goal.running ? "运行中" : "进行中";
	if (goal.status === "completed") return "已完成";
	if (goal.status === "blocked") return "已阻塞";
	switch (goal.pauseReason) {
		case "limit":
			return "已暂停 · 轮数上限";
		case "no-progress":
			return "已暂停 · 空转熔断";
		case "interrupted":
			return "已暂停 · 会话重建";
		default:
			return "已暂停";
	}
}

/** Elapsed time in the console's short form: seconds, then minutes, then hours. */
function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function roundLabel(round: ZGGoalRound): string {
	const kind = round.kind === "initial" ? "初始运行" : "自动续跑";
	const outcome =
		round.outcome === "completed"
			? " · 已完成"
			: round.outcome === "blocked"
				? " · 已阻塞"
				: round.outcome === "aborted"
					? " · 被中止"
					: round.outcome === "error"
						? " · 失败"
						: round.outcome === "paused"
							? " · 已暂停"
							: "";
	return `第 ${round.index} 轮 · ${kind}${outcome}`;
}

function RoundEntry({ round }: { round: ZGGoalRound }) {
	const duration =
		typeof round.endedAt === "number" && round.endedAt > round.startedAt
			? formatElapsed(round.endedAt - round.startedAt)
			: "进行中";
	const tokens = round.usage && round.usage.total > 0 ? ` · ${formatTokens(round.usage.total)} tokens` : "";
	return (
		<div className="goal-round">
			<div className="goal-round__head">
				<span>{roundLabel(round)}</span>
				<span className="goal-round__meta">
					{new Date(round.startedAt).toLocaleTimeString("zh-CN", { hour12: false })} · {duration} ·{" "}
					{round.toolCalls} 次工具调用{tokens}
				</span>
			</div>
			{round.summary ? <pre className="goal-round__summary">{round.summary}</pre> : null}
			{round.blockerReason ? <div className="goal-round__blocker">报告阻塞：{round.blockerReason}</div> : null}
		</div>
	);
}

export function GoalBar({
	goal,
	streaming,
	onPause,
	onResume,
	onClear,
}: {
	goal: ZGGoalView;
	streaming: boolean;
	onPause: () => void;
	onResume: () => void;
	onClear: () => void;
}) {
	const [now, setNow] = useState(() => Date.now());
	// Only a goal that is still moving needs a clock; a finished one shows its
	// final duration and stops re-rendering.
	useEffect(() => {
		if (goal.status !== "active") return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [goal.status]);

	const elapsed = (goal.endedAt ?? now) - goal.startedAt;
	const usage = goal.usage.total;
	const active = goal.status === "active";
	const lastRound = goal.rounds[goal.rounds.length - 1];
	const progress = goal.progress;

	return (
		<div className={`goal-bar goal-bar--${goal.status}`}>
			<div className="goal-bar__head">
				<span className="goal-chip">{statusLabel(goal)}</span>
				<span className="goal-objective" title={goal.objective}>
					{goal.objective}
				</span>
				<span className="goal-bar__spacer" />
				{active ? (
					<button type="button" className="ghost small" onClick={onPause} title="停止当前运行并暂停目标">
						暂停
					</button>
				) : goal.status === "completed" ? null : (
					<button type="button" className="ghost small" onClick={onResume} title="再给 3 轮自动续跑并立即开始">
						继续 +3 轮
					</button>
				)}
				<button type="button" className="ghost small" onClick={onClear} title="清除目标（正在运行时会先中止）">
					清除
				</button>
			</div>
			<div className="goal-bar__meta">
				<span title="自动续跑已用轮数 / 上限；初始运行不计入">
					轮次 {goal.roundsUsed}/{goal.roundLimit}
				</span>
				<span>耗时 {formatElapsed(elapsed)}</span>
				<span title="本目标开始以来的主代理用量">Token {formatTokens(usage)}</span>
				{goal.subagent.runs > 0 ? (
					<span title="子代理用量只作展示，不消耗续跑轮数">
						子代理 {goal.subagent.runs} 次 · {goal.subagent.turns} 轮
					</span>
				) : null}
				<span title="本目标期间提交到漏洞中枢的记录数">中枢 {goal.submitted} 条</span>
				<span className="goal-mode" title="持续目标只在自动模式下运行：命令无人拦截直接执行">
					自动模式 · 全放行
				</span>
				<span className="goal-id" title={`目标 ID：${goal.id}`}>
					{goal.id.slice(0, 13)}
				</span>
				{streaming && !active ? <span>后台仍在运行</span> : null}
			</div>
			{goal.criteria.length > 0 ? (
				<div className="goal-criteria">
					验收标准：{goal.criteria.map((item, index) => `${index + 1}. ${item}`).join("　")}
				</div>
			) : null}
			{goal.status === "paused" && goal.pauseNote ? <div className="goal-note">{goal.pauseNote}</div> : null}
			{goal.blocked ? (
				<div className="goal-note">
					阻塞原因：{goal.blocked.reason}（同一阻塞连续 {goal.blocked.streak} 轮）
				</div>
			) : null}
			<details className="goal-timeline">
				<summary>
					执行记录 · {goal.rounds.length} 轮
					{lastRound?.summary ? <span className="goal-timeline__last"> · 最近：{lastRound.summary.split("\n")[0]}</span> : null}
				</summary>
				<div className="goal-timeline__body">
					{progress.done.length > 0 || progress.todo.length > 0 || progress.blockers.length > 0 ? (
						<div className="goal-progress">
							{progress.done.length > 0 ? (
								<div>
									<span className="goal-progress__label">已完成</span>
									<ul>
										{progress.done.map((item, index) => (
											<li key={`done-${index}`}>{item}</li>
										))}
									</ul>
								</div>
							) : null}
							{progress.todo.length > 0 ? (
								<div>
									<span className="goal-progress__label">待办</span>
									<ul>
										{progress.todo.map((item, index) => (
											<li key={`todo-${index}`}>{item}</li>
										))}
									</ul>
								</div>
							) : null}
							{progress.blockers.length > 0 ? (
								<div>
									<span className="goal-progress__label">阻塞</span>
									<ul>
										{progress.blockers.map((item, index) => (
											<li key={`blocker-${index}`}>{item}</li>
										))}
									</ul>
								</div>
							) : null}
						</div>
					) : null}
					{goal.rounds.length === 0 ? <div className="goal-empty">还没有轮次记录。</div> : null}
					{goal.rounds.map((round) => (
						<RoundEntry key={round.index} round={round} />
					))}
					{goal.completion ? (
						<div className="goal-completion">
							<div className="goal-completion__title">完成结论</div>
							<pre className="goal-round__summary">{goal.completion.summary}</pre>
							{goal.completion.criteria.length > 0 ? (
								<ul>
									{goal.completion.criteria.map((item, index) => (
										<li key={`criterion-${index}`}>
											{item.met ? "满足" : "未满足"}：{item.criterion} —— {item.evidence}
										</li>
									))}
								</ul>
							) : null}
							{goal.completion.evidence.length > 0 ? (
								<>
									<div className="goal-progress__label">证据</div>
									<ul>
										{goal.completion.evidence.map((item, index) => (
											<li key={`evidence-${index}`}>{item}</li>
										))}
									</ul>
								</>
							) : null}
							<div className="goal-completion__meta">
								中枢记录 {goal.completion.submitted} 条
								{goal.completion.findingsNote ? ` · ${goal.completion.findingsNote}` : ""}
							</div>
						</div>
					) : null}
				</div>
			</details>
		</div>
	);
}
