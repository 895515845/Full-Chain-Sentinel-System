/**
 * The persistent goal bar of the chat page.
 *
 * A goal runs unattended for hours, so the default state is a single 38px strip
 * that answers four questions at a glance: is it running, how much of the round
 * budget is left, what has it cost, and what did the last round report. Everything
 * long (criteria, the round-by-round audit trail, the completion evidence or the
 * blocker that stopped it) lives in a right-hand drawer with its own scroll:
 * an unbounded inline block used to squeeze the transcript to nothing and clip
 * its own tail, which no amount of scrolling could reach.
 */

import { useEffect, useState } from "react";
import { formatTokens } from "../transcript.ts";
import type { SentinelGoalRound, SentinelGoalView } from "../types.ts";

/** Status chip text. Mirrors the server's labels, including the pause reason. */
function statusLabel(goal: SentinelGoalView): string {
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
		case "loop-guard":
			return "已暂停 · 输出重复";
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

function roundLabel(round: SentinelGoalRound): string {
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

function RoundEntry({ round }: { round: SentinelGoalRound }) {
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

/** One labelled list in the drawer (progress sections and criteria share it). */
function GoalList({ label, items }: { label: string; items: string[] }) {
	if (items.length === 0) return null;
	return (
		<div className="goal-drawer__group">
			<div className="goal-drawer__label">{label}</div>
			<ul>
				{items.map((item, index) => (
					<li key={`${label}-${index}`}>{item}</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The drawer: full metrics, criteria, progress, the round audit trail and the
 * outcome. It scrolls on its own, so length can never push the chat out of view.
 */
function GoalDetail({
	goal,
	elapsed,
	active,
	onPause,
	onResume,
	onClear,
	onClose,
}: {
	goal: SentinelGoalView;
	elapsed: number;
	active: boolean;
	onPause: () => void;
	onResume: () => void;
	onClear: () => void;
	onClose: () => void;
}) {
	const progress = goal.progress;
	return (
		<>
			<div className="goal-drawer__scrim" onClick={onClose} />
			<aside className="goal-drawer" role="dialog" aria-label="目标详情">
				<div className="goal-drawer__head">
					<span className="goal-drawer__title">目标详情</span>
					<span className={`goal-strip__state goal-strip__state--${goal.status}`}>{statusLabel(goal)}</span>
					<button type="button" className="ghost small goal-drawer__close" onClick={onClose}>
						关闭
					</button>
				</div>
				<div className="goal-drawer__body">
					<div className="goal-drawer__objective">{goal.objective}</div>
					<dl className="goal-kv">
						<dt>轮次</dt>
						<dd>
							{goal.roundsUsed}/{goal.roundLimit}（初始运行不计入）
						</dd>
						<dt>耗时</dt>
						<dd>{formatElapsed(elapsed)}</dd>
						<dt>Token</dt>
						<dd>{formatTokens(goal.usage.total)}</dd>
						<dt>子代理</dt>
						<dd>
							{goal.subagent.runs} 次 · {goal.subagent.turns} 轮
						</dd>
						<dt>中枢</dt>
						<dd>{goal.submitted} 条</dd>
						<dt>模式</dt>
						<dd>自动模式 · 全放行</dd>
						<dt>目标 ID</dt>
						<dd className="goal-kv__mono">{goal.id}</dd>
					</dl>
					{goal.status === "paused" && goal.pauseNote ? (
						<div className="goal-drawer__note">暂停说明：{goal.pauseNote}</div>
					) : null}
					{goal.blocked ? (
						<div className="goal-drawer__note">
							阻塞原因：{goal.blocked.reason}（同一阻塞连续 {goal.blocked.streak} 轮）
						</div>
					) : null}
					{goal.criteria.length > 0 ? (
						<GoalList label="验收标准" items={goal.criteria.map((item, index) => `${index + 1}. ${item}`)} />
					) : null}
					<div className="goal-drawer__group">
						<div className="goal-drawer__label">进度</div>
						{progress.done.length === 0 && progress.todo.length === 0 && progress.blockers.length === 0 ? (
							<div className="goal-empty">还没有进度记录。</div>
						) : null}
						<GoalList label="已完成" items={progress.done} />
						<GoalList label="待办" items={progress.todo} />
						<GoalList label="阻塞" items={progress.blockers} />
					</div>
					<div className="goal-drawer__label">执行记录 · {goal.rounds.length} 轮</div>
					{goal.rounds.length === 0 ? <div className="goal-empty">还没有轮次记录。</div> : null}
					{goal.rounds.map((round) => (
						<RoundEntry key={round.index} round={round} />
					))}
					{goal.completion ? (
						<div className="goal-completion">
							<div className="goal-completion__title">完成结论</div>
							<pre className="goal-round__summary">{goal.completion.summary}</pre>
							{goal.completion.criteria.length > 0 ? (
								<GoalList
									label="逐条判定"
									items={goal.completion.criteria.map(
										(item) => `${item.met ? "满足" : "未满足"}：${item.criterion} —— ${item.evidence}`,
									)}
								/>
							) : null}
							{goal.completion.evidence.length > 0 ? (
								<GoalList label="证据" items={goal.completion.evidence} />
							) : null}
							<div className="goal-completion__meta">
								中枢记录 {goal.completion.submitted} 条
								{goal.completion.findingsNote ? ` · ${goal.completion.findingsNote}` : ""}
							</div>
						</div>
					) : null}
				</div>
				<div className="goal-drawer__foot">
					{active ? (
						<button type="button" onClick={onPause} title="停止当前运行并暂停目标">
							暂停
						</button>
					) : goal.status === "completed" ? null : (
						<button type="button" onClick={onResume} title="再给 3 轮自动续跑并立即开始">
							继续 +3 轮
						</button>
					)}
					<button type="button" onClick={onClear} title="清除目标（正在运行时会先中止）">
						清除
					</button>
				</div>
			</aside>
		</>
	);
}

export function GoalBar({
	goal,
	streaming,
	onPause,
	onResume,
	onClear,
}: {
	goal: SentinelGoalView;
	streaming: boolean;
	onPause: () => void;
	onResume: () => void;
	onClear: () => void;
}) {
	const [now, setNow] = useState(() => Date.now());
	const [detailOpen, setDetailOpen] = useState(false);

	// Only a goal that is still moving needs a clock; a finished one shows its
	// final duration and stops re-rendering.
	useEffect(() => {
		if (goal.status !== "active") return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [goal.status]);

	// The drawer covers part of the chat, so Escape closes it.
	useEffect(() => {
		if (!detailOpen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setDetailOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [detailOpen]);

	const elapsed = (goal.endedAt ?? now) - goal.startedAt;
	const active = goal.status === "active";
	const lastRound = goal.rounds[goal.rounds.length - 1];

	return (
		<>
			<div className={`goal-strip goal-strip--${goal.status}`}>
				<span className="goal-strip__state">{statusLabel(goal)}</span>
				<span className="goal-strip__objective" title={goal.objective}>
					{goal.objective}
				</span>
				<span className="goal-strip__stats">
					<span title="自动续跑已用轮数 / 上限；初始运行不计入">
						轮次{" "}
						<b>
							{goal.roundsUsed}/{goal.roundLimit}
						</b>
					</span>
					<span>
						耗时 <b>{formatElapsed(elapsed)}</b>
					</span>
					<span title="本目标开始以来的主代理用量">
						Token <b>{formatTokens(goal.usage.total)}</b>
					</span>
					<span className="goal-strip__stat--secondary" title="本目标期间提交到漏洞中枢的记录数">
						中枢 <b>{goal.submitted}</b> 条
					</span>
					{goal.subagent.runs > 0 ? (
						<span className="goal-strip__stat--secondary" title="子代理用量只作展示，不消耗续跑轮数">
							子代理 <b>{goal.subagent.runs}</b> 次
						</span>
					) : null}
					{streaming && !active ? <span className="goal-strip__flag">后台仍在运行</span> : null}
				</span>
				<span className="goal-strip__ops">
					<button
						type="button"
						onClick={() => setDetailOpen(true)}
						title={
							lastRound?.summary
								? `详情：验收标准、进度与执行记录；最近一轮：${lastRound.summary.split("\n")[0]}`
								: "详情：验收标准、进度与执行记录"
						}
					>
						详情
					</button>
					{active ? (
						<button type="button" onClick={onPause} title="停止当前运行并暂停目标">
							暂停
						</button>
					) : goal.status === "completed" ? null : (
						<button type="button" onClick={onResume} title="再给 3 轮自动续跑并立即开始">
							继续 +3 轮
						</button>
					)}
					<button type="button" onClick={onClear} title="清除目标（正在运行时会先中止）">
						清除
					</button>
				</span>
			</div>
			{detailOpen ? (
				<GoalDetail
					goal={goal}
					elapsed={elapsed}
					active={active}
					onPause={onPause}
					onResume={onResume}
					onClear={onClear}
					onClose={() => setDetailOpen(false)}
				/>
			) : null}
		</>
	);
}
