import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApprovalQueue } from "./components/ApprovalQueue.tsx";
import { Composer } from "./components/Composer.tsx";
import { MarkdownText, MessageView } from "./components/MessageView.tsx";
import { ProjectPicker } from "./components/ProjectPicker.tsx";
import { OutputViewer, ToolCard } from "./components/ToolCard.tsx";
import { BranchModal } from "./components/BranchModal.tsx";
import { type SidebarTab, Sidebar } from "./components/Sidebar.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import type {
	AgentMessageView,
	ZGProjectInfo,
	SessionEventView,
	SessionInfoView,
	SessionTreeNodeView,
	ZGForkPoint,
	ZGModelConfig,
	ZGMode,
	ZGServerMessage,
	ZGStateSnapshot,
	ZGStatsView,
	ZGTestResult,
} from "./types.ts";
import { ZGConnection } from "./ws.ts";

interface LiveTool {
	id: string;
	name: string;
	command: string;
	status: "running" | "done" | "error";
	output: string;
	durationMs?: number;
}

function commandFromArgs(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const command = args.command ?? args.cmd ?? args.script;
	if (typeof command === "string") return command;
	return JSON.stringify(args, null, 2);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" && block !== null && (block as { type: string }).type === "text"
		)
		.map((block) => block.text)
		.join("");
}

export function App() {
	const [snapshot, setSnapshot] = useState<ZGStateSnapshot | null>(null);
	const [sessions, setSessions] = useState<SessionInfoView[]>([]);
	const [config, setConfig] = useState<ZGModelConfig | null>(null);
	const [stats, setStats] = useState<ZGStatsView | null>(null);
	const [liveText, setLiveText] = useState("");
	const [liveThinking, setLiveThinking] = useState("");
	const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
	const [errors, setErrors] = useState<string[]>([]);
	const [panelTab, setPanelTab] = useState<SidebarTab>("chat");
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("zg-sidebar-collapsed") === "1");
	const [branchOpen, setBranchOpen] = useState(() => localStorage.getItem("zg-branch-open") !== "0");
	const [projects, setProjects] = useState<ZGProjectInfo[]>([]);
	const [activeProject, setActiveProject] = useState<ZGProjectInfo | null>(null);
	const projectErrorRef = useRef<((message: string | null) => void) | null>(null);
	const [tree, setTree] = useState<SessionTreeNodeView[]>([]);
	const [leafId, setLeafId] = useState<string | null>(null);
	const [forkPoints, setForkPoints] = useState<ZGForkPoint[]>([]);
	const [viewer, setViewer] = useState<{ title: string; output: string } | null>(null);
	const [connected, setConnected] = useState(false);
	/** Messages sent from this console, shown optimistically until the snapshot absorbs them. */
	const [optimisticUserMessages, setOptimisticUserMessages] = useState<{ text: string; userCountAtSend: number }[]>([]);
	/** Queued steering/follow-up texts reported by queue_update events. */
	const [queuedMessages, setQueuedMessages] = useState<{ kind: "steer" | "followUp"; text: string }[]>([]);
	const connectionRef = useRef<ZGConnection | null>(null);
	const transcriptRef = useRef<HTMLDivElement | null>(null);
	const testResolverRef = useRef<((result: ZGTestResult | null) => void) | null>(null);
	const snapshotRef = useRef<ZGStateSnapshot | null>(null);

	const pushError = useCallback((message: string) => {
		setErrors((prev) => [...prev.slice(-4), message]);
		window.setTimeout(() => setErrors((prev) => prev.filter((item) => item !== message)), 8000);
	}, []);

	const refreshStats = useCallback(() => {
		connectionRef.current?.send({ type: "get_stats" });
	}, []);

	const handleServerMessage = useCallback(
		(message: ZGServerMessage) => {
			switch (message.type) {
				case "snapshot": {
					snapshotRef.current = message.snapshot;
					setSnapshot(message.snapshot);
					setLiveText("");
					setLiveThinking("");
					// Drop optimistic bubbles whose message has landed in the snapshot:
					// once the persisted user-message count covers the send, it is rendered there.
					const userCount = message.snapshot.messages.filter(
						(entry) => (entry as { role?: string }).role === "user",
					).length;
					setOptimisticUserMessages((prev) => prev.filter((item) => userCount < item.userCountAtSend + 1));
					setLiveTools((tools) =>
						tools.filter(
							(tool) =>
								!message.snapshot.messages.some(
									(entry) => (entry as { role?: string; toolCallId?: string }).role === "toolResult" && (entry as { toolCallId?: string }).toolCallId === tool.id,
								),
						),
					);
					break;
				}
				case "session_event":
					handleSessionEvent(message.event);
					break;
				case "sessions":
					setSessions(message.sessions);
					break;
				case "config":
					setConfig(message.config);
					break;
				case "test_result":
					if (testResolverRef.current) {
						const resolve = testResolverRef.current;
						testResolverRef.current = null;
						resolve(message.result);
					}
					break;
				case "stats":
					setStats(message.stats);
					break;
				case "tree":
					setTree(message.tree);
					setLeafId(message.leafId);
					setForkPoints(message.forkPoints);
					break;
				case "projects":
					setProjects(message.projects);
					setActiveProject((prev) => message.projects.find((project) => project.id === message.activeProjectId) ?? (message.activeProjectId === null ? null : prev));
					break;
				case "error":
					pushError(message.message);
					if (projectErrorRef.current) {
						const resolve = projectErrorRef.current;
						projectErrorRef.current = null;
						resolve(message.message);
					}
					break;
			}
		},
		[pushError],
	);

	const handleSessionEvent = useCallback((event: SessionEventView) => {
		if (event.type === "message_update" && event.assistantMessageEvent) {
			const delta = event.assistantMessageEvent as { type: string; delta?: string };
			if (delta.type === "text_delta" && typeof delta.delta === "string") {
				setLiveText((prev) => prev + delta.delta);
			} else if (delta.type === "thinking_delta" && typeof delta.delta === "string") {
				setLiveThinking((prev) => prev + delta.delta);
			}
		} else if (event.type === "message_end") {
			setLiveText("");
			setLiveThinking("");
		} else if (event.type === "tool_execution_start") {
			setLiveTools((prev) => [
				...prev,
				{
					id: event.toolCallId,
					name: event.toolName,
					command: commandFromArgs(event.args),
					status: "running",
					output: "",
				},
			]);
		} else if (event.type === "tool_execution_update") {
			const partial = event.partialResult as { content?: unknown } | null;
			const text = partial ? textFromContent(partial.content) : "";
			if (text) {
				setLiveTools((prev) => prev.map((tool) => (tool.id === event.toolCallId ? { ...tool, output: text } : tool)));
			}
		} else if (event.type === "tool_execution_end") {
			const text = event.result ? textFromContent(event.result.content) : "";
			setLiveTools((prev) =>
				prev.map((tool) =>
					tool.id === event.toolCallId
						? { ...tool, status: event.isError ? "error" : "done", output: text, durationMs: event.durationMs }
						: tool,
				),
			);
		} else if (event.type === "queue_update") {
			setQueuedMessages([
				...event.steering.map((text) => ({ kind: "steer" as const, text })),
				...event.followUp.map((text) => ({ kind: "followUp" as const, text })),
			]);
		} else if (event.type === "agent_settled") {
			// The run finished; any optimistic bubble not absorbed by the final
			// snapshot was consumed by an extension or dropped, so clear it. Messages
			// still queued are rendered from queue_update state.
			setOptimisticUserMessages([]);
			setQueuedMessages([]);
		}
	}, []);

	useEffect(() => {
		const connection = new ZGConnection((message) => {
			setConnected(true);
			handleServerMessage(message);
		});
		connectionRef.current = connection;
		connection.connect();
		const poll = window.setInterval(() => {
			if (connection.connected) connection.send({ type: "list_sessions" });
		}, 15000);
		connection.send({ type: "list_sessions" });
		connection.send({ type: "get_config" });
		connection.send({ type: "get_stats" });
		connection.send({ type: "list_projects" });
		return () => {
		window.clearInterval(poll);
		connection.close();
	};
	}, [handleServerMessage]);

	const send = useCallback((message: Parameters<ZGConnection["send"]>[0]) => {
		connectionRef.current?.send(message);
	}, []);

	const openPanelTab = useCallback(
		(tab: SidebarTab) => {
			setPanelTab(tab);
		},
		[],
	);

	const navigate = useCallback(
		(entryId: string) => {
			send({ type: "navigate", entryId });
			window.setTimeout(() => send({ type: "get_tree" }), 500);
		},
		[send],
	);

	const openViewer = useCallback((command: string | undefined, output: string) => {
		setViewer({ title: command ? command.slice(0, 80) : "工具输出", output });
	}, []);

	const mode: ZGMode = snapshot?.mode ?? "review";
	const streaming = snapshot?.streaming ?? false;
	const pendingApprovals = snapshot?.pendingApprovals ?? [];
	const needsConfig = snapshot !== null && !snapshot.modelConfigured;

	const visibleMessages = useMemo(
		() => (snapshot?.messages ?? []).filter((message) => message.role !== "system"),
		[snapshot],
	) as AgentMessageView[];

	const forkByUserOrder = useMemo(() => {
		let index = 0;
		return visibleMessages.map((message) =>
			message.role === "user" ? forkPoints[index++]?.entryId : undefined,
		);
	}, [visibleMessages, forkPoints]);

	useEffect(() => {
		if (!streaming) send({ type: "get_tree" });
	}, [streaming, send, snapshot?.messages.length]);

	useEffect(() => {
		if (!streaming) refreshStats();
	}, [streaming, refreshStats, snapshot?.messages.length]);

	return (
		<div className="app">
			<Sidebar
				activeTab={panelTab}
				collapsed={sidebarCollapsed}
				headerSlot={
					<ProjectPicker
						projects={projects}
						activeProject={snapshot?.project ?? null}
						streaming={streaming}
						onSwitch={(id) => send({ type: "switch_project", id })}
						onClear={() => send({ type: "switch_project", id: null })}
						onAdd={async (name) => {
							return await new Promise<string | null>((resolve) => {
								projectErrorRef.current = resolve;
								send({ type: "add_project", name });
								window.setTimeout(() => {
									if (projectErrorRef.current === resolve) {
										projectErrorRef.current = null;
										resolve(null);
									}
								}, 10000);
							});
						}}
						onRemove={async (id, confirmName) => {
							return await new Promise<string | null>((resolve) => {
								projectErrorRef.current = resolve;
								send({ type: "remove_project", id, confirmName });
								window.setTimeout(() => {
									if (projectErrorRef.current === resolve) {
										projectErrorRef.current = null;
										resolve(null);
									}
								}, 10000);
							});
						}}
					/>
				}
				mode={mode}
				streaming={streaming}
				connected={connected}
				modelConfigured={snapshot?.modelConfigured ?? false}
				stats={stats}
				allowedPrefixes={snapshot?.allowedPrefixes ?? []}
				sessions={sessions}
				activeSessionId={snapshot?.activeSessionId ?? null}
				runningSessions={snapshot?.runningSessions ?? []}
				pendingApprovals={pendingApprovals.length}
				onTab={(tab) => {
					if (sidebarCollapsed) setSidebarCollapsed(false);
					openPanelTab(tab);
				}}
				onToggleCollapse={() => {
					setSidebarCollapsed((prev) => {
						const next = !prev;
						localStorage.setItem("zg-sidebar-collapsed", next ? "1" : "0");
						return next;
					});
				}}
				onNewSession={() => send({ type: "new_session" })}
				onSwitchSession={(path) => {
					setPanelTab("chat");
					send({ type: "switch_session", path });
				}}
				onRenameSession={(path, name) => send({ type: "rename_session", path, name })}
				onDeleteSession={(path) => send({ type: "delete_session", path })}
				onAllowPrefix={(prefix) => send({ type: "allow_prefix", prefix })}
				onRemoveAllowedPrefix={(prefix) => send({ type: "remove_allowed_prefix", prefix })}
			/>
			<main className="main">
				{panelTab === "chat" ? (
					<div className="chat-wrap">
							<div className="transcript" ref={transcriptRef}>
								{visibleMessages.length === 0 && !liveText && !streaming ? (
									<div className="empty">
										{needsConfig
											? "请先在左侧「模型设置」中配置 OpenAI 兼容端点。\n输入目标范围和任务，开始渗透测试。"
											: "输入目标范围和任务，开始渗透测试。\n例如：对 10.10.10.5 进行全端口侦察，或派子代理并行侦察多个目标。"}
									</div>
								) : null}
								{visibleMessages.map((message, index) => (
									<MessageView
										key={index}
										message={message}
										forkEntryId={forkByUserOrder[index]}
										onFork={streaming ? undefined : navigate}
										onFullscreen={openViewer}
									/>
								))}
								{optimisticUserMessages.map((item, index) => (
									<div key={`optimistic-${index}`} className="entry operator">
										<div className="entry-head">
											<span className="role-tag operator">OPERATOR</span>
										</div>
										<div className="entry-body pending">{item.text}</div>
									</div>
								))}
								{queuedMessages.map((item, index) => (
									<div key={`queued-${index}`} className="entry operator">
										<div className="entry-head">
											<span className="role-tag operator">OPERATOR</span>
										</div>
										<div className="entry-body queued">
											{item.kind === "steer" ? "⏱ 插话中：" : "⏳ 排队中："}
											{item.text}
										</div>
									</div>
								))}
								{liveThinking ? (
									<div className="entry agent">
										<div className="entry-head">
											<span className="role-tag agent">AGENT</span>
										</div>
										<details className="thinking" open>
											<summary>思考中…</summary>
											<pre>{liveThinking}</pre>
										</details>
									</div>
								) : null}
								{liveTools.map((tool) => (
									<ToolCard
										key={tool.id}
										name={tool.name}
										status={tool.status}
										durationMs={tool.durationMs}
										command={tool.command}
										output={tool.output}
										onFullscreen={openViewer}
									/>
								))}
								{liveText ? (
									<div className="entry agent">
										<div className="entry-head">
											<span className="role-tag agent">AGENT</span>
										</div>
										<div className="entry-body streaming">
										<MarkdownText text={liveText} />
									</div>
									</div>
								) : null}
							</div>
							<Composer
								streaming={streaming}
								mode={mode}
								pendingApprovals={pendingApprovals.length}
								stats={stats}
								branchOpen={branchOpen}
								onSetMode={(next) => send({ type: "set_mode", mode: next })}
								onToggleBranch={() => {
									setBranchOpen((prev) => {
										const next = !prev;
										localStorage.setItem("zg-branch-open", next ? "1" : "0");
										return next;
									});
									send({ type: "get_tree" });
								}}
								onSend={(text, behavior) => {
									const userCount = (snapshotRef.current?.messages ?? []).filter(
										(entry) => (entry as { role?: string }).role === "user",
									).length;
									setOptimisticUserMessages((prev) => [...prev, { text, userCountAtSend: userCount }]);
									send({ type: "prompt", text, streamingBehavior: behavior });
								}}
								onAbort={() => send({ type: "abort" })}
							/>
						</div>
				) : (
					<div className="page-card">
						<h2>模型设置</h2>
						<SettingsPanel
							config={config}
							onSave={(next) => send({ type: "save_config", config: next })}
							onTest={async (candidate) => {
								const result = await new Promise<ZGTestResult | null>((resolve) => {
									testResolverRef.current = resolve;
									connectionRef.current?.send({ type: "test_config", config: candidate });
									window.setTimeout(() => {
										if (testResolverRef.current === resolve) {
											testResolverRef.current = null;
											resolve(null);
										}
									}, 20000);
								});
								return result;
							}}
						/>
					</div>
				)}
			</main>
			{branchOpen && panelTab === "chat" ? (
				<BranchModal
					tree={tree}
					leafId={leafId}
					forkPoints={forkPoints}
					onNavigate={navigate}
					onRenameBranch={(entryId, label) => send({ type: "rename_branch", entryId, label })}
					onClose={() => {
						setBranchOpen(false);
						localStorage.setItem("zg-branch-open", "0");
					}}
				/>
			) : null}
			{pendingApprovals.length > 0 ? (
				<ApprovalQueue
					requests={pendingApprovals}
					onDecide={(id, approved, command, alwaysAllowPrefix) =>
						send({ type: "decide", decision: { id, approved, command, alwaysAllowPrefix } })
					}
					onDecideAll={(approved) => send({ type: "decide_all", approved })}
				/>
			) : null}
			{viewer ? <OutputViewer title={viewer.title} output={viewer.output} onClose={() => setViewer(null)} /> : null}
			<div className="toasts">
				{errors.map((error, index) => (
					<div key={index} className="toast">
						{error}
					</div>
				))}
			</div>
		</div>
	);
}
