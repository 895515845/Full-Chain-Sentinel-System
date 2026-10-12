/**
 * 设置 → 模型 的守门段落。
 *
 * The judge endpoint itself is chosen in the 角色 block above (it is just a model
 * library entry); this panel owns what only the gatekeeper needs — the global
 * default mode, the judgment timeout, and the concurrency cap — plus a way to
 * prove the resolved endpoint actually answers.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ZGGatekeeperConfig, ZGMode, ZGResolvedModelView, ZGTestResult } from "../types.ts";
import { ZG_MODES, ZG_MODE_LABELS } from "../types.ts";

/** The gatekeeper's own settings, saved with one button. */
export function GatekeeperPanel({
	gatekeeperConfig,
	judgeResolved,
	onSave,
	onTestJudge,
}: {
	gatekeeperConfig: ZGGatekeeperConfig;
	/** What the 守门模型 role resolves to right now. */
	judgeResolved: ZGResolvedModelView | null;
	onSave: (settings: ZGGatekeeperConfig) => void;
	onTestJudge: () => Promise<{ result: ZGTestResult; raw?: string } | null>;
}) {
	const [globalMode, setGlobalMode] = useState<ZGMode>(gatekeeperConfig.mode);
	const [timeoutMs, setTimeoutMs] = useState(String(gatekeeperConfig.timeoutMs));
	const [concurrency, setConcurrency] = useState(String(gatekeeperConfig.concurrency));
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<ZGTestResult | null>(null);
	const [raw, setRaw] = useState<string | undefined>(undefined);

	// The reply to `get_gatekeeper_config` can arrive after this panel mounted.
	// Re-sync only when the stored config actually changed, so a save round-trip
	// cannot wipe what the operator is still typing.
	const appliedSettings = useRef(JSON.stringify(gatekeeperConfig));
	useEffect(() => {
		const incoming = JSON.stringify(gatekeeperConfig);
		if (incoming === appliedSettings.current) return;
		appliedSettings.current = incoming;
		setGlobalMode(gatekeeperConfig.mode);
		setTimeoutMs(String(gatekeeperConfig.timeoutMs));
		setConcurrency(String(gatekeeperConfig.concurrency));
	}, [gatekeeperConfig]);

	const settingsDraft = useMemo<ZGGatekeeperConfig>(
		() => ({
			mode: globalMode,
			timeoutMs: Math.max(1000, Math.floor(Number(timeoutMs) || 0)),
			concurrency: Math.max(0, Math.floor(Number(concurrency) || 0)),
		}),
		[globalMode, timeoutMs, concurrency],
	);

	const runTest = async () => {
		setTesting(true);
		setResult(null);
		setRaw(undefined);
		try {
			const outcome = await onTestJudge();
			setResult(outcome?.result ?? null);
			setRaw(outcome?.raw);
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className="settings">
			<h3 className="settings-section">守门设置（AI 审批）</h3>
			<p className="settings-hint">
				AI 审批模式下每条命令都先交给「守门模型」判定：返回 <code>ALLOW</code> 才执行，返回{" "}
				<code>BLOCK: 理由</code> 则拒绝并把理由回给 Agent。判定失败（超时、报错、返回无法解析）一律放行，
				并在审计页记为「请求失败」。端点在上面「角色 → 守门模型」里选。
			</p>
			<div className="test-result">
				<div>
					当前生效端点：
					{judgeResolved
						? `${judgeResolved.entryName} · ${judgeResolved.modelId}${judgeResolved.followedMain ? "（跟随主模型）" : ""}`
						: "无（切到 AI 审批会被拒绝）"}
				</div>
			</div>
			{result ? (
				<div className={`test-result ${result.ok ? "ok" : "bad"}`}>
					<div>{result.message}</div>
					{result.detail ? <pre>{result.detail}</pre> : null}
					{raw ? <pre>{raw}</pre> : null}
				</div>
			) : null}
			<div style={{ display: "flex", gap: 8 }}>
				<button type="button" disabled={judgeResolved === null || testing} onClick={runTest}>
					{testing ? "判定中…" : "测试判定"}
				</button>
			</div>

			<p className="settings-hint">
				下面的模式是全局默认：新建会话跟随它，已有会话可在对话工具栏单独设定或点「跟随全局」回到默认。
			</p>
			<div className="mode-switch" style={{ marginBottom: 12 }}>
				{ZG_MODES.map((item) => (
					<button key={item} type="button" className={globalMode === item ? "on" : ""} onClick={() => setGlobalMode(item)}>
						{ZG_MODE_LABELS[item]}
					</button>
				))}
			</div>
			<label>
				判定超时（毫秒）
				<input
					value={timeoutMs}
					inputMode="numeric"
					onChange={(event) => setTimeoutMs(event.target.value.replace(/[^\d]/g, ""))}
					placeholder="15000"
					spellCheck={false}
				/>
				<span className="field-sub">超时即放行并记为「请求失败」。范围 1000–120000。</span>
			</label>
			<label>
				并发上限
				<input
					value={concurrency}
					inputMode="numeric"
					onChange={(event) => setConcurrency(event.target.value.replace(/[^\d]/g, ""))}
					placeholder="0"
					spellCheck={false}
				/>
				<span className="field-sub">
					同时进行中的判定数量，0 = 不限制（子代理并行侦察时用得上）。上限 64。
				</span>
			</label>
			<div style={{ display: "flex", gap: 8 }}>
				<button type="button" className="primary" onClick={() => onSave(settingsDraft)}>
					保存守门配置
				</button>
			</div>
		</div>
	);
}
