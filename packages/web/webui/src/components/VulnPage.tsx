/**
 * The vulnerability hub.
 *
 * The agent submits findings while it works; this page is where the operator
 * reads them. It is deliberately read-mostly: a record's content comes from the
 * submission and cannot be rewritten here, because the value of the hub is that
 * it shows what was claimed and what was verified, separately. What the operator
 * changes is the review outcome — status, severity, CVSS and a note — and that
 * lands in the record's timeline.
 */

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.ts";
import type {
	SentinelEngine,
	SentinelFilePreview,
	SentinelVulnEvidence,
	SentinelVulnerability,
	SentinelVulnFilters,
	SentinelVulnReview,
	SentinelVulnSeverity,
	SentinelVulnStats,
	SentinelVulnStatus,
	SentinelVulnSummary,
	SentinelVulnUpdate,
	SessionInfoView,
} from "../types.ts";
import { SENTINEL_VULN_SEVERITIES, SENTINEL_VULN_SEVERITY_LABELS, SENTINEL_VULN_STATUS_LABELS } from "../types.ts";
import { CaretDownIcon, CloseIcon, DeleteIcon, DownloadIcon } from "./icons.tsx";
import { Overlay } from "./Overlay.tsx";

const STATUSES: readonly SentinelVulnStatus[] = ["pending", "confirmed", "false_positive", "fixed"];

function formatWhen(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const sameYear = date.getFullYear() === new Date().getFullYear();
	const datePart = sameYear
		? `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
		: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	return `${datePart} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Small state chip next to the severity: the reviewer's calibration status. */
function ReviewChip({ review }: { review?: SentinelVulnReview }) {
	if (!review || review.state === "skipped") return null;
	if (review.state === "queued") {
		return (
			<span className="review-chip review-queued" title={t("评审 LLM 排队中")}>
				{t("…评")}
			</span>
		);
	}
	if (review.state === "failed") {
		return (
			<span className="review-chip review-failed" title={t("评审失败：{error}", { error: review.error ?? "" })}>
				{t("未评")}
			</span>
		);
	}
	if (review.verdict === "dubious") {
		return (
			<span className="review-chip review-dubious" title={t("评审存疑：{reason}", { reason: review.reason ?? "" })}>
				{t("⚠存疑")}
			</span>
		);
	}
	return (
		<span
			className="review-chip review-done"
			title={t("已评审（{model}）：{reason}", { model: review.model ?? "", reason: review.reason ?? "" })}
		>
			{t("✓评")}
		</span>
	);
}

function severityClass(severity: SentinelVulnSeverity): string {
	return `vuln-sev vuln-sev-${severity}`;
}

/**
 * Whether the level on the record is still the agent's own guess.
 *
 * A record the reviewer has ruled on carries a calibrated number. One whose
 * review failed — or has not come back yet — carries what the agent claimed,
 * and the console labels it 「自评」 instead of presenting it as a verdict.
 */
function isAgentRating(review?: SentinelVulnReview): boolean {
	if (!review) return false;
	return review.state === "failed" || review.state === "queued";
}

/** The severity bucket a CVSS base score maps to; used for the mismatch hint. */
function severityForScore(score: number): SentinelVulnSeverity {
	if (score >= 9) return "critical";
	if (score >= 7) return "high";
	if (score >= 4) return "medium";
	if (score > 0) return "low";
	return "info";
}

/** Copy button used by the packet and evidence blocks. */
function CopyButton({ text, label = t("复制") }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="console-btn"
			onClick={() => {
				void navigator.clipboard
					.writeText(text)
					.then(() => {
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1500);
					})
					.catch(() => {});
			}}
		>
			{copied ? t("已复制") : label}
		</button>
	);
}

function vulnSource(source: string): string {
	if (source === "主代理") return t("主代理");
	if (source === "子代理") return t("子代理来源");
	if (source.startsWith("子代理 ")) return `${t("子代理来源")} ${source.slice(4)}`;
	const task = /^工程任务「(.+)」$/.exec(source);
	if (task) return t("工程任务「{name}」", { name: task[1] ?? "" });
	return source;
}

export function VulnPage({
	items,
	stats,
	filters,
	projectName,
	projectId,
	engines,
	sessions,
	hasProject,
	deletePending,
	deletePreview,
	onFiltersChange,
	onOpen,
	onExport,
	onRetryReview,
	onReviewAllPending,
	onRequestDelete,
	onConfirmDelete,
	onCancelDelete,
}: {
	items: SentinelVulnSummary[];
	stats: SentinelVulnStats;
	filters: SentinelVulnFilters;
	projectName: string | null;
	/** Active project, so the engine dropdown lists this project's engines only. */
	projectId: string | null;
	/** All engines of the project, finished ones included: findings are historical. */
	engines: SentinelEngine[];
	/** All sessions of the project, for the session dropdown. */
	sessions: SessionInfoView[];
	hasProject: boolean;
	/** Ids awaiting the delete confirmation, null when no dialog is open. */
	deletePending: string[] | null;
	/** What that deletion would take with it, once the server answered. */
	deletePreview: { count: number; evidence: number; notes: number } | null;
	onFiltersChange: (filters: SentinelVulnFilters) => void;
	onOpen: (id: string) => void;
	onExport: (filters: SentinelVulnFilters) => void;
	onRetryReview: (id: string, force: boolean) => void;
	onReviewAllPending: () => void;
	onRequestDelete: (ids: string[]) => void;
	onConfirmDelete: (ids: string[]) => void;
	onCancelDelete: () => void;
}) {
	const [search, setSearch] = useState(filters.search ?? "");
	const [target, setTarget] = useState(filters.target ?? "");
	/** The condition panel is closed by default: the chips already say what is on. */
	const [filterOpen, setFilterOpen] = useState(false);
	const filterRef = useRef<HTMLDivElement | null>(null);
	/** Rows ticked for deletion; cleared whenever the list is replaced. */
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

	// Keep the inputs in step when the page is opened fresh or filters are reset.
	useEffect(() => {
		setSearch(filters.search ?? "");
	}, [filters.search]);
	useEffect(() => {
		setTarget(filters.target ?? "");
	}, [filters.target]);
	// A refresh (another console, or the agent submitting a finding) must not drop
	// the operator's ticks, but ids that disappeared cannot stay selected: deleting
	// them would mean deleting records that are no longer visible.
	useEffect(() => {
		setSelected((prev) => {
			if (prev.size === 0) return prev;
			const visible = new Set(items.map((item) => item.id));
			const next = new Set([...prev].filter((id) => visible.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [items]);

	// Strictly this project's engines: with no project there is nothing to show, and
	// another project's engines must never appear in a project-scoped hub.
	useEffect(() => {
		if (!filterOpen) return;
		const onDown = (event: MouseEvent) => {
			if (filterRef.current && !filterRef.current.contains(event.target as Node)) setFilterOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setFilterOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [filterOpen]);

	const projectEngines = engines.filter((engine) => engine.projectId === projectId);
	const activeEngine = projectEngines.find((engine) => engine.id === filters.engineId);
	const toggle = (id: string): void => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
	const selectedIds = items.filter((item) => selected.has(item.id)).map((item) => item.id);
	// Every session of the project is offered, named when it has a name and
	// identified by its first message otherwise.
	const sessionOptions = sessions.map((session) => ({
		id: session.id,
		name: session.name?.trim() || session.firstMessage.slice(0, 40) || t("未命名会话"),
	}));
	/** A record can outlive its session; the snapshot keeps the option readable. */
	const sessionLabelFor = (id: string): string =>
		items.find((item) => item.id && item.sessionId === id)?.sessionName?.trim() || t("已删除的会话");

	/**
	 * The conditions the panel can set, as removable chips. Search and 存疑 are not
	 * here on purpose: each already has a visible control of its own.
	 */
	const chips: { key: string; label: string; value: string; clear: () => void }[] = [];
	if (filters.target) {
		chips.push({
			key: "target",
			label: t("目标"),
			value: filters.target,
			clear: () => onFiltersChange({ ...filters, target: undefined }),
		});
	}
	if (filters.sessionId) {
		chips.push({
			key: "session",
			label: t("会话"),
			value: sessionLabelFor(filters.sessionId),
			clear: () => onFiltersChange({ ...filters, sessionId: undefined }),
		});
	}
	if (filters.engineId) {
		chips.push({
			key: "engine",
			label: t("工程"),
			value: activeEngine?.name ?? filters.engineId,
			// A task belongs to an engine, so dropping the engine drops its task too.
			clear: () => onFiltersChange({ ...filters, engineId: undefined, taskId: undefined }),
		});
	}
	if (filters.taskId) {
		chips.push({
			key: "task",
			label: t("任务"),
			value: activeEngine?.tasks.find((task) => task.id === filters.taskId)?.title ?? filters.taskId,
			clear: () => onFiltersChange({ ...filters, taskId: undefined }),
		});
	}
	if (filters.severity) {
		chips.push({
			key: "severity",
			label: t("等级"),
			value: SENTINEL_VULN_SEVERITY_LABELS[filters.severity],
			clear: () => onFiltersChange({ ...filters, severity: undefined }),
		});
	}
	if (filters.status) {
		chips.push({
			key: "status",
			label: t("状态"),
			value: SENTINEL_VULN_STATUS_LABELS[filters.status],
			clear: () => onFiltersChange({ ...filters, status: undefined }),
		});
	}

	const clearAll = (): void => {
		setSearch("");
		setTarget("");
		onFiltersChange({});
	};

	if (!hasProject) {
		return (
			<div className="page-card">
				<div className="ws-panel__head">
					<div className="ws-panel__title">{t("漏洞中枢")}</div>
				</div>
				<div className="ws-panel__body">
					<div className="ws-empty">
						<span>{t("尚未选择项目")}</span>
						<span>{t("漏洞记录按项目隔离，请先在侧栏顶部选择或创建一个项目")}</span>
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="page-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					{t("漏洞中枢")}
					<span className="ws-panel__sub">
						{projectName ? `${projectName} · ` : ""}
						{t("{total} 条 · 待确认 {pending}", { total: stats.total, pending: stats.byStatus.pending })}
					</span>
				</div>
				{/* Batch actions act on the selection, not on the filters, so they stay
				    on the title row where they are always reachable. */}
				<div className="ws-panel__actions">
					<button
						type="button"
						className="ghost small"
						disabled={stats.byStatus.pending === 0}
						title={t(
							"把本项目所有「待确认」记录重新交给评审 LLM：按 CVSS 3.1 指标重算等级与分数（会覆盖这些记录现有的等级，时间线里会记录）",
						)}
						onClick={onReviewAllPending}
					>
						{t("重新评审待确认")}
					</button>
					<button
						type="button"
						disabled={items.length === 0}
						title={t("选中当前筛选结果里的全部记录")}
						onClick={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))}
					>
						{allSelected ? t("取消全选") : t("全选筛选结果")}
					</button>
					<button
						type="button"
						className="danger"
						disabled={selectedIds.length === 0}
						title={t("删除选中的漏洞记录：会一并删掉它们的证据与备注")}
						onClick={() => onRequestDelete(selectedIds)}
					>
						<DeleteIcon />
						{t("删除选中 ({count})", { count: selectedIds.length })}
					</button>
					<button type="button" className="primary" onClick={() => onExport(filters)}>
						<DownloadIcon />
						{t("导出 Markdown")}
					</button>
				</div>
			</div>
			{/* Filters: one search box and one panel. The conditions in force are shown
			    as removable chips, so the row does not grow with every control. */}
			<div className="vuln-filter-row" ref={filterRef}>
				<input
					className="inline-input vuln-filter-search"
					value={search}
					placeholder={t("搜索编号 / 标题 / 类型 / 描述 / 来源")}
					spellCheck={false}
					onChange={(event) => setSearch(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") onFiltersChange({ ...filters, search: search.trim() || undefined });
					}}
				/>
				<div className="vuln-filter-anchor">
					<button
						type="button"
						className={`ghost small${filterOpen ? " on" : ""}`}
						title={t("目标、会话、工程、任务、等级与状态都在这里设置")}
						onClick={() => setFilterOpen((open) => !open)}
					>
						{t("筛选")}
						{chips.length > 0 ? <span className="vuln-filter-count">{chips.length}</span> : null}
						<CaretDownIcon />
					</button>
					<div className={`vuln-filter-panel${filterOpen ? "" : " hidden"}`}>
						<div className="vuln-filter-grid">
							<label>
								<span className="vuln-filter-label">{t("目标（主机 / URL / IP:port）")}</span>
								<input
									className="inline-input"
									value={target}
									placeholder={t("10.0.0.5、https://…")}
									spellCheck={false}
									onChange={(event) => setTarget(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") onFiltersChange({ ...filters, target: target.trim() || undefined });
									}}
								/>
							</label>
							<label>
								<span className="vuln-filter-label">{t("会话（只列本项目）")}</span>
								<select
									className="inline-input"
									value={filters.sessionId ?? ""}
									onChange={(event) => onFiltersChange({ ...filters, sessionId: event.target.value || undefined })}
								>
									<option value="">{t("不限会话")}</option>
									{/* A record can outlive its session; the snapshot keeps the option
									    selectable instead of silently resetting the filter. */}
									{filters.sessionId && !sessionOptions.some((option) => option.id === filters.sessionId) ? (
										<option value={filters.sessionId}>{sessionLabelFor(filters.sessionId)}</option>
									) : null}
									{sessionOptions.map((option) => (
										<option key={option.id} value={option.id}>
											{option.name}
										</option>
									))}
								</select>
							</label>
							<label>
								<span className="vuln-filter-label">{t("工程（只列本项目，含已结束）")}</span>
								<select
									className="inline-input"
									value={filters.engineId ?? ""}
									onChange={(event) =>
										// The task belongs to an engine, so switching engines clears it.
										onFiltersChange({ ...filters, engineId: event.target.value || undefined, taskId: undefined })
									}
								>
									<option value="">{t("不限工程")}</option>
									{projectEngines.map((engine) => (
										<option key={engine.id} value={engine.id}>
											{engine.name}
										</option>
									))}
								</select>
							</label>
							<label>
								<span className="vuln-filter-label">{t("任务（先选工程）")}</span>
								<select
									className="inline-input"
									value={filters.taskId ?? ""}
									disabled={!filters.engineId}
									onChange={(event) => onFiltersChange({ ...filters, taskId: event.target.value || undefined })}
								>
									<option value="">{filters.engineId ? t("不限任务") : t("先选工程")}</option>
									{(activeEngine?.tasks ?? []).map((task) => (
										<option key={task.id} value={task.id}>
											{task.title}
										</option>
									))}
								</select>
							</label>
							<label>
								<span className="vuln-filter-label">{t("等级")}</span>
								<select
									className="inline-input"
									value={filters.severity ?? ""}
									onChange={(event) =>
										onFiltersChange({
											...filters,
											severity: (event.target.value || undefined) as SentinelVulnSeverity | undefined,
										})
									}
								>
									<option value="">{t("全部等级")}</option>
									{SENTINEL_VULN_SEVERITIES.map((severity) => (
										<option key={severity} value={severity}>
											{SENTINEL_VULN_SEVERITY_LABELS[severity]}
										</option>
									))}
								</select>
							</label>
							<label>
								<span className="vuln-filter-label">{t("状态")}</span>
								<select
									className="inline-input"
									value={filters.status ?? ""}
									onChange={(event) =>
										onFiltersChange({
											...filters,
											status: (event.target.value || undefined) as SentinelVulnStatus | undefined,
										})
									}
								>
									<option value="">{t("全部状态")}</option>
									{STATUSES.map((status) => (
										<option key={status} value={status}>
											{SENTINEL_VULN_STATUS_LABELS[status]}
										</option>
									))}
								</select>
							</label>
						</div>
						<div className="vuln-filter-foot">
							<button type="button" className="ghost small" onClick={clearAll}>
								{t("清空全部")}
							</button>
							<button type="button" className="primary small" onClick={() => setFilterOpen(false)}>
								{t("完成")}
							</button>
						</div>
					</div>
				</div>
				<button
					type="button"
					className={`ghost small${filters.dubious ? " on" : ""}`}
					title={t("只看评审 LLM 标记为「存疑」的记录：证据不足以支撑结论")}
					onClick={() => onFiltersChange({ ...filters, dubious: filters.dubious ? undefined : true })}
				>
					{t("⚠ 存疑")}
				</button>
			</div>
			{chips.length > 0 ? (
				<div className="vuln-chip-row">
					{chips.map((chip) => (
						<span key={chip.key} className="vuln-chip">
							<span className="vuln-chip__label">{chip.label}</span>
							<b>{chip.value}</b>
							<button type="button" title={t("移除该条件")} onClick={chip.clear}>
								<CloseIcon />
							</button>
						</span>
					))}
				</div>
			) : null}
			<div className="ws-panel__body">
				<div className="vuln-stats">
					{SENTINEL_VULN_SEVERITIES.map((severity) => (
						<span key={severity} className={severityClass(severity)}>
							{SENTINEL_VULN_SEVERITY_LABELS[severity]} {stats.bySeverity[severity]}
						</span>
					))}
					<span className="vuln-stat-status">{t("待确认 {count}", { count: stats.byStatus.pending })}</span>
					<span className="vuln-stat-status">{t("已确认 {count}", { count: stats.byStatus.confirmed })}</span>
					<span className="vuln-stat-status">{t("误报 {count}", { count: stats.byStatus.false_positive })}</span>
					<span className="vuln-stat-status">{t("已修复 {count}", { count: stats.byStatus.fixed })}</span>
				</div>
				{items.length === 0 ? (
					<div className="ws-empty">
						<span>{stats.total === 0 ? t("还没有漏洞记录") : t("没有符合条件的记录")}</span>
						<span>
							{stats.total === 0
								? t("代理用 vuln_submit 提交漏洞后会出现在这里（需要「设置 → 权限」中开启 vuln_submit）")
								: t("调整搜索或筛选条件")}
						</span>
					</div>
				) : (
					<div className="data-table vuln-table">
						<div className="data-row data-head">
							<span>
								<input
									type="checkbox"
									checked={allSelected}
									title={t("全选当前筛选结果")}
									onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))}
								/>
							</span>
							<span>{t("编号")}</span>
							<span>{t("等级")}</span>
							<span>{t("状态")}</span>
							<span>{t("目标")}</span>
							<span>{t("标题")}</span>
							<span>{t("来源")}</span>
							<span>{t("提交时间")}</span>
						</div>
						{items.map((item) => (
							<div
								key={item.id}
								className={`data-row vuln-row${selected.has(item.id) ? " selected" : ""}`}
								role="button"
								tabIndex={0}
								onClick={() => onOpen(item.id)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") onOpen(item.id);
								}}
							>
								<span
									className="vuln-select"
									onClick={(event) => {
										// Ticking a row must not open the record.
										event.stopPropagation();
									}}
								>
									<input
										type="checkbox"
										checked={selected.has(item.id)}
										onChange={() => toggle(item.id)}
										aria-label={t("选择 {label}", { label: item.label })}
									/>
								</span>
								<span className="data-mono">{item.label}</span>
								<span>
									<span className={severityClass(item.severity)}>
										{SENTINEL_VULN_SEVERITY_LABELS[item.severity]}
									</span>
									<span className={isAgentRating(item.review) ? "vuln-cvss vuln-cvss-self" : "vuln-cvss"}>
										{isAgentRating(item.review) ? `${t("自评")} ` : ""}
										{item.cvss.toFixed(1)}
									</span>
									<ReviewChip review={item.review} />
									{item.severityMismatch ? (
										<span className="vuln-warn" title={t("等级与 CVSS 分数不一致")}>
											!
										</span>
									) : null}
								</span>
								<span>
									<span className={`vuln-status-tag vuln-status-${item.status}`}>
										{SENTINEL_VULN_STATUS_LABELS[item.status]}
									</span>
								</span>
								<span className="data-mono" title={item.target}>
									{item.target}
								</span>
								<span className="data-name" title={item.title}>
									{item.title}
								</span>
								<span className="data-mono">{vulnSource(item.source)}</span>
								<span className="data-mono">{formatWhen(item.createdAt)}</span>
							</div>
						))}
					</div>
				)}
				<p className="ws-panel__hint">
					{t("代理提交的漏洞一律先记为「待确认」；确认、改级、标误报都在详情里完成，改动会记入时间线。")}{" "}
					{t("导出只包含当前项目的记录与当前筛选条件。")}
					{t("删除只能通过勾选记录进行：删除后证据与备注一并消失，不可恢复。")}
				</p>
			</div>
			{deletePending ? (
				<Overlay
					title={t("删除漏洞记录")}
					subtitle={t("删除后不可恢复")}
					className="vuln-delete-modal"
					onClose={onCancelDelete}
					actions={
						<>
							<button type="button" onClick={onCancelDelete}>
								{t("取消")}
							</button>
							<button
								type="button"
								className="danger"
								disabled={deletePreview === null}
								onClick={() => onConfirmDelete(deletePending)}
							>
								{t("确认删除")}
							</button>
						</>
					}
				>
					<div className="vuln-delete-body">
						<p>{t("将删除 {count} 条漏洞记录。", { count: deletePreview?.count ?? deletePending.length })}</p>
						{deletePreview ? (
							<ul>
								<li>{t("{count} 条证据", { count: deletePreview.evidence })}</li>
								<li>{t("{count} 条复核备注", { count: deletePreview.notes })}</li>
							</ul>
						) : (
							<p className="ws-panel__sub">{t("正在统计影响…")}</p>
						)}
						<p className="ws-panel__hint">
							{t("记录里的证据引用与备注会一并删除；容器里的原文件不受影响。")}
						</p>
					</div>
				</Overlay>
			) : null}
		</div>
	);
}

/** One evidence entry: a command with its output, or a previewable container file. */
function EvidenceBlock({
	item,
	index,
	preview,
	onPreview,
}: {
	item: SentinelVulnEvidence;
	index: number;
	preview: SentinelFilePreview | null;
	onPreview: (path: string) => void;
}) {
	return (
		<div className="vuln-evidence">
			<div className="vuln-evidence__head">
				<span className="vuln-evidence__index">{index + 1}</span>
				<span>{item.note ?? (item.kind === "file" ? t("容器文件") : t("命令证据"))}</span>
				{item.command ? <CopyButton text={item.command} label={t("复制命令")} /> : null}
				{item.output ? <CopyButton text={item.output} label={t("复制输出")} /> : null}
			</div>
			{item.command ? <pre className="ws-console__body">{item.command}</pre> : null}
			{item.output ? <pre className="ws-console__body">{item.output}</pre> : null}
			{item.path ? (
				<div className="vuln-evidence__file">
					<code>{item.path}</code>
					<button type="button" onClick={() => onPreview(item.path as string)}>
						{t("预览")}
					</button>
				</div>
			) : null}
			{preview && item.path && preview.path === item.path ? (
				<div className="vuln-preview">
					{preview.kind === "image" && preview.data ? (
						<img src={`data:${preview.mimeType ?? "image/png"};base64,${preview.data}`} alt={item.path} />
					) : preview.kind === "text" ? (
						<pre className="ws-console__body">
							{preview.text}
							{preview.truncated ? `\n${t("…（已截断）")}` : ""}
						</pre>
					) : (
						<span className="ws-panel__hint">
							{t("二进制文件（{size} 字节），请在「文件」弹窗中下载查看", { size: preview.size })}
						</span>
					)}
				</div>
			) : null}
		</div>
	);
}

export function VulnDetail({
	vuln,
	preview,
	provenance,
	onClose,
	onUpdate,
	onPreview,
	onRetryReview,
}: {
	vuln: SentinelVulnerability;
	/** Preview of a file referenced by this record's evidence, when one was requested. */
	preview: SentinelFilePreview | null;
	/** Human names for the stored 工程/任务/会话 ids, when they can still be resolved. */
	provenance: { engine?: string; task?: string; session?: string };
	onClose: () => void;
	onUpdate: (id: string, patch: SentinelVulnUpdate) => void;
	onPreview: (path: string) => void;
	onRetryReview: (id: string, force: boolean) => void;
}) {
	const [severity, setSeverity] = useState<SentinelVulnSeverity>(vuln.severity);
	const [cvss, setCvss] = useState(String(vuln.cvss));
	const [note, setNote] = useState("");
	/** When the last immediate save landed, shown as a quiet confirmation. */
	const [savedAt, setSavedAt] = useState<Date | null>(null);

	// A refreshed record (after an immediate save, or a submission from another
	// console) re-seeds the editors; keeping stale edits would fight the record.
	useEffect(() => {
		setSeverity(vuln.severity);
		setCvss(String(vuln.cvss));
		setNote("");
	}, [vuln.id, vuln.severity, vuln.cvss, vuln.updatedAt]);

	const parsedCvss = Number(cvss);
	const cvssValid = Number.isFinite(parsedCvss) && parsedCvss >= 0 && parsedCvss <= 10;

	// Every action below saves immediately: the server records one timeline
	// entry per change, so piecemeal updates make a readable audit trail
	// instead of one merged blob.
	const apply = (patch: SentinelVulnUpdate) => {
		onUpdate(vuln.id, patch);
		setSavedAt(new Date());
	};

	const transition = (next: SentinelVulnStatus) => {
		if (next === vuln.status) return;
		apply({ status: next });
	};

	/** Severity/CVSS commit on blur (Enter in the CVSS field commits too). */
	const commitRating = () => {
		if (!cvssValid) return;
		if (severity !== vuln.severity) apply({ severity });
		if (parsedCvss !== vuln.cvss) apply({ cvss: parsedCvss });
	};

	const submitNote = () => {
		const text = note.trim();
		if (!text) return;
		apply({ note: text });
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal vuln-detail" onClick={(event) => event.stopPropagation()}>
				<div className="vuln-detail__head">
					<div>
						<div className="vuln-detail__title" title={vuln.title}>
							{vuln.title}
						</div>
						<div className="vuln-detail__meta">
							<span className={severityClass(vuln.severity)}>{SENTINEL_VULN_SEVERITY_LABELS[vuln.severity]}</span>
							<span className={isAgentRating(vuln.review) ? "vuln-cvss vuln-cvss-self" : "vuln-cvss"}>
								{isAgentRating(vuln.review) ? `${t("自评")} CVSS ` : "CVSS "}
								{vuln.cvss.toFixed(1)}
							</span>
							{vuln.cvssVector ? <span className="data-mono">{vuln.cvssVector}</span> : null}
							<span>{SENTINEL_VULN_STATUS_LABELS[vuln.status]}</span>
							{vuln.review?.verdict === "dubious" ? (
								<span className="vuln-warn" title={vuln.review.reason ?? t("评审认为证据不足以支撑结论")}>
									{t("评审存疑")}
								</span>
							) : null}
							{vuln.severityMismatch ? (
								<span className="vuln-warn" title={t("等级与 CVSS 分数不一致")}>
									{t("等级与分数不一致")}
								</span>
							) : null}
						</div>
					</div>
					<button type="button" className="ghost small" onClick={onClose} title={t("关闭")}>
						<CloseIcon />
					</button>
				</div>

				<div className="vuln-detail__body">
					<div className="vuln-meta-grid">
						<div>
							<span>{t("编号")}</span>
							<code>{vuln.label}</code>
						</div>
						<div>
							<span>{t("目标")}</span>
							<code>{vuln.target}</code>
						</div>
						<div>
							<span>{t("类型")}</span>
							<span>{vuln.category ?? "—"}</span>
						</div>
						<div>
							<span>{t("来源")}</span>
							<span>{vulnSource(vuln.source)}</span>
						</div>
						<div>
							<span>{t("提交时间")}</span>
							<span>{formatWhen(vuln.createdAt)}</span>
						</div>
						{vuln.engineId || vuln.taskId ? (
							<div>
								<span>{t("工程 / 任务")}</span>
								<span>
									{provenance.engine ?? vuln.engineId}
									{provenance.task ? ` / ${provenance.task}` : ""}
								</span>
							</div>
						) : null}
						{vuln.sessionId ? (
							<div>
								<span>{t("会话")}</span>
								<span title={vuln.sessionId}>
									{provenance.session ?? vuln.sessionName ?? vuln.sessionId}
								</span>
							</div>
						) : null}
						<div>
							<span>{t("评审")}</span>
							<span>
								<ReviewChip review={vuln.review} />
								{vuln.review.state === "done" && vuln.review.model ? ` ${vuln.review.model}` : ""}
								{vuln.review.at
									? ` · ${new Date(vuln.review.at).toLocaleString("zh-CN", { hour12: false })}`
									: ""}
								{vuln.review.state === "failed" ? (
									<button
										type="button"
										className="ghost small"
										style={{ marginLeft: 8 }}
										onClick={() => onRetryReview(vuln.id, false)}
									>
										{t("重试评审")}
									</button>
								) : vuln.review.state === "queued" ? (
									<button type="button" className="ghost small" style={{ marginLeft: 8 }} disabled>
										{t("评审中…")}
									</button>
								) : (
									<button
										type="button"
										className="ghost small"
										style={{ marginLeft: 8 }}
										title={t(
											"按 CVSS 3.1 指标重新计算等级与分数。这条如果已被手动改过等级（或状态），也会一并覆盖，时间线里会记录",
										)}
										onClick={() => onRetryReview(vuln.id, true)}
									>
										{t("重新评审")}
									</button>
								)}
							</span>
						</div>
						{vuln.review.state === "done" && vuln.review.reason ? (
							<div style={{ gridColumn: "1 / -1" }}>
								<span>{t("评审意见")}</span>
								<span>
									{vuln.review.verdict === "dubious" ? t("⚠ 存疑：") : ""}
									{vuln.review.reason}
								</span>
							</div>
						) : null}
						{vuln.review.state === "failed" ? (
							<div style={{ gridColumn: "1 / -1" }}>
								<span>{t("评审失败原因")}</span>
								<span>{vuln.review.error ?? t("未知错误")}</span>
							</div>
						) : null}
					</div>

					<div className="vuln-action-band">
						<span className={`vuln-state-big vuln-state-${vuln.status}`}>
							{SENTINEL_VULN_STATUS_LABELS[vuln.status]}
						</span>
						{vuln.status === "pending" ? (
							<>
								<button
									type="button"
									className="vuln-transition confirm"
									onClick={() => transition("confirmed")}
								>
									{t("✓ 确认")}
								</button>
								<button
									type="button"
									className="vuln-transition false"
									onClick={() => transition("false_positive")}
								>
									{t("✕ 标误报")}
								</button>
							</>
						) : null}
						{vuln.status !== "fixed" ? (
							<button type="button" className="vuln-transition fix" onClick={() => transition("fixed")}>
								{t("✔ 标已修复")}
							</button>
						) : null}
						{vuln.status !== "pending" ? (
							<button type="button" className="vuln-transition" onClick={() => transition("pending")}>
								{t("↩ 退回待确认")}
							</button>
						) : null}
						<span className="vuln-action-spacer" />
						{savedAt ? (
							<span className="vuln-saved-hint">
								{t("已保存 {time}", { time: savedAt.toLocaleTimeString("zh-CN", { hour12: false }) })}
							</span>
						) : null}
					</div>
					<div className="vuln-action-band vuln-action-band--rating">
						<span className="vuln-action-label">{t("等级")}</span>
						<select
							value={severity}
							onChange={(event) => setSeverity(event.target.value as SentinelVulnSeverity)}
							onBlur={commitRating}
						>
							{SENTINEL_VULN_SEVERITIES.map((candidate) => (
								<option key={candidate} value={candidate}>
									{SENTINEL_VULN_SEVERITY_LABELS[candidate]}
								</option>
							))}
						</select>
						<span className="vuln-action-label">CVSS</span>
						<input
							className={`vuln-cvss-edit ${cvssValid ? "" : "invalid"}`}
							value={cvss}
							spellCheck={false}
							onChange={(event) => setCvss(event.target.value)}
							onBlur={commitRating}
							onKeyDown={(event) => {
								if (event.key === "Enter") commitRating();
							}}
						/>
						{!cvssValid ? <span className="page-error">{t("CVSS 需要 0.0-10.0")}</span> : null}
						{cvssValid && severityForScore(parsedCvss) !== severity ? (
							<span className="vuln-warn">
								{t("分数对应「{severity}」，与所选等级不一致", {
									severity: SENTINEL_VULN_SEVERITY_LABELS[severityForScore(parsedCvss)],
								})}
							</span>
						) : null}
						<span className="vuln-action-spacer" />
					</div>
					<input
						className="inline-input vuln-note-input"
						value={note}
						placeholder={t("复核备注（回车提交，追加到时间线）…")}
						spellCheck={false}
						onChange={(event) => setNote(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") submitNote();
						}}
					/>

					<section>
						<h3>{t("漏洞详情")}</h3>
						<pre className="vuln-text">{vuln.description}</pre>
					</section>

					<section>
						<div className="vuln-section-head">
							<h3>{t("原始数据包")}</h3>
							<CopyButton text={vuln.packet} label={t("复制数据包")} />
						</div>
						<pre className="vuln-packet">{vuln.packet}</pre>
					</section>

					{vuln.repro ? (
						<section>
							<h3>{t("复现步骤")}</h3>
							<pre className="vuln-text">{vuln.repro}</pre>
						</section>
					) : null}

					{vuln.evidence.length > 0 ? (
						<section>
							<h3>{t("证据")}</h3>
							{vuln.evidence.map((item, index) => (
								<EvidenceBlock
									key={`${item.kind}-${item.path ?? item.command ?? index}`}
									item={item}
									index={index}
									preview={preview}
									onPreview={onPreview}
								/>
							))}
						</section>
					) : null}

					{vuln.remediation ? (
						<section>
							<h3>{t("修复建议")}</h3>
							<pre className="vuln-text">{vuln.remediation}</pre>
						</section>
					) : null}

					{vuln.references && vuln.references.length > 0 ? (
						<section>
							<h3>{t("参考")}</h3>
							<ul className="vuln-refs">
								{vuln.references.map((reference) => (
									<li key={reference}>{reference}</li>
								))}
							</ul>
						</section>
					) : null}

					<section>
						<h3>{t("处理时间线")}</h3>
						<ul className="vuln-timeline">
							{vuln.notes.map((entry, index) => (
								<li key={`${entry.at}-${index}`}>
									<span className="vuln-timeline__at">{formatWhen(entry.at)}</span>
									<span className="vuln-timeline__author">{entry.author}</span>
									<span>{entry.text}</span>
								</li>
							))}
						</ul>
					</section>
				</div>
			</div>
		</div>
	);
}
