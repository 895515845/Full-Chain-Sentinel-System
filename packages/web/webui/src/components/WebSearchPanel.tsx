import { useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import type { SentinelTestResult, SentinelWebSearchConfigView, SentinelWebSearchKeyInput, SentinelWebSearchKeyView } from "../types.ts";

/**
 * The Web 搜索 (Tavily) section of the settings page — table layout (方案 A).
 *
 * One row per pool key; the add form is a permanent row above the table, and a
 * save probes the key automatically, so there is no separate "先验证" step.
 * Quota renders as a meter when a usage probe has run; the stored key itself is
 * only ever shown as its last four characters.
 */

function formatWhen(at: number | null): string {
	if (at === null) return t("尚未调用");
	const diff = Date.now() - at;
	const minute = 60_000;
	if (diff < minute) return t("刚刚");
	if (diff < 60 * minute) return t("{count} 分钟前", { count: Math.round(diff / minute) });
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	if (diff < 24 * 60 * minute) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fullWhen(at: number | null): string {
	if (at === null) return t("尚未调用");
	return new Date(at).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

export type WebSearchKeyState = "mounted" | "disabled" | "unkeyed" | "unverified";

export function webSearchKeyState(key: SentinelWebSearchKeyView): WebSearchKeyState {
	if (!key.enabled) return "disabled";
	if (!key.hasKey) return "unkeyed";
	return key.verified ? "mounted" : "unverified";
}

const STATE_LABELS: Record<WebSearchKeyState, string> = {
	mounted: t("已入池"),
	disabled: t("未启用"),
	unkeyed: t("未配置密钥"),
	unverified: t("验证失败"),
};

const STATE_TONES: Record<WebSearchKeyState, string> = {
	mounted: "ok",
	disabled: "off",
	unkeyed: "off",
	unverified: "bad",
};

/** Quota meter tone: healthy / low / spent-or-unknown. */
function quotaTone(key: SentinelWebSearchKeyView): "ok" | "low" | "empty" {
	const usage = key.usage;
	if (!usage || usage.remaining === null || usage.limit === null) return "ok";
	const ratio = usage.limit > 0 ? usage.remaining / usage.limit : 1;
	if (usage.remaining <= 0) return "empty";
	if (ratio < 0.2) return "low";
	return "ok";
}

function quotaText(key: SentinelWebSearchKeyView): string {
	const usage = key.usage;
	if (!usage) return key.status.quota ?? "—";
	const left = usage.remaining === null ? "∞" : String(usage.remaining);
	return usage.limit === null ? left : `${left} / ${usage.limit}`;
}

function quotaWidth(key: SentinelWebSearchKeyView): string {
	const usage = key.usage;
	if (!usage || usage.remaining === null || usage.limit === null || usage.limit <= 0) return "100%";
	const ratio = Math.max(0, Math.min(1, usage.remaining / usage.limit));
	return `${Math.round(ratio * 100)}%`;
}

export function WebSearchPanel({
	config,
	busy,
	onSave,
	onDelete,
	onSaveLimit,
	onTest,
}: {
	config: SentinelWebSearchConfigView;
	busy: boolean;
	onSave: (input: SentinelWebSearchKeyInput) => void;
	onDelete: (id: string) => void;
	onSaveLimit: (limit: number) => void;
	onTest: (id?: string, key?: string) => Promise<SentinelTestResult | null>;
}) {
	const [label, setLabel] = useState("");
	const [draft, setDraft] = useState("");
	const [limits, setLimits] = useState(String(config.sessionQueryLimit));
	const [testing, setTesting] = useState<string | null>(null);
	const [results, setResults] = useState<Record<string, SentinelTestResult | null>>({});

	const addKey = (): void => {
		if (!draft.trim() || busy) return;
		onSave({ label: label.trim() || t("未命名 Key"), key: draft.trim(), enabled: true });
		setLabel("");
		setDraft("");
	};

	const runTest = async (entry: SentinelWebSearchKeyView): Promise<void> => {
		setTesting(entry.id);
		setResults((prev) => ({ ...prev, [entry.id]: null }));
		try {
			const result = await onTest(entry.id);
			setResults((prev) => ({ ...prev, [entry.id]: result }));
		} finally {
			setTesting(null);
		}
	};

	return (
		<div className="asset-page">
			<div className="asset-notice">
				<b>{t("外发提示")}</b>{" "}
				{t(
					"搜索关键词与 API Key 会发送到 Tavily（api.tavily.com），搜索前请确认不包含涉密内容。多个 Key 组成号池，控制台按剩余额度自动轮换；单 Key 额度耗尽自动切换。",
				)}
			</div>

			<div className="asset-toolbar">
				<div className="asset-toolbar__stats">
					{t("号池")} <b>{config.usable}</b> / {config.keys.length} {t("个 Key 参与轮换")}
				</div>
				<div className="asset-toolbar__spacer" />
				<div className="asset-limit">
					<span>{t("每会话上限")}</span>
					<input
						value={limits}
						inputMode="numeric"
						onChange={(event) => setLimits(event.target.value.replace(/[^\d]/g, ""))}
						placeholder="0"
						spellCheck={false}
						aria-label={t("每个会话的搜索次数上限")}
					/>
					<span>{t("次 · 0 = 不限")}</span>
					<button type="button" className="primary" disabled={busy} onClick={() => onSaveLimit(Number(limits) || 0)}>
						{t("保存")}
					</button>
				</div>
			</div>

			<div className="asset-toolbar websearch-addrow">
				<input
					className="websearch-add-input websearch-add-input--label"
					value={label}
					onChange={(event) => setLabel(event.target.value)}
					placeholder={t("备注名（如 主账号）")}
					spellCheck={false}
					aria-label={t("新 Key 的备注名")}
				/>
				<input
					className="websearch-add-input websearch-add-input--key"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder={t("粘贴 Tavily API Key（tvly-…），保存后自动验证并入池")}
					type="password"
					spellCheck={false}
					autoComplete="off"
					aria-label={t("新 Key 的 API Key")}
					onKeyDown={(event) => {
						if (event.key === "Enter") addKey();
					}}
				/>
				<button
					type="button"
					className="primary"
					disabled={busy || !draft.trim() || config.keys.length >= 20}
					onClick={addKey}
				>
					{t("添加并验证")}
				</button>
			</div>

			<div className="asset-table">
				<div className="asset-row websearch-row asset-row--head">
					<div>Key</div>
					<div>{t("状态")}</div>
					<div>{t("剩余额度")}</div>
					<div>{t("最近调用")}</div>
					<div className="asset-ops">{t("操作")}</div>
				</div>

				{config.keys.length === 0 ? (
					<div className="asset-row websearch-row">
						<div className="asset-cell asset-cell--span">
							{t("还没有 Key：在上方粘贴并添加。申请地址")} https://app.tavily.com
						</div>
					</div>
				) : null}

				{config.keys.map((entry) => {
					const state = webSearchKeyState(entry);
					const tone = STATE_TONES[state];
					const meterTone = quotaTone(entry);
					const result = results[entry.id];
					return (
						<div className={`asset-group is-${tone}`} key={entry.id}>
							<div className="asset-row websearch-row">
								<div className="asset-plat">
									<span className="asset-mark">T</span>
									<div className="asset-plat__text">
										<div className="asset-plat__name">{entry.label}</div>
										<div className="asset-plat__tool">
											{entry.tail ? `tvly-…${entry.tail}` : "web_search / web_extract"}
										</div>
									</div>
								</div>

								<div className="asset-state">
									<span className={`asset-pill is-${tone}`}>{STATE_LABELS[state]}</span>
									<label className="asset-switch" title={t("启用 {label}", { label: entry.label })}>
										<input
											type="checkbox"
											checked={entry.enabled}
											disabled={busy}
											aria-label={t("启用 {label}", { label: entry.label })}
											onChange={(event) =>
												onSave({ id: entry.id, label: entry.label, key: null, enabled: event.target.checked })
											}
										/>
										<span />
									</label>
								</div>

								<div className="websearch-quota">
									<span className={`websearch-meter is-${meterTone}`}>
										<i style={{ width: quotaWidth(entry) }} />
									</span>
									<span className="websearch-quota__num" title={entry.status.quota ?? ""}>
										{quotaText(entry)}
									</span>
								</div>

								<div className="asset-cell asset-cell--nowrap" title={fullWhen(entry.status.at)}>
									{formatWhen(entry.status.at)}
									{entry.status.at === null ? "" : entry.status.ok ? t(" · 成功") : t(" · 失败")}
								</div>

								<div className="asset-ops">
									<button type="button" disabled={testing === entry.id || !entry.hasKey} onClick={() => void runTest(entry)}>
										{testing === entry.id ? t("验证中…") : t("测试")}
									</button>
									{entry.enabled ? (
										<button
											type="button"
											className="quiet"
											disabled={busy}
											onClick={() => onSave({ id: entry.id, label: entry.label, key: null, enabled: false })}
										>
											{t("禁用")}
										</button>
									) : (
										<button
											type="button"
											className="quiet"
											disabled={busy || !entry.hasKey}
											onClick={() => onSave({ id: entry.id, label: entry.label, key: null, enabled: true })}
										>
											{t("启用")}
										</button>
									)}
									<button type="button" className="quiet" disabled={busy} onClick={() => onDelete(entry.id)}>
										{t("删除")}
									</button>
								</div>
							</div>

							{result || entry.status.error ? (
								<div className="asset-detail">
									<div>
										{result ? (
											<div className={`asset-result is-${result.ok ? "ok" : "bad"}`}>
												{result.message}
												{result.detail ? <pre>{result.detail}</pre> : null}
											</div>
										) : null}
										{entry.status.error ? <div className="asset-error">{entry.status.error}</div> : null}
									</div>
								</div>
							) : null}
						</div>
					);
				})}
			</div>

			<p className="asset-footnote">
				{t(
					"保存 / 删除 Key 与修改上限都会重建会话（历史保留），有会话正在运行时会拒绝并提示，请先中止。添加 Key 时自动验证一次，通过即入池；控制台每分钟刷新一次各 Key 剩余额度，查询时优先使用剩余最多的。密钥只写入本机 websearch.json（0600），前端不回显；原始响应写入项目 evidence/search/。",
				)}
			</p>
		</div>
	);
}
