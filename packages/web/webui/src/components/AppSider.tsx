/**
 * The console's side menu.
 *
 * Structure follows the reference console: a 54px brand row, the project
 * selector, a grouped menu whose children render as indented 34px rows, and a
 * 48px footer holding connection state and utility buttons. The sider owns
 * navigation only; every page lives in the content area.
 */

import { useState } from "react";
import type { SessionInfoView, ZGMode, ZGPageId } from "../types.ts";
import { AboutIcon, CaretDownIcon, ChatIcon, CollapseIcon, DeleteIcon, EnvironmentIcon, ExpandIcon, ModelIcon, NotifyIcon, ProjectsIcon, RefreshIcon, RenameIcon, SettingsIcon, ShieldIcon } from "./icons.tsx";

type MenuIcon = React.ComponentType<{ size?: number }>;

interface MenuEntry {
	page: ZGPageId;
	label: string;
	icon: MenuIcon;
}

/**
 * Groups mirror the operator's workflow: the work itself, then configuration.
 * 文件 and 子代理 are opened from the chat page instead of living here.
 */
const MENU: { group: string; items: MenuEntry[] }[] = [
	{
		group: "工作台",
		items: [
			{ page: "chat", label: "对话", icon: ChatIcon },
			{ page: "projects", label: "项目", icon: ProjectsIcon },
		],
	},
	{
		group: "系统",
		items: [
			{ page: "settings.model", label: "设置", icon: SettingsIcon },
			{ page: "about", label: "关于", icon: AboutIcon },
		],
	},
];

/** The settings row expands into these pages. */
const SETTINGS_CHILDREN: MenuEntry[] = [
	{ page: "settings.model", label: "模型", icon: ModelIcon },
	{ page: "settings.notify", label: "通知", icon: NotifyIcon },
	{ page: "settings.permissions", label: "权限", icon: ShieldIcon },
	{ page: "settings.environment", label: "环境", icon: EnvironmentIcon },
];

export function AppSider({
	collapsed,
	onToggleCollapse,
	activePage,
	onNavigate,
	connected,
	mode,
	modelConfigured,
	sessions,
	activeSessionId,
	runningSessions,
	pendingApprovals,
	onNewSession,
	onSwitchSession,
	onRenameSession,
	onDeleteSession,
	projectSlot,
	onRefresh,
}: {
	collapsed: boolean;
	onToggleCollapse: () => void;
	activePage: ZGPageId;
	onNavigate: (page: ZGPageId) => void;
	connected: boolean;
	mode: ZGMode;
	modelConfigured: boolean;
	sessions: SessionInfoView[];
	activeSessionId: string | null;
	/** Session ids with a background run. */
	runningSessions: string[];
	pendingApprovals: number;
	onNewSession: () => void;
	onSwitchSession: (path: string) => void;
	onRenameSession: (path: string, name: string) => void;
	onDeleteSession: (path: string) => void;
	projectSlot: React.ReactNode;
	onRefresh: () => void;
}) {
	// The session list is the operator's working set, so it starts open; the
	// settings submenu stays folded until it is needed.
	const [sessionsOpen, setSessionsOpen] = useState(true);
	const [settingsOpen, setSettingsOpen] = useState(false);
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

	const sessionRows = () => (
		<div className="menu-sub">
			<div className="menu-sub-head">
				<span>{sessions.length > 0 ? `${sessions.length} 个会话` : "暂无会话"}</span>
				<button type="button" className="menu-sub-add" title="新建会话" onClick={onNewSession}>
					＋
				</button>
			</div>
			{sessions.map((session) => {
				const isActive = session.id === activeSessionId;
				const label = session.name ?? session.firstMessage.slice(0, 40);
				if (editingPath === session.path) {
					return (
						<div key={session.path} className="menu-sub-item">
							<input
								className="menu-sub-input"
								value={editingName}
								onChange={(event) => setEditingName(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") commitRename();
									if (event.key === "Escape") setEditingPath(null);
								}}
								onBlur={commitRename}
								spellCheck={false}
							/>
						</div>
					);
				}
				return (
					<div
						key={session.path}
						role="button"
						tabIndex={0}
						className={`menu-sub-item ${isActive ? "active" : ""}`}
						title={session.firstMessage}
						onClick={() => onSwitchSession(session.path)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") onSwitchSession(session.path);
						}}
					>
						<span className={`menu-sub-dot ${runningSessions.includes(session.id) ? "running" : ""}`} />
						<span className="menu-sub-name">{label}</span>
						<span className="menu-sub-ops">
							<button
								type="button"
								title="重命名"
								onClick={(event) => {
									event.stopPropagation();
									startRename(session);
								}}
							>
								<RenameIcon size={11} />
							</button>
							<button
								type="button"
								title="删除会话（不可恢复）"
								onClick={(event) => {
									event.stopPropagation();
									if (window.confirm(`删除会话「${label}」？\n该操作不可恢复。`)) {
										onDeleteSession(session.path);
									}
								}}
							>
								<DeleteIcon size={11} />
							</button>
						</span>
					</div>
				);
			})}
		</div>
	);

	/** Badge on a menu row: an unconfigured endpoint, or pending approvals. */
	const badgeFor = (item: MenuEntry): string | null => {
		if (item.page === "settings.model" && !modelConfigured) return "!";
		if (item.page === "chat" && pendingApprovals > 0) return pendingApprovals > 9 ? "9+" : String(pendingApprovals);
		return null;
	};

	return (
		<aside className={`sider ${collapsed ? "collapsed" : ""}`}>
			<div className="sider-brand" onClick={onToggleCollapse} title="ZGAgent">
				<div className="sider-logo">ZG</div>
				<span className="sider-title">ZGAgent</span>
				<button
					type="button"
					className="sider-collapse"
					title={collapsed ? "展开侧边栏" : "收起侧边栏"}
					onClick={(event) => {
						event.stopPropagation();
						onToggleCollapse();
					}}
				>
					{collapsed ? <ExpandIcon /> : <CollapseIcon />}
				</button>
			</div>

			<div className="sider-project">{projectSlot}</div>

			<nav className="sider-menu">
				{MENU.map((group) => (
					<div key={group.group}>
						<div className="menu-group">{collapsed ? "" : group.group}</div>
						{group.items.map((item) => {
							const Icon = item.icon;
							const isChat = item.page === "chat";
							const isSettings = item.page === "settings.model";
							const active =
								activePage === item.page || (isSettings && activePage.startsWith("settings."));
							const childOpen = isChat ? sessionsOpen : settingsOpen;
							const hasChildren = isChat || isSettings;
							const badge = badgeFor(item);
							return (
								<div key={item.page}>
									<button
										type="button"
										className={`menu-item ${active ? "active" : ""}`}
										title={item.label}
										onClick={() => {
											if (!hasChildren) {
												onNavigate(item.page);
												return;
											}
											const setOpen = isChat ? setSessionsOpen : setSettingsOpen;
											// Clicking the row of the page you are on collapses it;
											// clicking it from anywhere else opens it and goes there.
											if (active && childOpen) {
												setOpen(false);
												return;
											}
											setOpen(true);
											onNavigate(item.page);
										}}
									>
										<Icon />
										<span className="menu-label">{item.label}</span>
										{badge ? <span className="menu-badge">{badge}</span> : null}
										{hasChildren && !collapsed ? (
											<span className={`menu-caret ${childOpen ? "open" : ""}`}>
												<CaretDownIcon size={10} />
											</span>
										) : null}
									</button>
									{hasChildren && childOpen && !collapsed
										? isChat
											? sessionRows()
											: (
													<div className="menu-sub">
														{SETTINGS_CHILDREN.map((child) => {
															const ChildIcon = child.icon;
															return (
																<button
																	key={child.page}
																	type="button"
																	className={`menu-sub-item ${activePage === child.page ? "active" : ""}`}
																	onClick={() => onNavigate(child.page)}
																>
																	<span className="menu-sub-dot" />
																	<span className="menu-sub-name">{child.label}</span>
																	<ChildIcon size={12} />
																</button>
															);
														})}
													</div>
												)
										: null}
								</div>
							);
						})}
					</div>
				))}
			</nav>

			<div className="sider-footer">
				<span className="sider-foot-status">
					<span className={`dot ${connected ? "ok" : ""}`} />
					{connected ? (mode === "review" ? "审批模式" : "自动执行") : "已断开"}
				</span>
				<button type="button" className="sider-foot-btn" title="刷新当前页" onClick={onRefresh}>
					<RefreshIcon />
				</button>
			</div>
		</aside>
	);
}
