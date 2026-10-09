import { useMemo, useState } from "react";
import type { ZGNotifyConfig, ZGNotifyStatus, ZGTestResult } from "../types.ts";

function formatWhen(at: number | null): string {
	if (at === null) return "尚未发送过通知";
	return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

/** The "notifications" section of the settings page: DingTalk group robot. */
export function NotifyPanel({
	config,
	status,
	onSave,
	onTest,
}: {
	config: ZGNotifyConfig;
	status: ZGNotifyStatus;
	onSave: (config: ZGNotifyConfig) => void;
	onTest: (config: ZGNotifyConfig) => Promise<ZGTestResult | null>;
}) {
	const [enabled, setEnabled] = useState(config.enabled);
	const [webhook, setWebhook] = useState(config.webhook);
	const [secret, setSecret] = useState(config.secret);
	const [keyword, setKeyword] = useState(config.keyword);
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<ZGTestResult | null>(null);

	const draft = useMemo(
		() => ({ enabled, webhook: webhook.trim(), secret: secret.trim(), keyword: keyword.trim() }),
		[enabled, webhook, secret, keyword],
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
				任务完成后向钉钉群机器人推送一条 markdown 消息。在钉钉群「群设置 → 智能群助手 → 添加机器人 → 自定义」里拿到 webhook
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
					placeholder="ZGAgent"
					spellCheck={false}
				/>
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
