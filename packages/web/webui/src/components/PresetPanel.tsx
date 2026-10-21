/**
 * 设置 → 预设 Agent.
 *
 * A preset is system-prompt context, not capability: the page says so up front,
 * because an operator who expects a preset to bring tools will otherwise assume
 * the switches below are broken. The library is always operator-created, so the
 * empty state explains where presets come from instead of offering a sample.
 */

import { useRef, useState } from "react";
import { t } from "../i18n.ts";
import type { SentinelClientMessage, SentinelPresetView } from "../types.ts";

/** Body-size thresholds at which the token figure turns yellow, then red. */
const TOKEN_WARN = 2000;
const TOKEN_DANGER = 8000;

/** The 导入 reply, shown inline instead of as a browser alert. */
export interface PresetImportNotice {
	imported: number;
	skipped: { name: string; reason: string }[];
}

type SavePresetInput = Extract<SentinelClientMessage, { type: "save_preset" }>["input"];

interface Draft {
	/** Set when editing an existing preset; absent when creating one. */
	id?: string;
	name: string;
	description: string;
	tags: string;
	placeholder: string;
	text: string;
}

const EMPTY_DRAFT: Draft = { name: "", description: "", tags: "", placeholder: "", text: "" };

function draftOf(preset: SentinelPresetView): Draft {
	return {
		id: preset.id,
		name: preset.name,
		description: preset.description,
		tags: preset.tags.join(", "),
		placeholder: preset.placeholder,
		text: preset.text,
	};
}

function tokenClass(tokens: number): string {
	if (tokens >= TOKEN_DANGER) return "preset-tokens preset-tokens--danger";
	if (tokens >= TOKEN_WARN) return "preset-tokens preset-tokens--warn";
	return "preset-tokens";
}

export function PresetPanel({
	presets,
	importNotice,
	onSave,
	onDelete,
	onSetEnabled,
	onExport,
	onImport,
}: {
	presets: SentinelPresetView[] | null;
	importNotice: PresetImportNotice | null;
	onSave: (input: SavePresetInput) => void;
	onDelete: (id: string) => void;
	onSetEnabled: (id: string, enabled: boolean) => void;
	onExport: () => void;
	onImport: (content: string) => void;
}) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);

	const submit = () => {
		if (!draft) return;
		const name = draft.name.trim();
		// The body may be any length, but an empty one saves a preset that does
		// nothing; the server refuses it too, so the button stays disabled instead.
		if (!name || !draft.text.trim()) return;
		onSave({
			...(draft.id ? { id: draft.id } : {}),
			name,
			description: draft.description.trim(),
			tags: draft.tags
				.split(/[,，]/)
				.map((tag) => tag.trim())
				.filter(Boolean),
			placeholder: draft.placeholder.trim(),
			text: draft.text,
		});
		setDraft(null);
	};

	if (!presets) {
		return (
			<div className="settings settings--wide">
				<p className="settings-hint">{t("正在读取预设 Agent…")}</p>
			</div>
		);
	}

	return (
		<div className="settings settings--wide">
			<p className="settings-hint">
				{t("预设 Agent 是「一段追加到会话系统提示的文本」，只影响身份与背景知识：它不改变可用的工具、技能或模型，也不能扩大权限——能不能做什么只由「权限」页决定。")}
				{t("这个库初始为空，所有预设都由你手动创建；新建会话时可选一个，已有会话在输入框上方的「预设 Agent」里随时可换，工程模式下由指挥官按任务自行挑选。")}
			</p>

			{importNotice ? (
				<div className="preset-import-notice" role="status">
					<span>{t("导入完成：新增 {count} 个预设。", { count: importNotice.imported })}</span>
					{importNotice.skipped.length > 0 ? (
						<ul className="preset-import-skipped">
							{importNotice.skipped.map((item, index) => (
								<li key={`${item.name}-${index}`}>
									{item.name}：{item.reason}
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}

			<div className="settings-block__head">
				<h3 className="settings-section">
					{t("预设列表")}{" "}
					<span className="hint">{t("（{count} 条）", { count: presets.length })}</span>
				</h3>
				<div className="preset-toolbar">
					<button type="button" onClick={onExport}>
						{t("导出全部")}
					</button>
					<button type="button" onClick={() => fileRef.current?.click()}>
						{t("导入")}
					</button>
					<button type="button" className="primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
						+ {t("新建预设")}
					</button>
					<input
						ref={fileRef}
						type="file"
						accept=".json,application/json"
						className="preset-import-input"
						onChange={(event) => {
							const file = event.target.files?.[0];
							// Clear the value so picking the same file twice fires again.
							event.target.value = "";
							if (!file) return;
							void file.text().then((content) => onImport(content));
						}}
					/>
				</div>
			</div>

			{presets.length === 0 ? (
				<p className="settings-hint">
					{t("还没有预设 Agent。点「新建预设」写入一段系统提示即可；不创建也不影响使用，会话会跑默认 Agent。")}
				</p>
			) : (
				<div className="model-table-wrap">
					<div className="data-table preset-table">
						<div className="data-row data-head">
							<span>{t("名称")}</span>
							<span>{t("一句话描述")}</span>
							<span>{t("标签")}</span>
							<span>{t("估算 token")}</span>
							<span>{t("状态")}</span>
							<span className="model-table__actions-head">{t("操作")}</span>
						</div>
						{presets.map((preset) => (
							<div className={`data-row ${preset.textMissing ? "is-missing" : ""}`} key={preset.id}>
								<span className="data-name preset-name">
									{preset.name}
									{preset.textMissing ? (
										<span
											className="preset-missing"
											title={t("正文文件 presets/<id>.md 已丢失：该预设当前不可用，需重新编写并保存才能恢复")}
										>
											{t("正文缺失")}
										</span>
									) : null}
								</span>
								<span className="preset-description" title={preset.description}>
									{preset.textMissing ? (
										<span className="preset-missing-text">
											{t("正文文件已丢失，该预设不可用，需重新编写正文并保存")}
										</span>
									) : null}
									{preset.textMissing && preset.description ? " · " : null}
									{preset.description || (preset.textMissing ? null : t("（未填写）"))}
								</span>
								<span className="data-roles">
									{preset.tags.length === 0 ? (
										<span className="hint">{t("无标签")}</span>
									) : (
										preset.tags.map((tag) => (
											<span className="tag tag-accent" key={tag}>
												{tag}
											</span>
										))
									)}
								</span>
								<span className={tokenClass(preset.tokens)} title={t("按字符粗略估算，用于发现过大的预设")}>
									{t("粗估 {count} tokens", { count: preset.tokens })}
								</span>
								<span>
									<label
										className="preset-toggle"
										title={t("停用后新建会话与工程派发都不再选它；已在运行的会话不受影响")}
									>
										<input
											type="checkbox"
											checked={preset.enabled}
											onChange={(event) => onSetEnabled(preset.id, event.target.checked)}
										/>
										<span className={preset.enabled ? "tag tag-ok" : "tag tag-aborted"}>
											{preset.enabled ? t("已启用") : t("已停用")}
										</span>
									</label>
								</span>
								<span className="data-actions">
									<button type="button" onClick={() => setDraft(draftOf(preset))}>
										{t("编辑")}
									</button>
									<button
										type="button"
										title={t("删除后不可恢复；已用该预设创建的会话与工程任务会回退到默认 Agent")}
										onClick={() => onDelete(preset.id)}
									>
										{t("删除")}
									</button>
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{draft ? (
				<div className="model-editor preset-editor">
					<h3 className="settings-section">{draft.id ? t("编辑预设") : t("新建预设")}</h3>
					<div className="model-editor__grid">
						<label>
							{t("名称")}
							<input
								value={draft.name}
								onChange={(event) => setDraft({ ...draft, name: event.target.value })}
								placeholder={t("如：内网横向 / 代码审计")}
								spellCheck={false}
							/>
						</label>
						<label>
							{t("一句话描述")}
							<input
								value={draft.description}
								onChange={(event) => setDraft({ ...draft, description: event.target.value })}
								placeholder={t("新建会话时作为提示，如：优先看 Web 漏洞")}
								spellCheck={false}
							/>
						</label>
						<label>
							{t("标签")}
							<input
								value={draft.tags}
								onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
								placeholder={t("用逗号分隔，如：web, 内网, 免杀")}
								spellCheck={false}
							/>
						</label>
						<label title={t("该预设生效时，输入框里的灰色提示文案；留空则用控制台默认的那句（可拖入文件 / 粘贴截图）")}>
							{t("输入框提示")}
							<input
								value={draft.placeholder}
								onChange={(event) => setDraft({ ...draft, placeholder: event.target.value })}
								placeholder={t("留空用默认文案，如：说说这次要看的目标")}
								spellCheck={false}
							/>
						</label>
					</div>
					<label className="preset-editor__body">
						<span>
							{t("正文（追加到会话系统提示，纯文本，可任意长度）")}
							<span className="hint"> · {t("保存后显示估算 token；过大时列表会标黄/标红")}</span>
						</span>
						<textarea
							value={draft.text}
							onChange={(event) => setDraft({ ...draft, text: event.target.value })}
							placeholder={t("例：你是一名内网渗透测试专家，优先使用 …")}
							spellCheck={false}
						/>
					</label>
					<div className="model-editor__actions">
						<button
							type="button"
							className="primary"
							disabled={!draft.name.trim() || !draft.text.trim()}
							onClick={submit}
						>
							{t("保存")}
						</button>
						<button type="button" onClick={() => setDraft(null)}>
							{t("取消")}
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}
