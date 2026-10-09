import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApprovalQueue } from "./components/ApprovalQueue.tsx";
import { Composer } from "./components/Composer.tsx";
import { type FilePanelState, FilePanel, saveDownload } from "./components/FilePanel.tsx";
import { MarkdownText, MessageView } from "./components/MessageView.tsx";
import { NotifyPanel } from "./components/NotifyPanel.tsx";
import { ProjectGate } from "./components/ProjectGate.tsx";
import { ProjectPicker } from "./components/ProjectPicker.tsx";
import { type SidePanelTab, SidePanel } from "./components/SidePanel.tsx";
import { SubagentPanel } from "./components/SubagentPanel.tsx";
import { OutputViewer, ToolCard } from "./components/ToolCard.tsx";
import { BranchModal } from "./components/BranchModal.tsx";
import { type SidebarTab, Sidebar } from "./components/Sidebar.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import type {
	AgentMessageView,
	ZGFileEntry,
	ZGFilePreview,
	ZGProjectInfo,
	SessionEventView,
	SessionInfoView,
	SessionTreeNodeView,
	ZGForkPoint,
	ZGModelConfig,
	ZGMode,
	ZGNotifyConfig,
	ZGNotifyStatus,
	ZGServerMessage,
	ZGStateSnapshot,
	ZGStatsView,
	ZGSubagentEvent,
	ZGSubagentRun,
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
	const [notifyConfig, setNotifyConfig] = useState<ZGNotifyConfig>({
		enabled: false,
		webhook: "",
		secret: "",
		keyword: "",
	});
	const [notifyStatus, setNotifyStatus] = useState<ZGNotifyStatus>({ at: null, ok: true });
	/** Settings page section: model endpoint or DingTalk notifications. */
	const [settingsSection, setSettingsSection] = useState<"model" | "notify">("model");
	/**
	 * Composer choice for the next run: true/false once the operator toggles the
	 * pill, null while it simply follows the global switch.
	 */
	const [notifyRun, setNotifyRun] = useState<boolean | null>(null);
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
	const [optimisticUserMessages, setOptimisticUserMessages] = useState<
		{ text: string; imageCount: number; userCountAtSend: number }[]
	>([]);
	/** Queued steering/follow-up texts reported by queue_update events. */
	const [queuedMessages, setQueuedMessages] = useState<{ kind: "steer" | "followUp"; text: string }[]>([]);
	/** Right-hand drawer: null when closed. */
	const [sidePanel, setSidePanel] = useState<SidePanelTab | null>(null);
	const [filePath, setFilePath] = useState("/work");
	const [fileEntries, setFileEntries] = useState<ZGFileEntry[]>([]);
	const [filePreview, setFilePreview] = useState<ZGFilePreview | null>(null);
	const [fileBusy, setFileBusy] = useState(false);
	/** Loaded process steps per sub-agent run; a run absent here is not expanded. */
	const [subagentTranscripts, setSubagentTranscripts] = useState<Record<string, ZGSubagentEvent[]>>({});
	const connectionRef = useRef<ZGConnection | null>(null);
	const transcriptRef = useRef<HTMLDivElement | null>(null);
	const testResolverRef = useRef<((result: ZGTestResult | null) => void) | null>(null);
	const notifyTestResolverRef = useRef<((result: ZGTestResult | null) => void) | null>(null);
	const snapshotRef = useRef<ZGStateSnapshot | null>(null);
	/** Directory the file panel is showing; read by handlers that must re-list it. */
	const filePathRef = useRef("/work");
	/** Open drawer tab, readable from effects that must not re-run when it changes. */
	const sidePanelRef = useRef<SidePanelTab | null>(null);
	/** Path the preview pane is showing, so a write can refresh it. */
	const previewPathRef = useRef<string | null>(null);

	const pushError = useCallback((message: string) => {
		setErrors((prev) => [...prev.slice(-4), message]);
		window.setTimeout(() => setErrors((prev) => prev.filter((item) => item !== message)), 8000);
	}, []);

	const refreshStats = useCallback(() => {
		connectionRef.current?.send({ type: "get_stats" });
	}, []);

	/** Show a directory in the file panel (also used to refresh the current one). */
	const loadFiles = useCallback((path: string) => {
		filePathRef.current = path;
		setFilePath(path);
		setFileBusy(true);
		setFilePreview(null);
		previewPathRef.current = null;
		connectionRef.current?.send({ type: "list_files", path });
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
				case "notify_config":
					setNotifyConfig(message.config);
					setNotifyStatus(message.status);
					break;
				case "notify_test_result":
					if (notifyTestResolverRef.current) {
						const resolve = notifyTestResolverRef.current;
						notifyTestResolverRef.current = null;
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
				case "files":
					filePathRef.current = message.path;
					setFilePath(message.path);
					setFileEntries(message.entries);
					setFileBusy(false);
					break;
				case "file_preview":
					previewPathRef.current = message.preview.path;
					setFilePreview(message.preview);
					setFileBusy(false);
					break;
				case "file_download":
					saveDownload(message.path, message.data, message.mimeType);
					setFileBusy(false);
					break;
				case "file_result":
					setFileBusy(false);
					if (!message.ok) {
						if (message.error) pushError(message.error);
					} else if (message.action === "删除" || message.action === "重命名") {
						// The previewed path is gone or moved; drop the pane.
						previewPathRef.current = null;
						setFilePreview(null);
					} else if (message.action === "保存" || message.action === "上传") {
						// Re-read so the pane shows what was actually written.
						if (previewPathRef.current) {
							connectionRef.current?.send({ type: "read_file", path: previewPathRef.current });
						}
					}
					// Any mutation changes the listing; re-read it and refresh the snapshot.
					connectionRef.current?.send({ type: "list_files", path: filePathRef.current });
					connectionRef.current?.send({ type: "get_state" });
					break;
				case "subagent_run":
					setSubagentTranscripts((prev) => ({ ...prev, [message.run.id]: message.run.events ?? [] }));
					break;
				case "subagent_event":
					setSubagentTranscripts((prev) => {
						const existing = prev[message.runId];
						if (!existing) return prev;
						return { ...prev, [message.runId]: [...existing, message.event] };
					});
					break;
				case "subagent_result":
					if (!message.ok && message.error) pushError(message.error);
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
		connection.send({ type: "get_notify_config" });
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

	/** Create a project and resolve with the server's error message, if any. */
	const addProject = useCallback(
		async (name: string): Promise<string | null> => {
			return await new Promise<string | null>((resolve) => {
				projectErrorRef.current = resolve;
				send({ type: "add_project", name });
				window.setTimeout(() => {
					if (projectErrorRef.current === resolve) {
						projectErrorRef.current = null;
						resolve(null);
					}
				}, 60000);
			});
		},
		[send],
	);

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

	const toggleSidePanel = useCallback(
		(tab: SidePanelTab) => {
			setSidePanel((prev) => {
				const next = prev === tab ? null : tab;
				sidePanelRef.current = next;
				return next;
			});
			if (tab === "files") loadFiles(filePathRef.current);
		},
		[loadFiles],
	);

	// A different project means a different container: drop anything cached from
	// the previous one and re-read the work directory if the panel is open.
	useEffect(() => {
		setFilePath("/work");
		filePathRef.current = "/work";
		setFileEntries([]);
		setFilePreview(null);
		setSubagentTranscripts({});
		if (sidePanelRef.current === "files") loadFiles("/work");
	}, [snapshot?.project?.id, loadFiles]);

	const mode: ZGMode = snapshot?.mode ?? "review";
	const streaming = snapshot?.streaming ?? false;
	const pendingApprovals = snapshot?.pendingApprovals ?? [];
	const needsConfig = snapshot !== null && !snapshot.modelConfigured;
	/** No project means no container, so the console blocks the chat entirely. */
	const needsProject = snapshot !== null && snapshot.project === null;
	const subagentRuns = snapshot?.subagents ?? [];
	const subagentRunning = subagentRuns.filter((run) => run.status === "running").length;

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
						onAdd={addProject}
						onRemove={async (id, confirmName) => {
							return await new Promise<string | null>((resolve) => {
								projectErrorRef.current = resolve;
								send({ type: "remove_project", id, confirmName });
								window.setTimeout(() => {
									if (projectErrorRef.current === resolve) {
										projectErrorRef.current = null;
										resolve(null);
									}
								}, 60000);
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
				{needsProject ? (
					<ProjectGate
						projects={projects}
						busy={streaming}
						onCreate={addProject}
						onSwitch={(id) => send({ type: "switch_project", id })}
						onOpenSettings={() => setPanelTab("settings")}
					/>
				) : panelTab === "chat" ? (
					<div className="chat-wrap">
							<div className="transcript" ref={transcriptRef}>
								{visibleMessages.length === 0 && !liveText && !streaming ? (
									<div className="empty">
										{needsConfig
											? "请先在左侧「设置 → 模型」中配置 OpenAI 兼容端点。\n输入目标范围和任务，开始渗透测试。"
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
										<div className="entry-body pending">
											{item.text}
											{item.imageCount > 0 ? `（附 ${item.imageCount} 张图片）` : ""}
										</div>
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
								sidePanel={sidePanel}
								hasProject={snapshot?.project !== null && snapshot?.project !== undefined}
								subagentRunning={subagentRunning}
								notifyRun={notifyRun ?? notifyConfig.enabled}
								onToggleNotifyRun={() => setNotifyRun(!(notifyRun ?? notifyConfig.enabled))}
								onToggleSidePanel={toggleSidePanel}
								thinkingLevel={snapshot?.thinkingLevel ?? "off"}
								availableThinkingLevels={snapshot?.availableThinkingLevels ?? []}
								onSetMode={(next) => send({ type: "set_mode", mode: next })}
								onSetThinkingLevel={(level) => send({ type: "set_thinking_level", level })}
								onCompact={() => send({ type: "compact" })}
								onToggleBranch={() => {
									setBranchOpen((prev) => {
										const next = !prev;
										localStorage.setItem("zg-branch-open", next ? "1" : "0");
										return next;
									});
									send({ type: "get_tree" });
								}}
								onSend={(text, behavior, images) => {
									const userCount = (snapshotRef.current?.messages ?? []).filter(
										(entry) => (entry as { role?: string }).role === "user",
									).length;
									setOptimisticUserMessages((prev) => [
										...prev,
										{ text, imageCount: images?.length ?? 0, userCountAtSend: userCount },
									]);
									send({
										type: "prompt",
										text,
										streamingBehavior: behavior,
										images,
										notify: notifyRun ?? notifyConfig.enabled,
									});
								}}
								onAbort={() => send({ type: "abort" })}
							/>
						</div>
				) : (
					<div className="page-card">
						<h2>设置</h2>
						<div className="settings-sections">
							<button
								type="button"
								className={`settings-section${settingsSection === "model" ? " active" : ""}`}
								onClick={() => setSettingsSection("model")}
							>
								模型
							</button>
							<button
								type="button"
								className={`settings-section${settingsSection === "notify" ? " active" : ""}`}
								onClick={() => setSettingsSection("notify")}
							>
								通知
							</button>
						</div>
						{settingsSection === "model" ? (
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
						) : (
							<NotifyPanel
								config={notifyConfig}
								status={notifyStatus}
								onSave={(next) => send({ type: "save_notify_config", config: next })}
								onTest={async (candidate) => {
									const result = await new Promise<ZGTestResult | null>((resolve) => {
										notifyTestResolverRef.current = resolve;
										connectionRef.current?.send({ type: "test_notify", config: candidate });
										window.setTimeout(() => {
											if (notifyTestResolverRef.current === resolve) {
												notifyTestResolverRef.current = null;
												resolve(null);
											}
										}, 40000);
									});
									return result;
								}}
							/>
						)}
					</div>
				)}
			</main>
			<SidePanel
				open={sidePanel !== null && !needsProject}
				tab={sidePanel ?? "files"}
				projectName={snapshot?.project?.name ?? null}
				fileCount={fileEntries.length}
				runningCount={subagentRunning}
				onTab={(tab) => toggleSidePanel(tab)}
				onClose={() => {
					setSidePanel(null);
					sidePanelRef.current = null;
				}}
			>
				{sidePanel === "files" ? (
					<FilePanel
						state={{ path: filePath, entries: fileEntries, preview: filePreview, busy: fileBusy }}
						onOpen={loadFiles}
						onPreview={(path) => {
							setFileBusy(true);
							send({ type: "read_file", path });
						}}
						onSave={(path, text) => {
							setFileBusy(true);
							send({ type: "write_file", path, text });
						}}
						onUpload={(path, data) => {
							setFileBusy(true);
							send({ type: "upload_file", path, data });
						}}
						onDelete={(path) => {
							setFileBusy(true);
							send({ type: "delete_path", path });
						}}
						onRename={(from, to) => {
							setFileBusy(true);
							send({ type: "rename_path", from, to });
						}}
						onMkdir={(path) => {
							setFileBusy(true);
							send({ type: "make_directory", path });
						}}
						onDownload={(path) => {
							setFileBusy(true);
							send({ type: "download_file", path });
						}}
					/>
				) : (
					<SubagentPanel
						runs={subagentRuns}
						transcripts={subagentTranscripts}
						onLoad={(id) => send({ type: "get_subagent", id })}
						onAbort={(id) => send({ type: "abort_subagent", id })}
						onSteer={(id, text) => send({ type: "steer_subagent", id, text })}
					/>
				)}
			</SidePanel>
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
