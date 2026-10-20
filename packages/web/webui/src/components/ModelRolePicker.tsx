import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type {
	SentinelModelLibraryView,
	SentinelModelRoleName,
	SentinelTestResult,
} from "../types.ts";
import { CloseIcon } from "./icons.tsx";
import {
	FOLLOW_MAIN,
	hostOf,
	ModelStatusTag,
	ROLE_HINTS,
	ROLE_LABELS,
	testDetail,
	testState,
	UsageTags,
} from "./model-ui.tsx";

/**
 * A role only ever points at a library entry (or at 主模型); editing the model
 * itself lives in the drawer. Keeping assignment in a small dialog means the
 * cockpit never grows a second full editor.
 */
export function ModelRolePicker({
	library,
	role,
	results,
	onApply,
	onClose,
}: {
	library: SentinelModelLibraryView;
	role: SentinelModelRoleName;
	results: Record<string, SentinelTestResult | null>;
	onApply: (target: string | null) => void;
	onClose: () => void;
}) {
	const current = role === "main" ? library.roles.main : library.roles[role];
	const [selected, setSelected] = useState<string>(current ?? "");
	const resolved = library.resolved[role];
	const mainEntry = library.entries.find((entry) => entry.id === library.roles.main);

	useEffect(() => {
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [onClose]);

	return createPortal(
		<div className="cockpit-layer">
			<button type="button" className="cockpit-scrim" aria-label="关闭" onClick={onClose} />
			<div className="cockpit-dialog" role="dialog" aria-modal="true" aria-label={`更换${ROLE_LABELS[role]}`}>
				<div className="cockpit-dialog__head">
					<div>
						<h3>更换{ROLE_LABELS[role]}</h3>
						<p>{ROLE_HINTS[role]} · 同一模型可被多个角色复用</p>
					</div>
					<button type="button" className="cockpit-iconbtn" aria-label="关闭" onClick={onClose}>
						<CloseIcon />
					</button>
				</div>
				<div className="cockpit-dialog__body">
					<p className="cockpit-dialog__note">
						当前：{resolved ? `${resolved.entryName} · ${resolved.modelId}` : "未绑定"}
					</p>
					{role === "main" ? (
						<label className={`cockpit-option${selected === "" ? " is-selected" : ""}`}>
							<input
								type="radio"
								name="cockpit-role-model"
								checked={selected === ""}
								onChange={() => setSelected("")}
							/>
							<span className="cockpit-option__main">
								<b>未选择</b>
								<span>主模型未配置时，依赖它的角色也无法解析</span>
							</span>
						</label>
					) : (
						<label className={`cockpit-option${selected === FOLLOW_MAIN ? " is-selected" : ""}`}>
							<input
								type="radio"
								name="cockpit-role-model"
								checked={selected === FOLLOW_MAIN}
								onChange={() => setSelected(FOLLOW_MAIN)}
							/>
							<span className="cockpit-option__main">
								<b>跟随主模型</b>
								<span>{mainEntry ? `使用 ${mainEntry.name} · ${mainEntry.modelId}` : "主模型尚未配置"}</span>
							</span>
						</label>
					)}
					{library.entries.map((entry) => (
						<label
							className={`cockpit-option${selected === entry.id ? " is-selected" : ""}`}
							key={entry.id}
						>
							<input
								type="radio"
								name="cockpit-role-model"
								checked={selected === entry.id}
								onChange={() => setSelected(entry.id)}
							/>
							<span className="cockpit-option__main">
								<b>
									{entry.name} · {entry.modelId}
								</b>
								<span>{hostOf(entry.baseUrl)}</span>
							</span>
							<span className="cockpit-option__tags">
								<UsageTags roles={entry.roles} />
								<ModelStatusTag
									state={testState(false, results[entry.id])}
									detail={testDetail(results[entry.id])}
								/>
							</span>
						</label>
					))}
				</div>
				<div className="cockpit-dialog__foot">
					<span className="cockpit-hint">更多模型在「模型库」中添加</span>
					<button type="button" onClick={onClose}>
						取消
					</button>
					<button type="button" className="primary" onClick={() => onApply(selected === "" ? null : selected)}>
						应用
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
