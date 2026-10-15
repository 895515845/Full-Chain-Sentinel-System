import { useMemo, useState } from "react";
import type { SentinelNotifyConfig, SentinelNotifyStatus, SentinelTestResult } from "../types.ts";

function formatWhen(at: number | null): string {
	if (at === null) return "尚未发送过通知";
	return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

/** The notification kinds, in the order the checkboxes list them. */
const KINDS = [
	["runs", "运行报告", "每次运行结束（含失败/中止）的汇总报告"],
	["vulns", "高危漏洞", "提交或被审查抬级为 high/critical 的漏洞"],
	["goals", "持续目标结束", "目标完成、阻塞、暂停或轮数用完"],
	["engines", "工程完成", "工程总报告提交时"],
	["pocs", "POC 订阅失败", "订阅源同步失败时（成功不推送）"],
] as const;

/** Every kind at the same value, for the 全选 / 全部不选 buttons. */
function selectAll(value: boolean): SentinelNotifyConfig["kinds"] {
	return { runs: value, vulns: value, goals: value, engines: value, pocs: value };
}

/** The "notifications" section of the settings page: DingTalk group robot. */
export function NotifyPanel({
	config,
	status,
	onSave,
	onTest,
}: {
	config: SentinelNotifyConfig;
	status: SentinelNotifyStatus;
	onSave: (config: SentinelNotifyConfig) => void;
	onTest: (config: SentinelNotifyConfig) => Promise<SentinelTestResult | null>;
}) {
	const [enabled, setEnabled] = useState(config.enabled);
	const [webhook, setWebhook] = useState(config.webhook);
	const [secret, setSecret] = useState(config.secret);
	const [keyword, setKeyword] = useState(config.keyword);
	const [kinds, setKinds] = useState(config.kinds);
	const [summaryLimit, setSummaryLimit] = useState(String(config.summaryLimit));
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<SentinelTestResult | null>(null);

	const draft = useMemo(
		() => ({
			enabled,
			webhook: webhook.trim(),
			secret: secret.trim(),
			keyword: keyword.trim(),
			kinds,
			summaryLimit: Math.max(0, Math.floor(Number(summaryLimit) || 0)),
		}),
		[enabled, webhook, secret, keyword, kinds, summaryLimit],
	);
	const canSend = draft.webhook.length > 0;

	const runTest = async () => {
		setTesting(true);
		setResult(null);
		try {
			setResult(await onTest(draft));
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className="settings">
			<p className="settings-hint">
				任务完成后向钉钉群机器人推送一条 markdown 消息。在钉钉群「群设置 → 智能群助手 → 添加机器人 → 自定义」里拿到
				webhook
				地址；机器人若开启「加签」，把密钥填进签名密钥；若用「自定义关键词」，把关键词填进关键词字段（会拼在正文最前面）。
			</p>
			<label className="check-row">
				<input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
				启用钉钉通知（关闭后仍可在输入框旁单条强制发送）
			</label>
			<label>
				Webhook 地址
				<input
					value={webhook}
					onChange={(event) => setWebhook(event.target.value)}
					placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
					spellCheck={false}
				/>
			</label>
			<label>
				签名密钥（可选，对应机器人「加签」）
				<input
					value={secret}
					onChange={(event) => setSecret(event.target.value)}
					placeholder="SEC…"
					type="password"
					spellCheck={false}
				/>
			</label>
			<label>
				自定义关键词（可选，对应机器人「自定义关键词」）
				<input
					value={keyword}
					onChange={(event) => setKeyword(event.target.value)}
					placeholder="Full Chain Sentinel"
					spellCheck={false}
				/>
			</label>
			<div className="form-field">
				<label>推送内容（勾选的要推，不勾的不推）</label>
				<div className="check-group kinds-grid">
					<div className="kinds-head">
						<span>
							已勾选 {KINDS.filter(([key]) => kinds[key]).length} / {KINDS.length} 项
						</span>
						<span className="kinds-head-ops">
							<button type="button" onClick={() => setKinds((prev) => ({ ...prev, ...selectAll(true) }))}>
								全选
							</button>
							<button type="button" onClick={() => setKinds((prev) => ({ ...prev, ...selectAll(false) }))}>
								全部不选
							</button>
						</span>
					</div>
					{KINDS.map(([key, name, note]) => (
						<label key={key} className={`check-item ${kinds[key] ? "on" : ""}`}>
							<input
								type="checkbox"
								checked={kinds[key]}
								onChange={(event) => setKinds((prev) => ({ ...prev, [key]: event.target.checked }))}
							/>
							<span className="cname">{name}</span>
							<span className="ctext">{note}</span>
						</label>
					))}
				</div>
				<span className="field-sub">
					输入框旁单条强制发送的运行报告不受「运行报告」勾选影响：那是当场点名的，不走这里。
				</span>
			</div>
			<label>
				通知正文字数上限
				<input
					value={summaryLimit}
					inputMode="numeric"
					onChange={(event) => setSummaryLimit(event.target.value.replace(/[^\d]/g, ""))}
					placeholder="2000"
					spellCheck={false}
				/>
				<span className="field-sub">
					留空或填 0 =
					不截断。作用于任务报告的「最后回复」、持续目标的「结论」和漏洞通知的「原始数据包」；正文超过钉钉单条
					20000 字节时仍会被硬截断并注明。
				</span>
			</label>
			{result ? (
				<div className={`test-result ${result.ok ? "ok" : "bad"}`}>
					<div>{result.message}</div>
					{result.detail ? <pre>{result.detail}</pre> : null}
				</div>
			) : null}
			<div className={`test-result ${status.at === null ? "" : status.ok ? "ok" : "bad"}`}>
				<div>
					最近一次通知：{formatWhen(status.at)}
					{status.at === null ? "" : status.ok ? " 发送成功" : ` 发送失败`}
				</div>
				{status.error ? <pre>{status.error}</pre> : null}
			</div>
			<div style={{ display: "flex", gap: 8 }}>
				<button type="button" disabled={!canSend || testing} onClick={runTest}>
					{testing ? "发送中…" : "发送测试消息"}
				</button>
				<button type="button" className="primary" onClick={() => onSave(draft)}>
					保存
				</button>
			</div>
		</div>
	);
}
