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
import type {
	ZGVulnEvidence,
	ZGVulnFilters,
	ZGVulnSeverity,
	ZGVulnStats,
	ZGVulnStatus,
	ZGVulnSummary,
	ZGVulnUpdate,
	ZGVulnerability,
} from "../types.ts";
import { ZG_VULN_SEVERITIES, ZG_VULN_SEVERITY_LABELS, ZG_VULN_STATUS_LABELS } from "../types.ts";
import type { ZGFilePreview } from "../types.ts";
import { CloseIcon, DeleteIcon, DownloadIcon } from "./icons.tsx";

const STATUSES: readonly ZGVulnStatus[] = ["pending", "confirmed", "false_positive", "fixed"];

function formatWhen(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function severityClass(severity: ZGVulnSeverity): string {
	return `vuln-sev vuln-sev-${severity}`;
}

/** Copy button used by the packet and evidence blocks. */
function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
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
			{copied ? "已复制" : label}
		</button>
	);
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
}: {
	items: ZGVulnSummary[];
	stats: ZGVulnStats;
	filters: ZGVulnFilters;
	projectName: string | null;
	hasProject: boolean;
	onFiltersChange: (filters: ZGVulnFilters) => void;
	onOpen: (id: string) => void;
	onExport: (filters: ZGVulnFilters) => void;
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
					<div className="ws-panel__title">漏洞中枢</div>
				</div>
				<div className="ws-panel__body">
					<div className="ws-empty">
						<span>尚未选择项目</span>
						<span>漏洞记录按项目隔离，请先在侧栏顶部选择或创建一个项目</span>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="page-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					漏洞中枢
					<span className="ws-panel__sub">
						{projectName ? `${projectName} · ` : ""}
						{stats.total} 条 · 待确认 {stats.byStatus.pending}
					</span>
				</div>
				<div className="ws-panel__actions">
					<input
						className="inline-input"
						value={search}
						placeholder="搜索编号 / 标题 / 类型 / 描述"
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
								severity: (event.target.value || undefined) as ZGVulnSeverity | undefined,
							})
						}
					>
						<option value="">全部等级</option>
						{ZG_VULN_SEVERITIES.map((severity) => (
							<option key={severity} value={severity}>
								{ZG_VULN_SEVERITY_LABELS[severity]}
							</option>
						))}
					</select>
					<select
						className="inline-input"
						value={filters.status ?? ""}
						onChange={(event) =>
							onFiltersChange({
								...filters,
								status: (event.target.value || undefined) as ZGVulnStatus | undefined,
							})
						}
					>
						<option value="">全部状态</option>
						{STATUSES.map((status) => (
							<option key={status} value={status}>
								{ZG_VULN_STATUS_LABELS[status]}
							</option>
						))}
					</select>
					<button type="button" onClick={() => onFiltersChange({ search: search.trim() || undefined })}>
						重置
					</button>
					<button type="button" className="primary" onClick={() => onExport(filters)}>
						<DownloadIcon />
						导出 Markdown
					</button>
				</div>
			</div>
			<div className="ws-panel__body">
				<div className="vuln-stats">
					{ZG_VULN_SEVERITIES.map((severity) => (
						<span key={severity} className={severityClass(severity)}>
							{ZG_VULN_SEVERITY_LABELS[severity]} {stats.bySeverity[severity]}
						</span>
					))}
					<span className="vuln-stat-status">待确认 {stats.byStatus.pending}</span>
					<span className="vuln-stat-status">已确认 {stats.byStatus.confirmed}</span>
					<span className="vuln-stat-status">误报 {stats.byStatus.false_positive}</span>
					<span className="vuln-stat-status">已修复 {stats.byStatus.fixed}</span>
				</div>
				{items.length === 0 ? (
					<div className="ws-empty">
						<span>{stats.total === 0 ? "还没有漏洞记录" : "没有符合条件的记录"}</span>
						<span>
							{stats.total === 0
								? "代理用 vuln_submit 提交漏洞后会出现在这里（需要「设置 → 权限」中开启 vuln_submit）"
								: "调整搜索或筛选条件"}
						</span>
					</div>
				) : (
					<div className="data-table vuln-table">
						<div className="data-row data-head">
							<span>编号</span>
							<span>等级</span>
							<span>状态</span>
							<span>目标</span>
							<span>标题</span>
							<span>来源</span>
							<span>提交时间</span>
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
									<span className={severityClass(item.severity)}>{ZG_VULN_SEVERITY_LABELS[item.severity]}</span>
									<span className="vuln-cvss">{item.cvss.toFixed(1)}</span>
									{item.severityMismatch ? (
										<span className="vuln-warn" title="等级与 CVSS 分数不一致">
											!
										</span>
									) : null}
								</span>
								<span>{ZG_VULN_STATUS_LABELS[item.status]}</span>
								<span className="data-mono">{item.target}</span>
								<span className="data-name">{item.title}</span>
								<span>{item.source}</span>
								<span>{formatWhen(item.createdAt)}</span>
							</div>
						))}
					</div>
				)}
				<p className="ws-panel__hint">
					代理提交的漏洞一律先记为「待确认」；确认、改级、标误报都在详情里完成，改动会记入时间线。
					导出只包含当前项目的记录与当前筛选条件。
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
	item: ZGVulnEvidence;
	index: number;
	preview: ZGFilePreview | null;
	onPreview: (path: string) => void;
}) {
	return (
		<div className="vuln-evidence">
			<div className="vuln-evidence__head">
				<span className="vuln-evidence__index">{index + 1}</span>
				<span>{item.note ?? (item.kind === "file" ? "容器文件" : "命令证据")}</span>
				{item.command ? <CopyButton text={item.command} label="复制命令" /> : null}
				{item.output ? <CopyButton text={item.output} label="复制输出" /> : null}
			</div>
			{item.command ? <pre className="ws-console__body">{item.command}</pre> : null}
			{item.output ? <pre className="ws-console__body">{item.output}</pre> : null}
			{item.path ? (
				<div className="vuln-evidence__file">
					<code>{item.path}</code>
					<button type="button" onClick={() => onPreview(item.path as string)}>
						预览
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
							{preview.truncated ? "\n…（已截断）" : ""}
						</pre>
					) : (
						<span className="ws-panel__hint">二进制文件（{preview.size} 字节），请在「文件」弹窗中下载查看</span>
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
}: {
	vuln: ZGVulnerability;
	/** Preview of a file referenced by this record's evidence, when one was requested. */
	preview: ZGFilePreview | null;
	onClose: () => void;
	onUpdate: (id: string, patch: ZGVulnUpdate) => void;
	onDelete: (id: string) => void;
	onPreview: (path: string) => void;
}) {
	const [status, setStatus] = useState<ZGVulnStatus>(vuln.status);
	const [severity, setSeverity] = useState<ZGVulnSeverity>(vuln.severity);
	const [cvss, setCvss] = useState(String(vuln.cvss));
	const [note, setNote] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);

	// A refreshed record (after a save, or a submission from another console)
	// re-seeds the form; keeping stale edits would silently overwrite it.
	useEffect(() => {
		setStatus(vuln.status);
		setSeverity(vuln.severity);
		setCvss(String(vuln.cvss));
		setNote("");
		setConfirmDelete(false);
	}, [vuln.id, vuln.status, vuln.severity, vuln.cvss, vuln.updatedAt]);

	const parsedCvss = Number(cvss);
	const cvssValid = Number.isFinite(parsedCvss) && parsedCvss >= 0 && parsedCvss <= 10;
	const dirty =
		status !== vuln.status || severity !== vuln.severity || (cvssValid && parsedCvss !== vuln.cvss) || note.trim() !== "";

	const save = () => {
		if (!cvssValid) return;
		onUpdate(vuln.id, {
			status,
			severity,
			cvss: parsedCvss,
			...(note.trim() ? { note: note.trim() } : {}),
		});
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal vuln-detail" onClick={(event) => event.stopPropagation()}>
				<div className="vuln-detail__head">
					<div>
						<div className="vuln-detail__title">
							<span className="data-mono">{vuln.label}</span> {vuln.title}
						</div>
						<div className="vuln-detail__meta">
							<span className={severityClass(vuln.severity)}>{ZG_VULN_SEVERITY_LABELS[vuln.severity]}</span>
							<span className="vuln-cvss">CVSS {vuln.cvss.toFixed(1)}</span>
							{vuln.cvssVector ? <span className="data-mono">{vuln.cvssVector}</span> : null}
							<span>{ZG_VULN_STATUS_LABELS[vuln.status]}</span>
							{vuln.severityMismatch ? (
								<span className="vuln-warn" title="等级与 CVSS 分数不一致">
									等级与分数不一致
								</span>
							) : null}
						</div>
					</div>
					<button type="button" className="ghost small" onClick={onClose} title="关闭">
						<CloseIcon />
					</button>
				</div>

				<div className="vuln-detail__body">
					<div className="vuln-meta-grid">
						<div>
							<span>目标</span>
							<code>{vuln.target}</code>
						</div>
						<div>
							<span>类型</span>
							<span>{vuln.category ?? "—"}</span>
						</div>
						<div>
							<span>来源</span>
							<span>{vuln.source}</span>
						</div>
						<div>
							<span>提交时间</span>
							<span>{formatWhen(vuln.createdAt)}</span>
						</div>
						{vuln.sessionId ? (
							<div>
								<span>会话</span>
								<code>{vuln.sessionId}</code>
							</div>
						) : null}
					</div>

					<section className="vuln-review">
						<h3>复核</h3>
						<div className="vuln-review__row">
							<span>状态</span>
							{STATUSES.map((candidate) => (
								<button
									key={candidate}
									type="button"
									className={status === candidate ? "primary" : ""}
									onClick={() => setStatus(candidate)}
								>
									{ZG_VULN_STATUS_LABELS[candidate]}
								</button>
							))}
						</div>
						<div className="vuln-review__row">
							<span>等级</span>
							<select value={severity} onChange={(event) => setSeverity(event.target.value as ZGVulnSeverity)}>
								{ZG_VULN_SEVERITIES.map((candidate) => (
									<option key={candidate} value={candidate}>
										{ZG_VULN_SEVERITY_LABELS[candidate]}
									</option>
								))}
							</select>
							<span>CVSS</span>
							<input
								className={cvssValid ? "" : "invalid"}
								value={cvss}
								spellCheck={false}
								onChange={(event) => setCvss(event.target.value)}
							/>
							{!cvssValid ? <span className="page-error">CVSS 需要 0.0-10.0</span> : null}
						</div>
						<div className="vuln-review__row">
							<span>备注</span>
							<input
								className="inline-input wide"
								value={note}
								placeholder="复核说明，会追加到时间线"
								spellCheck={false}
								onChange={(event) => setNote(event.target.value)}
							/>
						</div>
						<div className="vuln-review__actions">
							<button type="button" className="primary" disabled={!dirty || !cvssValid} onClick={save}>
								保存复核结果
							</button>
							<button type="button" disabled={!dirty} onClick={() => { setStatus(vuln.status); setSeverity(vuln.severity); setCvss(String(vuln.cvss)); setNote(""); }}>
								撤销修改
							</button>
							{confirmDelete ? (
								<>
									<span className="page-error">删除后不可恢复，确认？</span>
									<button type="button" className="danger" onClick={() => onDelete(vuln.id)}>
										确认删除
									</button>
									<button type="button" onClick={() => setConfirmDelete(false)}>
										取消
									</button>
								</>
							) : (
								<button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
									<DeleteIcon />
									删除记录
								</button>
							)}
						</div>
					</section>

					<section>
						<h3>漏洞详情</h3>
						<pre className="vuln-text">{vuln.description}</pre>
					</section>

					<section>
						<div className="vuln-section-head">
							<h3>原始数据包</h3>
							<CopyButton text={vuln.packet} label="复制数据包" />
						</div>
						<pre className="vuln-packet">{vuln.packet}</pre>
					</section>

					{vuln.repro ? (
						<section>
							<h3>复现步骤</h3>
							<pre className="vuln-text">{vuln.repro}</pre>
						</section>
					) : null}

					{vuln.evidence.length > 0 ? (
						<section>
							<h3>证据</h3>
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
							<h3>修复建议</h3>
							<pre className="vuln-text">{vuln.remediation}</pre>
						</section>
					) : null}

					{vuln.references && vuln.references.length > 0 ? (
						<section>
							<h3>参考</h3>
							<ul className="vuln-refs">
								{vuln.references.map((reference) => (
									<li key={reference}>{reference}</li>
								))}
							</ul>
						</section>
					) : null}

					<section>
						<h3>处理时间线</h3>
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
