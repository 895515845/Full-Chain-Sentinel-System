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

import { useEffect, useState } from "react";
import { t } from "../i18n.ts";
import type {
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
} from "../types.ts";
import { SENTINEL_VULN_SEVERITIES, SENTINEL_VULN_SEVERITY_LABELS, SENTINEL_VULN_STATUS_LABELS } from "../types.ts";
import { CloseIcon, DeleteIcon, DownloadIcon } from "./icons.tsx";

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
	hasProject,
	onFiltersChange,
	onOpen,
	onExport,
	onRetryReview,
	onReviewAllPending,
}: {
	items: SentinelVulnSummary[];
	stats: SentinelVulnStats;
	filters: SentinelVulnFilters;
	projectName: string | null;
	hasProject: boolean;
	onFiltersChange: (filters: SentinelVulnFilters) => void;
	onOpen: (id: string) => void;
	onExport: (filters: SentinelVulnFilters) => void;
	onRetryReview: (id: string, force: boolean) => void;
	onReviewAllPending: () => void;
}) {
	const [search, setSearch] = useState(filters.search ?? "");

	// Keep the input in step when the page is opened fresh or filters are reset.
	useEffect(() => {
		setSearch(filters.search ?? "");
	}, [filters.search]);

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
						className={`ghost small${filters.dubious ? " on" : ""}`}
						title={t("只看评审 LLM 标记为「存疑」的记录：证据不足以支撑结论")}
						onClick={() => onFiltersChange({ ...filters, dubious: filters.dubious ? undefined : true })}
					>
						{t("⚠ 存疑")}
					</button>
					<input
						className="inline-input"
						value={search}
						placeholder={t("搜索编号 / 标题 / 类型 / 描述")}
						spellCheck={false}
						onChange={(event) => setSearch(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") onFiltersChange({ ...filters, search: search.trim() || undefined });
						}}
					/>
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
					<button type="button" onClick={() => onFiltersChange({ search: search.trim() || undefined })}>
						{t("重置")}
					</button>
					<button type="button" className="primary" onClick={() => onExport(filters)}>
						<DownloadIcon />
						{t("导出 Markdown")}
					</button>
				</div>
			</div>
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
								className="data-row vuln-row"
								role="button"
								tabIndex={0}
								onClick={() => onOpen(item.id)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") onOpen(item.id);
								}}
							>
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
				</p>
			</div>
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
	onClose,
	onUpdate,
	onDelete,
	onPreview,
	onRetryReview,
}: {
	vuln: SentinelVulnerability;
	/** Preview of a file referenced by this record's evidence, when one was requested. */
	preview: SentinelFilePreview | null;
	onClose: () => void;
	onUpdate: (id: string, patch: SentinelVulnUpdate) => void;
	onDelete: (id: string) => void;
	onPreview: (path: string) => void;
	onRetryReview: (id: string, force: boolean) => void;
}) {
	const [severity, setSeverity] = useState<SentinelVulnSeverity>(vuln.severity);
	const [cvss, setCvss] = useState(String(vuln.cvss));
	const [note, setNote] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);
	/** When the last immediate save landed, shown as a quiet confirmation. */
	const [savedAt, setSavedAt] = useState<Date | null>(null);

	// A refreshed record (after an immediate save, or a submission from another
	// console) re-seeds the editors; keeping stale edits would fight the record.
	useEffect(() => {
		setSeverity(vuln.severity);
		setCvss(String(vuln.cvss));
		setNote("");
		setConfirmDelete(false);
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
						{vuln.sessionId ? (
							<div>
								<span>{t("会话")}</span>
								<code>{vuln.sessionId}</code>
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
						{confirmDelete ? (
							<>
								<span className="page-error">{t("删除后不可恢复")}</span>
								<button type="button" className="danger" onClick={() => onDelete(vuln.id)}>
									{t("确认删除")}
								</button>
								<button type="button" onClick={() => setConfirmDelete(false)}>
									{t("取消")}
								</button>
							</>
						) : (
							<button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
								{t("删除")}
							</button>
						)}
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
