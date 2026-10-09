import { useState } from "react";
import type { SessionInfoView, ZGMode, ZGStatsView } from "../types.ts";
import { ChatIcon, CloseIcon, DeleteIcon, HistoryIcon, RenameIcon, SettingsIcon } from "./icons.tsx";

export type SidebarTab = "chat" | "settings";

export function Sidebar({
	activeTab,
	collapsed,
	headerSlot,
	mode,
	streaming,
	connected,
	modelConfigured,
	stats,
	allowedPrefixes,
	sessions,
	activeSessionId,
	runningSessions,
	pendingApprovals,
	onTab,
	onToggleCollapse,
	onNewSession,
	onSwitchSession,
	onRenameSession,
	onDeleteSession,
	onAllowPrefix,
	onRemoveAllowedPrefix,
}: {
	activeTab: SidebarTab;
	collapsed: boolean;
	headerSlot?: React.ReactNode;
	mode: ZGMode;
	streaming: boolean;
	connected: boolean;
	modelConfigured: boolean;
	stats: ZGStatsView | null;
	allowedPrefixes: string[];
	sessions: SessionInfoView[];
	activeSessionId: string | null;
	/** Session ids with a background run. */
	runningSessions: string[];
	pendingApprovals: number;
	onTab: (tab: SidebarTab) => void;
	onToggleCollapse: () => void;
	onNewSession: () => void;
	onSwitchSession: (path: string) => void;
	onRenameSession: (path: string, name: string) => void;
	onDeleteSession: (path: string) => void;
	onAllowPrefix: (prefix: string) => void;
	onRemoveAllowedPrefix: (prefix: string) => void;
}) {
	const [newPrefix, setNewPrefix] = useState("");
	const [historyOpen, setHistoryOpen] = useState(true);
	const [editingPath, setEditingPath] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");

	const startRename = (session: SessionInfoView) => {
		setEditingPath(session.path);
		setEditingName(session.name ?? session.firstMessage.slice(0, 40));
	};

	const commitRename = () => {
		const name = editingName.trim();
		if (editingPath && name) onRenameSession(editingPath, name);
		setEditingPath(null);
	};

	const sessionRow = (session: SessionInfoView) => {
		const isActive = session.id === activeSessionId;
		const isEditing = editingPath === session.path;
		return (
			<div key={session.path} className={`sub-item-row ${isActive ? "active" : ""}`}>
				{isEditing ? (
					<input
						className="sub-rename-input"
						value={editingName}
						onChange={(event) => setEditingName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") commitRename();
							if (event.key === "Escape") setEditingPath(null);
						}}
						onBlur={commitRename}
						spellCheck={false}
					/>
				) : (
					<button
						type="button"
						className={`sb-child ${isActive ? "active" : ""}`}
						onClick={() => onSwitchSession(session.path)}
						title={session.firstMessage}
					>
						<span
							className={`child-dot ${runningSessions.includes(session.id) ? "running" : isActive ? "on" : ""}`}
						/>
						<span className="child-name">{session.name ?? session.firstMessage.slice(0, 40)}</span>
					</button>
				)}
				{!isEditing ? (
					<div className="child-ops">
						<button type="button" className="ghost small" title="重命名" onClick={() => startRename(session)}>
							<RenameIcon />
						</button>
						<button
							type="button"
							className="ghost small"
							title="删除会话（不可恢复）"
							onClick={() => {
								if (window.confirm(`删除会话「${session.name ?? session.firstMessage.slice(0, 30)}」？\n该操作不可恢复。`)) {
									onDeleteSession(session.path);
								}
							}}
						>
							<DeleteIcon />
						</button>
					</div>
				) : null}
			</div>
		);
	};

	if (collapsed) {
		return (
			<aside className="sidebar collapsed">
				<div className="sb-brand">
					<div className="sb-logo">ZG</div>
				</div>
				<nav className="sb-menu">
					<button
						type="button"
						className={`sb-item ${activeTab === "chat" ? "active" : ""}`}
						title="对话"
						onClick={() => {
							onToggleCollapse();
							onTab("chat");
						}}
					>
						<ChatIcon />
						{pendingApprovals > 0 ? (
							<span className="badge-dot">{pendingApprovals > 9 ? "9+" : pendingApprovals}</span>
						) : null}
					</button>
					<button
						type="button"
						className={`sb-item ${activeTab === "settings" ? "active" : ""}`}
						title="设置"
						onClick={() => onTab("settings")}
					>
						<SettingsIcon />
					</button>
				</nav>
				<div className="sb-spacer" />
				<div className="sb-footer">
					<span className={`dot ${connected ? "ok" : "bad"}`} />
				</div>
			</aside>
		);
	}

	return (
		<aside className="sidebar">
			<div className="sb-brand">
				<div className="sb-logo">ZG</div>
				<span className="sb-title">ZGAgent</span>
				<button type="button" className="sb-collapse" title="折叠侧栏" onClick={onToggleCollapse}>
					«
				</button>
			</div>

			{headerSlot ? <div className="sb-project-slot">{headerSlot}</div> : null}

			<nav className="sb-menu">
				<button type="button" className={`sb-item ${activeTab === "chat" ? "active" : ""}`} onClick={() => onTab("chat")}>
					<ChatIcon />
					<span>对话</span>
					{pendingApprovals > 0 ? (
						<span className="badge-dot">{pendingApprovals > 9 ? "9+" : pendingApprovals}</span>
					) : null}
				</button>

				<button
					type="button"
					className={`sb-item group ${activeTab === "chat" ? "lit" : ""}`}
					onClick={() => setHistoryOpen((prev) => !prev)}
				>
					<HistoryIcon />
					<span>会话历史</span>
					<span className={`caret ${historyOpen ? "open" : ""}`}>^</span>
				</button>
				{historyOpen ? (
					<div className="sb-children">
						<div className="sb-children-head">
							<button type="button" className="ghost small" onClick={onNewSession} disabled={streaming}>
								＋ 新建
							</button>
						</div>
						{sessions.length === 0 ? <div className="sb-empty">暂无历史会话</div> : null}
						{sessions.map(sessionRow)}
					</div>
				) : null}

				<button
					type="button"
					className={`sb-item ${activeTab === "settings" ? "active" : ""}`}
					onClick={() => onTab("settings")}
				>
					<SettingsIcon />
					<span>设置</span>
					{!modelConfigured ? (
						<span className="warn-dot" title="未配置">
							!
						</span>
					) : null}
				</button>

			</nav>

			{mode === "review" && allowedPrefixes.length > 0 ? (
				<div className="sb-section">
					<div className="sb-label">命令白名单</div>
					<div className="prefix-list">
						{allowedPrefixes.map((prefix) => (
							<span key={prefix} className="prefix-chip">
								{prefix}
								<button type="button" className="chip-remove" onClick={() => onRemoveAllowedPrefix(prefix)}>
									<CloseIcon size={12} />
								</button>
							</span>
						))}
					</div>
					<form
						className="prefix-form"
						onSubmit={(event) => {
							event.preventDefault();
							const value = newPrefix.trim();
							if (value) onAllowPrefix(value);
							setNewPrefix("");
						}}
					>
						<input
							value={newPrefix}
							onChange={(event) => setNewPrefix(event.target.value)}
							placeholder="添加放行前缀，如 nmap"
							spellCheck={false}
						/>
						<button type="submit" className="ghost small" disabled={!newPrefix.trim()}>
							添加
						</button>
					</form>
				</div>
			) : null}

			<div className="sb-spacer" />

			<div className="sb-footer">
				<span className={`dot ${connected ? "ok" : "bad"}`} />
				{connected ? "已连接" : "连接断开"}
				{stats ? (
					<span style={{ marginLeft: "auto" }}>
						${stats.cost.toFixed(3)} · {(stats.tokens.total / 1000).toFixed(1)}k tok
					</span>
				) : null}
			</div>
		</aside>
	);
}
