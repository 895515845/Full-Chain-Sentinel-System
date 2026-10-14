/**
 * The POC library page: the operator's Nuclei template center.
 *
 * Layout follows the "console ledger" design (mockup C3): the whole page is
 * one panel card — breadcrumb bar with the import and official-sync actions, a
 * toolbar with the filters and the hit counter, then a ledger table whose rows
 * expand inline into a dark terminal block showing the template yaml. No modal:
 * the code belongs to its row.
 *
 * Import and the one-click official sync are the only write actions here, and
 * both belong to the operator. The agent never gets an import or delete tool —
 * its whole interface to the library is poc_search / poc_read, and the
 * templates themselves are never mounted into a project container. To fire a
 * template, the agent writes its own yaml into the working directory and runs
 * nuclei on that.
 */

import { useRef, useState } from "react";
import type {
	ZGPoc,
	ZGPocFilters,
	ZGPocImportOutcome,
	ZGPocSeverity,
	ZGPocSource,
	ZGPocStats,
	ZGPocSummary,
} from "../types.ts";
import { ZG_VULN_SEVERITIES, ZG_VULN_SEVERITY_LABELS } from "../types.ts";

/** Sort keys the table headers offer. */
type SortKey = "id" | "when";

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="poc-term-op"
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
			{copied ? "已复制" : "复制全文"}
		</button>
	);
}

/** The official source's newest outcome as one dim line; failures say why. */
function officialLine(source: ZGPocSource): string {
	const last = source.lastResult;
	if (!last) return "官方同步：还没有同步过";
	const when = last.at.slice(0, 19).replace("T", " ");
	const base = `${when} · 新增 ${last.imported} · 覆盖 ${last.replaced} · 跳过 ${last.skipped} · ${(last.durationMs / 1000).toFixed(1)}s`;
	return last.ok ? `官方同步：${base}` : `官方同步失败：${base} · ${last.error ?? "未知错误"}`;
}

export function PocPage({
	items,
	stats,
	filters,
	detail,
	importing,
	outcome,
	onFiltersChange,
	onOpen,
	onImport,
	onDelete,
	officialSource,
	officialSyncing,
	onSyncOfficial,
}: {
	items: ZGPocSummary[];
	stats: ZGPocStats;
	filters: ZGPocFilters;
	detail: ZGPoc | null;
	importing: boolean;
	/** Result of the last import batch, shown until the next one starts. */
	outcome: ZGPocImportOutcome | null;
	onFiltersChange(filters: ZGPocFilters): void;
	/** Fetch one template's full yaml for the row being expanded. */
	onOpen(id: string): void;
	onImport(files: File[]): void;
	onDelete(id: string): void;
	/** The built-in official source, once the one-click sync created it. */
	officialSource: ZGPocSource | null;
	/** True while that sync downloads and imports; it can take minutes. */
	officialSyncing: boolean;
	onSyncOfficial(): void;
}) {
	const [search, setSearch] = useState(filters.search ?? "");
	const [tag, setTag] = useState(filters.tag ?? "");
	const [openId, setOpenId] = useState<string | null>(null);
	const [sortKey, setSortKey] = useState<SortKey>("when");
	const [sortDesc, setSortDesc] = useState(true);
	const fileInput = useRef<HTMLInputElement | null>(null);

	const apply = (patch: Partial<ZGPocFilters>): void => {
		onFiltersChange({
			...(search.trim() ? { search: search.trim() } : {}),
			...(filters.severity ? { severity: filters.severity } : {}),
			...(tag.trim() ? { tag: tag.trim() } : {}),
			...patch,
		});
	};

	const toggleSort = (key: SortKey): void => {
		if (key === sortKey) setSortDesc((prev) => !prev);
		else {
			setSortKey(key);
			setSortDesc(key === "when"); // ids sort up, timestamps sort down
		}
	};

	const sorted = [...items].sort((left, right) => {
		const compared =
			sortKey === "id" ? left.id.localeCompare(right.id) : left.importedAt.localeCompare(right.importedAt);
		return sortDesc ? -compared : compared;
	});

	/** One main row plus, when expanded, the detail row right below it. */
	const row = (item: ZGPocSummary, zebra: boolean) => {
		const open = openId === item.id;
		const expanded = open && detail?.id === item.id ? detail : null;
		const confirmDelete = (): void => {
			if (window.confirm(`删除模板「${item.id}」？\n该操作不可恢复。`)) onDelete(item.id);
		};
		return [
			<tr
				key={item.id}
				className={`poc-row ${open ? "open" : ""} ${zebra ? "zebra" : ""}`}
				onClick={() => {
					if (open) {
						setOpenId(null);
						return;
					}
					setOpenId(item.id);
					onOpen(item.id);
				}}
			>
				<td className="poc-caret">{open ? "▼" : "▶"}</td>
				<td className="poc-id">{item.id}</td>
				<td>
					<span className={`poc-sev poc-sev-${item.severity}`}>{ZG_VULN_SEVERITY_LABELS[item.severity]}</span>
				</td>
				<td className="poc-name" title={item.name}>
					{item.name}
				</td>
				<td>
					<span className="poc-tags">
						{item.tags.map((tagItem) => (
							<span key={tagItem}>{tagItem}</span>
						))}
					</span>
				</td>
				<td className="poc-cve">{item.references.join(", ") || "—"}</td>
				<td className="poc-when">{item.importedAt.slice(0, 16).replace("T", " ")}</td>
				<td className="poc-op">
					<button
						type="button"
						title={`删除模板 ${item.id}（不可恢复）`}
						onClick={(event) => {
							event.stopPropagation();
							confirmDelete();
						}}
					>
						删除
					</button>
				</td>
			</tr>,
			open ? (
				<tr key={`${item.id}-detail`} className="poc-detail" onClick={(event) => event.stopPropagation()}>
					<td colSpan={8}>
						<div className="poc-term">
							<div className="poc-term-head">
								<span className="poc-traffic">
									<i />
									<i />
									<i />
								</span>
								<span className="poc-term-file">
									{item.sourceFile} · 导入 {item.importedAt.slice(0, 16).replace("T", " ")}
									{item.tags.length > 0 ? ` · ${item.tags.join(", ")}` : ""}
								</span>
								<span className="poc-term-ops">
									{expanded ? <CopyButton text={expanded.content} /> : null}
									<button type="button" className="poc-term-op danger" onClick={confirmDelete}>
										删除模板
									</button>
								</span>
							</div>
							<pre className="poc-term-body">{expanded ? expanded.content : "加载模板全文…"}</pre>
						</div>
					</td>
				</tr>
			) : null,
		];
	};

	return (
		<div className="poc-sheet">
			<div className="poc-bar">
				<div className="poc-crumb">
					工作台 <span>/</span> <span className="cur">POC 库</span>
				</div>
				<h1>Nuclei 模板中心</h1>
				<span className="poc-sub">共 {stats.total} 个 · Agent 侧只读（poc_search / poc_read）</span>
				<span className="poc-bar-ops">
					<input
						ref={fileInput}
						type="file"
						multiple
						accept=".yaml,.yml,.zip"
						style={{ display: "none" }}
						onChange={(event) => {
							if (event.target.files && event.target.files.length > 0) onImport([...event.target.files]);
							event.target.value = "";
						}}
					/>
					<button
						type="button"
						className="ghost small"
						disabled={officialSyncing}
						title="从官方仓库 projectdiscovery/nuclei-templates 下载最新模板包（zip 约 18MB、约 1.4 万个模板），按 id 去重后并入 POC 库；不会删除已有模板"
						onClick={onSyncOfficial}
					>
						{officialSyncing ? "同步中…" : "一键同步官方 POC"}
					</button>
					<button
						type="button"
						className="primary"
						disabled={importing}
						title="选择或拖入 Nuclei 模板文件：可多选 .yaml / .yml，或打包的 .zip（解包后自动跳过非模板文件）"
						onClick={() => fileInput.current?.click()}
					>
						{importing ? "导入中…" : "导入 POC"}
					</button>
				</span>
			</div>

			{officialSource?.lastResult ? (
				<div className={officialSource.lastResult.ok ? "poc-official" : "poc-official err-text"}>
					{officialLine(officialSource)}
				</div>
			) : null}

			<div className="poc-toolbar">
				<input
					className="poc-search"
					placeholder="搜索模板 id、名称、标签或 CVE…"
					value={search}
					spellCheck={false}
					onChange={(event) => setSearch(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") apply({});
					}}
				/>
				<select
					className="poc-select"
					value={filters.severity ?? ""}
					onChange={(event) => {
						const value = event.target.value;
						apply(value ? { severity: value as ZGPocSeverity } : { severity: undefined });
					}}
				>
					<option value="">全部等级</option>
					{ZG_VULN_SEVERITIES.map((severity) => (
						<option key={severity} value={severity}>
							{ZG_VULN_SEVERITY_LABELS[severity]}
						</option>
					))}
				</select>
				<input
					className="poc-select poc-tag"
					placeholder="精确标签，如 cve"
					value={tag}
					spellCheck={false}
					onChange={(event) => setTag(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") apply({});
					}}
				/>
				<span className="poc-hits">
					显示 {items.length} / {stats.total} 条
					{filters.search || filters.severity || filters.tag ? "（已筛选）" : ""}
				</span>
			</div>

			{outcome ? (
				<div className="poc-import-note">
					导入完成：新增 {outcome.imported} 条，覆盖 {outcome.replaced} 条
					{outcome.skipped.length > 0
						? `，跳过 ${outcome.skipped.length} 条（${outcome.skipped
								.slice(0, 3)
								.map((item) => `${item.name}：${item.reason}`)
								.join("；")}${outcome.skipped.length > 3 ? " 等" : ""}）`
						: ""}
				</div>
			) : null}

			<div className="poc-tablewrap">
				<table className="poc-table">
					<thead>
						<tr>
							<th className="poc-caret-col" />
							<th className="poc-sortable" onClick={() => toggleSort("id")}>
								模板 ID{sortKey === "id" ? (sortDesc ? " ▼" : " ▲") : ""}
							</th>
							<th>等级</th>
							<th>名称</th>
							<th>标签</th>
							<th>CVE</th>
							<th className="poc-sortable" onClick={() => toggleSort("when")}>
								导入时间{sortKey === "when" ? (sortDesc ? " ▼" : " ▲") : ""}
							</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{sorted.length === 0 ? (
							<tr className="poc-empty">
								<td colSpan={8}>
									暂无模板。点右上「导入 POC」上传 nuclei 模板（可多选 yaml 或 zip）；导入后 Agent 可用 poc_search / poc_read
									只读检索。
								</td>
							</tr>
						) : (
							sorted.flatMap((item, index) => row(item, index % 2 === 1))
						)}
					</tbody>
				</table>
			</div>

			<div className="poc-foot">
				<span>库为全局共享；模板不进容器，Agent 需自己写 yaml 后经 bash 执行 nuclei</span>
				<span className="poc-foot-sev">
					严重 {stats.bySeverity.critical} · 高危 {stats.bySeverity.high} · 中危 {stats.bySeverity.medium} · 低危{" "}
					{stats.bySeverity.low} · 信息 {stats.bySeverity.info}
				</span>
			</div>
		</div>
	);
}

export function readFileBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result ?? "");
			resolve(result.slice(result.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}
