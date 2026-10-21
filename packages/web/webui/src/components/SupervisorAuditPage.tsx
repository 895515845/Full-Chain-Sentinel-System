/**
 * 工作台 → 监督: a read-only audit of every conversation that was armed.
 *
 * Option A (Ops Table): filters + KPI strip + dense table, with a detail
 * inspector pinned to the right edge. The live view belongs to the floating
 * window; this page never changes a running session.
 *
 * Two layout rules worth keeping:
 * - The detail opens as a modal over the table. The console already has that
 *   shell (Overlay), and the supervisor detail is three blocks of reading
 *   material — Episode, 建议, 日志 — that want the full width side by side
 *   rather than a 380px column.
 * - Filters apply the moment they change. The keyword box waits for Enter or
 *   查询, and the pager re-uses the filter that was applied — not the one
 *   half-typed in the box.
 */

import { useEffect, useState } from "react";
import { Overlay } from "./Overlay.tsx";
import type {
	SentinelProjectInfo,
	SentinelSupervisorAuditItem,
	SentinelSupervisorAuditPage,
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorDetail,
	SentinelSupervisorEpisode,
	SentinelSupervisorLog,
	SentinelSupervisorMode,
	SentinelSupervisorProgress,
	SentinelSupervisorStrategy,
} from "../types.ts";
import { SUPERVISOR_STRATEGY_OPTIONS, supervisorStrategyLabel } from "../supervisor-strategy.ts";

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

const STATUS_LABELS: Record<string, string> = {
	waiting: "等待开始",
	running: "监督中",
	stopped: "已停止",
	error: "错误",
};

const MODE_LABELS: Record<SentinelSupervisorMode, string> = {
	observe: "观察",
	intervene: "介入",
};

/** Why the supervisor woke up. The stored value is an English enum. */
const TRIGGER_LABELS: Record<string, string> = {
	batch: "批量触发",
	duplicate: "重复调用",
	"no-progress": "没有新证据",
	"error-streak": "连续报错",
	manual: "手动触发",
	settled: "运行结算",
};

function timeLabel(at: number): string {
	return new Date(at).toLocaleString("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function strategyNames(item: SentinelSupervisorAuditItem): string {
	const selected = item.strategies?.filter((entry) => entry.name || entry.strategy);
	if (selected && selected.length > 0) {
		return selected.map((entry) => entry.name || supervisorStrategyLabel(entry.strategy)).join(" + ");
	}
	return item.strategyName || supervisorStrategyLabel(item.strategy);
}

function strategyNotes(item: SentinelSupervisorAuditItem): Array<{ name: string; instructions: string }> {
	const selected = item.strategies?.filter((entry) => entry.instructions.trim());
	if (selected && selected.length > 0) {
		return selected.map((entry) => ({
			name: entry.name || supervisorStrategyLabel(entry.strategy),
			instructions: entry.instructions,
		}));
	}
	return item.strategyInstructions
		? [{ name: item.strategyName || supervisorStrategyLabel(item.strategy), instructions: item.strategyInstructions }]
		: [];
}

function phaseLabel(value: string): string {
	return PHASE_LABELS[value] ?? value;
}

function progressLabel(value: string): string {
	return PROGRESS_LABELS[value] ?? value;
}

function triggerLabel(value: string): string {
	return TRIGGER_LABELS[value] ?? value;
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function statusClass(status: string): string {
	if (status === "running") return "ok";
	if (status === "waiting") return "warn";
	if (status === "error") return "bad";
	return "";
}

function progressClass(progress: string): string {
	if (progress === "advancing") return "ok";
	if (progress === "stalled") return "warn";
	if (progress === "looping") return "bad";
	return "";
}

/** How an advice ended up: sent, dropped by the operator, or still waiting. */
function adviceStatusClass(status: string): string {
	if (status === "sent") return "ok";
	if (status === "ignored") return "";
	return "warn";
}

/** The mode a session was armed with, including how an advice is delivered. */
function modeHint(item: { mode: SentinelSupervisorMode; delivery: string }): string {
	if (item.mode === "observe") return "观察模式：只记录，不向主代理注入任何内容";
	return item.delivery === "auto" ? "介入模式：建议自动发送" : "介入模式：建议需操作员确认后发送";
}

/**
 * How much of each column one page holds. A page is sized to fit the column
 * so the common case needs no scrolling at all; the column still scrolls when
 * one entry is unusually tall. An episode is the tallest entry (intent, a few
 * outcomes, what was ruled out, what is next), so it gets the smallest page;
 * a log line is one row, so it gets the largest.
 */
const EPISODE_PAGE_SIZE = 3;
const ADVICE_PAGE_SIZE = 3;
const LOG_PAGE_SIZE = 20;

function pageCount(total: number, size: number): number {
	return Math.max(1, Math.ceil(total / size));
}

function pageItems<T>(items: T[], page: number, size: number): T[] {
	const start = (page - 1) * size;
	return items.slice(start, start + size);
}

/** The pager at the bottom of a column. Hidden when one page holds it all. */
function ColumnPager({
	page,
	pages,
	onChange,
}: {
	page: number;
	pages: number;
	onChange: (page: number) => void;
}) {
	if (pages <= 1) return null;
	return (
		<div className="sva-col-pager">
			<button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="上一页">
				‹
			</button>
			<span>
				{page} / {pages}
			</span>
			<button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="下一页">
				›
			</button>
		</div>
	);
}

function EpisodeBlock({ episode }: { episode: SentinelSupervisorEpisode }) {
	return (
		<div className="sva-episode">
			<div className="sva-episode-head">
				<span className="sva-mono">{timeLabel(episode.at)}</span>
				<span className={`sva-flag ${progressClass(episode.progress)}`}>{progressLabel(episode.progress)}</span>
				<span className="sva-episode-phase">{phaseLabel(episode.phase)}</span>
				{episode.error ? <span className="sva-flag bad">失败</span> : null}
				<span className="sva-episode-trigger" title="触发原因">
					{triggerLabel(episode.trigger)}
				</span>
			</div>
			<p>{episode.intent || episode.error || "（无摘要）"}</p>
			{episode.outcomes.length > 0 ? (
				<ul>
					{episode.outcomes.map((item, index) => (
						<li key={index}>{item}</li>
					))}
				</ul>
			) : null}
			{episode.deadEnds.length > 0 ? <p className="sva-dead">已排除：{episode.deadEnds.join("；")}</p> : null}
			{episode.nextCandidates.length > 0 ? (
				<p className="sva-next">下一步：{episode.nextCandidates.join("；")}</p>
			) : null}
		</div>
	);
}

function LogBlock({ logs }: { logs: SentinelSupervisorLog[] }) {
	return (
		<div className="sva-log">
			{logs.length === 0 ? <p className="sva-empty">暂无日志。</p> : null}
			{logs.map((log, index) => (
				<div key={`${log.at}-${index}`} className={`sv-log__line ${log.kind === "error" ? "bad" : ""}`}>
					<span>{timeLabel(log.at)}</span>
					<span>{log.text}</span>
				</div>
			))}
		</div>
	);
}

function StatusCell({ item }: { item: SentinelSupervisorAuditItem }) {
	return (
		<span className="sva-status-cell">
			<span className="sva-status">
				<span className={`sva-dot ${statusClass(item.status)}`} />
				{STATUS_LABELS[item.status] ?? item.status}
			</span>
			<span className="sva-status-mode" title={modeHint(item)}>
				{MODE_LABELS[item.mode]}
			</span>
		</span>
	);
}

/** The filter controls the page owns; the query itself is sent by App. */
interface FilterState {
	projectId: string;
	mode: "" | SentinelSupervisorMode;
	progress: "" | SentinelSupervisorProgress;
	strategy: "" | SentinelSupervisorStrategy;
	customStrategyId: string;
	search: string;
}

const EMPTY_FILTER: FilterState = {
	projectId: "",
	mode: "",
	progress: "",
	strategy: "",
	customStrategyId: "",
	search: "",
};

export function SupervisorAuditPage({
	page,
	detail,
	projects,
	customStrategies,
	onQuery,
	onSelect,
	onBack,
	onOpenSession,
}: {
	page: SentinelSupervisorAuditPage | null;
	detail: SentinelSupervisorDetail | null;
	projects: SentinelProjectInfo[];
	customStrategies: SentinelSupervisorCustomStrategy[];
	onQuery: (query: {
		page?: number;
		projectId?: string;
		search?: string;
		mode?: SentinelSupervisorMode;
		progress?: SentinelSupervisorProgress;
		strategy?: SentinelSupervisorStrategy;
		customStrategyId?: string;
	}) => void;
	onSelect: (sessionId: string) => void;
	onBack: () => void;
	onOpenSession: (path: string) => void;
}) {
	const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
	// The filter that is actually on screen. The pager re-uses it, so typing
	// in the keyword box without pressing 查询 cannot change what page 2 shows.
	const [applied, setApplied] = useState<FilterState>(EMPTY_FILTER);
	// Each column pages on its own: the episode list, the advice and the log
	// grow at very different rates, and one shared pager would drag all three.
	const [episodePage, setEpisodePage] = useState(1);
	const [advicePage, setAdvicePage] = useState(1);
	const [logPage, setLogPage] = useState(1);

	// The detail is a real dialog: Escape closes it. The backdrop click is
	// handled by the console's own Overlay shell.
	useEffect(() => {
		if (!detail) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onBack();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [detail, onBack]);

	// A new session means a new set of columns: start every pager at the top.
	useEffect(() => {
		setEpisodePage(1);
		setAdvicePage(1);
		setLogPage(1);
	}, [detail?.session.sessionId]);

	const episodePages = pageCount(detail?.episodes.length ?? 0, EPISODE_PAGE_SIZE);
	const advicePages = pageCount(detail?.advice.length ?? 0, ADVICE_PAGE_SIZE);
	const logPages = pageCount(detail?.logs.length ?? 0, LOG_PAGE_SIZE);

	const stats = page?.stats ?? {
		total: 0,
		advancing: 0,
		stalled: 0,
		looping: 0,
		stopped: 0,
		pendingAdvice: 0,
	};

	const toQuery = (state: FilterState, nextPage: number) => ({
		page: nextPage,
		projectId: state.projectId || undefined,
		search: state.search.trim() || undefined,
		mode: state.mode || undefined,
		progress: state.progress || undefined,
		strategy: state.strategy || undefined,
		customStrategyId: state.customStrategyId || undefined,
	});

	const apply = (patch: Partial<FilterState>, nextPage = 1) => {
		const next = { ...filter, ...patch };
		setFilter(next);
		setApplied(next);
		onQuery(toQuery(next, nextPage));
	};

	const clearFilters = () => {
		setFilter(EMPTY_FILTER);
		setApplied(EMPTY_FILTER);
		onQuery(toQuery(EMPTY_FILTER, 1));
	};

	const filtered = Boolean(
		applied.projectId ||
			applied.mode ||
			applied.progress ||
			applied.strategy ||
			applied.customStrategyId ||
			applied.search.trim(),
	);

	return (
		<div className="page-card sva-page">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					监督
					<span className="ws-panel__sub">
						全部对话的监督审计 · 只读{page ? ` · 共 ${page.total} 个会话` : ""}
					</span>
				</div>
				<button type="button" className="ghost" onClick={() => onQuery(toQuery(applied, page?.page ?? 1))}>
					刷新
				</button>
			</div>

			<div className="ws-panel__body sva-body">
				<div className="sva-content">
					<div className="gate-filters sva-filters">
						<label>
							项目
							<select
								value={filter.projectId}
								onChange={(event) => apply({ projectId: event.target.value })}
							>
								<option value="">全部项目</option>
								{projects.map((project) => (
									<option value={project.id} key={project.id}>
										{project.name}
									</option>
								))}
							</select>
						</label>
						<label>
							模式
							<select
								value={filter.mode}
								onChange={(event) => apply({ mode: event.target.value as "" | SentinelSupervisorMode })}
							>
								<option value="">全部模式</option>
								<option value="observe">观察</option>
								<option value="intervene">介入</option>
							</select>
						</label>
						<label>
							进度
							<select
								value={filter.progress}
								onChange={(event) => apply({ progress: event.target.value as "" | SentinelSupervisorProgress })}
							>
								<option value="">全部进度</option>
								<option value="advancing">有进展</option>
								<option value="stalled">停滞</option>
								<option value="looping">循环</option>
								<option value="unknown">未判断</option>
							</select>
						</label>
						<label>
							策略
							<select
								value={filter.strategy}
								onChange={(event) => apply({ strategy: event.target.value as "" | SentinelSupervisorStrategy })}
							>
								<option value="">全部预设</option>
								{SUPERVISOR_STRATEGY_OPTIONS.map((option) => (
									<option value={option.id} key={option.id}>
										{option.label}
									</option>
								))}
							</select>
						</label>
						{customStrategies.length > 0 ? (
							<label>
								自定义
								<select
									value={filter.customStrategyId}
									onChange={(event) => apply({ customStrategyId: event.target.value })}
								>
									<option value="">全部</option>
									{customStrategies.map((custom) => (
										<option value={custom.id} key={custom.id}>
											{custom.name}
										</option>
									))}
								</select>
							</label>
						) : null}
						<label className="sva-search">
							关键字
							<input
								placeholder="会话 / 项目 / 意图"
								value={filter.search}
								spellCheck={false}
								onChange={(event) => setFilter({ ...filter, search: event.target.value })}
								onKeyDown={(event) => {
									if (event.key === "Enter") apply({ search: filter.search });
								}}
							/>
						</label>
						<button type="button" onClick={() => apply({ search: filter.search })}>
							查询
						</button>
						{filtered ? (
							<button type="button" className="ghost" onClick={clearFilters}>
								清空
							</button>
						) : null}
					</div>

					<div className="gate-summary sva-summary">
						<span>
							监督会话 <b>{stats.total}</b>
						</span>
						<span className="ok">
							有进展 <b>{stats.advancing}</b>
						</span>
						<span className={stats.stalled > 0 ? "warn" : ""}>
							停滞 <b>{stats.stalled}</b>
						</span>
						<span className={stats.looping > 0 ? "bad" : ""}>
							循环 <b>{stats.looping}</b>
						</span>
						<span>
							已停止 <b>{stats.stopped}</b>
						</span>
						<span className={stats.pendingAdvice > 0 ? "warn" : ""}>
							待确认建议 <b>{stats.pendingAdvice}</b>
						</span>
						<span className="gate-summary__note">进度与停止按每个会话的最新状态统计</span>
					</div>

					{!page ? (
						<div className="ws-empty">
							<span>正在读取监督审计…</span>
						</div>
					) : page.items.length === 0 ? (
						<div className="ws-empty">
							<span>{filtered ? "没有符合条件的监督会话" : "还没有开启过监督的会话"}</span>
							<span>
								{filtered
									? "清空筛选条件，或换个关键字再试一次。"
									: "开始对话前在输入框上方点「监督」，这里就会出现记录。"}
							</span>
						</div>
					) : (
						<>
							<div className="sva-table-scroll">
								<table className="sva-table">
									<thead>
										<tr>
											<th title="监督状态与模式">状态</th>
											<th>会话 / 项目</th>
											<th title="监督模型判断的当前阶段">阶段</th>
											<th title="监督模型判断的进展">进度</th>
											<th>策略</th>
											<th title="工具调用次数 / 监督 Episode 数">调用 / Episode</th>
											<th title="监督建议条数">建议</th>
											<th title="监督模型消耗的 tokens">tokens</th>
											<th>最近更新</th>
										</tr>
									</thead>
									<tbody>
										{page.items.map((item) => (
											<tr
												key={item.sessionId}
												className={detail?.session.sessionId === item.sessionId ? "selected" : ""}
												tabIndex={0}
												onClick={() => onSelect(item.sessionId)}
												onKeyDown={(event) => {
													if (event.key === "Enter" || event.key === " ") {
														event.preventDefault();
														onSelect(item.sessionId);
													}
												}}
											>
												<td>
													<StatusCell item={item} />
												</td>
												<td>
													<div className="sva-session">
														<b title={item.sessionName}>{item.sessionName}</b>
														<span title={item.projectName ?? undefined}>{item.projectName ?? "—"}</span>
													</div>
												</td>
												<td>{phaseLabel(item.phase)}</td>
												<td>
													<span className={`sva-pill ${progressClass(item.progress)}`}>
														{progressLabel(item.progress)}
													</span>
												</td>
												<td>
													<span className="sva-pill" title={strategyNames(item)}>
														{strategyNames(item)}
													</span>
												</td>
												<td className="sva-mono">
													{item.callCount} / {item.episodeCount}
												</td>
												<td>
													{item.adviceCount > 0 ? (
														<span className="sva-advice-count" title={`${item.adviceCount} 条监督建议`}>
															{item.adviceCount}
														</span>
													) : (
														<span className="sva-faint">—</span>
													)}
												</td>
												<td className="sva-mono">{formatTokens(item.usage.total)}</td>
												<td className="sva-time">{timeLabel(item.updatedAt)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<div className="sva-table-foot">
								<span>共 {page.total} 个会话</span>
								<div className="sva-pager">
									<button
										type="button"
										disabled={page.page <= 1}
										onClick={() => onQuery(toQuery(applied, page.page - 1))}
									>
										上一页
									</button>
									<span>
										{page.page} / {Math.max(1, Math.ceil(page.total / page.pageSize))}
									</span>
									<button
										type="button"
										disabled={page.page * page.pageSize >= page.total}
										onClick={() => onQuery(toQuery(applied, page.page + 1))}
									>
										下一页
									</button>
								</div>
							</div>
						</>
					)}
				</div>

				{detail ? (
					<Overlay
						title={detail.session.sessionName}
						className="sva-modal"
						subtitle={`${detail.session.projectName ?? "未选择项目"} · ${
							detail.session.mode === "observe"
								? "观察"
								: `介入 · ${detail.session.delivery === "auto" ? "自动" : "确认"}`
						} · ${strategyNames(detail.session)}`}
						actions={
							detail.session.sessionPath ? (
								<button
									type="button"
									className="primary"
									onClick={() => onOpenSession(detail.session.sessionPath!)}
								>
									打开会话
								</button>
							) : null
						}
						onClose={onBack}
					>
						<div className="sva-meta-inline">
							<span>
								阶段 <b>{phaseLabel(detail.session.phase)}</b>
							</span>
							<span>
								进度 <b>{progressLabel(detail.session.progress)}</b>
							</span>
							<span>
								工具调用 <b>{detail.session.callCount}</b>
							</span>
							<span>
								Episode <b>{detail.session.episodeCount}</b>
							</span>
							<span>
								tokens <b>{formatTokens(detail.session.usage.total)}</b>
							</span>
							<span>
								模式 <b>{MODE_LABELS[detail.session.mode]}</b>
							</span>
							<span>
								策略 <b>{strategyNames(detail.session)}</b>
							</span>
						</div>
						{strategyNotes(detail.session).map((note, index) => (
							<p className="sva-note" key={`${note.name}-${index}`}>
								策略说明 · {note.name}：{note.instructions}
							</p>
						))}
						{detail.session.strategyNote ? <p className="sva-note">补充：{detail.session.strategyNote}</p> : null}
						{detail.session.intent ? <p className="sva-intent">{detail.session.intent}</p> : null}
						{detail.session.lastError ? (
							<p className="sva-error">最近错误：{detail.session.lastError}</p>
						) : null}
						<div className="sva-modal-cols">
							<div className="sva-section">
								<h4>
									Episode <span className="sva-count">{detail.episodes.length}</span>
								</h4>
								<div className="sva-col-scroll">
									{pageItems(detail.episodes, episodePage, EPISODE_PAGE_SIZE).map((episode) => (
										<EpisodeBlock key={episode.id} episode={episode} />
									))}
									{detail.episodes.length === 0 ? <p className="sva-empty">还没有 episode。</p> : null}
								</div>
								<ColumnPager page={episodePage} pages={episodePages} onChange={setEpisodePage} />
							</div>
							<div className="sva-section">
								<h4>
									建议 <span className="sva-count">{detail.advice.length}</span>
								</h4>
								<div className="sva-col-scroll">
									{detail.advice.length === 0 ? (
										<p className="sva-empty">这次监督没有给出建议。</p>
									) : null}
									{pageItems(detail.advice, advicePage, ADVICE_PAGE_SIZE).map((advice) => (
										<div className={`sva-advice ${advice.status}`} key={advice.id}>
											<div className="sva-advice-head">
												<span className="sva-mono">{timeLabel(advice.at)}</span>
												<span>{advice.delivery === "auto" ? "自动" : "确认"}</span>
												<span className={`sva-advice-status sva-flag ${adviceStatusClass(advice.status)}`}>
													{advice.status === "sent"
														? "已发送"
														: advice.status === "ignored"
															? "已忽略"
															: "待确认"}
												</span>
											</div>
											<pre>{advice.text}</pre>
										</div>
									))}
								</div>
								<ColumnPager page={advicePage} pages={advicePages} onChange={setAdvicePage} />
							</div>
							<div className="sva-section">
								<h4>
									日志 <span className="sva-count">{detail.logs.length}</span>
								</h4>
								<div className="sva-col-scroll">
									<LogBlock logs={pageItems(detail.logs, logPage, LOG_PAGE_SIZE)} />
								</div>
								<ColumnPager page={logPage} pages={logPages} onChange={setLogPage} />
							</div>
						</div>
					</Overlay>
				) : null}
			</div>
		</div>
	);
}
