/**
 * The dialogs a project row's overflow menu opens.
 *
 * The row is a table cell: it has room for a menu, not for a sentence explaining
 * what a destructive click costs. Every item in that menu therefore only records
 * which action is pending, and this component turns that into the confirmation.
 *
 * They live in one place — and one `action` — on purpose. Four independent
 * `pending*` states used to sit in the page, and the menu was wired to all of
 * them while only one dialog was ever rendered, which made 停止容器, 重建容器 and
 * 删除项目… look like decoration: the state changed, nothing appeared. One
 * discriminated action means a menu item that opens nothing is a type error
 * rather than a silent no-op.
 */

import { t } from "../i18n.ts";
import type { SentinelProjectInfo, SentinelProxyConfigView } from "../types.ts";
import { ProjectRecreateDialog, ProjectStopDialog } from "./ProjectContainerDialogs.tsx";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog.tsx";
import { ProjectProxyDialog } from "./ProjectProxyDialog.tsx";

/** What the row menu can open. */
export type ProjectRowAction = "stop" | "recreate" | "delete" | "proxy";

export function ProjectRowDialogs({
	action,
	project,
	config,
	busy,
	onStop,
	onRecreate,
	onRemove,
	onSaveProxy,
	onCancel,
}: {
	/** Which action is pending, or null when the menu is closed. */
	action: ProjectRowAction | null;
	/** The project it applies to; null while the list is being refreshed. */
	project: SentinelProjectInfo | null;
	config: SentinelProxyConfigView;
	busy: boolean;
	onStop: (project: SentinelProjectInfo) => void;
	onRecreate: (project: SentinelProjectInfo) => void;
	onRemove: (project: SentinelProjectInfo, scope: "container" | "data") => void;
	onSaveProxy: (project: SentinelProjectInfo, proxyId: string | null | undefined, proxyNode?: string) => void;
	onCancel: () => void;
}) {
	if (!action || !project) return null;
	switch (action) {
		case "stop":
			return (
				<ProjectStopDialog
					project={project}
					busy={busy}
					onCancel={onCancel}
					onConfirm={() => onStop(project)}
				/>
			);
		case "recreate":
			return (
				<ProjectRecreateDialog
					project={project}
					busy={busy}
					onCancel={onCancel}
					onConfirm={() => onRecreate(project)}
				/>
			);
		case "delete":
			return (
				<ProjectDeleteDialog
					project={project}
					busy={busy}
					sessionCount={project.sessionCount}
					onCancel={onCancel}
					onConfirm={(scope) => onRemove(project, scope)}
				/>
			);
		case "proxy":
			return (
				<ProjectProxyDialog
					project={project}
					config={config}
					busy={busy}
					onCancel={onCancel}
					onConfirm={(proxyId, proxyNode) => onSaveProxy(project, proxyId, proxyNode)}
				/>
			);
		default: {
			// Exhaustiveness: a new action without a dialog fails to compile here.
			const unreachable: never = action;
			throw new Error(`unhandled project row action: ${String(unreachable)}`);
		}
	}
}

/** The menu labels, in the order the row shows them. */
export function projectRowActionLabel(action: ProjectRowAction): string {
	switch (action) {
		case "stop":
			return t("停止容器");
		case "recreate":
			return t("重建容器");
		case "delete":
			return t("删除项目…");
		case "proxy":
			return t("代理设置…");
	}
}
