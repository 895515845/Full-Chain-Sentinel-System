/**
 * The 业务建模 menu: one composer entry for both modeling actions.
 *
 * 开始建模 runs the two-tool cycle on this conversation (or ends the run in
 * force); 关联建模数据 attaches existing records to a fresh conversation. The
 * attach checklist lives inside the same menu as a second view, because the two
 * actions are one feature, not two switches.
 *
 * Like the preset picker it is portaled to document.body with fixed
 * coordinates: the composer sits at the bottom of the window where a plain
 * dropdown would clip.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n.ts";
import type { SentinelApiModelSummary, SentinelModelingState } from "../types.ts";
import type { PresetMenuAnchor } from "./PresetMenu.tsx";

export function ModelingMenu(props: {
	anchor: PresetMenuAnchor;
	/** The run in force for this conversation, if any: the first item ends it. */
	modeling: SentinelModelingState | null;
	/** Records this conversation already carries; shown with a removal action. */
	attached: ReadonlyArray<{ id: string; title: string }>;
	/** The project's records, offered for attaching on a fresh conversation. */
	records: readonly SentinelApiModelSummary[];
	selected: readonly string[];
	/** Attaching rides the first message, so an ongoing conversation cannot do it. */
	canAttach: boolean;
	/** 开始建模 needs a settled session; 结束建模 the same. */
	canToggleRun: boolean;
	onStart(): void;
	onEnd(): void;
	onToggle(id: string): void;
	onDetach(): void;
	onClose(): void;
}) {
	const [view, setView] = useState<"actions" | "attach">("actions");
	// Same dismiss contract as the preset picker: outside click or Escape. Toggling
	// a checkbox keeps the menu open — the checklist is multi-select, and actions
	// close the menu themselves.
	const onClose = useRef(props.onClose);
	useEffect(() => {
		onClose.current = props.onClose;
	});
	const mountedAt = useRef(performance.now());
	useEffect(() => {
		const close = (event: MouseEvent) => {
			if (event.timeStamp <= mountedAt.current) return;
			onClose.current();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose.current();
		};
		window.addEventListener("click", close);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, []);
	return createPortal(
		<div
			className="preset-menu modeling-menu"
			style={{
				top: props.anchor.top,
				bottom: props.anchor.bottom,
				left: props.anchor.left,
				maxHeight: props.anchor.maxHeight,
			}}
			onClick={(event) => event.stopPropagation()}
		>
			{view === "actions" ? (
				<>
					<div className="preset-menu-title">{t("业务建模")}</div>
					{props.modeling ? (
						<button
							type="button"
							className="preset-menu-item"
							disabled={!props.canToggleRun}
							title={
								props.canToggleRun
									? t("结束这次建模，Agent 回到普通工作")
									: t("Agent 正在运行，先中止或等本轮结束")
							}
							onClick={() => {
								props.onEnd();
								props.onClose();
							}}
						>
							<span className="preset-menu-name">{t("结束建模")}</span>
							<span className="preset-menu-desc">
								{props.modeling.title} · {t("{pathCount} 路径 / {operationCount} 操作", {
									pathCount: props.modeling.pathCount,
									operationCount: props.modeling.operationCount,
								})}
							</span>
						</button>
					) : (
						<button
							type="button"
							className="preset-menu-item"
							disabled={!props.canToggleRun}
							title={
								props.canToggleRun
									? t("在当前会话里还原目标的接口与业务实体，生成 Swagger 文档")
									: t("Agent 正在运行，先中止或等本轮结束")
							}
							onClick={() => {
								props.onStart();
								props.onClose();
							}}
						>
							<span className="preset-menu-name">{t("开始建模")}</span>
							<span className="preset-menu-desc">{t("在本会话里还原接口与业务实体；在对话里直接要求也可以")}</span>
						</button>
					)}
					<button
						type="button"
						className="preset-menu-item"
						disabled={!props.canAttach && props.attached.length === 0}
						title={
							props.attached.length > 0
								? t("查看本会话已带入的建模数据，或全部移除")
								: props.canAttach
									? t("勾选已有建模记录，随第一条消息把接口目录交给 Agent")
									: t("只有还没有发过消息的新对话可以关联建模数据")
						}
						onClick={() => setView("attach")}
					>
						<span className="preset-menu-name">
							{t("关联建模数据")}
							{props.attached.length > 0 ? (
								<span className="modeling-menu-count">
									{t("{count} 份", { count: props.attached.length })}
								</span>
							) : null}
						</span>
						<span className="preset-menu-desc">
							{props.attached.length > 0
								? t("目录已注入，api_model_read 可读全文")
								: props.canAttach
									? t("把已有记录的接口目录带进这条新对话")
									: t("仅新对话可用")}
						</span>
					</button>
				</>
			) : (
				<>
					<div className="modeling-menu-back">
						<button type="button" className="modeling-menu-back__button" onClick={() => setView("actions")}>
							‹ {t("返回")}
						</button>
						<span className="modeling-menu-back__title">{t("关联建模数据")}</span>
					</div>
					{props.attached.length > 0 ? (
						<>
							{props.attached.map((record) => (
								<div key={record.id} className="preset-menu-item modeling-menu-static">
									<span className="preset-menu-name">{record.title}</span>
									<span className="preset-menu-desc">{t("目录已注入，api_model_read 可读全文")}</span>
								</div>
							))}
							<button type="button" className="modeling-menu-remove" onClick={props.onDetach}>
								{t("全部移除（摘除 api_model_read）")}
							</button>
						</>
					) : (
						<>
							{props.records.map((record) => (
								<button
									key={record.id}
									type="button"
									className="preset-menu-item"
									onClick={() => props.onToggle(record.id)}
									title={t("{pathCount} 路径 / {operationCount} 操作", {
										pathCount: record.pathCount,
										operationCount: record.operationCount,
									})}
								>
									<span className={`attach-check ${props.selected.includes(record.id) ? "on" : ""}`} />
									<span className="preset-menu-name">{record.title}</span>
									<span className="preset-menu-desc">
										{t("{pathCount} 路径 · {operationCount} 操作 · {entityCount} 实体", {
											pathCount: record.pathCount,
											operationCount: record.operationCount,
											entityCount: record.entityCount,
										})}
									</span>
								</button>
							))}
							{props.records.length === 0 ? (
								<div className="preset-menu-hint">{t("这个项目还没有业务建模记录。先开始一次建模。")}</div>
							) : (
								<div className="preset-menu-hint">
									{t("勾选后随第一条消息把接口目录交给 Agent（细节它可用 api_model_read 自己查）；一条都不勾，就什么都不插入。发送后勾选自动清空。")}
								</div>
							)}
						</>
					)}
				</>
			)}
		</div>,
		document.body,
	);
}
