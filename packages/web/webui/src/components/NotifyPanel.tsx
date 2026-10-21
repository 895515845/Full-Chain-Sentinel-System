import { useMemo, useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import type {
	SentinelNotifyChannel,
	SentinelNotifyChannelConfig,
	SentinelNotifyConfig,
	SentinelNotifyStatus,
	SentinelTestResult,
} from "../types.ts";
import {
	BellIcon,
	CheckIcon,
	KeyIcon,
	LinkIcon,
	PocIcon,
	PluginIcon,
	SaveIcon,
	SendIcon,
	ShieldIcon,
	TagIcon,
	TargetIcon,
} from "./icons.tsx";

function formatWhen(at: number | null): string {
	if (at === null) return t("尚未发送过通知");
	return new Date(at).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

type NotifyKind = keyof SentinelNotifyConfig["kinds"];

/** The notification kinds, in the order the checkboxes list them. */
const KINDS = [
	["runs", t("运行报告"), t("每次运行结束（含失败/中止）的汇总报告")],
	["vulns", t("高危漏洞"), t("提交或被审查抬级为 high/critical 的漏洞")],
	["goals", t("持续目标结束"), t("目标完成、阻塞、暂停或轮数用完")],
	["engines", t("工程完成"), t("工程总报告提交时")],
	["pocs", t("POC 订阅失败"), t("订阅源同步失败时（成功不推送）")],
] as const;

/** Every kind at the same value, for the 全选 / 全部不选 buttons. */
function selectAll(value: boolean): SentinelNotifyConfig["kinds"] {
	return { runs: value, vulns: value, goals: value, engines: value, pocs: value };
}

/** The glyph that sits beside one notification kind. */
function kindIcon(kind: NotifyKind) {
	switch (kind) {
		case "runs":
			return <BellIcon size={13} />;
		case "vulns":
			return <ShieldIcon size={13} />;
		case "goals":
			return <TargetIcon size={13} />;
		case "engines":
			return <PluginIcon size={13} />;
		case "pocs":
			return <PocIcon size={13} />;
	}
}

/** The brand initial in a channel card's top-left square. */
function channelMark(channel: SentinelNotifyChannel): string {
	return channel === "dingtalk" ? t("钉") : t("飞");
}

/**
 * One robot's card: its switch, connection fields, and test action.
 *
 * The card owns no state; both channels are edited through the panel so they
 * can be saved as one configuration.
 */
function ChannelCard({
	channel,
	title,
	subtitle,
	config,
	placeholder,
	keywordPlaceholder,
	busy,
	testing,
	result,
	onChange,
	onTest,
}: {
	channel: SentinelNotifyChannel;
	title: string;
	subtitle: string;
	config: SentinelNotifyChannelConfig;
	placeholder: string;
	keywordPlaceholder: string;
	/** Any channel is testing; this one may be disabled while another runs. */
	busy: boolean;
	/** This channel is the one sending. */
	testing: boolean;
	result: SentinelTestResult | null;
	onChange: (patch: Partial<SentinelNotifyChannelConfig>) => void;
	onTest: () => void;
}) {
	return (
		<article className={`notify-card notify-card--${channel}`}>
			<header className="notify-card__head">
				<span className="notify-logo" aria-hidden="true">
					{channelMark(channel)}
				</span>
				<div className="notify-card__title">
					<h4>{title}</h4>
					<p>{subtitle}</p>
				</div>
				<label
					className="notify-switch"
					title={config.enabled ? t("关闭{title}通知", { title }) : t("启用{title}通知", { title })}
				>
					<input
						type="checkbox"
						checked={config.enabled}
						aria-label={config.enabled ? t("关闭{title}通知", { title }) : t("启用{title}通知", { title })}
						onChange={(event) => onChange({ enabled: event.target.checked })}
					/>
					<span aria-hidden="true" />
				</label>
			</header>

			<div className="notify-card__meta">
				<span className={`notify-state ${config.enabled ? "on" : "off"}`}>
					<i aria-hidden="true" />
					{config.enabled ? t("已启用") : t("已关闭")}
				</span>
				<span className="notify-meta-sep" aria-hidden="true" />
				<span>
					{!config.enabled
						? t("开启后才会自动推送")
						: config.webhook.trim()
							? t("允许自动推送和测试")
							: t("已启用，但 webhook 为空")}
				</span>
			</div>

			<div className="notify-card__body">
				<label className="notify-field">
					<span>
						{t("Webhook 地址")} <em>{t("必填")}</em>
					</span>
					<span className="notify-input">
						<LinkIcon size={13} />
						<input
							value={config.webhook}
							onChange={(event) => onChange({ webhook: event.target.value })}
							placeholder={placeholder}
							spellCheck={false}
						/>
					</span>
				</label>

				<div className="notify-field-row">
					<label className="notify-field">
						<span>{t("签名密钥")} <em>{t("加签")}</em></span>
						<span className="notify-input">
							<KeyIcon size={13} />
							<input
								value={config.secret}
								onChange={(event) => onChange({ secret: event.target.value })}
								placeholder={channel === "feishu" ? t("飞书加签密钥") : "SEC…"}
								type="password"
								spellCheck={false}
							/>
						</span>
					</label>
					<label className="notify-field">
						<span>{t("关键词")} <em>{t("自定义")}</em></span>
						<span className="notify-input">
							<TagIcon size={13} />
							<input
								value={config.keyword}
								onChange={(event) => onChange({ keyword: event.target.value })}
								placeholder={keywordPlaceholder}
								spellCheck={false}
							/>
						</span>
					</label>
				</div>
			</div>

			<footer className="notify-card__foot">
				<div className="notify-card__foot-row">
					<button
						type="button"
						className="notify-test"
						disabled={!config.webhook.trim() || busy}
						onClick={onTest}
					>
						<SendIcon size={13} />
						{testing ? t("发送中…") : t("发送测试消息")}
					</button>
					<span className="notify-foot-hint">
						{config.webhook.trim() ? t("只发送一条测试卡片") : t("先填写 webhook")}
					</span>
				</div>
				{result ? (
					<div className={`notify-test-result ${result.ok ? "ok" : "bad"}`} role="status">
						<div className="notify-test-result__line">
							{result.ok ? <CheckIcon size={13} /> : null}
							<span>{result.message}</span>
						</div>
						{result.detail ? <pre>{result.detail}</pre> : null}
					</div>
				) : null}
			</footer>
		</article>
	);
}

/** The "notifications" section of the settings page: DingTalk and Feishu robots. */
export function NotifyPanel({
	config,
	status,
	onSave,
	onTest,
}: {
	config: SentinelNotifyConfig;
	status: SentinelNotifyStatus;
	onSave: (config: SentinelNotifyConfig) => void;
	onTest: (
		config: SentinelNotifyConfig,
		channel: SentinelNotifyChannel,
	) => Promise<SentinelTestResult | null>;
}) {
	const [dingtalk, setDingtalk] = useState<SentinelNotifyChannelConfig>({
		enabled: config.enabled,
		webhook: config.webhook,
		secret: config.secret,
		keyword: config.keyword,
	});
	const [feishu, setFeishu] = useState<SentinelNotifyChannelConfig>(config.feishu);
	const [kinds, setKinds] = useState(config.kinds);
	const [summaryLimit, setSummaryLimit] = useState(String(config.summaryLimit));
	const [testing, setTesting] = useState<SentinelNotifyChannel | null>(null);
	const [result, setResult] = useState<{ channel: SentinelNotifyChannel; result: SentinelTestResult } | null>(null);

	const draft = useMemo(
		() => ({
			...dingtalk,
			webhook: dingtalk.webhook.trim(),
			secret: dingtalk.secret.trim(),
			keyword: dingtalk.keyword.trim(),
			feishu: {
				...feishu,
				webhook: feishu.webhook.trim(),
				secret: feishu.secret.trim(),
				keyword: feishu.keyword.trim(),
			},
			kinds,
			summaryLimit: Math.max(0, Math.floor(Number(summaryLimit) || 0)),
		}),
		[dingtalk, feishu, kinds, summaryLimit],
	);

	const runTest = async (channel: SentinelNotifyChannel) => {
		setTesting(channel);
		setResult(null);
		try {
			const test = await onTest(draft, channel);
			if (test) setResult({ channel, result: test });
		} finally {
			setTesting(null);
		}
	};

	const enabledChannels = Number(dingtalk.enabled) + Number(feishu.enabled);
	const selectedKinds = KINDS.filter(([key]) => kinds[key]).length;
	const channelStatuses = (["dingtalk", "feishu"] as const).flatMap((channel) => {
		const entry = status.channels?.[channel];
		return entry ? [{ channel, ...entry }] : [];
	});
	const lastTone = status.at === null ? "idle" : status.ok ? "ok" : "bad";

	return (
		<div className="settings settings--wide settings--notify">
			<header className="notify-toolbar">
				<div className="notify-toolbar__copy">
					<div className="notify-toolbar__title">
						<h3>{t("通知渠道")}</h3>
						<span className="notify-count">
							{t("{enabled} / {total} 已启用", { enabled: enabledChannels, total: 2 })}
						</span>
					</div>
					<p>
						{t("任务结束后把结果推送到团队群。钉钉和飞书可同时启用；在群「设置 → 群机器人」添加自定义机器人并填入 webhook。加签和关键词按机器人的安全设置选填。")}
					</p>
				</div>
				<div className="notify-toolbar__actions">
					<span className="notify-save-hint">{t("保存后立即生效")}</span>
					<button type="button" className="primary" onClick={() => onSave(draft)}>
						<SaveIcon size={13} />
						{t("保存设置")}
					</button>
				</div>
			</header>

			<div className="notify-channel-grid">
				<ChannelCard
					channel="dingtalk"
					title={t("钉钉")}
					subtitle={t("自定义机器人 · Markdown")}
					config={dingtalk}
					placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
					keywordPlaceholder="Full Chain Sentinel"
					busy={testing !== null}
					testing={testing === "dingtalk"}
					result={result?.channel === "dingtalk" ? result.result : null}
					onChange={(patch) => setDingtalk((prev) => ({ ...prev, ...patch }))}
					onTest={() => void runTest("dingtalk")}
				/>

				<ChannelCard
					channel="feishu"
					title={t("飞书")}
					subtitle={t("自定义机器人 · interactive 卡片")}
					config={feishu}
					placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
					keywordPlaceholder="zgagent"
					busy={testing !== null}
					testing={testing === "feishu"}
					result={result?.channel === "feishu" ? result.result : null}
					onChange={(patch) => setFeishu((prev) => ({ ...prev, ...patch }))}
					onTest={() => void runTest("feishu")}
				/>
			</div>

			<section className="notify-rules">
				<header className="notify-rules__head">
					<div>
						<h4>{t("推送内容")}</h4>
						<p>
							{t("勾选的事件会同时发送到所有已启用渠道。")}
							<span className="notify-rules__count">
								{t("已选 {selected} / {total}", { selected: selectedKinds, total: KINDS.length })}
							</span>
						</p>
					</div>
					<div className="notify-rules__actions">
						<button
							type="button"
							className="ghost small"
							onClick={() => setKinds((prev) => ({ ...prev, ...selectAll(true) }))}
						>
							{t("全选")}
						</button>
						<button
							type="button"
							className="ghost small"
							onClick={() => setKinds((prev) => ({ ...prev, ...selectAll(false) }))}
						>
							{t("全部不选")}
						</button>
					</div>
				</header>

				<div className="notify-rules__body">
					<div className="notify-events">
						{KINDS.map(([key, name, note]) => (
							<label key={key} className={`notify-event ${kinds[key] ? "on" : ""}`}>
								<span className="notify-event__icon" aria-hidden="true">
									{kindIcon(key)}
								</span>
								<span className="notify-event__copy">
									<b>{name}</b>
									<small>{note}</small>
								</span>
								<input
									type="checkbox"
									checked={kinds[key]}
									onChange={(event) => setKinds((prev) => ({ ...prev, [key]: event.target.checked }))}
								/>
							</label>
						))}
					</div>

					<div className="notify-limit">
						<div className="notify-limit__head">
							<span>{t("通知正文字数上限")}</span>
							<em>{t("0 = 不截断")}</em>
						</div>
						<input
							value={summaryLimit}
							inputMode="numeric"
							aria-label={t("通知正文字数上限")}
							onChange={(event) => setSummaryLimit(event.target.value.replace(/[^\d]/g, ""))}
							placeholder="2000"
							spellCheck={false}
						/>
						<p>
							{t("作用于任务报告的「最后回复」、持续目标的「结论」和漏洞通知的「原始数据包」。超过钉钉 20,000 字节或飞书 30,000 字节时仍会硬截断并注明。")}
						</p>
						<p className="notify-limit__note">{t("输入框旁单条强制发送不受「运行报告」勾选影响。")}</p>
					</div>
				</div>
			</section>

			<div className={`notify-last ${lastTone}`}>
				<span className="notify-last__dot" aria-hidden="true" />
				<div className="notify-last__copy">
					<b>
						{status.at === null
							? t("最近一次通知")
							: t("最近一次通知：{time}", { time: formatWhen(status.at) })}
					</b>
					<span>
						{status.at === null ? (
							t("启用渠道并保存后，下一轮任务结束时会在这里显示投递结果。")
						) : (
							<>
								{status.ok ? t("发送成功") : t("发送失败")}
								{status.subject ? t(" · {subject}", { subject: status.subject }) : ""}
							</>
						)}
					</span>
					{status.error ? <span className="notify-last__error">{status.error}</span> : null}
				</div>
				{channelStatuses.length > 0 ? (
					<div className="notify-last__channels">
						{channelStatuses.map((entry) => (
							<span
								key={entry.channel}
								className={`notify-pill ${entry.ok ? "ok" : "bad"}`}
								title={entry.error ?? undefined}
							>
								{entry.channel === "dingtalk" ? t("钉钉") : t("飞书")}
								{entry.ok ? t(" 成功") : t(" 失败")}
							</span>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
