import { useMemo, useState } from "react";
import type { ZGModelConfig, ZGTestResult } from "../types.ts";

/** The "settings" panel tab: endpoint configuration with test connection. */
export function SettingsPanel({
	config,
	onSave,
	onTest,
}: {
	config: ZGModelConfig | null;
	onSave: (config: ZGModelConfig) => void;
	onTest: (config: ZGModelConfig) => Promise<ZGTestResult | null>;
}) {
	const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState(config?.apiKey ?? "");
	const [modelId, setModelId] = useState(config?.modelId ?? "");
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<ZGTestResult | null>(null);

	const draft = useMemo(
		() => ({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), modelId: modelId.trim() }),
		[baseUrl, apiKey, modelId],
	);
	const valid = draft.baseUrl.length > 0 && draft.modelId.length > 0;

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
				配置 OpenAI 兼容端点（vLLM、one-api、new-api 等均可）。先「测试连接」验证再保存；本地无鉴权端点请留空 API Key。
			</p>
			<label>
				Base URL
				<input
					value={baseUrl}
					onChange={(event) => setBaseUrl(event.target.value)}
					placeholder="http://127.0.0.1:8000/v1"
					spellCheck={false}
				/>
			</label>
			<label>
				API Key（无鉴权端点留空）
				<input
					value={apiKey}
					onChange={(event) => setApiKey(event.target.value)}
					placeholder="sk-…"
					type="password"
					spellCheck={false}
				/>
			</label>
			<label>
				模型 ID
				<input
					value={modelId}
					onChange={(event) => setModelId(event.target.value)}
					placeholder="deepseek-v3.1 / glm-4.7 / qwen3-coder…"
					spellCheck={false}
				/>
			</label>
			{result ? (
				<div className={`test-result ${result.ok ? "ok" : "bad"}`}>
					<div>{result.message}</div>
					{result.detail ? <pre>{result.detail}</pre> : null}
				</div>
			) : null}
			<div style={{ display: "flex", gap: 8 }}>
				<button type="button" disabled={!valid || testing} onClick={runTest}>
					{testing ? "测试中…" : "测试连接"}
				</button>
				<button type="button" className="primary" disabled={!valid} onClick={() => onSave(draft)}>
					保存并重载
				</button>
			</div>
		</div>
	);
}
