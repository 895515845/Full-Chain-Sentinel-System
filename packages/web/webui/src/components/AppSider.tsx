/**
 * The console's side menu.
 *
 * Structure follows the reference console: a 54px brand row, the project
 * selector, a grouped menu whose children render as indented 34px rows, and a
 * 56px footer holding connection state and utility buttons. The sider owns
 * navigation only; every page lives in the content area.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PROJECT_REPOSITORY } from "../branding.ts";
import { getLanguage, t } from "../i18n.ts";
import type { SessionInfoView, SentinelEngine, SentinelMode, SentinelPageId, SentinelSessionStatus } from "../types.ts";
import { SENTINEL_MODE_LABELS } from "../types.ts";
import {
	AboutIcon,
	ApiModelIcon,
	AssetIcon,
	CaretDownIcon,
	ChatIcon,
	CollapseIcon,
	DeleteIcon,
	DroidIcon,
	EnvironmentIcon,
	ExpandIcon,
	GateIcon,
	GitHubIcon,
	IosIcon,
	LockIcon,
	LogoutIcon,
	McpIcon,
	ModelIcon,
	NotifyIcon,
	PocIcon,
	ProjectsIcon,
	PluginIcon,
	RefreshIcon,
	RenameIcon,
	SentinelMark,
	SettingsIcon,
	ShieldIcon,
	SubagentIcon,
	SupervisorIcon,
	VulnIcon,
} from "./icons.tsx";
import { SESSION_STATUS_LABELS, SessionStatusControl, SessionStatusRail } from "./SessionStatusControl.tsx";

type MenuIcon = React.ComponentType<{ size?: number }>;

interface MenuEntry {
	page: SentinelPageId;
	label: string;
	icon: MenuIcon;
}

/** A plugin UI the operator pinned to the workbench group. */
export interface PluginNavEntry {
	page: SentinelPageId;
	label: string;
	title: string;
	iconUrl: string | null;
	disabled: boolean;
}

/**
 * Groups mirror the operator's workflow: the work itself, then configuration.
 * 文件 and 子代理 are opened from the chat page instead of living here.
 */
const MENU: { group: string; items: MenuEntry[] }[] = [
	{
		group: "工作台",
		items: [
			{ page: "chat", label: t("对话"), icon: ChatIcon },
			{ page: "projects", label: t("项目"), icon: ProjectsIcon },
			{ page: "vulns", label: t("漏洞"), icon: VulnIcon },
			{ page: "apimodels", label: t("业务建模"), icon: ApiModelIcon },
			{ page: "droid", label: t("安卓设备"), icon: DroidIcon },
			{ page: "ios", label: t("iOS 设备"), icon: IosIcon },
			{ page: "pocs", label: t("POC 库"), icon: PocIcon },
			{ page: "engine", label: t("工程"), icon: SubagentIcon },
			{ page: "gates", label: t("审批"), icon: GateIcon },
			{ page: "supervisor", label: t("监督"), icon: SupervisorIcon },
		],
	},
	{
		group: "系统",
		items: [
			{ page: "settings.model", label: t("设置"), icon: SettingsIcon },
			{ page: "about", label: t("关于"), icon: AboutIcon },
		],
	},
];

/** The settings row expands into these pages. */
const SETTINGS_CHILDREN: MenuEntry[] = [
	{ page: "settings.model", label: t("模型"), icon: ModelIcon },
	{ page: "settings.supervisor", label: t("监督"), icon: SupervisorIcon },
	{ page: "settings.notify", label: t("通知"), icon: NotifyIcon },
	{ page: "settings.permissions", label: t("权限"), icon: ShieldIcon },
	{ page: "settings.presets", label: t("预设 Agent"), icon: SubagentIcon },
	{ page: "settings.pocs", label: t("POC 订阅"), icon: PocIcon },
	{ page: "settings.assets", label: t("资产测绘"), icon: AssetIcon },
	{ page: "settings.websearch", label: t("Web 搜索"), icon: AssetIcon },
	{ page: "settings.mcp", label: "MCP", icon: McpIcon },
	{ page: "settings.plugins", label: t("插件"), icon: PluginIcon },
	{ page: "settings.security", label: t("安全"), icon: LockIcon },
	{ page: "settings.environment", label: t("环境"), icon: EnvironmentIcon },
];

/** Sidebar tags for an engineering task session's live status. */
const TASK_TAG_LABELS: Record<string, string> = {
	queued: t("排队"),
	running: t("运行"),
	done: t("完成"),
	failed: t("失败"),
	blocked: t("阻塞"),
	aborted: t("中止"),
	paused: t("暂停"),
};

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
	engines,
	pluginPages,
	pendingApprovals,
	/** Findings still waiting for review, shown as the hub's badge. */
	pendingVulns,
	/** The preset library, for the 新建会话 picker; disabled entries are not offered. */
	onNewSession,
	onSwitchSession,
	onRenameSession,
	onDeleteSession,
	onSetSessionStatus,
	projectSlot,
	onRefresh,
	authUser,
	onLogout,
	onSwitchLanguage,
}: {
	collapsed: boolean;
	onToggleCollapse: () => void;
	activePage: SentinelPageId;
	onNavigate: (page: SentinelPageId) => void;
	connected: boolean;
	mode: SentinelMode;
	modelConfigured: boolean;
	sessions: SessionInfoView[];
	engines: SentinelEngine[];
	pluginPages: PluginNavEntry[];
	activeSessionId: string | null;
	/** Session ids with a background run. */
	runningSessions: string[];
	pendingApprovals: number;
	pendingVulns: number;
	/** `presetId` omitted creates a default-agent session. */
	onNewSession: () => void;
	onSwitchSession: (path: string) => void;
	onRenameSession: (path: string, name: string) => void;
	onDeleteSession: (path: string) => void;
	onSetSessionStatus: (path: string, status: SentinelSessionStatus | null) => void;
	projectSlot: React.ReactNode;
	onRefresh: () => void;
	/** The logged-in administrator; null hides the logout button. */
	authUser: string | null;
	onLogout: () => void;
	onSwitchLanguage: (language: "zh" | "en") => void;
}) {
	// The session list is the operator's working set, so it starts open; the
	// settings submenu stays folded until it is needed.
	const [sessionsOpen, setSessionsOpen] = useState(true);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [editingPath, setEditingPath] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	/**
	 * The 新建会话 preset picker. The sider clips overflow, so the menu is
	 * portaled to document.body with fixed coordinates like the hover card.
	 */
	/**
	 * Two independent filter dimensions over the flat session list:
	 * - status: "未完成" hides 已完成/已忽略 sessions;
	 * - source: 对话 (console-born) vs 工程 (engineering task conversations),
	 *   badged with the engine's name so a batch run never drowns the rest.
	 */
	const [statusFilter, setStatusFilter] = useState<"all" | "open">(() =>
		localStorage.getItem("sentinel-session-filter") === "open" ? "open" : "all",
	);
	const [sourceFilter, setSourceFilter] = useState<"all" | "chat" | "engine">(() => {
		const stored = localStorage.getItem("sentinel-session-source");
		return stored === "chat" || stored === "engine" ? stored : "all";
	});
	/** Collapsed per-engine groups; the sidebar starts expanded. */
	const [collapsedEngines, setCollapsedEngines] = useState<Set<string>>(() => {
		try {
			const stored = localStorage.getItem("sentinel-engine-groups-collapsed");
			return new Set(stored ? (JSON.parse(stored) as string[]) : []);
		} catch {
			return new Set();
		}
	});

	const toggleEngineGroup = (engineId: string) => {
		setCollapsedEngines((prev) => {
			const next = new Set(prev);
			if (next.has(engineId)) next.delete(engineId);
			else next.add(engineId);
			localStorage.setItem("sentinel-engine-groups-collapsed", JSON.stringify([...next]));
			return next;
		});
	};
	const visibleSessions = useMemo(
		() =>
			sessions.filter((session) => {
				if (statusFilter === "open" && (session.status === "done" || session.status === "ignored")) {
					return false;
				}
				if (sourceFilter === "chat" && session.engine) return false;
				if (sourceFilter === "engine" && !session.engine) return false;
				return true;
			}),
		[sessions, statusFilter, sourceFilter],
	);

	/**
	 * Engineering sessions grouped by their engine (variant 4): the engine name
	 * becomes a collapsible sub-heading with a live running count, and the rows
	 * inside carry no engine badge at all — that is what buys the title its
	 * space back in a 210px sidebar. Chat sessions stay flat above the groups.
	 */
	const engineGroups = useMemo(() => {
		const groups = new Map<string, { engineName: string; sessions: SessionInfoView[] }>();
		for (const session of visibleSessions) {
			if (!session.engine) continue;
			const group = groups.get(session.engine.engineId) ?? { engineName: session.engine.engineName, sessions: [] };
			group.sessions.push(session);
			groups.set(session.engine.engineId, group);
		}
		// Newest activity first: a group leads with its most recent task.
		return [...groups.values()].sort((left, right) =>
			(right.sessions[0]?.modified ?? "").localeCompare(left.sessions[0]?.modified ?? ""),
		);
	}, [visibleSessions]);
	const chatSessions = useMemo(() => visibleSessions.filter((session) => !session.engine), [visibleSessions]);

	/**
	 * The hover card renders through a portal to document.body with fixed
	 * coordinates: the sidebar and its menu both clip overflow, so an absolutely
	 * positioned card inside a row would never be visible.
	 *
	 * Only the path is kept, never the session object: the card shows the
	 * operator's status, and a snapshot would keep rendering the status the row
	 * had when the pointer arrived — picking 已完成 left the card on 未设置.
	 */
	const [hoverCard, setHoverCard] = useState<{ path: string; top: number; left: number } | null>(null);
	const hideTimer = useRef<number | null>(null);
	/**
	 * The card's status picker is a fixed panel below the card: while it is open
	 * the pointer legitimately leaves the card box, so the card must not hide.
	 */
	const statusPickerOpen = useRef(false);
	const cancelHide = () => {
		if (hideTimer.current !== null) {
			window.clearTimeout(hideTimer.current);
			hideTimer.current = null;
		}
	};
	const showCard = (session: SessionInfoView, row: HTMLElement) => {
		cancelHide();
		const rect = row.getBoundingClientRect();
		const left = Math.min(rect.right + 8, window.innerWidth - 268);
		const top = Math.max(8, Math.min(rect.top - 6, window.innerHeight - 250));
		setHoverCard({ path: session.path, top, left });
	};
	const scheduleHide = () => {
		cancelHide();
		if (statusPickerOpen.current) return;
		hideTimer.current = window.setTimeout(() => setHoverCard(null), 150);
	};
	useEffect(() => cancelHide, []);

	/** Live task info behind a session id, for the hover card. */
	const taskOfSession = (sessionId: string) => {
		for (const engine of engines) {
			for (const task of engine.tasks) {
				if (task.sessionId === sessionId) return { engine, task };
			}
		}
		return undefined;
	};

	/** The row behind an open hover card, re-read every render so labels stay live. */
	const cardSession = hoverCard ? sessions.find((session) => session.path === hoverCard.path) : undefined;

	const setStatus = (next: "all" | "open") => {
		localStorage.setItem("sentinel-session-filter", next);
		setStatusFilter(next);
	};

	const setSource = (next: "all" | "chat" | "engine") => {
		localStorage.setItem("sentinel-session-source", next);
		setSourceFilter(next);
	};

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
		// Grouped rows already state their engine in the group heading, so the
		// historical 「工程名 · 」 prefix is stripped from what we display.
		const rawLabel = session.name ?? session.firstMessage.slice(0, 40);
		const label =
			session.engine && session.engine.engineName && rawLabel.startsWith(`${session.engine.engineName} · `)
				? rawLabel.slice(session.engine.engineName.length + 3)
				: rawLabel;
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
		const live = taskOfSession(session.id);
		const dotClass = session.engine
			? `sdot sd-${session.engine.taskStatus}`
			: runningSessions.includes(session.id)
				? "sdot sd-run"
				: "sdot sd-idle";
		return (
			<div
				key={session.path}
				role="button"
				tabIndex={0}
				className={`menu-sub-item session-row ${isActive ? "active" : ""}`}
				onClick={() => onSwitchSession(session.path)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") onSwitchSession(session.path);
				}}
				onMouseEnter={(event) => showCard(session, event.currentTarget)}
				onMouseLeave={scheduleHide}
			>
				<span
					className={dotClass}
					title={
						session.engine
							? t("工程任务：{status}", { status: TASK_TAG_LABELS[session.engine.taskStatus] ?? session.engine.taskStatus })
							: runningSessions.includes(session.id)
								? t("运行中")
								: undefined
					}
				/>
				<span className="menu-sub-name">{label}</span>
				<SessionStatusRail status={session.status} />
			</div>
		);
	};

	const sessionRows = () => (
		<div className="menu-sub">
			<div className="menu-sub-head">
				<span>
					{sessions.length === 0
						? t("暂无会话")
						: statusFilter === "open" || sourceFilter !== "all"
							? t("{visible} / {total} 个会话", { visible: visibleSessions.length, total: sessions.length })
							: t("{total} 个会话", { total: sessions.length })}
				</span>
				<span className="menu-sub-head-ops">
					<button type="button" className="menu-sub-add" title={t("新建会话")} onClick={() => onNewSession()}>
						＋
					</button>
				</span>
			</div>
			<div className="menu-sub-filters" title={t("未完成隐藏「已完成/已忽略」；对话/工程按会话来源筛选，可与未完成组合")}>
				<button
					type="button"
					className={statusFilter === "all" && sourceFilter === "all" ? "on" : ""}
					onClick={() => {
						setStatus("all");
						setSource("all");
					}}
				>
					{t("全部")}
				</button>
				<button
					type="button"
					className={statusFilter === "open" ? "on" : ""}
					onClick={() => setStatus(statusFilter === "open" ? "all" : "open")}
				>
					{t("未完成")}
				</button>
				<button
					type="button"
					className={sourceFilter === "chat" ? "on" : ""}
					disabled={!sessions.some((session) => !session.engine) && sourceFilter !== "chat"}
					onClick={() => setSource(sourceFilter === "chat" ? "all" : "chat")}
				>
					{t("对话")}
				</button>
				<button
					type="button"
					className={sourceFilter === "engine" ? "on" : ""}
					disabled={!sessions.some((session) => session.engine) && sourceFilter !== "engine"}
					onClick={() => setSource(sourceFilter === "engine" ? "all" : "engine")}
				>
					{t("工程")}
				</button>
			</div>
			{/*
			 * Under 全部 the two zones need a visible boundary: flat chat rows
			 * and the engine groups are different kinds of things, and mixing
			 * them without a separator reads as one jumbled list. The labels
			 * appear only when both zones actually have content.
			 */}
			{chatSessions.length > 0 && engineGroups.length > 0 ? (
				<div className="session-section-label">
					{t("对话")} <span className="n">{chatSessions.length}</span>
				</div>
			) : null}
			{chatSessions.map(sessionRow)}
			{chatSessions.length > 0 && engineGroups.length > 0 ? (
				<div className="session-section-label">
					{t("工程")} <span className="n">{engineGroups.reduce((sum, group) => sum + group.sessions.length, 0)}</span>
				</div>
			) : null}
			{engineGroups.map((group) => {
				const collapsed = collapsedEngines.has(group.engineName);
				const running = group.sessions.filter((session) => runningSessions.includes(session.id)).length;
				return (
					<div key={group.engineName}>
						<div
							className="engine-group-head"
							role="button"
							tabIndex={0}
							title={t("点击折叠 / 展开该工程的会话")}
							onClick={() => toggleEngineGroup(group.engineName)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") toggleEngineGroup(group.engineName);
							}}
						>
							<span className="caret">{collapsed ? "▸" : "▾"}</span>
							<span className={`engine-group-dot ${running > 0 ? "run" : ""}`} />
							<span className="engine-group-name">{group.engineName}</span>
							<span className="engine-group-count">
								{group.sessions.length}
								{running > 0 ? t(" · 运行 {count}", { count: running }) : ""}
							</span>
						</div>
						{collapsed ? null : group.sessions.map(sessionRow)}
					</div>
				);
			})}
		</div>
	);

	/** Badge on a menu row: an unconfigured endpoint, pending approvals, or unreviewed findings. */
	const badgeFor = (item: MenuEntry): string | null => {
		if (item.page === "settings.model" && !modelConfigured) return "!";
		if (item.page === "chat" && pendingApprovals > 0) return pendingApprovals > 9 ? "9+" : String(pendingApprovals);
		if (item.page === "vulns" && pendingVulns > 0) return pendingVulns > 9 ? "9+" : String(pendingVulns);
		return null;
	};

	return (
		<aside className={`sider ${collapsed ? "collapsed" : ""}`}>
			<div
				className="sider-brand"
				onClick={onToggleCollapse}
				title={t("全链哨兵 Full Chain Sentinel System")}
			>
				<div className="sider-logo">
					<SentinelMark size={18} />
				</div>
				<span className="sider-title">{t("全链哨兵")}</span>
				<button
					type="button"
					className="sider-collapse"
					title={collapsed ? t("展开侧边栏") : t("收起侧边栏")}
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
						<div className="menu-group">{collapsed ? "" : t(group.group)}</div>
						{group.items.map((item) => {
							const Icon = item.icon;
							const isChat = item.page === "chat";
							const isSettings = item.page === "settings.model";
							const active = activePage === item.page || (isSettings && activePage.startsWith("settings."));
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
									{hasChildren && childOpen && !collapsed ? (
										isChat ? (
											sessionRows()
										) : (
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
									) : null}
								</div>
							);
						})}
						{group.group === "工作台"
							? pluginPages.map((entry) => (
									<button
										key={entry.page}
										type="button"
										className={`menu-item plugin-menu-item ${activePage === entry.page ? "active" : ""}`}
										disabled={entry.disabled}
										title={entry.title}
										onClick={() => onNavigate(entry.page)}
									>
										{entry.iconUrl ? (
											<img className="menu-plugin-icon" src={entry.iconUrl} alt="" />
										) : (
											<PluginIcon />
										)}
										<span className="menu-label">{entry.label}</span>
									</button>
								))
							: null}
					</div>
				))}
			</nav>

			<div className="sider-footer">
				<div className="sider-foot-row">
					<span className="sider-foot-status">
						<span className={`dot ${connected ? "ok" : ""}`} />
						{connected ? SENTINEL_MODE_LABELS[mode] : t("已断开")}
					</span>
					{authUser ? (
						<span className="sider-foot-user" title={t("已登录：{user}", { user: authUser })}>
							{authUser}
						</span>
					) : null}
				</div>
				<div className="sider-foot-actions">
					{authUser ? (
						<button type="button" className="sider-foot-btn" title={t("退出登录")} onClick={onLogout}>
							<LogoutIcon />
						</button>
					) : null}
					<a
						className="sider-foot-btn"
						href={PROJECT_REPOSITORY}
						target="_blank"
						rel="noreferrer"
						title={t("源码仓库 · GitHub")}
						aria-label={t("打开 GitHub 源码仓库")}
					>
						<GitHubIcon />
					</a>
					<button
						type="button"
						className="sider-foot-btn sider-foot-lang"
						title={t("切换语言")}
						onClick={() => onSwitchLanguage(getLanguage() === "zh" ? "en" : "zh")}
					>
						{getLanguage() === "zh" ? "EN" : "中"}
					</button>
					<button type="button" className="sider-foot-btn" title={t("刷新当前页")} onClick={onRefresh}>
						<RefreshIcon />
					</button>
				</div>
			</div>
			{hoverCard && cardSession ? (
				<SessionHoverCard
					data={{ session: cardSession, top: hoverCard.top, left: hoverCard.left }}
					engines={engines}
					onRename={(session) => {
						setHoverCard(null);
						startRename(session);
					}}
					onSetStatus={onSetSessionStatus}
					onDelete={onDeleteSession}
					onEnter={cancelHide}
					onLeave={() => {
						if (statusPickerOpen.current) return;
						setHoverCard(null);
					}}
					onPickerOpenChange={(open) => {
						statusPickerOpen.current = open;
					}}
				/>
			) : null}
		</aside>
	);
}

/**
 * The session hover card, portaled to document.body so no ancestor's overflow
 * clipping can hide it. Pinned open while the pointer is over the card itself.
 */
function SessionHoverCard({
	data,
	engines,
	onRename,
	onSetStatus,
	onDelete,
	onEnter,
	onLeave,
	onPickerOpenChange,
}: {
	data: { session: SessionInfoView; top: number; left: number };
	engines: SentinelEngine[];
	onRename(session: SessionInfoView): void;
	onSetStatus(path: string, status: SentinelSessionStatus | null): void;
	onDelete(path: string): void;
	onEnter(): void;
	onLeave(): void;
	/** The status picker opened or closed; the card stays up while it is open. */
	onPickerOpenChange(open: boolean): void;
}) {
	const { session, top, left } = data;
	const label = session.name ?? session.firstMessage.slice(0, 40);
	const live = (() => {
		for (const engine of engines) {
			for (const task of engine.tasks) {
				if (task.sessionId === session.id) return { engine, task };
			}
		}
		return undefined;
	})();
	return createPortal(
		<div
			className="session-hovercard"
			style={{ top, left }}
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="hc-name">{label}</div>
			{session.engine ? (
				<div className="hc-row">
					<span>{t("工程")}</span>
					<b>{session.engine.engineName}</b>
				</div>
			) : null}
			{live ? (
				<div className="hc-row">
					<span>{t("任务状态")}</span>
					<b>
						{TASK_TAG_LABELS[live.task.status] ?? live.task.status}
						{live.task.status === "running" || live.task.status === "queued"
							? t(" · 轮 {used}/{limit}", { used: (live.task as { roundsUsed?: number }).roundsUsed ?? 0, limit: live.task.roundLimit })
							: ""}
					</b>
				</div>
			) : null}
			<div className="hc-row">
				<span>{t("人工标记")}</span>
				<b>{session.status ? SESSION_STATUS_LABELS[session.status] : t("未设置")}</b>
			</div>
			<div className="hc-row">
				<span>{t("最近活动")}</span>
				<b>{new Date(session.modified).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en-US", { hour12: false })}</b>
			</div>
			<div className="hc-actions">
				<button type="button" title={t("重命名")} onClick={() => onRename(session)}>
					✎ {t("改名")}
				</button>
				<SessionStatusControl
					variant="chip"
					status={session.status}
					onOpenChange={onPickerOpenChange}
					onPick={(next) => {
						onPickerOpenChange(false);
						onSetStatus(session.path, next);
					}}
				/>
				<button
					type="button"
					title={t("删除会话（不可恢复）")}
					onClick={() => {
						if (window.confirm(t("删除会话「{name}」？\n该操作不可恢复。", { name: label }))) onDelete(session.path);
					}}
				>
					🗑 {t("删除")}
				</button>
			</div>
		</div>,
		document.body,
	);
}
