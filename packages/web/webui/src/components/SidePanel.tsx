import type { ReactNode } from "react";

export type SidePanelTab = "files" | "subagents";

/** Right-hand drawer shared by the file browser and the sub-agent monitor. */
export function SidePanel({
	open,
	tab,
	projectName,
	fileCount,
	runningCount,
	onTab,
	onClose,
	children,
}: {
	open: boolean;
	tab: SidePanelTab;
	projectName: string | null;
	fileCount: number;
	runningCount: number;
	onTab: (tab: SidePanelTab) => void;
	onClose: () => void;
	children: ReactNode;
}) {
	if (!open) return null;
	return (
		<aside className="side-panel">
			<div className="side-panel-head">
				<div className="side-panel-tabs">
					<button
						type="button"
						className={`side-panel-tab ${tab === "files" ? "active" : ""}`}
						onClick={() => onTab("files")}
					>
						文件{fileCount > 0 ? <span className="tab-count">{fileCount}</span> : null}
					</button>
					<button
						type="button"
						className={`side-panel-tab ${tab === "subagents" ? "active" : ""}`}
						onClick={() => onTab("subagents")}
					>
						子代理{runningCount > 0 ? <span className="tab-count running">{runningCount}</span> : null}
					</button>
				</div>
				<button type="button" className="side-panel-close" title="收起面板" onClick={onClose}>
					×
				</button>
			</div>
			<div className="side-panel-context" title={projectName ?? ""}>
				{tab === "files" ? "容器工作目录 /work" : "当前会话的子代理"} · {projectName ?? "未选择项目"}
			</div>
			<div className="side-panel-body">{children}</div>
		</aside>
	);
}
