import { useEffect, useState } from "react";
import type {
	SentinelModelLibraryView,
	SentinelSupervisorConfig,
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorStrategy,
	SentinelSupervisorStrategyRef,
	SentinelTestResult,
} from "../types.ts";
import { SUPERVISOR_STRATEGY_OPTIONS, supervisorStrategyKey } from "../supervisor-strategy.ts";
import { ModelRolePicker } from "./ModelRolePicker.tsx";
import { capabilityChips, hostOf } from "./model-ui.tsx";

interface CustomStrategyDraft {
	id?: string;
	name: string;
	base: SentinelSupervisorStrategy;
	description: string;
	instructions: string;
}

/**
 * 设置 → 监督: strategy and thresholds are separate from the model library, so
 * they no longer sit under the model page. The supervisor endpoint is still a
 * normal library entry and is swapped through the same picker.
 */
export function SupervisorSettingsPanel({
	supervisorConfig,
	library,
	onSaveSupervisorConfig,
	onTestSupervisor,
	onSetRole,
}: {
	supervisorConfig: SentinelSupervisorConfig;
	library: SentinelModelLibraryView | null;
	onSaveSupervisorConfig: (config: SentinelSupervisorConfig) => void;
	onTestSupervisor: () => Promise<{ result: SentinelTestResult; raw?: string } | null>;
	onSetRole: (role: "supervisor", target: string | null) => void;
}) {
	const [supervisorDraft, setSupervisorDraft] = useState<SentinelSupervisorConfig>(supervisorConfig);
	const [supervisorDirty, setSupervisorDirty] = useState(false);
	const [supervisorTesting, setSupervisorTesting] = useState(false);
	const [supervisorTest, setSupervisorTest] = useState<SentinelTestResult | null>(null);
	const [customStrategyDraft, setCustomStrategyDraft] = useState<CustomStrategyDraft | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	useEffect(() => {
		// Snapshots arrive while a run is active; they must not wipe an unsaved edit.
		if (!supervisorDirty) setSupervisorDraft(supervisorConfig);
	}, [supervisorConfig, supervisorDirty]);

	const updateSupervisor = (patch: Partial<SentinelSupervisorConfig>): void => {
		setSupervisorDirty(true);
		setSupervisorDraft((current) => ({ ...current, ...patch }));
	};

	const customStrategies = supervisorDraft.customStrategies;
	const defaultStrategies: SentinelSupervisorStrategyRef[] =
		supervisorDraft.defaultStrategies && supervisorDraft.defaultStrategies.length > 0
			? supervisorDraft.defaultStrategies
			: [
					{
						strategy: supervisorDraft.defaultStrategy,
						customStrategyId: supervisorDraft.defaultCustomStrategyId,
					},
				];
	const setDefaultStrategies = (next: SentinelSupervisorStrategyRef[]): void => {
		const primary = next[0];
		if (!primary) return;
		updateSupervisor({
			defaultStrategies: next,
			defaultStrategy: primary.strategy,
			defaultCustomStrategyId: primary.customStrategyId,
		});
	};
	const toggleDefaultStrategy = (ref: SentinelSupervisorStrategyRef): void => {
		const key = supervisorStrategyKey(ref);
		const exists = defaultStrategies.some((entry) => supervisorStrategyKey(entry) === key);
		if (exists) {
			if (defaultStrategies.length <= 1) return;
			setDefaultStrategies(defaultStrategies.filter((entry) => supervisorStrategyKey(entry) !== key));
			return;
		}
		setDefaultStrategies([...defaultStrategies, ref]);
	};

	const commitCustomStrategy = (): void => {
		if (!customStrategyDraft) return;
		const name = customStrategyDraft.name.trim().slice(0, 30);
		const instructions = customStrategyDraft.instructions.trim().slice(0, 500);
		if (!name || !instructions) return;
		const now = Date.now();
		const id = customStrategyDraft.id ?? `custom-${globalThis.crypto?.randomUUID?.() ?? now}`;
		const next: SentinelSupervisorCustomStrategy = {
			id,
			name,
			base: customStrategyDraft.base,
			description: customStrategyDraft.description.trim().slice(0, 80) || name,
			instructions,
			createdAt: customStrategies.find((entry) => entry.id === id)?.createdAt ?? now,
			updatedAt: now,
		};
		const list = customStrategies.some((entry) => entry.id === id)
			? customStrategies.map((entry) => (entry.id === id ? next : entry))
			: [...customStrategies, next];
		const nextDefaults = defaultStrategies.map((entry) =>
			entry.customStrategyId === id ? { strategy: next.base, customStrategyId: id } : entry,
		);
		updateSupervisor({
			customStrategies: list,
			defaultStrategies: nextDefaults,
			defaultStrategy: nextDefaults[0]?.strategy ?? next.base,
			defaultCustomStrategyId: nextDefaults[0]?.customStrategyId ?? null,
		});
		setCustomStrategyDraft(null);
	};

	const removeCustomStrategy = (id: string): void => {
		const nextDefaults = defaultStrategies.filter((entry) => entry.customStrategyId !== id);
		const safeDefaults =
			nextDefaults.length > 0 ? nextDefaults : [{ strategy: "steady" as const, customStrategyId: null }];
		updateSupervisor({
			customStrategies: customStrategies.filter((entry) => entry.id !== id),
			defaultStrategies: safeDefaults,
			defaultStrategy: safeDefaults[0]?.strategy ?? "steady",
			defaultCustomStrategyId: safeDefaults[0]?.customStrategyId ?? null,
		});
		if (customStrategyDraft?.id === id) setCustomStrategyDraft(null);
	};

	const resolved = library?.resolved.supervisor ?? null;
	const entry = library?.entries.find((candidate) => candidate.id === resolved?.entryId) ?? null;

	return (
		<div className="settings settings--wide cockpit">
			<div className="cockpit-sec cockpit-sec--first">
				<h3>监督模型</h3>
				<span className="cockpit-sec__meta">观察模式总结与介入判断使用的端点</span>
			</div>
			<div className="cockpit-sup">
				<div className="cockpit-sup__main">
					<div className="cockpit-sup__name">
						{entry?.name ?? "未选择监督模型"}
						{resolved?.followedMain ? <span className="cockpit-tag is-accent">跟随主模型</span> : null}
					</div>
					<div className="cockpit-sup__sub">
						{entry ? `${entry.modelId} · ${hostOf(entry.baseUrl)}` : "尚未解析到可用端点"}
					</div>
					<div className="cockpit-chips">
						{entry ? (
							capabilityChips(entry).map((chip) => (
								<span className="cockpit-chip" key={chip}>
									{chip}
								</span>
							))
						) : null}
					</div>
				</div>
				<button type="button" className="cockpit-mini-btn" onClick={() => setPickerOpen(true)}>
					更换模型
				</button>
			</div>
			<p className="cockpit-hint">
				建议使用低成本的独立模型，避免和监督对象共用同一端点。监督模型在「设置 → 模型」的模型库里维护。
			</p>

			<div className="cockpit-sec">
				<h3>监督策略</h3>
				<span className="cockpit-sec__meta">全局阈值与新会话的默认值</span>
			</div>
			<p className="settings-hint">
				监督是会话级功能：开始对话前在输入框上方点「监督」才会生效。这里配置全局阈值、批大小、新会话的默认策略（可多选）和自定义策略；模式、策略和补充说明在对话里选。
			</p>
			<div className="supervisor-settings">
				<label className="cockpit-check">
					<input
						type="checkbox"
						checked={supervisorDraft.enabled}
						onChange={(event) => updateSupervisor({ enabled: event.target.checked })}
					/>
					<span>允许在对话中开启监督</span>
				</label>
				<div className="supervisor-settings__strategy">
					<div className="supervisor-settings__strategy-head">
						<span>默认监督策略</span>
						<span>可多选 · {defaultStrategies.length} 个</span>
					</div>
					<div className="supervisor-strategy-grid">
						{SUPERVISOR_STRATEGY_OPTIONS.map((option) => {
							const ref: SentinelSupervisorStrategyRef = {
								strategy: option.id,
								customStrategyId: null,
							};
							const selected = defaultStrategies.some(
								(entry) => supervisorStrategyKey(entry) === supervisorStrategyKey(ref),
							);
							return (
								<label
									className={`supervisor-strategy-option ${selected ? "on" : ""}`}
									key={option.id}
								>
									<input
										type="checkbox"
										checked={selected}
										onChange={() => toggleDefaultStrategy(ref)}
									/>
									<span>
										<b>{option.label}</b>
										<small>{option.hint}</small>
									</span>
								</label>
							);
						})}
						{customStrategies.map((custom) => {
							const ref: SentinelSupervisorStrategyRef = {
								strategy: custom.base,
								customStrategyId: custom.id,
							};
							const selected = defaultStrategies.some(
								(entry) => supervisorStrategyKey(entry) === supervisorStrategyKey(ref),
							);
							return (
								<label
									className={`supervisor-strategy-option ${selected ? "on" : ""}`}
									key={custom.id}
								>
									<input
										type="checkbox"
										checked={selected}
										onChange={() => toggleDefaultStrategy(ref)}
									/>
									<span>
										<b>{custom.name}</b>
										<small>{custom.description}</small>
									</span>
								</label>
							);
						})}
					</div>
					<span className="hint">
						可同时选择多个策略，开启监督时会合并生效；至少保留一个。这里只决定新会话的默认值，对话里仍可调整。
					</span>
				</div>
				<div className="supervisor-custom">
					<div className="supervisor-custom__head">
						<div>
							<strong>自定义策略</strong>
							<span>{customStrategies.length} / 12</span>
						</div>
						<button
							type="button"
							onClick={() =>
								setCustomStrategyDraft({ name: "", base: "steady", description: "", instructions: "" })
							}
							disabled={customStrategies.length >= 12 || customStrategyDraft !== null}
						>
							+ 新建
						</button>
					</div>
					{customStrategies.length === 0 && !customStrategyDraft ? (
						<p className="supervisor-custom__empty">还没有自定义策略。可以基于五种预设，追加自己的关注点。</p>
					) : null}
					{customStrategies.map((custom) => (
						<div className="supervisor-custom__row" key={custom.id}>
							<div>
								<strong>{custom.name}</strong>
								<span>
									{SUPERVISOR_STRATEGY_OPTIONS.find((option) => option.id === custom.base)?.label ??
										custom.base}{" "}
									· {custom.description}
								</span>
							</div>
							<div className="supervisor-custom__actions">
								<button
									type="button"
									onClick={() =>
										setCustomStrategyDraft({
											id: custom.id,
											name: custom.name,
											base: custom.base,
											description: custom.description,
											instructions: custom.instructions,
										})
									}
								>
									编辑
								</button>
								<button type="button" className="danger" onClick={() => removeCustomStrategy(custom.id)}>
									删除
								</button>
							</div>
						</div>
					))}
					{customStrategyDraft ? (
						<div className="supervisor-custom__editor">
							<div className="supervisor-custom__editor-title">
								{customStrategyDraft.id ? "编辑自定义策略" : "新建自定义策略"}
							</div>
							<label>
								名称
								<input
									value={customStrategyDraft.name}
									maxLength={30}
									onChange={(event) =>
										setCustomStrategyDraft({ ...customStrategyDraft, name: event.target.value })
									}
									placeholder="例如：支付网关专用"
								/>
							</label>
							<label>
								基础预设
								<select
									value={customStrategyDraft.base}
									onChange={(event) =>
										setCustomStrategyDraft({
											...customStrategyDraft,
											base: event.target.value as SentinelSupervisorStrategy,
										})
									}
								>
									{SUPERVISOR_STRATEGY_OPTIONS.map((option) => (
										<option value={option.id} key={option.id}>
											{option.label}
										</option>
									))}
								</select>
							</label>
							<label>
								一句话说明
								<input
									value={customStrategyDraft.description}
									maxLength={80}
									onChange={(event) =>
										setCustomStrategyDraft({
											...customStrategyDraft,
											description: event.target.value,
										})
									}
									placeholder="例如：先看授权边界，再验证越权"
								/>
							</label>
							<label>
								关注点与建议风格
								<textarea
									value={customStrategyDraft.instructions}
									maxLength={500}
									onChange={(event) =>
										setCustomStrategyDraft({
											...customStrategyDraft,
											instructions: event.target.value,
										})
									}
									placeholder="例如：优先验证 IDOR；不做目录爆破；建议必须给出对照请求。"
								/>
							</label>
							<p className="hint">自定义说明只改变监督关注点和建议风格，不能放宽授权范围或安全规则。</p>
							<div className="supervisor-custom__editor-actions">
								<button type="button" onClick={() => setCustomStrategyDraft(null)}>
									取消
								</button>
								<button
									type="button"
									className="primary"
									disabled={!customStrategyDraft.name.trim() || !customStrategyDraft.instructions.trim()}
									onClick={commitCustomStrategy}
								>
									保存到列表
								</button>
							</div>
						</div>
					) : null}
					<p className="hint">先保存到列表，再点下方「保存监督设置」写入配置。</p>
				</div>
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
							onChange={(event) => updateSupervisor({ noProgressCalls: Number(event.target.value) || 10 })}
						/>
					</label>
					<label>
						连续报错阈值
						<input
							type="number"
							min={2}
							max={50}
							value={supervisorDraft.errorStreak}
							onChange={(event) => updateSupervisor({ errorStreak: Number(event.target.value) || 3 })}
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

			{pickerOpen && library ? (
				<ModelRolePicker
					library={library}
					role="supervisor"
					results={{}}
					onApply={(target) => {
						onSetRole("supervisor", target);
						setPickerOpen(false);
					}}
					onClose={() => setPickerOpen(false)}
				/>
			) : null}
		</div>
	);
}
