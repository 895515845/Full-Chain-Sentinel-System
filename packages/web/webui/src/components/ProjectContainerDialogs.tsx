/**
 * The confirmations behind a project row's overflow menu.
 *
 * Both actions are irreversible in the sense that matters — the container's own
 * layer goes — and the row menu is far too narrow to say so. The menu therefore
 * only opens one of these; the decision, and the sentence explaining what it
 * costs, live in a dialog.
 *
 * Neither one asks for the project name: that gate belongs to deletion, which
 * also destroys the work directory. Stopping and rebuilding keep every file the
 * operator can see in the file panel.
 */

import { t } from "../i18n.ts";
import type { SentinelProjectInfo } from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** Stop: the container and everything installed inside it stay, nothing runs. */
export function ProjectStopDialog({
	project,
	busy,
	onConfirm,
	onCancel,
}: {
	project: SentinelProjectInfo;
	busy: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<ConfirmDialog
			title={t("停止容器")}
			subtitle={project.name}
			onCancel={onCancel}
			footer={
				<button type="button" className="danger" disabled={busy} onClick={onConfirm}>
					{t("确认停止")}
				</button>
			}
		>
			<p className="confirm-note">
				{t("停止后这个项目的工具调用与对话都无法进行，需要点「启动容器」才能继续。")}
			</p>
			<p className="confirm-note">
				{t("容器里用 apt 装的包与启动的进程状态会丢失，")} <code>/work</code>{" "}
				{t("里的文件、会话与漏洞记录都不受影响。")}
			</p>
			<p className="confirm-note">{t("该项目有正在运行的工程任务或对话时不能停止。")}</p>
		</ConfirmDialog>
	);
}

/** Rebuild: the container is replaced, which is how creation-time settings apply. */
export function ProjectRecreateDialog({
	project,
	busy,
	onConfirm,
	onCancel,
}: {
	project: SentinelProjectInfo;
	busy: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<ConfirmDialog
			title={t("重建容器")}
			subtitle={project.name}
			onCancel={onCancel}
			footer={
				<button type="button" className="primary" disabled={busy} onClick={onConfirm}>
					{t("确认重建")}
				</button>
			}
		>
			<p className="confirm-note">
				{t("容器会被删掉并按当前的网络模式与代理设置重新创建，这是让创建期设置生效的唯一方式。")}
			</p>
			<p className="confirm-note">
				{t("容器里用 apt 装的包、")} <code>/work</code> {t("之外的文件都会丢失，")} <code>/work</code>{" "}
				{t("里的文件、会话与漏洞记录不受影响。")}
			</p>
			<p className="confirm-note">{t("正在这个容器里跑的命令会失败。")}</p>
		</ConfirmDialog>
	);
}
