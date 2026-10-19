/**
 * 审批：AI 审批判定流水 + 自动审批工具调用流水，只读。
 *
 * Two tabs, one table. 「AI 审批」 is what the gatekeeper judged; 「自动审批」
 * is every tool call nobody judged. Together they cover each call exactly once —
 * a call is written by the judge or by `recordUnjudged`, never by both — so the
 * two tabs are a split of one trail, not two logs to reconcile.
 *
 * The tabs are not local state: they are a view of `filter.approval`, which is
 * the same field the tab switch writes. That keeps the pagination at the bottom
 * honest — it re-queries with the same filter instead of losing the split.
 */

import { useMemo, useState } from "react";
import type {
	SentinelGateApproval,
	SentinelGateDecision,
	SentinelGateFilter,
	SentinelGateStats,
	SentinelGateTab,
	SentinelProjectInfo,
	SessionInfoView,
} from "../types.ts";
import { SENTINEL_GATE_APPROVAL_LABELS, SENTINEL_GATE_DECISION_LABELS, SENTINEL_GATE_TAB_BUCKETS } from "../types.ts";

const PAGE_SIZE = 50;

/** How many sessions the 会话 filter offers; the rest are found by id. */
const MAX_SESSION_OPTIONS = 60;

/** Time windows the since-filter offers; 0 means "everything". */
const WINDOWS: Array<{ label: string; ms: number }> = [
	{ label: "全部时间", ms: 0 },
	{ label: "最近 1 小时", ms: 60 * 60 * 1000 },
	{ label: "最近 24 小时", ms: 24 * 60 * 60 * 1000 },
	{ label: "最近 7 天", ms: 7 * 24 * 60 * 60 * 1000 },
];

/** Row form: date plus clock, without the year. */
function formatClock(at: number): string {
	return new Date(at).toLocaleString("zh-CN", {
		hour12: false,
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** Short form for the stat tiles, where the year is noise. */
function formatShort(at: number): string {
	return new Date(at).toLocaleString("zh-CN", {
		hour12: false,
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatLatency(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	return `${(ms / 1000).toFixed(1)} s`;
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

/**
 * `mcp__<server>__<tool>` → `<tool>`. The server is what tells plugin tools from
 * custom MCP servers, so it stays in the tooltip and in the expanded row.
 */
function toolLabel(tool: string): string {
	if (!tool.startsWith("mcp__")) return tool;
	const rest = tool.slice("mcp__".length);
	const end = rest.indexOf("__");
	return end > 0 ? rest.slice(end + 2) : rest;
}

/** What the 会话 filter shows for one session: its name, else its first line. */
function sessionTitle(session: SessionInfoView): string {
	const name = session.name?.trim() || session.firstMessage?.trim() || session.id;
	return name.length > 48 ? `${name.slice(0, 48)}…` : name;
}

/** The one filter state the page owns; the query itself is sent by App. */
export function GateAuditPage({
	items,
	stats,
	tabCounts,
	total,
	page,
	filter,
	projects,
	sessions,
	onQuery,
	onRefresh,
	onOpenSession,
	sessionPathOf,
}: {
	items: SentinelGateDecision[];
	stats: SentinelGateStats | null;
	/** Rows per approval bucket under every filter but the tab's own. */
	tabCounts: Record<SentinelGateApproval, number> | null;
	total: number;
	page: number;
	filter: SentinelGateFilter;
	projects: SentinelProjectInfo[];
	/** Known conversations, newest first, for the 会话 filter. */
	sessions: SessionInfoView[];
	onQuery: (filter: SentinelGateFilter, page: number) => void;
	onRefresh: () => void;
	onOpenSession: (path: string) => void;
	/** Resolve a judgment's session id to a conversation file, when it is known. */
	sessionPathOf: (sessionId: string) => string | null;
}) {
	const [search, setSearch] = useState(filter.search ?? "");
	const [windowIndex, setWindowIndex] = useState(0);
	const [expanded, setExpanded] = useState<string | null>(null);

	/**
	 * Which tab the filter selects. An absent or empty list reads as the first
	 * tab rather than the second: a link that opens the page without an approval
	 * field should land on 「AI 审批」, which is what this page has always shown.
	 */
	const tab: SentinelGateTab =
		filter.approval && filter.approval.length > 0 && !filter.approval.includes("ai") ? "auto" : "ai";

	const apply = (patch: Partial<SentinelGateFilter>, nextPage = 1) => {
		onQuery({ ...filter, ...patch }, nextPage);
	};

	// The verdict filter means different things on the two tabs: `failed` only
	// exists where a judge ran, and 人工拦截 is a 判定 value on this tab. Dropping
	// it on the way over keeps a filter from silently emptying the other tab.
	const applyTab = (next: SentinelGateTab) => {
		onQuery({ ...filter, decision: undefined, approval: SENTINEL_GATE_TAB_BUCKETS[next] }, 1);
	};

	const applyWindow = (index: number) => {
		setWindowIndex(index);
		const entry = WINDOWS[index];
		apply({ since: entry && entry.ms > 0 ? Date.now() - entry.ms : undefined });
	};

	// Session id → what to call it, so the row and the filter agree on a name.
	const titles = useMemo(() => new Map(sessions.map((session) => [session.id, sessionTitle(session)])), [sessions]);
	const sessionOptions = useMemo(
		() => [...sessions].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)).slice(0, MAX_SESSION_OPTIONS),
		[sessions],
	);

	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	/**
	 * Whether anything other than the tab itself narrows the list. An empty page
	 * with no other filter is a bucket that has never been written to, which is
	 * a different sentence from a filter that matched nothing.
	 */
	const filtersBeyondTab = Boolean(
		filter.projectId || filter.sessionId || filter.source || filter.search || filter.since || filter.decision,
	);

	return (
		<div className="page-card">
			<div className="ws-panel__head">
			<div className="ws-panel__title">
				审批
				<span className="ws-panel__sub">
					{tab === "ai" ? "AI 审批判定流水" : "自动审批工具调用流水"}
						{" · 只读 · 永久保留"}
						{stats ? ` · 共 ${stats.total} 条` : ""}
					</span>
				</div>
				<button type="button" className="ghost" onClick={onRefresh}>
					刷新
				</button>
			</div>
			<div className="ws-panel__body">
				<div className="gate-tabs">
					<button type="button" className={tab === "ai" ? "on" : ""} onClick={() => applyTab("ai")}>
						AI 审批
						<span className="gate-tabs__count">{tabCounts?.ai ?? stats?.byApproval.ai ?? 0}</span>
					</button>
					<button type="button" className={tab === "auto" ? "on" : ""} onClick={() => applyTab("auto")}>
						自动审批
						<span className="gate-tabs__count">
							{(tabCounts?.auto ?? stats?.byApproval.auto ?? 0) + (tabCounts?.human ?? stats?.byApproval.human ?? 0)}
						</span>
					</button>
				</div>

				{tab === "ai" ? (
					<div className="gate-summary">
						<span>
							拦截 <b>{stats?.byDecision.block ?? 0}</b>
						</span>
						<span>
							放行 <b>{stats?.byDecision.allow ?? 0}</b>
						</span>
						<span className={(stats?.byDecision.failed ?? 0) > 0 ? "bad" : ""}>
							失败 <b>{stats?.byDecision.failed ?? 0}</b>
						</span>
						<span>
							拦截率 <b>{stats ? percent(stats.blockRate) : "-"}</b>
						</span>
						<span>
							平均耗时 <b>{stats ? formatLatency(stats.avgLatencyMs) : "-"}</b>
						</span>
						<span>
							24 小时 <b>{stats?.last24h ?? 0}</b>
						</span>
						<span>
							tokens <b>{stats ? stats.totalTokens.toLocaleString("en-US") : 0}</b>
						</span>
						<span>
							最近成功 <b>{stats?.lastSuccessAt ? formatShort(stats.lastSuccessAt) : "从未"}</b>
						</span>
					</div>
				) : (
					<div className="gate-summary">
						<span>
							自动放行 <b>{stats?.byApproval.auto ?? 0}</b>
						</span>
						<span>
							人工放行 <b>{stats?.byApproval.human ?? 0}</b>
						</span>
						<span className={(stats?.byDecision.block ?? 0) > 0 ? "bad" : ""}>
							人工拦截 <b>{stats?.byDecision.block ?? 0}</b>
						</span>
						<span>
							24 小时 <b>{stats?.last24h ?? 0}</b>
						</span>
						<span className="gate-summary__note">这些调用不经过判定，只留痕</span>
					</div>
				)}

				{stats?.lastError ? (
					<div className="test-result bad">
						<div>最近一次判定失败：{stats.lastError}</div>
					</div>
				) : null}

				<div className="gate-filters">
					{tab === "ai" ? (
						<label>
							判定
							<select
								value={filter.decision ?? ""}
								onChange={(event) =>
									apply({ decision: (event.target.value || undefined) as SentinelGateFilter["decision"] })
								}
							>
								<option value="">全部</option>
								<option value="block">拦截</option>
								<option value="allow">放行</option>
								<option value="failed">请求失败</option>
							</select>
						</label>
					) : null}
					<label>
						来源
						<select
							value={filter.source ?? ""}
							onChange={(event) => apply({ source: event.target.value || undefined })}
						>
							<option value="">全部</option>
							<option value="主代理">主代理</option>
							<option value="子代理">子代理</option>
						</select>
					</label>
					<label>
						时间
						<select value={windowIndex} onChange={(event) => applyWindow(Number(event.target.value))}>
							{WINDOWS.map((entry, index) => (
								<option key={entry.label} value={index}>
									{entry.label}
								</option>
							))}
						</select>
					</label>
					<label>
						项目
						<select
							value={filter.projectId ?? ""}
							onChange={(event) => apply({ projectId: event.target.value || undefined })}
						>
							<option value="">全部项目</option>
							{projects.map((project) => (
								<option key={project.id} value={project.id}>
									{project.name}
								</option>
							))}
						</select>
					</label>
					<label>
						会话
						<select
							value={filter.sessionId ?? ""}
							onChange={(event) => apply({ sessionId: event.target.value || undefined })}
						>
							<option value="">全部会话</option>
							{sessionOptions.map((session) => (
								<option key={session.id} value={session.id}>
									{sessionTitle(session)}
								</option>
							))}
						</select>
					</label>
					<label className="gate-search">
						关键字
						<input
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") apply({ search: search.trim() || undefined });
							}}
							placeholder="命令或理由中包含…"
							spellCheck={false}
						/>
					</label>
					<button type="button" onClick={() => apply({ search: search.trim() || undefined })}>
						筛选
					</button>
					<button
						type="button"
						className="ghost"
						onClick={() => {
							setSearch("");
							setWindowIndex(0);
							onQuery(tab === "ai" ? { approval: SENTINEL_GATE_TAB_BUCKETS.ai } : {}, 1);
						}}
					>
						清空
					</button>
				</div>

			{items.length === 0 ? (
				<div className="ws-empty">
					<span>
						{filtersBeyondTab
							? `没有符合条件的${tab === "ai" ? "判定记录" : "调用记录"}`
							: tab === "ai"
								? "AI 审批还没有任何记录"
								: "自动审批还没有任何记录"}
					</span>
					{tab === "ai" ? (
						<span>
							AI 审批模式下每条命令、以及（开关打开时）每次 MCP / 插件工具调用都会在这里留下一条记录；审批模式与自动执行不产生判定记录，它们的调用在「自动审批」标签页。
						</span>
					) : (
						<span>
							{filtersBeyondTab
								? "这一页是所有「没有经过判定」的调用：自动执行模式、审批模式（含人工放行与人工拦截）、以及 AI 审批下守门没覆盖到的工具（read / edit / write、MCP 开关关闭时）。每次 bash、droid_shell、MCP 与插件、内置工具调用都会留一条。"
								: "这一页只记录本次更新之后发生的调用——自动执行模式、审批模式（含人工放行与人工拦截）、以及 AI 审批下守门没覆盖到的工具（read / edit / write、MCP 开关关闭时）。把某个会话的模式切到「自动执行」或「审批模式」再跑几条命令，这里就会出现记录。"}
						</span>
					)}
				</div>
			) : (
					<table className="gate-table">
						<thead>
							<tr>
								<th>时间</th>
								<th>{tab === "ai" ? "判定" : "方式"}</th>
								<th>调用</th>
								<th>来源</th>
								{tab === "ai" ? <th>模型</th> : <th>会话</th>}
								{tab === "ai" ? <th>耗时</th> : null}
							</tr>
						</thead>
						<tbody>
							{items.map((item) => {
								const sessionPath = item.sessionId ? sessionPathOf(item.sessionId) : null;
								const open = expanded === item.id;
								return (
									<tr
										key={item.id}
										className={`gate-row ${item.decision}`}
										onClick={() => setExpanded(open ? null : item.id)}
									>
										<td className="gate-time">{formatClock(item.at)}</td>
										<td>
											{tab === "ai" ? (
												<span className={`gate-badge ${item.decision}`}>
													{SENTINEL_GATE_DECISION_LABELS[item.decision]}
												</span>
											) : (
												<span className={`gate-badge ${item.decision === "block" ? "block" : "allow"}`}>
													{item.decision === "block" ? "人工拦截" : SENTINEL_GATE_APPROVAL_LABELS[item.approval]}
												</span>
											)}
										</td>
										<td className="gate-command">
											{item.tool !== "bash" ? (
												<span className="gate-tool" title={item.tool}>
													{toolLabel(item.tool)}
												</span>
											) : null}
											<code className={open ? "open" : ""} title={item.command}>
												{open ? item.command : item.command.split("\n")[0]?.slice(0, 200)}
											</code>
											{open ? (
												<div className="gate-detail">
													{item.tool !== "bash" ? <div>工具：{item.tool}</div> : null}
													<div>方式：{SENTINEL_GATE_APPROVAL_LABELS[item.approval]}</div>
													{item.reason ? <div>理由：{item.reason}</div> : null}
													{item.error ? <div className="gate-detail-error">失败：{item.error}</div> : null}
													<div>工作目录：{item.cwd ?? "-"}</div>
													<div>
														tokens：{item.totalTokens ?? "-"}
														{item.modelFrom ? ` · 来源 ${item.modelFrom}` : ""}
														{item.commandTruncated ? " · 命令已截断存储" : ""}
													</div>
													{item.commandTruncated ? <div>（记录里的命令超过 8 KB，已截断）</div> : null}
												</div>
											) : null}
										</td>
										<td className="gate-source" title={item.source}>
											{item.source}
											{sessionPath ? (
												<button
													type="button"
													className="link"
													title="打开这次调用所在的会话"
													onClick={(event) => {
														event.stopPropagation();
														onOpenSession(sessionPath);
													}}
												>
													会话
												</button>
											) : null}
										</td>
										{tab === "ai" ? (
											<>
												<td className="gate-model">
													<span className="gate-model-id" title={item.model ?? ""}>
														{item.model ?? "-"}
													</span>
													{item.modelFrom ? <span className="gate-model-from">{item.modelFrom}</span> : null}
												</td>
												<td className="gate-latency">{formatLatency(item.latencyMs)}</td>
											</>
										) : (
											<td className="gate-session" title={item.sessionId ? titles.get(item.sessionId) ?? "" : ""}>
												{item.sessionId ? (titles.get(item.sessionId) ?? item.sessionId.slice(0, 8)) : "-"}
											</td>
										)}
									</tr>
								);
							})}
						</tbody>
					</table>
				)}

				{pages > 1 ? (
					<div className="gate-pager">
						<button type="button" disabled={page <= 1} onClick={() => onQuery(filter, page - 1)}>
							上一页
						</button>
						<span>
							第 {page} / {pages} 页 · 共 {total} 条
						</span>
						<button type="button" disabled={page >= pages} onClick={() => onQuery(filter, page + 1)}>
							下一页
						</button>
					</div>
				) : null}
			</div>
		</div>
	);
}
