/**
 * 工作台 → 监督: a read-only audit of every conversation that was armed.
 *
 * Option A (Ops Table): filters + KPI strip + dense table, with a detail drawer
 * over the right edge. The live view belongs to the floating window; this page
 * never changes a running session.
 */

import { useState } from "react";
import type {
	SentinelProjectInfo,
	SentinelSupervisorAuditItem,
	SentinelSupervisorAuditPage,
	SentinelSupervisorDetail,
	SentinelSupervisorEpisode,
	SentinelSupervisorLog,
	SentinelSupervisorMode,
	SentinelSupervisorProgress,
} from "../types.ts";

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

function timeLabel(at: number): string {
	return new Date(at).toLocaleString("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function phaseLabel(value: string): string {
	return PHASE_LABELS[value] ?? value;
}

function progressLabel(value: string): string {
	return PROGRESS_LABELS[value] ?? value;
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

function EpisodeBlock({ episode }: { episode: SentinelSupervisorEpisode }) {
	return (
		<div className="sva-episode">
			<div className="sva-episode-head">
				<span>{timeLabel(episode.at)}</span>
				<span className={`sva-pill ${progressClass(episode.progress)}`}>
					{progressLabel(episode.progress)}
				</span>
				{episode.error ? <span className="sva-pill bad">失败</span> : null}
				<span className="sva-episode-trigger">{episode.trigger}</span>
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
		<span className="sva-status">
			<span className={`sva-dot ${statusClass(item.status)}`} />
			{STATUS_LABELS[item.status] ?? item.status}
		</span>
	);
}

export function SupervisorAuditPage({
	page,
	detail,
	projects,
	onQuery,
	onSelect,
	onBack,
	onOpenSession,
}: {
	page: SentinelSupervisorAuditPage | null;
	detail: SentinelSupervisorDetail | null;
	projects: SentinelProjectInfo[];
	onQuery: (query: {
		page?: number;
		projectId?: string;
		search?: string;
		mode?: SentinelSupervisorMode;
		progress?: SentinelSupervisorProgress;
	}) => void;
	onSelect: (sessionId: string) => void;
	onBack: () => void;
	onOpenSession: (path: string) => void;
}) {
	const [projectId, setProjectId] = useState("");
	const [mode, setMode] = useState<"" | SentinelSupervisorMode>("");
	const [progress, setProgress] = useState<"" | SentinelSupervisorProgress>("");
	const [search, setSearch] = useState("");
	const stats = page?.stats ?? {
		total: 0,
		advancing: 0,
		stalled: 0,
		looping: 0,
		stopped: 0,
		pendingAdvice: 0,
	};

	const query = (nextPage = 1) => ({
		page: nextPage,
		projectId: projectId || undefined,
		search: search || undefined,
		mode: mode || undefined,
		progress: progress || undefined,
	});

	return (
		<div className="sva-page">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					监督
					<span className="ws-panel__sub">全部对话的监督审计 · 只读</span>
				</div>
				<div className="sva-head-actions">
					<button type="button" onClick={() => onQuery(query(page?.page ?? 1))}>
						刷新
					</button>
				</div>
			</div>

			<div className="ws-panel__body sva-body">
				<div className="sva-content">
					<div className="sva-filters">
						<select
							value={projectId}
							onChange={(event) => setProjectId(event.target.value)}
							aria-label="按项目筛选"
						>
							<option value="">全部项目</option>
							{projects.map((project) => (
								<option value={project.id} key={project.id}>
									{project.name}
								</option>
							))}
						</select>
						<select
							value={mode}
							onChange={(event) => setMode(event.target.value as "" | SentinelSupervisorMode)}
							aria-label="按模式筛选"
						>
							<option value="">全部模式</option>
							<option value="observe">观察</option>
							<option value="intervene">介入</option>
						</select>
						<select
							value={progress}
							onChange={(event) => setProgress(event.target.value as "" | SentinelSupervisorProgress)}
							aria-label="按进度筛选"
						>
							<option value="">全部进度</option>
							<option value="advancing">有进展</option>
							<option value="stalled">停滞</option>
							<option value="looping">循环</option>
							<option value="unknown">未判断</option>
						</select>
						<input
							placeholder="搜索会话 / 项目 / 意图"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") onQuery(query(1));
							}}
						/>
						<button type="button" className="primary" onClick={() => onQuery(query(1))}>
							查询
						</button>
					</div>

					<div className="sva-kpis">
						<div className="sva-kpi">
							<b>{stats.total}</b>
							<span>监督会话</span>
						</div>
						<div className="sva-kpi ok">
							<b>{stats.advancing}</b>
							<span>有进展</span>
						</div>
						<div className="sva-kpi warn">
							<b>{stats.stalled}</b>
							<span>停滞</span>
						</div>
						<div className="sva-kpi bad">
							<b>{stats.looping}</b>
							<span>循环</span>
						</div>
						<div className="sva-kpi">
							<b>{stats.pendingAdvice}</b>
							<span>待确认建议</span>
						</div>
					</div>

					{!page ? (
						<p className="sva-empty">正在读取监督审计…</p>
					) : page.items.length === 0 ? (
						<p className="sva-empty">还没有开启过监督的会话。开始对话前在输入框上方点「监督」。</p>
					) : (
						<div className="sva-table-wrap">
							<table className="sva-table">
								<thead>
									<tr>
										<th>状态</th>
										<th>会话 / 项目</th>
										<th>阶段</th>
										<th>进度</th>
										<th>调用 / EP</th>
										<th>建议</th>
										<th>tokens</th>
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
												if (event.key === "Enter" || event.key === " ") onSelect(item.sessionId);
											}}
										>
											<td>
												<StatusCell item={item} />
											</td>
											<td>
												<div className="sva-session">
													<b>{item.sessionName}</b>
													<span>{item.projectName ?? "—"}</span>
												</div>
											</td>
											<td>{phaseLabel(item.phase)}</td>
											<td>
												<span className={`sva-pill ${progressClass(item.progress)}`}>
													{progressLabel(item.progress)}
												</span>
											</td>
											<td className="sva-mono">
												{item.callCount} / {item.episodeCount}
											</td>
											<td>
												{item.adviceCount > 0 ? (
													<span className="sva-advice-count">{item.adviceCount}</span>
												) : (
													<span className="sva-faint">0</span>
												)}
											</td>
											<td className="sva-mono">{formatTokens(item.usage.total)}</td>
											<td className="sva-time">{timeLabel(item.updatedAt)}</td>
										</tr>
									))}
								</tbody>
							</table>
							<div className="sva-table-foot">
								<span>共 {page.total} 个会话</span>
								<div className="sva-pager">
									<button
										type="button"
										disabled={page.page <= 1}
										onClick={() => onQuery(query(page.page - 1))}
									>
										上一页
									</button>
									<span>
										{page.page} / {Math.max(1, Math.ceil(page.total / page.pageSize))}
									</span>
									<button
										type="button"
										disabled={page.page * page.pageSize >= page.total}
										onClick={() => onQuery(query(page.page + 1))}
									>
										下一页
									</button>
								</div>
							</div>
						</div>
					)}
				</div>

				{detail ? (
					<aside className="sva-drawer" aria-label="监督详情">
						<div className="sva-drawer-head">
							<div>
								<h3>{detail.session.sessionName}</h3>
								<p>
									{detail.session.projectName ?? "未选择项目"} ·{" "}
									{detail.session.mode === "observe"
										? "观察"
										: `介入 · ${detail.session.delivery === "auto" ? "自动" : "确认"}`}
								</p>
							</div>
							<button type="button" onClick={onBack} aria-label="关闭详情">
								×
							</button>
						</div>
						<div className="sva-drawer-body">
							<div className="sva-meta-grid">
								<div>
									<b>{phaseLabel(detail.session.phase)}</b>
									<span>阶段</span>
								</div>
								<div>
									<b>{progressLabel(detail.session.progress)}</b>
									<span>进度</span>
								</div>
								<div>
									<b>{detail.session.callCount}</b>
									<span>调用</span>
								</div>
								<div>
									<b>{formatTokens(detail.session.usage.total)}</b>
									<span>tokens</span>
								</div>
							</div>

							{detail.session.intent ? <p className="sva-drawer-intent">{detail.session.intent}</p> : null}
							{detail.session.lastError ? (
								<p className="sva-drawer-error">最近错误：{detail.session.lastError}</p>
							) : null}

							<div className="sva-drawer-section">
								<h4>Episode</h4>
								{detail.episodes.length === 0 ? <p className="sva-empty">还没有 episode。</p> : null}
								{detail.episodes.map((episode) => (
									<EpisodeBlock key={episode.id} episode={episode} />
								))}
							</div>

							{detail.advice.length > 0 ? (
								<div className="sva-drawer-section">
									<h4>建议</h4>
									{detail.advice.map((advice) => (
										<div className={`sva-advice ${advice.status}`} key={advice.id}>
											<div className="sva-advice-head">
												<span>{timeLabel(advice.at)}</span>
												<span>{advice.delivery === "auto" ? "自动" : "确认"}</span>
												<span>
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
							) : null}

							<div className="sva-drawer-section">
								<h4>日志</h4>
								<LogBlock logs={detail.logs} />
							</div>

							{detail.session.sessionPath ? (
								<button
									type="button"
									className="primary sva-open-session"
									onClick={() => onOpenSession(detail.session.sessionPath!)}
								>
									打开会话
								</button>
							) : null}
						</div>
					</aside>
				) : null}
			</div>
		</div>
	);
}
