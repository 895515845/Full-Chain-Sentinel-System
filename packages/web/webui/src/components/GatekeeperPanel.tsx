/**
 * 设置 → 模型 的守门段落。
 *
 * The judge endpoint itself is chosen in the 角色 block above (it is just a model
 * library entry); this panel owns what only the gatekeeper needs — the global
 * default mode, the judgment timeout, and the concurrency cap — plus a way to
 * prove the resolved endpoint actually answers.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type {
	SentinelGatekeeperConfig,
	SentinelMcpToolGate,
	SentinelMode,
	SentinelResolvedModelView,
	SentinelTestResult,
} from "../types.ts";
import { SENTINEL_MODE_LABELS, SENTINEL_MODES } from "../types.ts";

/**
 * What an unread config means. A console that predates the switches (or a reply
 * that arrives without them) must not take the page down: the whole settings
 * screen is one render tree and there is no error boundary above it.
 */
const DEFAULT_MCP_TOOLS: SentinelMcpToolGate = { enabled: true, includePlugins: false };

/** The gatekeeper's own settings, saved with one button. */
export function GatekeeperPanel({
	gatekeeperConfig,
	judgeResolved,
	onSave,
	onTestJudge,
}: {
	gatekeeperConfig: SentinelGatekeeperConfig;
	/** What the 守门模型 role resolves to right now. */
	judgeResolved: SentinelResolvedModelView | null;
	onSave: (settings: SentinelGatekeeperConfig) => void;
	onTestJudge: () => Promise<{ result: SentinelTestResult; raw?: string } | null>;
}) {
	const [globalMode, setGlobalMode] = useState<SentinelMode>(gatekeeperConfig.mode);
	const [timeoutMs, setTimeoutMs] = useState(String(gatekeeperConfig.timeoutMs));
	const [concurrency, setConcurrency] = useState(String(gatekeeperConfig.concurrency));
	const [mcpTools, setMcpTools] = useState<SentinelMcpToolGate>(gatekeeperConfig.mcpTools ?? DEFAULT_MCP_TOOLS);
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<SentinelTestResult | null>(null);
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
		setMcpTools(gatekeeperConfig.mcpTools ?? DEFAULT_MCP_TOOLS);
	}, [gatekeeperConfig]);

	const settingsDraft = useMemo<SentinelGatekeeperConfig>(
		() => ({
			mode: globalMode,
			timeoutMs: Math.max(1000, Math.floor(Number(timeoutMs) || 0)),
			concurrency: Math.max(0, Math.floor(Number(concurrency) || 0)),
			mcpTools,
		}),
		[globalMode, timeoutMs, concurrency, mcpTools],
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
		<div className="settings settings--wide cockpit gatekeeper">
			<div className="cockpit-sec">
				<h3>守门设置（AI 审批）</h3>
				<span className="cockpit-sec__meta">全局默认 · 判定端点取「守门模型」</span>
			</div>
			<p className="gate-prose">
				AI 审批模式下每条命令都先交给「守门模型」判定：返回 <code>ALLOW</code> 才执行，返回{" "}
				<code>BLOCK: 理由</code>{" "}
				则拒绝并把理由回给 Agent。判定失败（超时、报错、返回无法解析）一律放行，并在审计页记为「请求失败」。
				端点在上面「角色 → 守门模型」里选。
			</p>

			<div className="gate-card">
				<div className="gate-row gate-endpoint">
					<span className="gate-row__label">当前生效端点</span>
					{judgeResolved ? (
						<span className="gate-endpoint__value">
							{judgeResolved.entryName} · <strong>{judgeResolved.modelId}</strong>
							{judgeResolved.followedMain ? <span className="gate-row__tag">跟随主模型</span> : null}
						</span>
					) : (
						<span className="gate-endpoint__value is-missing">无（切到 AI 审批会被拒绝）</span>
					)}
					<button
						type="button"
						className="cockpit-mini-btn"
						disabled={judgeResolved === null || testing}
						onClick={runTest}
					>
						{testing ? "判定中…" : "测试判定"}
					</button>
				</div>
				<div className="gate-row gate-mode">
					<span className="gate-row__label">全局默认模式</span>
					<div className="mode-switch gate-mode-switch">
						{SENTINEL_MODES.map((item) => (
							<button
								key={item}
								type="button"
								className={globalMode === item ? "on" : ""}
								onClick={() => setGlobalMode(item)}
							>
								{SENTINEL_MODE_LABELS[item]}
							</button>
						))}
					</div>
					<span className="gate-row__hint">
						新建会话跟随它；已有会话可在对话工具栏单独设定或点「跟随全局」回到默认。
					</span>
				</div>
				<label className="gate-row">
					<span className="gate-row__label">判定超时（毫秒）</span>
					<input
						className="gate-input"
						value={timeoutMs}
						inputMode="numeric"
						onChange={(event) => setTimeoutMs(event.target.value.replace(/[^\d]/g, ""))}
						placeholder="15000"
						spellCheck={false}
					/>
					<span className="gate-row__hint">超时即放行并记为「请求失败」。范围 1000–120000。</span>
				</label>
				<label className="gate-row">
					<span className="gate-row__label">并发上限</span>
					<input
						className="gate-input"
						value={concurrency}
						inputMode="numeric"
						onChange={(event) => setConcurrency(event.target.value.replace(/[^\d]/g, ""))}
						placeholder="0"
						spellCheck={false}
					/>
					<span className="gate-row__hint">
						同时进行中的判定数量，0 = 不限制（子代理并行侦察时用得上）。上限 64。
					</span>
				</label>
			</div>

			{result ? (
				<div className={`test-result gate-test-result ${result.ok ? "ok" : "bad"}`}>
					<div>{result.message}</div>
					{result.detail ? <pre>{result.detail}</pre> : null}
					{raw ? <pre>{raw}</pre> : null}
				</div>
			) : null}

			<div className="cockpit-sec">
				<h3>MCP 工具判定</h3>
			</div>
			<p className="gate-prose">
				bash 命令在任何模式下都由上面的模式决定；这一段管的是另外一类调用：MCP 与插件工具。
				打开后，AI 审批模式下每一次这类调用也会先交给守门模型，被拦时把理由回给 Agent。
				<b>每次调用都要多花一次模型往返</b>，高频只读工具（列目录、查资产）会明显变慢。
			</p>
			<div className="gate-card">
				<label className="gate-option">
					<input
						type="checkbox"
						checked={mcpTools.enabled}
						onChange={(event) => setMcpTools((prev) => ({ ...prev, enabled: event.target.checked }))}
					/>
					<span className="gate-option__text">
						<span className="gate-option__title">同时判定 MCP 工具</span>
						<span className="gate-option__hint">
							关闭后守门模型只看 bash 命令，插件与 MCP 工具不再经过判定
						</span>
					</span>
				</label>
				<label className={`gate-option${mcpTools.enabled ? "" : " is-off"}`}>
					<input
						type="checkbox"
						checked={mcpTools.includePlugins}
						disabled={!mcpTools.enabled}
						onChange={(event) => setMcpTools((prev) => ({ ...prev, includePlugins: event.target.checked }))}
					/>
					<span className="gate-option__text">
						<span className="gate-option__title">包含插件工具</span>
						<span className="gate-option__hint">
							插件工具（server 名以 <code>plugin-</code> 开头）能操作受管主机，最值得判；一个插件常有几十个工具，
							也最吵。默认不纳入
						</span>
					</span>
				</label>
			</div>

			<div className="gate-actions">
				<button type="button" className="primary" onClick={() => onSave(settingsDraft)}>
					保存守门配置
				</button>
			</div>
		</div>
	);
}
