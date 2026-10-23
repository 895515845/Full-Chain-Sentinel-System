/**
 * The delete confirmation for one project.
 *
 * The two scopes are the two buttons: nothing is preselected, so the operator
 * reads what each one does and the click itself is the choice. Both stay
 * disabled until the full project name is typed, which is what makes an
 * irreversible deletion deliberate without adding a second step.
 */

import { useState } from "react";
import { t } from "../i18n.ts";
import type { SentinelProjectInfo } from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/**
 * What the confirmation offers, in the order it shows them: the safe scope
 * first, the destructive one in solid red.
 */
export const PROJECT_REMOVE_OPTIONS: readonly {
	scope: "container" | "data";
	label: string;
	danger: boolean;
}[] = [
	{ scope: "container", label: t("仅删除容器"), danger: false },
	{ scope: "data", label: t("删除项目数据"), danger: true },
];

/** Whether the typed name matches the project, which is what unlocks both actions. */
export function deleteConfirmMatches(confirmName: string, projectName: string): boolean {
	return confirmName.trim() === projectName;
}

export function ProjectDeleteDialog({
	project,
	busy = false,
	sessionCount,
	onConfirm,
	onCancel,
}: {
	project: SentinelProjectInfo;
	busy?: boolean;
	sessionCount?: number;
	onConfirm: (scope: "container" | "data") => void;
	onCancel: () => void;
}) {
	const [confirmName, setConfirmName] = useState("");
	const matches = deleteConfirmMatches(confirmName, project.name);

	return (
		<ConfirmDialog
			title={t("删除项目")}
			subtitle={project.name}
			onCancel={onCancel}
			footer={
				<>
					{PROJECT_REMOVE_OPTIONS.map((entry) => (
						<button
							key={entry.scope}
							type="button"
							className={entry.danger ? "danger" : undefined}
							disabled={busy || !matches}
							onClick={() => onConfirm(entry.scope)}
						>
							{entry.label}
						</button>
					))}
				</>
			}
		>
			<div className="confirm-meta">
				{t("容器")} <code>{project.container ?? t("无容器")}</code>
				{sessionCount === undefined ? "" : ` · ${t("{count} 个会话", { count: sessionCount })}`}
				{` · ${t("{count} 条漏洞记录", { count: project.vulnCount ?? 0 })}`}
				{` · ${t("{count} 条审批记录", { count: project.gateCount ?? 0 })}`}
			</div>
			<p className="confirm-note">
				{t("仅删除容器只删掉容器本身，项目、工作目录、会话与记录都保留，下次「启动容器」按当前设置重建；")}
				{t("删除项目数据会连项目条目、工作目录 /work 里的文件、会话文件与漏洞/审批等记录一起删除，不可恢复。")}
			</p>
			<label className="confirm-field">
				<span className="confirm-field__label">
					{t("输入项目名 {name} 以确认", { name: project.name })}
					{matches ? <span className="confirm-field__ok">{t("已确认")}</span> : null}
				</span>
				<input
					value={confirmName}
					placeholder={project.name}
					spellCheck={false}
					/* biome-ignore lint/a11y/noAutofocus: the dialog exists to type this name */
					autoFocus
					onChange={(event) => setConfirmName(event.target.value)}
				/>
			</label>
		</ConfirmDialog>
	);
}
