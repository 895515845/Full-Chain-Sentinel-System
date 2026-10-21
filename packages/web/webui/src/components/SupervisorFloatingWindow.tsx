/**
 * The live supervision window, opened from the composer's 监督 button.
 *
 * Option B (Inspector Card): a light card with a phase header, per-conversation
 * mode controls, and 状态 / 过程 / 日志 tabs. The global audit list lives in
 * 工作台 → 监督. Closing this window only hides it; supervision continues until
 * 停止监督.
 */

import { useState } from "react";
import type {
	SentinelSupervisorAdvice,
	SentinelSupervisorCall,
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorEpisode,
	SentinelSupervisorLog,
	SentinelSupervisorMode,
	SentinelSupervisorStrategyRef,
	SentinelSupervisorView,
} from "../types.ts";
import { SUPERVISOR_STRATEGY_OPTIONS, supervisorStrategyKey, supervisorStrategyLabel } from "../supervisor-strategy.ts";

const PHASE_LABELS: Record<string, string> = {
	recon: "侦察",
	enum: "枚举",
	vuln_mapping: "漏洞验证",
	exploitation: "利用",
	post: "后渗透",
	report: "报告",
	unknown: "未判断",
};

const PROGRESS_LABELS: Record<string, string> = {
	advancing: "有进展",
	stalled: "停滞",
	looping: "循环",
	unknown: "未判断",
};

type Tab = "state" | "process" | "logs";

const ADVICE_LOG_LABELS: Record<string, string> = {
	"advice-pending": "待确认",
	"advice-sent": "已发送",
	"advice-ignored": "已忽略",
	"advice-skip": "冷却跳过",
};

function mergeLogs(first: SentinelSupervisorLog[], second: SentinelSupervisorLog[]): SentinelSupervisorLog[] {
	const seen = new Set<string>();
	const merged: SentinelSupervisorLog[] = [];
	for (const log of [...first, ...second]) {
		const key = `${log.at}-${log.kind}-${log.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(log);
	}
	return merged.sort((left, right) => left.at - right.at);
}

function phaseLabel(value: string): string {
	return PHASE_LABELS[value] ?? value;
}

function progressLabel(value: string): string {
	return PROGRESS_LABELS[value] ?? value;
}

function progressClass(value: string): string {
	if (value === "looping") return "bad";
	if (value === "stalled") return "warn";
	if (value === "advancing") return "ok";
	return "";
}

function timeLabel(at: number): string {
	return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function statusLabel(view: SentinelSupervisorView): string {
	if (view.status === "waiting") return "等待开始";
	if (view.status === "stopped") return "已停止";
	if (view.running) return "分析中";
	return "监督中";
}

function modeLabel(mode: SentinelSupervisorMode, delivery: "auto" | "confirm"): string {
	if (mode === "observe") return "观察模式";
	return delivery === "auto" ? "介入 · 自动发送" : "介入 · 确认后发送";
}

function CallRow({ call, onOpen }: { call: SentinelSupervisorCall; onOpen: (callId: string) => void }) {
	return (
		<button type="button" className="sv-call" onClick={() => onOpen(call.callId)} title="查看完整输出">
			<span className={`sv-call__status ${call.status === "error" ? "bad" : "ok"}`} />
			<span className="sv-call__tool">{call.tool}</span>
			<span className="sv-call__args">{call.args}</span>
			<span className="sv-call__meta">
				{call.durationMs === null ? "" : `${Math.round(call.durationMs)}ms`}
				{call.httpStatus === null ? "" : ` · HTTP ${call.httpStatus}`}
			</span>
		</button>
	);
}

function AdviceCard({
	advice,
	onSend,
	onIgnore,
}: {
	advice: SentinelSupervisorAdvice;
	onSend: (id: string) => void;
	onIgnore: (id: string) => void;
}) {
	if (advice.status !== "pending") {
		return (
			<div className={`sv-advice ${advice.status}`}>
				<div className="sv-advice__head">
					{advice.status === "sent" ? "建议已发送" : "建议已忽略"}
					<span>{timeLabel(advice.sentAt ?? advice.at)}</span>
				</div>
				<pre>{advice.text}</pre>
			</div>
		);
	}
	return (
		<div className="sv-advice pending">
			<div className="sv-advice__head">
				待确认的监督建议
				<span>{timeLabel(advice.at)}</span>
			</div>
			<pre>{advice.text}</pre>
			<div className="sv-advice__actions">
				<button type="button" className="primary" onClick={() => onSend(advice.id)}>
					发送给 Agent
				</button>
				<button type="button" onClick={() => onIgnore(advice.id)}>
					忽略
				</button>
			</div>
		</div>
	);
}

function EpisodeItem({ episode }: { episode: SentinelSupervisorEpisode }) {
	return (
		<div className="sv-episode">
			<div className="sv-episode__head">
				<span>{timeLabel(episode.at)}</span>
				<span>{phaseLabel(episode.phase)}</span>
				<span className={progressClass(episode.progress)}>{progressLabel(episode.progress)}</span>
				{episode.error ? <span className="bad">失败</span> : null}
			</div>
			<div className="sv-episode__intent">{episode.intent || episode.error || "（无摘要）"}</div>
			{episode.outcomes.length > 0 ? (
				<ul className="sv-episode__list">
					{episode.outcomes.slice(0, 4).map((item, index) => (
						<li key={index}>{item}</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export function SupervisorFloatingWindow({
	view,
	episodes,
	logs,
	onHide,
	onStop,
	onRunNow,
	onSetMode,
	onSetStrategies,
	customStrategies,
	onOpenCall,
	onSendAdvice,
	onIgnoreAdvice,
}: {
	view: SentinelSupervisorView;
	episodes: SentinelSupervisorEpisode[];
	logs: SentinelSupervisorLog[];
	onHide: () => void;
	onStop: () => void;
	onRunNow: () => void;
	onSetMode: (mode: SentinelSupervisorMode, delivery: "auto" | "confirm") => void;
	onSetStrategies: (strategies: SentinelSupervisorStrategyRef[], note?: string) => void;
	customStrategies: SentinelSupervisorCustomStrategy[];
	onOpenCall: (callId: string) => void;
	onSendAdvice: (id: string) => void;
	onIgnoreAdvice: (id: string) => void;
}) {
	const [tab, setTab] = useState<Tab>("state");
	const mode = view.mode;
	const delivery = view.delivery;
	const state = view.state;
	const stopped = view.status === "stopped";
	const activeStrategies = view.strategies?.length
		? view.strategies
		: [
				{
					strategy: view.strategy,
					customStrategyId: view.strategyCustomId,
					name: view.strategyName || supervisorStrategyLabel(view.strategy),
					instructions: view.strategyInstructions,
				},
			];
	const availableForAdd = activeStrategies.filter(
		(entry) => !entry.customStrategyId || customStrategies.some((custom) => custom.id === entry.customStrategyId),
	);
	const toggleStrategy = (ref: SentinelSupervisorStrategyRef): void => {
		const key = supervisorStrategyKey(ref);
		const exists = activeStrategies.some((entry) => supervisorStrategyKey(entry) === key);
		if (exists) {
			if (activeStrategies.length <= 1) return;
			onSetStrategies(
				activeStrategies.filter((entry) => supervisorStrategyKey(entry) !== key),
				view.strategyNote,
			);
			return;
		}
		onSetStrategies([...availableForAdd, ref], view.strategyNote);
	};
	const mergedLogs = mergeLogs(view.logs, logs);
	const adviceLogs = mergedLogs.filter((log) => log.kind.startsWith("advice-")).slice(-4);
	const tabButton = (value: Tab, label: string, count?: number) => (
		<button
			type="button"
			role="tab"
			aria-selected={tab === value}
			className={`svb-tab ${tab === value ? "on" : ""}`}
			onClick={() => setTab(value)}
		>
			{label}
			{count === undefined ? null : <span>{count}</span>}
		</button>
	);

	return (
		<aside className="svb" aria-label="监督">
			<header className="svb-head">
				<div className="svb-heading">
					<div className="svb-eyebrow">监督 · {view.sessionName}</div>
					<div className="svb-sub">
						{modeLabel(mode, delivery)} ·{" "}
						{activeStrategies.map((entry) => entry.name || supervisorStrategyLabel(entry.strategy)).join(" + ")} ·
						已分析 {view.episodeCount} 个 episode
					</div>
				</div>
				<span className={`svb-status ${view.status}`}>{statusLabel(view)}</span>
				<button type="button" className="svb-collapse" onClick={onHide} title="隐藏窗口，监督继续">
					收起
				</button>
			</header>

			<div className="svb-body">
				<div className="svb-phase-row">
					<span className="svb-phase">{phaseLabel(state.phase)}</span>
					<span className={`svb-progress ${progressClass(state.progress)}`}>
						{progressLabel(state.progress)}
					</span>
					{view.pendingAdvice ? <span className="svb-advice-flag">待确认建议</span> : null}
					<span className={`svb-model ${view.model ? "" : "bad"}`}>
						{view.model?.modelId ?? "未配置模型"}
					</span>
				</div>
				<div className="svb-intent">{state.intent || "等待第一批调用…"}</div>

				<div className="svb-meter" aria-label={`监督判断：${progressLabel(state.progress)}`}>
					<span className={state.progress === "advancing" ? "on ok" : ""} />
					<span className={state.progress === "stalled" ? "on warn" : ""} />
					<span className={state.progress === "looping" ? "on bad" : ""} />
				</div>
				<div className="svb-meter-meta">
					<span>监督判断：{progressLabel(state.progress)}</span>
					<span>
						{view.callCount} 次调用 · {view.episodeCount} 个 episode
					</span>
				</div>

				<div className="svb-strategy">
					<div className="svb-strategy__head">
						<span>监督策略</span>
						<span>{activeStrategies.length} 个</span>
					</div>
					<div className="svb-strategy__list">
						{SUPERVISOR_STRATEGY_OPTIONS.map((option) => {
							const ref: SentinelSupervisorStrategyRef = {
								strategy: option.id,
								customStrategyId: null,
							};
							const selected = activeStrategies.some(
								(entry) => supervisorStrategyKey(entry) === supervisorStrategyKey(ref),
							);
							return (
								<button
									type="button"
									key={option.id}
									className={selected ? "on" : ""}
									aria-pressed={selected}
									disabled={stopped}
									onClick={() => toggleStrategy(ref)}
								>
									{option.label}
								</button>
							);
						})}
						{customStrategies.map((custom) => {
							const ref: SentinelSupervisorStrategyRef = {
								strategy: custom.base,
								customStrategyId: custom.id,
							};
							const selected = activeStrategies.some(
								(entry) => supervisorStrategyKey(entry) === supervisorStrategyKey(ref),
							);
							return (
								<button
									type="button"
									key={custom.id}
									className={selected ? "on" : ""}
									aria-pressed={selected}
									disabled={stopped}
									onClick={() => toggleStrategy(ref)}
								>
									{custom.name}
								</button>
							);
						})}
						{activeStrategies
							.filter(
								(entry) =>
									entry.customStrategyId &&
									!customStrategies.some((custom) => custom.id === entry.customStrategyId),
							)
							.map((entry) => (
								<button
									type="button"
									key={`deleted:${entry.customStrategyId}`}
									className="on"
									aria-pressed
									disabled={stopped}
									title="该自定义策略已删除；点击可移除"
									onClick={() => toggleStrategy(entry)}
								>
									{entry.name}（已删除）
								</button>
							))}
					</div>
					{view.strategyNote ? (
						<span className="svb-strategy-note" title={view.strategyNote}>
							{view.strategyNote}
						</span>
					) : null}
				</div>

				<div className="svb-mode">
					<button
						type="button"
						className={mode === "observe" ? "on" : ""}
						disabled={stopped}
						onClick={() => onSetMode("observe", delivery)}
					>
						观察
					</button>
					<button
						type="button"
						className={mode === "intervene" && delivery === "auto" ? "on" : ""}
						disabled={stopped}
						onClick={() => onSetMode("intervene", "auto")}
					>
						介入 · 自动
					</button>
					<button
						type="button"
						className={mode === "intervene" && delivery === "confirm" ? "on" : ""}
						disabled={stopped}
						onClick={() => onSetMode("intervene", "confirm")}
					>
						介入 · 确认
					</button>
					<button
						type="button"
						className="svb-run-now"
						onClick={onRunNow}
						disabled={view.status !== "running" || view.running}
					>
						{view.running ? "分析中…" : "立即分析"}
					</button>
				</div>

				<div className="svb-tabs" role="tablist" aria-label="监督视图">
					{tabButton("state", "状态")}
					{tabButton("process", "过程", episodes.length + view.recentCalls.length)}
					{tabButton("logs", "日志", mergedLogs.length)}
				</div>

				<div className="svb-tabpanel" hidden={tab !== "state"}>
					{view.pendingAdvice ? (
						<AdviceCard advice={view.pendingAdvice} onSend={onSendAdvice} onIgnore={onIgnoreAdvice} />
					) : null}
					{view.lastError ? <p className="svb-error">最近错误：{view.lastError}</p> : null}

					<div className="svb-section">
						<div className="svb-section-head">
							<h4>已排除 / 新证据</h4>
							<span>{state.deadEnds.length + state.newEvidence.length}</span>
						</div>
						<div className="svb-chips">
							{state.deadEnds.slice(-4).map((item) => (
								<span className="svb-chip bad" key={`dead-${item}`} title={item}>
									{item}
								</span>
							))}
							{state.newEvidence.slice(-4).map((item) => (
								<span className="svb-chip ok" key={`evidence-${item}`} title={item}>
									{item}
								</span>
							))}
							{state.deadEnds.length === 0 && state.newEvidence.length === 0 ? (
								<span className="svb-empty">还没有排除项或新证据。</span>
							) : null}
						</div>
					</div>

					{state.tested.length > 0 ? (
						<div className="svb-section">
							<div className="svb-section-head">
								<h4>已测试</h4>
								<span>{state.tested.length}</span>
							</div>
							<table className="svb-table">
								<thead>
									<tr>
										<th>目标</th>
										<th>测试</th>
										<th>结果</th>
									</tr>
								</thead>
								<tbody>
									{state.tested.slice(-5).reverse().map((entry, index) => (
										<tr key={`${entry.target}-${entry.test}-${index}`}>
											<td title={entry.target}>{entry.target}</td>
											<td>{entry.test}</td>
											<td title={entry.result}>{entry.result}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : null}

					{state.nextCandidates.length > 0 ? (
						<div className="svb-next">
							<h4>下一步候选</h4>
							<ul>
								{state.nextCandidates.slice(0, 4).map((item, index) => (
									<li key={index}>{item}</li>
								))}
							</ul>
						</div>
					) : null}

					{adviceLogs.length > 0 ? (
						<div className="svb-section">
							<div className="svb-section-head">
								<h4>最近介入</h4>
								<span>{adviceLogs.length}</span>
							</div>
							<div className="svb-advice-log">
								{adviceLogs.map((log, index) => (
									<div key={`${log.at}-${index}`}>
										<span>{timeLabel(log.at)}</span>
										<b className={log.kind === "advice-skip" ? "warn" : ""}>
											{ADVICE_LOG_LABELS[log.kind] ?? log.kind}
										</b>
										<span>{log.text}</span>
									</div>
								))}
							</div>
						</div>
					) : null}

					<div className="svb-meta">
						<span>监督模型 tokens {formatTokens(view.usage.total)}</span>
						<span>
							{view.usage.input} in / {view.usage.output} out
						</span>
					</div>
				</div>

				<div className="svb-tabpanel" hidden={tab !== "process"}>
					<div className="svb-section">
						<div className="svb-section-head">
							<h4>最近 episode</h4>
							<span>{episodes.length}</span>
						</div>
						{episodes.length === 0 ? (
							<p className="svb-empty">还没有 episode。每 20 次调用或发现重复/空转后会生成一条。</p>
						) : (
							<div className="sv-episode-list">
								{[...episodes].slice(-5).reverse().map((episode) => (
									<EpisodeItem key={episode.id} episode={episode} />
								))}
							</div>
						)}
					</div>

					<div className="svb-section">
						<div className="svb-section-head">
							<h4>最近调用</h4>
							<span>{view.recentCalls.length}</span>
						</div>
						{view.recentCalls.length === 0 ? (
							<p className="svb-empty">还没有工具调用。</p>
						) : (
							<div className="sv-call-list">
								{[...view.recentCalls].slice(-10).reverse().map((call) => (
									<CallRow key={call.callId} call={call} onOpen={onOpenCall} />
								))}
							</div>
						)}
					</div>
				</div>

				<div className="svb-tabpanel" hidden={tab !== "logs"}>
					<div className="sv-log">
						{mergedLogs.slice(-60).map((log, index) => (
							<div key={`${log.at}-${index}`} className={`sv-log__line ${log.kind === "error" ? "bad" : ""}`}>
								<span>{timeLabel(log.at)}</span>
								<span>{log.text}</span>
							</div>
						))}
						{mergedLogs.length === 0 ? <p className="svb-empty">暂无日志。</p> : null}
					</div>
				</div>
			</div>

			<footer className="svb-foot">
				<span>收起窗口不会停止监督</span>
				<div>
					<button
						type="button"
						className="danger"
						disabled={stopped}
						onClick={() => {
							if (window.confirm("停止监督后，本次会话不再采集；要重新监督只能新开对话。确定停止？")) onStop();
						}}
					>
						停止监督
					</button>
				</div>
			</footer>
		</aside>
	);
}
