/**
 * 守门审计：AI 审批模式下的判定流水，只读。
 *
 * Every judgment is here, including the ones that were allowed and the ones that
 * never got an answer. A log of blocks alone could not answer the questions this
 * page exists for: what did the gatekeeper actually see, how often did it say no,
 * and is it even alive.
 */

import { useState } from "react";
import type { SentinelGateDecision, SentinelGateFilter, SentinelGateStats, SentinelProjectInfo } from "../types.ts";
import { SENTINEL_GATE_DECISION_LABELS } from "../types.ts";

const PAGE_SIZE = 50;

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

/** The one filter state the page owns; the query itself is sent by App. */
export function GateAuditPage({
	items,
	stats,
	total,
	page,
	filter,
	projects,
	onQuery,
	onOpenSession,
	sessionPathOf,
}: {
	items: SentinelGateDecision[];
	stats: SentinelGateStats | null;
	total: number;
	page: number;
	filter: SentinelGateFilter;
	projects: SentinelProjectInfo[];
	onQuery: (filter: SentinelGateFilter, page: number) => void;
	onOpenSession: (path: string) => void;
	/** Resolve a judgment's session id to a conversation file, when it is known. */
	sessionPathOf: (sessionId: string) => string | null;
}) {
	const [search, setSearch] = useState(filter.search ?? "");
	const [windowIndex, setWindowIndex] = useState(0);
	const [expanded, setExpanded] = useState<string | null>(null);

	const apply = (patch: Partial<SentinelGateFilter>, nextPage = 1) => {
		onQuery({ ...filter, ...patch }, nextPage);
	};

	const applyWindow = (index: number) => {
		setWindowIndex(index);
		const entry = WINDOWS[index];
		apply({ since: entry && entry.ms > 0 ? Date.now() - entry.ms : undefined });
	};

	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return (
		<div className="page-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					守门审计
					<span className="ws-panel__sub">
						AI 审批判定流水 · 只读 · 永久保留
						{stats ? ` · 共 ${stats.total} 条` : ""}
					</span>
				</div>
			</div>
			<div className="ws-panel__body">
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

				{stats?.lastError ? (
					<div className="test-result bad">
						<div>最近一次判定失败：{stats.lastError}</div>
					</div>
				) : null}

				<div className="gate-filters">
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
							onQuery({}, 1);
						}}
					>
						清空
					</button>
				</div>

				{items.length === 0 ? (
					<div className="ws-empty">
						<span>没有符合条件的判定记录</span>
						<span>
							AI 审批模式下每条命令、以及（开关打开时）每次 MCP / 插件工具调用都会在这里留下一条记录；审批模式与自动执行不产生记录。
						</span>
					</div>
				) : (
					<table className="gate-table">
						<thead>
							<tr>
								<th>时间</th>
								<th>判定</th>
								<th>调用</th>
								<th>来源</th>
								<th>模型</th>
								<th>耗时</th>
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
											<span className={`gate-badge ${item.decision}`}>
												{SENTINEL_GATE_DECISION_LABELS[item.decision]}
											</span>
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
													title="打开这次判定所在的会话"
													onClick={(event) => {
														event.stopPropagation();
														onOpenSession(sessionPath);
													}}
												>
													会话
												</button>
											) : null}
										</td>
										<td className="gate-model">
											<span className="gate-model-id" title={item.model ?? ""}>
												{item.model ?? "-"}
											</span>
											{item.modelFrom ? <span className="gate-model-from">{item.modelFrom}</span> : null}
										</td>
										<td className="gate-latency">{formatLatency(item.latencyMs)}</td>
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
