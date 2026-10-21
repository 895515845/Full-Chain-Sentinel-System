/**
 * The supervisor arming menu. It deliberately uses the preset-menu shell and
 * portal/fixed anchoring: the composer lives inside clipped scroll panels, so an
 * absolutely positioned menu can be cut off at the panel edge.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n.ts";
import { SUPERVISOR_STRATEGY_OPTIONS } from "../supervisor-strategy.ts";
import type {
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorMode,
	SentinelSupervisorStrategyRef,
} from "../types.ts";
import type { PresetMenuAnchor } from "./PresetMenu.tsx";

export type SupervisorLaunchMode = "observe" | "auto" | "confirm";

const MODES: Array<{ value: SupervisorLaunchMode; label: string; description: string }> = [
	{ value: "observe", label: t("观察"), description: t("只记录和总结，不改主 Agent") },
	{ value: "auto", label: t("自动发送"), description: t("判断停滞或循环时直接给建议") },
	{ value: "confirm", label: t("确认后发送"), description: t("建议先到悬浮窗，由你决定是否发送") },
];

export function SupervisorStartMenu({
	anchor,
	mode,
	strategies,
	customStrategies,
	note,
	onModeChange,
	onToggleStrategy,
	onNoteChange,
	onStart,
	onClose,
}: {
	anchor: PresetMenuAnchor;
	mode: SupervisorLaunchMode;
	strategies: SentinelSupervisorStrategyRef[];
	customStrategies: SentinelSupervisorCustomStrategy[];
	note: string;
	onModeChange: (mode: SupervisorLaunchMode) => void;
	onToggleStrategy: (ref: SentinelSupervisorStrategyRef) => void;
	onNoteChange: (note: string) => void;
	onStart: () => void;
	onClose: () => void;
}) {
	const onCloseRef = useRef(onClose);
	useEffect(() => {
		onCloseRef.current = onClose;
	});
	useEffect(() => {
		const mountedAt = performance.now();
		const close = (event: MouseEvent) => {
			if (event.timeStamp <= mountedAt) return;
			onCloseRef.current();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCloseRef.current();
		};
		window.addEventListener("click", close);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, []);

	const isSelected = (ref: SentinelSupervisorStrategyRef): boolean =>
		strategies.some((entry) =>
			ref.customStrategyId
				? entry.customStrategyId === ref.customStrategyId
				: !entry.customStrategyId && entry.strategy === ref.strategy,
		);
	const selected = strategies.map((ref) => {
		const custom = ref.customStrategyId
			? customStrategies.find((entry) => entry.id === ref.customStrategyId)
			: undefined;
		const option = SUPERVISOR_STRATEGY_OPTIONS.find((entry) => entry.id === ref.strategy);
		return {
			key: ref.customStrategyId ? `custom:${ref.customStrategyId}` : `preset:${ref.strategy}`,
			name: custom?.name ?? option?.label ?? t("监督策略"),
			description: custom?.description ?? option?.hint ?? "",
			instructions: custom?.instructions ?? "",
		};
	});
	const title =
		selected.length > 1
			? t("{count} 个监督策略", { count: selected.length })
			: (selected[0]?.name ?? t("监督策略"));
	const description =
		selected.length > 1
			? t("多个策略会合并到同一份监督判断中；冲突时以安全规则和补充说明为准。")
			: (selected[0]?.description ?? "");
	const selectedMode = MODES.find((entry) => entry.value === mode) ?? MODES[0];

	return createPortal(
		<div
			className="preset-menu composer-supervisor-menu"
			style={{
				top: anchor.top,
				bottom: anchor.bottom,
				left: anchor.left,
				maxHeight: anchor.maxHeight,
			}}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="preset-menu-title composer-supervisor-title">
				{t("开启监督")}
				<span>{t("方式 · 策略 · 说明")}</span>
			</div>
			<div className="composer-supervisor-modes">
				{MODES.map((entry) => (
					<button
						type="button"
						key={entry.value}
						className={mode === entry.value ? "on" : ""}
						onClick={() => onModeChange(entry.value)}
					>
						{entry.label}
					</button>
				))}
			</div>
			<div className="composer-supervisor-mode-hint">{selectedMode?.description}</div>
			<div className="composer-supervisor-panel">
				<div className="composer-supervisor-nav">
					{SUPERVISOR_STRATEGY_OPTIONS.map((option) => {
						const ref: SentinelSupervisorStrategyRef = {
							strategy: option.id,
							customStrategyId: null,
						};
						return (
							<button
								type="button"
								key={option.id}
								className={isSelected(ref) ? "on" : ""}
								aria-pressed={isSelected(ref)}
								onClick={() => onToggleStrategy(ref)}
							>
								{option.label}
							</button>
						);
					})}
					{customStrategies.length > 0 ? (
						<div className="composer-supervisor-nav-label">{t("自定义")}</div>
					) : null}
					{customStrategies.map((custom) => {
						const ref: SentinelSupervisorStrategyRef = {
							strategy: custom.base,
							customStrategyId: custom.id,
						};
						return (
							<button
								type="button"
								key={custom.id}
								className={isSelected(ref) ? "on" : ""}
								aria-pressed={isSelected(ref)}
								onClick={() => onToggleStrategy(ref)}
							>
								{custom.name}
							</button>
						);
					})}
				</div>
				<div className="composer-supervisor-detail">
					<h3>{title}</h3>
					<p>{description}</p>
					{selected.length > 1 ? (
						<div className="composer-supervisor-selected">
							{selected.map((entry) => (
								<span key={entry.key} title={entry.instructions || entry.description}>
									{entry.name}
								</span>
							))}
						</div>
					) : null}
					<label className="composer-supervisor-note">
						{t("补充说明 · 可选")}
						<textarea
							value={note}
							maxLength={200}
							onChange={(event) => onNoteChange(event.target.value)}
							placeholder={t("例如：只允许测试 10.0.0.5，禁止删除业务数据")}
						/>
					</label>
				</div>
			</div>
			<div className="composer-supervisor-foot">
				<span>{t("可多选，至少保留一个；策略不会放宽安全规则")}</span>
				<button type="button" className="primary small" onClick={onStart} disabled={strategies.length === 0}>
					{strategies.length === 0 ? t("至少选择一个策略") : t("开始监督")}
				</button>
			</div>
		</div>,
		document.body,
	);
}
