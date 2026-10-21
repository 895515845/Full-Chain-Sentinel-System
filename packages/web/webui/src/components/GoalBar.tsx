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
import { t } from "../i18n.ts";
import { formatTokens } from "../transcript.ts";
import type { SentinelGoalRound, SentinelGoalView } from "../types.ts";

/** Status chip text. Mirrors the server's labels, including the pause reason. */
function statusLabel(goal: SentinelGoalView): string {
	if (goal.status === "active") return goal.running ? t("运行中") : t("进行中");
	if (goal.status === "completed") return t("已完成");
	if (goal.status === "blocked") return t("已阻塞");
	switch (goal.pauseReason) {
		case "limit":
			return t("已暂停 · 轮数上限");
		case "no-progress":
			return t("已暂停 · 空转熔断");
		case "interrupted":
			return t("已暂停 · 会话重建");
		case "loop-guard":
			return t("已暂停 · 输出重复");
		default:
			return t("已暂停");
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
	const kind = round.kind === "initial" ? t("初始运行") : t("自动续跑");
	const outcome =
		round.outcome === "completed"
			? t(" · 已完成")
			: round.outcome === "blocked"
				? t(" · 已阻塞")
				: round.outcome === "aborted"
					? t(" · 被中止")
					: round.outcome === "error"
						? t(" · 失败")
						: round.outcome === "paused"
							? t(" · 已暂停")
							: "";
	return t("第 {index} 轮 · {kind}{outcome}", { index: round.index, kind, outcome });
}

function RoundEntry({ round }: { round: SentinelGoalRound }) {
	const duration =
		typeof round.endedAt === "number" && round.endedAt > round.startedAt
			? formatElapsed(round.endedAt - round.startedAt)
			: t("进行中");
	const tokens = round.usage && round.usage.total > 0 ? ` · ${formatTokens(round.usage.total)} tokens` : "";
	return (
		<div className="goal-round">
			<div className="goal-round__head">
				<span>{roundLabel(round)}</span>
				<span className="goal-round__meta">
					{new Date(round.startedAt).toLocaleTimeString("zh-CN", { hour12: false })} · {duration} ·{" "}
					{t("{count} 次工具调用", { count: round.toolCalls })}
					{tokens}
				</span>
			</div>
			{round.summary ? <pre className="goal-round__summary">{round.summary}</pre> : null}
			{round.blockerReason ? (
				<div className="goal-round__blocker">{t("报告阻塞：{reason}", { reason: round.blockerReason })}</div>
			) : null}
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
			<aside className="goal-drawer" role="dialog" aria-label={t("目标详情")}>
				<div className="goal-drawer__head">
					<span className="goal-drawer__title">{t("目标详情")}</span>
					<span className={`goal-strip__state goal-strip__state--${goal.status}`}>{statusLabel(goal)}</span>
					<button type="button" className="ghost small goal-drawer__close" onClick={onClose}>
						{t("关闭")}
					</button>
				</div>
				<div className="goal-drawer__body">
					<div className="goal-drawer__objective">{goal.objective}</div>
					<dl className="goal-kv">
						<dt>{t("轮次")}</dt>
						<dd>
							{goal.roundsUsed}/{goal.roundLimit}
							{t("（初始运行不计入）")}
						</dd>
						<dt>{t("耗时")}</dt>
						<dd>{formatElapsed(elapsed)}</dd>
						<dt>Token</dt>
						<dd>{formatTokens(goal.usage.total)}</dd>
						<dt>{t("子代理")}</dt>
						<dd>{t("{runs} 次 · {turns} 轮", { runs: goal.subagent.runs, turns: goal.subagent.turns })}</dd>
						<dt>{t("中枢")}</dt>
						<dd>{t("{count} 条", { count: goal.submitted })}</dd>
						<dt>{t("模式")}</dt>
						<dd>{t("自动模式 · 全放行")}</dd>
						<dt>{t("目标 ID")}</dt>
						<dd className="goal-kv__mono">{goal.id}</dd>
					</dl>
					{goal.status === "paused" && goal.pauseNote ? (
						<div className="goal-drawer__note">{t("暂停说明：{note}", { note: goal.pauseNote })}</div>
					) : null}
					{goal.blocked ? (
						<div className="goal-drawer__note">
							{t("阻塞原因：{reason}（同一阻塞连续 {count} 轮）", {
								reason: goal.blocked.reason,
								count: goal.blocked.streak,
							})}
						</div>
					) : null}
					{goal.criteria.length > 0 ? (
						<GoalList
							label={t("验收标准")}
							items={goal.criteria.map((item, index) => `${index + 1}. ${item}`)}
						/>
					) : null}
					<div className="goal-drawer__group">
						<div className="goal-drawer__label">{t("进度")}</div>
						{progress.done.length === 0 && progress.todo.length === 0 && progress.blockers.length === 0 ? (
							<div className="goal-empty">{t("还没有进度记录。")}</div>
						) : null}
						<GoalList label={t("已完成")} items={progress.done} />
						<GoalList label={t("待办")} items={progress.todo} />
						<GoalList label={t("阻塞")} items={progress.blockers} />
					</div>
					<div className="goal-drawer__label">
						{t("执行记录 · {count} 轮", { count: goal.rounds.length })}
					</div>
					{goal.rounds.length === 0 ? <div className="goal-empty">{t("还没有轮次记录。")}</div> : null}
					{goal.rounds.map((round) => (
						<RoundEntry key={round.index} round={round} />
					))}
					{goal.completion ? (
						<div className="goal-completion">
							<div className="goal-completion__title">{t("完成结论")}</div>
							<pre className="goal-round__summary">{goal.completion.summary}</pre>
							{goal.completion.criteria.length > 0 ? (
								<GoalList
									label={t("逐条判定")}
									items={goal.completion.criteria.map((item) =>
										t("{state}：{criterion} —— {evidence}", {
											state: item.met ? t("满足") : t("未满足"),
											criterion: item.criterion,
											evidence: item.evidence,
										}),
									)}
								/>
							) : null}
							{goal.completion.evidence.length > 0 ? (
								<GoalList label={t("证据")} items={goal.completion.evidence} />
							) : null}
							<div className="goal-completion__meta">
								{t("中枢记录 {count} 条", { count: goal.completion.submitted })}
								{goal.completion.findingsNote ? ` · ${goal.completion.findingsNote}` : ""}
							</div>
						</div>
					) : null}
				</div>
				<div className="goal-drawer__foot">
					{active ? (
						<button type="button" onClick={onPause} title={t("停止当前运行并暂停目标")}>
							{t("暂停")}
						</button>
					) : goal.status === "completed" ? null : (
						<button type="button" onClick={onResume} title={t("再给 3 轮自动续跑并立即开始")}>
							{t("继续 +3 轮")}
						</button>
					)}
					<button type="button" onClick={onClear} title={t("清除目标（正在运行时会先中止）")}>
						{t("清除")}
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
					<span title={t("自动续跑已用轮数 / 上限；初始运行不计入")}>
						{t("轮次")}{" "}
						<b>
							{goal.roundsUsed}/{goal.roundLimit}
						</b>
					</span>
					<span>
						{t("耗时")} <b>{formatElapsed(elapsed)}</b>
					</span>
					<span title={t("本目标开始以来的主代理用量")}>
						Token <b>{formatTokens(goal.usage.total)}</b>
					</span>
					<span className="goal-strip__stat--secondary" title={t("本目标期间提交到漏洞中枢的记录数")}>
						{t("中枢")} <b>{goal.submitted}</b> {t("条")}
					</span>
					{goal.subagent.runs > 0 ? (
						<span className="goal-strip__stat--secondary" title={t("子代理用量只作展示，不消耗续跑轮数")}>
							{t("子代理")} <b>{goal.subagent.runs}</b> {t("次")}
						</span>
					) : null}
					{streaming && !active ? <span className="goal-strip__flag">{t("后台仍在运行")}</span> : null}
				</span>
				<span className="goal-strip__ops">
					<button
						type="button"
						onClick={() => setDetailOpen(true)}
						title={
							lastRound?.summary
								? t("详情：验收标准、进度与执行记录；最近一轮：{summary}", {
										summary: lastRound.summary.split("\n")[0],
									})
								: t("详情：验收标准、进度与执行记录")
						}
					>
						{t("详情")}
					</button>
					{active ? (
						<button type="button" onClick={onPause} title={t("停止当前运行并暂停目标")}>
							{t("暂停")}
						</button>
					) : goal.status === "completed" ? null : (
						<button type="button" onClick={onResume} title={t("再给 3 轮自动续跑并立即开始")}>
							{t("继续 +3 轮")}
						</button>
					)}
					<button type="button" onClick={onClear} title={t("清除目标（正在运行时会先中止）")}>
						{t("清除")}
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
