import { useEffect, useState } from "react";
import type {
	SentinelModelEntryView,
	SentinelModelLibraryView,
	SentinelModelRoleName,
	SentinelSupervisorConfig,
	SentinelTestResult,
} from "../types.ts";

/** Which roles can follow 主模型 instead of naming their own entry. */
const FOLLOW_MAIN = "follow-main";

const ROLE_HINTS: Record<SentinelModelRoleName, string> = {
	main: "对话页的主代理；改完下次发送时生效，不打断正在跑的会话",
	judge: "AI 审批逐条判定 bash 命令；改完立即生效",
	reviewer: "提交漏洞后自动校准等级与 CVSS；改完立即生效",
	supervisor: "观察模式每 20 次调用或异常时总结；介入模式只给建议，不阻断工具调用",
};

const ROLE_ORDER: SentinelModelRoleName[] = ["main", "judge", "reviewer", "supervisor"];

const ROLE_LABELS: Record<SentinelModelRoleName, string> = {
	main: "主模型",
	judge: "守门模型",
	reviewer: "漏洞评审",
	supervisor: "监督模型",
};

interface Draft {
	/** Set when editing an existing entry. */
	id?: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/** The operator asked to drop the stored key, turning the endpoint unauthenticated. */
	clearKey: boolean;
}

const EMPTY_DRAFT: Draft = { name: "", baseUrl: "", apiKey: "", modelId: "", clearKey: false };

function draftOf(entry: SentinelModelEntryView): Draft {
	return {
		id: entry.id,
		name: entry.name,
		baseUrl: entry.baseUrl,
		apiKey: "",
		modelId: entry.modelId,
		clearKey: false,
	};
}

/**
 * 设置 → 模型, laid out as 方案 D: the three roles come first, because the
 * operator thinks in jobs ("who judges bash"), and the library below is pure
 * maintenance. An entry can only be deleted when no role points at it; the table
 * says which roles hold it.
 */
export function SettingsPanel({
	library,
	onSaveEntry,
	onRemoveEntry,
	onDuplicateEntry,
	onSetRole,
	onSetReviewerAuto,
	onTestEntry,
	supervisorConfig,
	onSaveSupervisorConfig,
	onTestSupervisor,
}: {
	library: SentinelModelLibraryView | null;
	onSaveEntry: (entry: { id?: string; name: string; baseUrl: string; apiKey: string | null; modelId: string }) => void;
	onRemoveEntry: (id: string) => void;
	onDuplicateEntry: (id: string) => void;
	onSetRole: (role: SentinelModelRoleName, target: string | null) => void;
	onSetReviewerAuto: (enabled: boolean) => void;
	onTestEntry: (id: string) => Promise<SentinelTestResult | null>;
	supervisorConfig: SentinelSupervisorConfig | null;
	onSaveSupervisorConfig: (config: SentinelSupervisorConfig) => void;
	onTestSupervisor: () => Promise<{ result: SentinelTestResult; raw?: string } | null>;
}) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [testing, setTesting] = useState<string | null>(null);
	/** Test results live in this component only: a stored "usable" goes stale. */
	const [results, setResults] = useState<Record<string, SentinelTestResult | null>>({});
	const [supervisorDraft, setSupervisorDraft] = useState<SentinelSupervisorConfig | null>(supervisorConfig);
	const [supervisorDirty, setSupervisorDirty] = useState(false);
	const [supervisorTesting, setSupervisorTesting] = useState(false);
	const [supervisorTest, setSupervisorTest] = useState<SentinelTestResult | null>(null);
	useEffect(() => {
		// Snapshots arrive while a run is active; they must not wipe an unsaved edit.
		if (!supervisorDirty) setSupervisorDraft(supervisorConfig);
	}, [supervisorConfig]);
	const updateSupervisor = (patch: Partial<SentinelSupervisorConfig>): void => {
		setSupervisorDirty(true);
		setSupervisorDraft((current) => (current ? { ...current, ...patch } : current));
	};

	if (!library) {
		return (
			<div className="settings settings--wide">
				<p className="settings-hint">正在读取模型配置…</p>
			</div>
		);
	}

	const runTest = async (id: string) => {
		setTesting(id);
		try {
			const result = await onTestEntry(id);
			setResults((current) => ({ ...current, [id]: result }));
		} finally {
			setTesting(null);
		}
	};

	const submit = () => {
		if (!draft) return;
		// Editing: an untouched key field means "keep what is stored". Adding: an
		// empty key means the endpoint needs no authentication.
		const apiKey = draft.clearKey ? "" : draft.apiKey.trim() ? draft.apiKey.trim() : draft.id ? null : "";
		onSaveEntry({
			...(draft.id ? { id: draft.id } : {}),
			name: draft.name,
			baseUrl: draft.baseUrl,
			apiKey,
			modelId: draft.modelId,
		});
		setDraft(null);
	};

	const valid = draft !== null && draft.baseUrl.trim().length > 0 && draft.modelId.trim().length > 0;

	return (
		<div className="settings settings--wide">
			<h3 className="settings-section">角色</h3>
			<p className="settings-hint">
				每个角色从下面的模型库里挑一条。守门模型、漏洞评审和监督模型可以「跟随主模型」，改主模型时它们一起换。
			</p>
			{ROLE_ORDER.map((role) => {
				const value = library.roles[role] ?? FOLLOW_MAIN;
				const resolved = library.resolved[role];
				return (
					<div className="role-card" key={role}>
						<div className="role-card__info">
							<div className="role-card__name">{ROLE_LABELS[role]}</div>
							<div className="role-card__desc">{ROLE_HINTS[role]}</div>
						</div>
						<div className="role-card__pick">
							<select
								value={value}
								onChange={(event) => {
									const target = event.target.value;
									onSetRole(role, target === FOLLOW_MAIN ? (role === "main" ? null : FOLLOW_MAIN) : target);
								}}
							>
								{role === "main" ? <option value={FOLLOW_MAIN}>未选择</option> : null}
								{library.entries.map((entry) => (
									<option value={entry.id} key={entry.id}>
										{entry.name}
									</option>
								))}
								{role !== "main" ? <option value={FOLLOW_MAIN}>跟随主模型</option> : null}
							</select>
						</div>
						<div className="role-card__effect">
							<div className="role-card__resolved">
								{resolved ? (
									<>
										当前生效：<strong>{resolved.modelId}</strong>
										<span className="hint">
											（{resolved.entryName}
											{resolved.followedMain ? " · 跟随主模型" : ""}）
										</span>
									</>
								) : (
									<span className="warn-text">尚未解析到可用端点</span>
								)}
							</div>
							{role === "reviewer" ? (
								<label className="role-card__auto">
									<input
										type="checkbox"
										checked={library.reviewerAuto}
										onChange={(event) => onSetReviewerAuto(event.target.checked)}
									/>
									自动评审
									<span className="hint">关闭后新记录不再排队，已排队的也会停止</span>
								</label>
							) : null}
						</div>
					</div>
				);
			})}

			<h3 className="settings-section">监督</h3>
			<p className="settings-hint">
				监督是会话级功能：开始对话前在输入框上方点「监督」才会生效。这里只配置全局阈值和批大小，模式和发送方式在对话里选。
			</p>
			{supervisorDraft ? (
				<div className="supervisor-settings">
					<label className="role-card__auto">
						<input
							type="checkbox"
							checked={supervisorDraft.enabled}
							onChange={(event) => updateSupervisor({ enabled: event.target.checked })}
						/>
						允许在对话中开启监督
					</label>
					<div className="supervisor-settings__grid">
						<label>
							每批调用数
							<input
								type="number"
								min={5}
								max={100}
								value={supervisorDraft.batchToolCalls}
								onChange={(event) => updateSupervisor({ batchToolCalls: Number(event.target.value) || 20 })}
							/>
						</label>
						<label>
							重复阈值
							<input
								type="number"
								min={2}
								max={50}
								value={supervisorDraft.duplicateThreshold}
								onChange={(event) =>
									updateSupervisor({ duplicateThreshold: Number(event.target.value) || 3 })
								}
							/>
						</label>
						<label>
							无新证据阈值
							<input
								type="number"
								min={2}
								max={50}
								value={supervisorDraft.noProgressCalls}
								onChange={(event) =>
									updateSupervisor({ noProgressCalls: Number(event.target.value) || 10 })
								}
							/>
						</label>
						<label>
							连续报错阈值
							<input
								type="number"
								min={2}
								max={50}
								value={supervisorDraft.errorStreak}
								onChange={(event) =>
									updateSupervisor({ errorStreak: Number(event.target.value) || 3 })
								}
							/>
						</label>
						<label>
							超时（秒）
							<input
								type="number"
								min={5}
								max={300}
								value={Math.round(supervisorDraft.timeoutMs / 1000)}
								onChange={(event) =>
									updateSupervisor({ timeoutMs: (Number(event.target.value) || 180) * 1000 })
								}
							/>
						</label>
					</div>
					<div className="supervisor-settings__actions">
						<button
							type="button"
							className="primary"
							onClick={() => {
								onSaveSupervisorConfig(supervisorDraft);
								setSupervisorDirty(false);
							}}
						>
							保存监督设置
						</button>
						<button
							type="button"
							disabled={supervisorTesting}
							onClick={async () => {
								setSupervisorTesting(true);
								try {
									const outcome = await onTestSupervisor();
									setSupervisorTest(outcome?.result ?? null);
								} finally {
									setSupervisorTesting(false);
								}
							}}
						>
							{supervisorTesting ? "测试中…" : "测试监督模型"}
						</button>
						{supervisorTest ? (
							<span className={supervisorTest.ok ? "tag tag-ok" : "tag tag-bad"}>
								{supervisorTest.message}
							</span>
						) : null}
					</div>
				</div>
			) : null}

			<div className="settings-block__head">
				<h3 className="settings-section">
					模型库 <span className="hint">（{library.entries.length} 条）</span>
				</h3>
				<button type="button" className="primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
					+ 添加模型
				</button>
			</div>
			{library.entries.length === 0 ? (
				<p className="settings-hint">还没有模型。添加一条后，角色下拉里就能选它。</p>
			) : (
				<div className="model-table-wrap">
					<div className="data-table model-table">
						<div className="data-row data-head">
							<span>名称</span>
							<span>Base URL</span>
							<span>模型 ID</span>
							<span>状态</span>
							<span>用于</span>
							<span className="model-table__actions-head">操作</span>
						</div>
						{library.entries.map((entry) => {
							const result = results[entry.id];
							return (
								<div className="data-row" key={entry.id}>
									<span className="data-name">{entry.name}</span>
									<span className="data-mono" title={entry.baseUrl}>
										{entry.baseUrl}
									</span>
									<span className="data-mono" title={entry.modelId}>
										{entry.modelId}
									</span>
									<span>
										{result ? (
											<span
												className={`tag ${result.ok ? "tag-ok" : "tag-bad"}`}
												title={result.detail ?? ""}
											>
												{result.ok ? "可用" : "失败"}
											</span>
										) : (
											<span className="tag tag-info">未测试</span>
										)}
									</span>
									<span className="data-roles">
										{entry.roles.length === 0 ? (
											<span className="hint">未使用</span>
										) : (
											entry.roles.map((role) => (
												<span className="tag tag-accent" key={role}>
													{ROLE_LABELS[role]}
												</span>
											))
										)}
									</span>
									<span className="data-actions">
										<button
											type="button"
											disabled={testing === entry.id}
											onClick={() => void runTest(entry.id)}
										>
											{testing === entry.id ? "测试中…" : "测试"}
										</button>
										<button type="button" onClick={() => setDraft(draftOf(entry))}>
											编辑
										</button>
										<button type="button" onClick={() => onDuplicateEntry(entry.id)}>
											复制
										</button>
										<button
											type="button"
											title={entry.roles.length > 0 ? "先把这个模型从角色里换掉再删除" : "删除"}
											onClick={() => onRemoveEntry(entry.id)}
										>
											删除
										</button>
									</span>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{draft ? (
				<div className="model-editor">
					<h3 className="settings-section">{draft.id ? "编辑模型" : "添加模型"}</h3>
					<div className="model-editor__grid">
						<label>
							名称
							<input
								value={draft.name}
								onChange={(event) => setDraft({ ...draft, name: event.target.value })}
								placeholder="留空则用模型 ID"
								spellCheck={false}
							/>
						</label>
						<label>
							Base URL
							<input
								value={draft.baseUrl}
								onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
								placeholder="http://127.0.0.1:8000/v1"
								spellCheck={false}
							/>
						</label>
						<label>
							模型 ID
							<input
								value={draft.modelId}
								onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
								placeholder="deepseek-chat / glm-4.7 / qwen3-coder…"
								spellCheck={false}
							/>
						</label>
						<label>
							API Key
							<input
								value={draft.apiKey}
								onChange={(event) => setDraft({ ...draft, apiKey: event.target.value, clearKey: false })}
								placeholder={draft.id ? "留空表示不修改已保存的密钥" : "无鉴权端点留空"}
								type="password"
								spellCheck={false}
							/>
						</label>
					</div>
					{draft.id ? (
						<label className="role-card__auto">
							<input
								type="checkbox"
								checked={draft.clearKey}
								onChange={(event) => setDraft({ ...draft, clearKey: event.target.checked, apiKey: "" })}
							/>
							清除已保存的密钥（改成无鉴权端点）
						</label>
					) : null}
					<div className="model-editor__actions">
						<button type="button" className="primary" disabled={!valid} onClick={submit}>
							保存
						</button>
						<button type="button" onClick={() => setDraft(null)}>
							取消
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}
