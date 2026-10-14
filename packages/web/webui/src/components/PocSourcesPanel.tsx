/**
 * The POC subscription settings page: remote zip sources the operator follows.
 *
 * A source is a name, a zip URL, an optional auth header, and an optional
 * automatic interval. Everything here is operator territory — the agent has no
 * tool that can add, edit, or trigger a source. Syncs only upsert templates
 * (by id) and never delete; the header value is written to subscriptions.json
 * (0600) and never echoed back, so an edit leaves the field blank to keep the
 * stored secret.
 *
 * 「一键同步官方 POC」 is the same machinery with the source supplied: the
 * server creates the official nuclei-templates source if it is missing and
 * syncs it, so a first-time operator never has to know the URL. That source is
 * ordinary afterwards — this list edits, retargets, and deletes it like any
 * other, and pressing the button again recreates it.
 *
 * The page follows the console's settings idioms: labeled fields as a vertical
 * stack (`settings`), one block heading with its action on the right
 * (`settings-block__head`), and the source list as a `data-table`.
 */

import { useState } from "react";
import type { ZGPocSource, ZGPocSourceSave } from "../types.ts";
import { ZG_OFFICIAL_POC_SOURCE_ID } from "../types.ts";

/** Editing state of the form; a source being edited fills every field. */
interface Draft {
	id: string | null;
	name: string;
	url: string;
	headerName: string;
	headerValue: string;
	/** True while editing a source whose stored header value the form cannot show. */
	headerSet: boolean;
	intervalHours: number;
	enabled: boolean;
}

const EMPTY_DRAFT: Draft = {
	id: null,
	name: "",
	url: "",
	headerName: "",
	headerValue: "",
	headerSet: false,
	intervalHours: 24,
	enabled: true,
};

const INTERVAL_CHOICES: readonly number[] = [0, 1, 6, 24, 168];

function intervalLabel(hours: number): string {
	if (hours <= 0) return "仅手动";
	if (hours === 168) return "每 7 天";
	return `每 ${hours} 小时`;
}

function formatWhen(value: string | null): string {
	if (!value) return "从未同步";
	return value.slice(0, 19).replace("T", " ");
}

function resultLine(source: ZGPocSource): string {
	const last = source.lastResult;
	if (!last) return "暂无同步记录";
	const base = `${last.ok ? "成功" : "失败"} · 新增 ${last.imported} · 覆盖 ${last.replaced} · 跳过 ${last.skipped} · ${(last.durationMs / 1000).toFixed(1)}s`;
	return last.ok ? base : `${base} · ${last.error ?? "未知错误"}`;
}

/** Grey pill before the first sync, then green for ok and red for a failure. */
function statusTag(source: ZGPocSource): { className: string; label: string } {
	if (!source.lastResult) return { className: "tag tag-aborted", label: "未同步" };
	return source.lastResult.ok
		? { className: "tag tag-done", label: "正常" }
		: { className: "tag tag-failed", label: "失败" };
}

export function PocSourcesPanel({
	sources,
	syncing,
	onSave,
	onDelete,
	onSync,
	onRefresh,
	officialSyncing,
	onSyncOfficial,
}: {
	sources: ZGPocSource[];
	/** Id currently syncing, so its row shows the wait instead of a second click. */
	syncing: string | null;
	onSave(source: ZGPocSourceSave): void;
	onDelete(id: string): void;
	onSync(id: string): void;
	onRefresh(): void;
	/** True while the one-click official sync runs (it creates its own source). */
	officialSyncing: boolean;
	onSyncOfficial(): void;
}) {
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	const [error, setError] = useState<string | null>(null);
	const [historyOf, setHistoryOf] = useState<string | null>(null);

	const set = (patch: Partial<Draft>): void => setDraft((prev) => ({ ...prev, ...patch }));

	const edit = (source: ZGPocSource): void => {
		setDraft({
			id: source.id,
			name: source.name,
			url: source.url,
			headerName: source.headerName ?? "",
			// Blank keeps the stored secret; the form cannot show it back.
			headerValue: "",
			headerSet: source.headerSet,
			intervalHours: source.intervalHours,
			enabled: source.enabled,
		});
		setError(null);
	};

	const submit = (): void => {
		if (!draft.name.trim() || !draft.url.trim()) {
			setError("名称和 URL 不能为空");
			return;
		}
		if (!/^https?:\/\//i.test(draft.url.trim())) {
			setError("URL 必须以 http:// 或 https:// 开头");
			return;
		}
		setError(null);
		onSave({
			...(draft.id ? { id: draft.id } : {}),
			name: draft.name.trim(),
			url: draft.url.trim(),
			...(draft.headerName.trim() ? { headerName: draft.headerName.trim() } : {}),
			...(draft.headerValue ? { headerValue: draft.headerValue } : {}),
			intervalHours: draft.intervalHours,
			enabled: draft.enabled,
		});
		setDraft(EMPTY_DRAFT);
	};

	return (
		<div className="settings settings--wide">
			<p className="settings-hint">
				订阅远程 zip 模板包：手动「立即同步」，或按间隔自动拉取。同步只新增与覆盖（按模板 id
				去重），从不删除本地模板；下载限 256MB、单次 60 秒超时、网络错误自动重试一次，每个源保留最近 5 次同步记录。
			</p>

			<div className="form-field">
				<label>{draft.id ? "编辑订阅源" : "添加订阅源"}</label>
				<div className="source-fields">
					<label>
						名称
						<input
							value={draft.name}
							placeholder="内网模板包"
							spellCheck={false}
							onChange={(event) => set({ name: event.target.value })}
						/>
					</label>
					<label>
						同步间隔
						<select
							value={draft.intervalHours}
							onChange={(event) => set({ intervalHours: Number(event.target.value) })}
						>
							{INTERVAL_CHOICES.map((hours) => (
								<option key={hours} value={hours}>
									{intervalLabel(hours)}
								</option>
							))}
						</select>
					</label>
					<label className="source-fields__wide">
						zip 直链 URL
						<input
							value={draft.url}
							placeholder="https://example.com/nuclei-templates.zip"
							spellCheck={false}
							onChange={(event) => set({ url: event.target.value })}
						/>
					</label>
					<label>
						认证头名称（可选）
						<input
							value={draft.headerName}
							placeholder="Authorization"
							spellCheck={false}
							onChange={(event) => set({ headerName: event.target.value })}
						/>
					</label>
					<label>
						认证头的值（可选）
						<input
							type="password"
							value={draft.headerValue}
							placeholder={draft.headerSet ? "留空保留原值" : "Bearer …"}
							spellCheck={false}
							onChange={(event) => set({ headerValue: event.target.value })}
						/>
					</label>
				</div>
				<label className="check-row">
					<input
						type="checkbox"
						checked={draft.enabled}
						onChange={(event) => set({ enabled: event.target.checked })}
					/>
					启用（停用后不再自动同步，仍可手动「立即同步」）
				</label>
				<div className="source-form-ops">
					<button type="button" className="primary" onClick={submit}>
						{draft.id ? "保存修改" : "添加订阅源"}
					</button>
					{draft.id ? (
						<button type="button" onClick={() => setDraft(EMPTY_DRAFT)}>
							取消
						</button>
					) : null}
				</div>
				{error ? <span className="field-sub err-text">{error}</span> : null}
			</div>

			<div className="settings-block__head">
				<h3 className="settings-section">
					订阅源 <span className="hint">（{sources.length} 个）</span>
				</h3>
				<span className="settings-block__ops">
					<button
						type="button"
						className="ghost small"
						disabled={officialSyncing}
						title="从官方仓库 projectdiscovery/nuclei-templates 下载最新模板包并导入；源不存在会自动创建，之后 URL 可以改成镜像"
						onClick={onSyncOfficial}
					>
						{officialSyncing ? "同步中…" : "一键同步官方 POC"}
					</button>
					<button type="button" onClick={onRefresh}>
						刷新
					</button>
				</span>
			</div>

			{sources.length === 0 ? (
				<p className="settings-hint">
					还没有订阅源。填一个 zip 直链后点「添加订阅源」；「立即同步」会把包内模板按 id 去重后并入 POC 库。
				</p>
			) : (
				<div className="model-table-wrap">
					<div className="data-table source-table">
						<div className="data-row data-head">
							<span>名称</span>
							<span>zip 直链</span>
							<span>同步</span>
							<span>最近结果</span>
							<span className="data-actions-col">操作</span>
						</div>
						{sources.map((source) => {
							const tag = statusTag(source);
							// The official sync starts before its source exists in this
							// list, so its busy state is not keyed on the id alone.
							const busy =
								syncing === source.id || (officialSyncing && source.id === ZG_OFFICIAL_POC_SOURCE_ID);
							return (
								<div className="data-row" key={source.id}>
									<span className="data-name">
										{source.name}
										<span className={tag.className} title={source.enabled ? "已启用" : "已停用，不会自动同步"}>
											{source.enabled ? tag.label : `${tag.label} · 已停用`}
										</span>
									</span>
									<span className="data-mono" title={source.url}>
										{source.url}
									</span>
									<span className="source-schedule">
										{intervalLabel(source.intervalHours)}
										<span className="hint">{formatWhen(source.lastSyncAt)}</span>
									</span>
									<span
										className={`source-result ${source.lastResult && !source.lastResult.ok ? "err-text" : ""}`}
										title={resultLine(source)}
									>
										{resultLine(source)}
									</span>
									<span className="data-actions">
										<button type="button" disabled={busy} onClick={() => onSync(source.id)}>
											{busy ? "同步中…" : "立即同步"}
										</button>
										<button
											type="button"
											onClick={() => setHistoryOf(historyOf === source.id ? null : source.id)}
										>
											{historyOf === source.id ? "收起" : "历史"}
										</button>
										<button type="button" onClick={() => edit(source)}>
											编辑
										</button>
										<button
											type="button"
											onClick={() => {
												if (window.confirm(`删除订阅源「${source.name}」？\n已导入的模板不会被删除。`)) {
													onDelete(source.id);
												}
											}}
										>
											删除
										</button>
									</span>
									{historyOf === source.id ? (
										<div className="source-history">
											<div className="source-history__title">最近 {source.history.length} 次同步</div>
											{source.history.length === 0 ? (
												<div className="hint">还没有同步过。</div>
											) : (
												source.history.map((record) => (
													<div key={record.at} className={record.ok ? "" : "err-text"}>
														{formatWhen(record.at)} · {record.ok ? "成功" : "失败"} · 新增 {record.imported} · 覆盖{" "}
														{record.replaced} · 跳过 {record.skipped} · {(record.durationMs / 1000).toFixed(1)}s ·{" "}
														{record.trigger === "auto" ? "自动" : "手动"}
														{record.error ? ` · ${record.error}` : ""}
													</div>
												))
											)}
										</div>
									) : null}
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
