import { useState } from "react";
import type {
	SentinelAssetConfigView,
	SentinelAssetPlatform,
	SentinelAssetPlatformInput,
	SentinelAssetPlatformView,
	SentinelTestResult,
} from "../types.ts";

/** Tool name the platform mounts, shown so the operator can match it in 权限. */
const TOOL_NAMES: Record<SentinelAssetPlatform, string> = {
	fofa: "fofa_search",
	quake: "quake_search",
	hunter: "hunter_search",
};

/** Badge letter for the platform, since the labels have no common initial. */
const PLATFORM_MARKS: Record<SentinelAssetPlatform, string> = {
	fofa: "F",
	quake: "Q",
	hunter: "H",
};

/** One platform's own query language, so the operator can copy a working example. */
const SYNTAX_EXAMPLES: Record<SentinelAssetPlatform, string> = {
	fofa: 'ip="1.1.1.1" · domain="example.com" · title="后台" · body="login"',
	quake: 'ip:"1.1.1.1" · domain:"example.com" · title:"后台" · port:8080',
	hunter: 'ip="1.1.1.1" · domain="example.com" · web.title="后台" · port="8080"',
};

/** A constraint that only bites at query time, so it sits next to the syntax. */
const SYNTAX_NOTES: Partial<Record<SentinelAssetPlatform, string>> = {
	hunter: "Hunter 的 page_size 只接受 1 / 10 / 20 / 50 / 100，其它值由控制台向上取整。",
};

/** Where to apply for a key. */
const KEY_PAGES: Record<SentinelAssetPlatform, string> = {
	fofa: "https://fofa.info/userInfo/",
	quake: "https://quake.360.net/quake/#/personalInfo",
	hunter: "https://hunter.qianxin.com/home/userInfo",
};

/** Compact timestamp for the table cell; the full value rides along in the title. */
function formatWhen(at: number | null): string {
	if (at === null) return "尚未调用";
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fullWhen(at: number | null): string {
	if (at === null) return "尚未调用";
	return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

/**
 * Which of the four states a platform is in. It is the single source for both
 * the row's rail and the sentence that explains the missing tool, so the badge
 * and the explanation can never disagree.
 */
export type AssetPlatformState = "mounted" | "disabled" | "unkeyed" | "unverified";

export function platformState(platform: SentinelAssetPlatformView): AssetPlatformState {
	if (!platform.enabled) return "disabled";
	if (!platform.hasKey) return "unkeyed";
	return platform.verified ? "mounted" : "unverified";
}

const STATE_LABELS: Record<AssetPlatformState, string> = {
	mounted: "已挂载",
	disabled: "未启用",
	unkeyed: "未配置密钥",
	unverified: "验证失败",
};

/** Row rail and badge tone per state. */
const STATE_TONES: Record<AssetPlatformState, string> = {
	mounted: "ok",
	disabled: "off",
	unkeyed: "off",
	unverified: "bad",
};

/** Why a platform contributes no tool, phrased for the operator. */
export function mountReason(platform: SentinelAssetPlatformView): string {
	const state = platformState(platform);
	if (state === "mounted") return `已挂载 ${TOOL_NAMES[platform.id]} 给 Agent`;
	if (state === "disabled") return "未启用，工具不挂载";
	if (state === "unkeyed") return "未配置密钥，工具不挂载";
	return "密钥未通过验证，工具不挂载";
}

/**
 * The payload for a save.
 *
 * An empty box means "keep what is stored" (the key is never read back, so the
 * operator cannot retype it by accident), and a typed value replaces it. Clearing
 * is a separate action that sends the empty string, which is the only way to
 * delete a stored key.
 */
export function platformSaveInput(
	id: SentinelAssetPlatform,
	enabled: boolean,
	draft: string | undefined,
): SentinelAssetPlatformInput {
	const key = draft?.trim();
	return { id, enabled, key: key ? key : null };
}

/**
 * The 资产测绘 section of the settings page.
 *
 * One row per platform so the three can be compared at a glance — status, quota
 * and the last call are the columns, because "which platform is actually feeding
 * the agent" is the question this page exists to answer. Everything that is read
 * once (query syntax, where to apply, why a tool is missing) folds into the row's
 * detail, which starts open for a platform that is switched on but failing: that
 * is the state the operator has to act on.
 *
 * The page is where a platform becomes usable: a key that is switched on and
 * verified by 测试连接 is the only thing that makes its tool appear in the
 * agent's tool list. Nothing here is read back to the browser — the stored key
 * is reported as "已保存" and never echoed.
 */
export function AssetPanel({
	config,
	busy,
	onSave,
	onSaveLimit,
	onTest,
}: {
	config: SentinelAssetConfigView;
	busy: boolean;
	onSave: (input: SentinelAssetPlatformInput) => void;
	onSaveLimit: (limit: number) => void;
	onTest: (platform: SentinelAssetPlatform, key?: string) => Promise<SentinelTestResult | null>;
}) {
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [limits, setLimits] = useState(String(config.sessionQueryLimit));
	const [testing, setTesting] = useState<string | null>(null);
	const [results, setResults] = useState<Record<string, SentinelTestResult | null>>({});
	const [open, setOpen] = useState<Record<string, boolean>>(() =>
		Object.fromEntries(
			config.platforms.filter((platform) => platformState(platform) === "unverified").map((platform) => [platform.id, true]),
		),
	);

	const setDraft = (id: SentinelAssetPlatform, value: string): void => {
		setDrafts((prev) => ({ ...prev, [id]: value }));
	};

	const toggle = (id: SentinelAssetPlatform): void => {
		setOpen((prev) => ({ ...prev, [id]: !prev[id] }));
	};

	const runTest = async (platform: SentinelAssetPlatformView): Promise<void> => {
		setTesting(platform.id);
		setResults((prev) => ({ ...prev, [platform.id]: null }));
		try {
			const key = drafts[platform.id]?.trim();
			const result = await onTest(platform.id, key ? key : undefined);
			setResults((prev) => ({ ...prev, [platform.id]: result }));
		} finally {
			setTesting(null);
		}
	};

	return (
		<div className="asset-page">
			<div className="asset-notice">
				<b>外发提示</b>
				查询内容与 API Key 会发送到对应第三方平台（FOFA / 360 Quake / 奇安信 Hunter），查询前请确认目标在授权范围内。
			</div>

			<div className="asset-toolbar">
				<div className="asset-toolbar__stats">
					已挂载 <b>{config.usable}</b> / {config.platforms.length} 个平台 · 只有「已启用 + 已配置密钥 + 已验证通过」的平台才把工具挂给 Agent
				</div>
				<div className="asset-toolbar__spacer" />
				<div className="asset-limit">
					<span>每会话上限</span>
					<input
						value={limits}
						inputMode="numeric"
						onChange={(event) => setLimits(event.target.value.replace(/[^\d]/g, ""))}
						placeholder="0"
						spellCheck={false}
						aria-label="每个会话的查询次数上限"
					/>
					<span>次 · 0 = 不限</span>
					<button type="button" className="primary" disabled={busy} onClick={() => onSaveLimit(Number(limits) || 0)}>
						保存
					</button>
				</div>
			</div>

			<div className="asset-table">
				<div className="asset-row asset-row--head">
					<div>平台</div>
					<div>状态</div>
					<div>API Key</div>
					<div>额度</div>
					<div>最近调用</div>
					<div className="asset-ops">操作</div>
				</div>

				{config.platforms.map((platform) => {
					const state = platformState(platform);
					const tone = STATE_TONES[state];
					const result = results[platform.id];
					const draft = drafts[platform.id] ?? "";
					const isOpen = open[platform.id] === true;
					const note = SYNTAX_NOTES[platform.id];
					return (
						<div className={`asset-group is-${tone}`} key={platform.id}>
							<div className="asset-row">
								<div className="asset-plat">
									<button
										type="button"
										className={`asset-toggle${isOpen ? " open" : ""}`}
										aria-expanded={isOpen}
										aria-label={`展开 ${platform.label} 的详情`}
										onClick={() => toggle(platform.id)}
									/>
									<span className="asset-mark">{PLATFORM_MARKS[platform.id]}</span>
									<div className="asset-plat__text">
										<div className="asset-plat__name">{platform.label}</div>
										<div className="asset-plat__tool" title={TOOL_NAMES[platform.id]}>
											{TOOL_NAMES[platform.id]}
											{state === "mounted" ? "" : " · 未挂载"}
										</div>
									</div>
								</div>

								<div className="asset-state">
									<span className={`asset-pill is-${tone}`}>{STATE_LABELS[state]}</span>
									<label className="asset-switch" title={`启用 ${platform.label}`}>
										<input
											type="checkbox"
											checked={platform.enabled}
											disabled={busy}
											aria-label={`启用 ${platform.label}`}
											onChange={(event) =>
												onSave(platformSaveInput(platform.id, event.target.checked, drafts[platform.id]))
											}
										/>
										<span />
									</label>
								</div>

								<div className="asset-key">
									<input
										value={draft}
										onChange={(event) => setDraft(platform.id, event.target.value)}
										placeholder={platform.hasKey ? "已保存，留空不改" : "粘贴 API Key"}
										type="password"
										spellCheck={false}
										autoComplete="off"
										aria-label={`${platform.label} 的 API Key`}
									/>
								</div>

								<div className="asset-cell" title={platform.status.quota ?? ""}>
									{platform.status.quota ?? "—"}
								</div>

								<div className="asset-cell asset-cell--nowrap" title={fullWhen(platform.status.at)}>
									{formatWhen(platform.status.at)}
									{platform.status.at === null ? "" : platform.status.ok ? " · 成功" : " · 失败"}
								</div>

								<div className="asset-ops">
									<button
										type="button"
										disabled={testing === platform.id || (!platform.hasKey && !draft.trim())}
										onClick={() => void runTest(platform)}
									>
										{testing === platform.id ? "验证中…" : "测试"}
									</button>
									<button
										type="button"
										className="primary"
										disabled={busy}
										onClick={() => onSave(platformSaveInput(platform.id, platform.enabled, drafts[platform.id]))}
									>
										保存
									</button>
									<button
										type="button"
										className="quiet"
										disabled={busy || !platform.hasKey}
										onClick={() => {
											setDraft(platform.id, "");
											// The empty string is the explicit "delete the stored key".
											onSave({ id: platform.id, enabled: platform.enabled, key: "" });
										}}
									>
										清除
									</button>
								</div>
							</div>

							<div className="asset-detail" hidden={!isOpen}>
								<div>
									{result ? (
										<div className={`asset-result is-${result.ok ? "ok" : "bad"}`}>
											{result.message}
											{result.detail ? <pre>{result.detail}</pre> : null}
										</div>
									) : null}
									{platform.status.error ? (
										<>
											<div className="asset-detail__title">上次错误</div>
											<div className="asset-error">{platform.status.error}</div>
										</>
									) : null}
									<div className="asset-detail__title">查询语法（给 Agent 用）</div>
									<div className="asset-syntax">{SYNTAX_EXAMPLES[platform.id]}</div>
									{note ? <div className="asset-note">{note}</div> : null}
								</div>
								<div>
									<div className="asset-detail__title">挂载状态</div>
									<div className="asset-note">
										{mountReason(platform)}。
										{state === "mounted"
											? `Agent 的工具列表里能看到 ${TOOL_NAMES[platform.id]}。`
											: "条件不满足的平台不挂载工具，Agent 看不到。"}
									</div>
									<div className="asset-detail__title">申请地址</div>
									<div className="asset-note">
										<a href={KEY_PAGES[platform.id]} target="_blank" rel="noreferrer">
											{KEY_PAGES[platform.id]}
										</a>
									</div>
									<div className="asset-detail__title">密钥存放</div>
									<div className="asset-note">
										只写入本机 assets.json（0600），前端不回显；查询由控制台直接发出，不进容器、不进 bash 审计，原始响应写入项目
										evidence/asset/。
									</div>
								</div>
							</div>
						</div>
					);
				})}
			</div>

			<p className="asset-footnote">
				保存时会自动验证一次，也可以点「测试」单独验证（验证结果会立即生效，并按需重建活动会话）。上限按「每个会话、三家合计」计算，子代理共用同一个额度；修改上限同样会重建会话，请先中止正在运行的会话。
			</p>
		</div>
	);
}
