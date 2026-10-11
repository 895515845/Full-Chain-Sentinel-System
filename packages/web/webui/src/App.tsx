import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AboutPage } from "./components/AboutPage.tsx";
import { ApprovalQueue } from "./components/ApprovalQueue.tsx";
import { AppSider } from "./components/AppSider.tsx";
import { ChatToolbar } from "./components/ChatToolbar.tsx";
import { Composer } from "./components/Composer.tsx";
import { type FilePanelState, FilePanel, saveDownload } from "./components/FilePanel.tsx";
import { GoalBar } from "./components/GoalBar.tsx";
import { GoalStartDialog } from "./components/GoalStartDialog.tsx";
import { AgentEntry, MarkdownText, MessageView } from "./components/MessageView.tsx";
import { RunFold } from "./components/RunFold.tsx";
import { NotifyPanel } from "./components/NotifyPanel.tsx";
import { Overlay } from "./components/Overlay.tsx";
import { EnvironmentPanel } from "./components/EnvironmentPanel.tsx";
import { PermissionsPanel } from "./components/PermissionsPanel.tsx";
import { ProjectGate } from "./components/ProjectGate.tsx";
import { ProjectPicker } from "./components/ProjectPicker.tsx";
import { ProjectsPage } from "./components/ProjectsPage.tsx";
import { SubagentPanel } from "./components/SubagentPanel.tsx";
import { OutputViewer, ToolCard } from "./components/ToolCard.tsx";
import { BranchModal } from "./components/BranchModal.tsx";
import { EnginePage } from "./components/EnginePage.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { VulnDetail, VulnPage } from "./components/VulnPage.tsx";
import { groupRuns, messageKey, runFoldState, textFromContent } from "./transcript.ts";
import type {
	AgentMessageView,
	ZGEnvReport,
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
	ZGPageId,
	ZGPermissionPreset,
	ZGPermissionsConfig,
	ZGPermissionSet,
	ZGServerMessage,
	ZGStateSnapshot,
	ZGStatsView,
	ZGSubagentEvent,
	ZGSubagentRun,
	ZGTestResult,
	ZGToolInfo,
	ZGVulnFilters,
	ZGVulnStats,
	ZGVulnSummary,
	ZGVulnUpdate,
	ZGVulnerability,
	ZGEngine,
	ZGDoctrineView,
	ZGClientMessage,
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
	// File tools name their target in `path`; dumping the whole argument object
	// would print file contents into the summary row.
	const path = args.path ?? args.file_path ?? args.filePath;
	if (typeof path === "string") return path;
	return JSON.stringify(args);
}

/** Command of the tool call a result message answers, when the transcript has it. */
/**
 * How long the round a goal continuation marker closed took: from the previous
 * boundary (an operator prompt or an earlier round marker) to this marker.
 * Returns undefined when the timestamps needed are missing.
 */
/**
 * Whether the operator sent anything after the goal ended: the terminal badge
 * belongs to the goal's stretch, not to whatever conversation followed it.
 */
function chattedAfterGoalEnd(messages: unknown[], goal: { endedAt?: number }): boolean {
	const endedAt = goal.endedAt;
	if (!endedAt) return false;
	return messages.some(
		(entry) => (entry as { role?: string }).role === "user" && ((entry as { timestamp?: number }).timestamp ?? 0) > endedAt,
	);
}

/** Compact total duration for the terminal goal badge. */
function formatGoalTotalMs(ms: number): string {
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return `${minutes} 分`;
	return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

function goalMarkerElapsed(messages: unknown[], marker: AgentMessageView): number | undefined {
	const markerTime = (marker as { timestamp?: number }).timestamp;
	const index = messages.findIndex(
		(entry) =>
			(entry as { customType?: string }).customType === "zg-goal" &&
			messageKey(entry as { role?: string; timestamp?: number }) ===
				messageKey(marker as { role?: string; timestamp?: number }),
	);
	if (index <= 0 || markerTime === undefined) return undefined;
	for (let i = index - 1; i >= 0; i -= 1) {
		const entry = messages[i] as { role?: string; customType?: string; timestamp?: number };
		if (entry.role === "user" || entry.customType === "zg-goal") {
			if (!entry.timestamp) return undefined;
			return Math.max(0, markerTime - entry.timestamp);
		}
	}
	return undefined;
}

function toolCommandOf(message: AgentMessageView, commands: Map<string, string>): string | undefined {
	return message.role === "toolResult" ? commands.get(message.toolCallId) : undefined;
}

/** Whether an assistant turn carries something to render on its own. */
function hasVisibleAssistantContent(message: AgentMessageView): boolean {
	if (message.role !== "assistant") return true;
	if (message.errorMessage) return true;
	return message.content.some((block) => {
		const typed = block as { type?: string; text?: string; thinking?: string };
		return (
			(typed.type === "text" && (typed.text ?? "").length > 0) ||
			(typed.type === "thinking" && (typed.thinking ?? "").length > 0)
		);
	});
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
		summaryLimit: 2000,
	});
	const [notifyStatus, setNotifyStatus] = useState<ZGNotifyStatus>({ at: null, ok: true });
	const [permissions, setPermissions] = useState<ZGPermissionsConfig | null>(null);
	const [permissionPresets, setPermissionPresets] = useState<ZGPermissionPreset[]>([]);
	const [permissionTools, setPermissionTools] = useState<ZGToolInfo[]>([]);
	const [permissionEffective, setPermissionEffective] = useState<ZGPermissionSet | null>(null);
	const [permissionBusy, setPermissionBusy] = useState(false);
	/**
	 * Composer choice for the next run: true/false once the operator toggles the
	 * pill, null while it simply follows the global switch.
	 */
	const [notifyRun, setNotifyRun] = useState<boolean | null>(null);
	const [stats, setStats] = useState<ZGStatsView | null>(null);
	const [liveText, setLiveText] = useState("");
	const [liveThinking, setLiveThinking] = useState("");
	const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
	/**
	 * Messages the event stream has already committed but the snapshot does not
	 * carry yet. A run only refreshes the snapshot when it settles, so without
	 * this the assistant's text would vanish at every message_end and the
	 * transcript would read as a jumble until a manual refresh.
	 */
	const [pendingMessages, setPendingMessages] = useState<AgentMessageView[]>([]);
	/** Runs the operator opened by hand; they stay open instead of re-folding. */
	const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
	const [errors, setErrors] = useState<string[]>([]);
	/** The one page the content area shows; navigation lives in the sider. */
	const [page, setPage] = useState<ZGPageId>("chat");
	/** Overlays opened from the chat toolbar. */
	const [filesOpen, setFilesOpen] = useState(false);
	const [subagentsOpen, setSubagentsOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("zg-sidebar-collapsed") === "1");
	// The branch tree is a modal now, so it starts closed.
	const [branchOpen, setBranchOpen] = useState(() => localStorage.getItem("zg-branch-open") === "1");
	const [projects, setProjects] = useState<ZGProjectInfo[]>([]);
	const [activeProject, setActiveProject] = useState<ZGProjectInfo | null>(null);
	const projectErrorRef = useRef<((message: string | null) => void) | null>(null);
	const [tree, setTree] = useState<SessionTreeNodeView[]>([]);
	const [leafId, setLeafId] = useState<string | null>(null);
	const [forkPoints, setForkPoints] = useState<ZGForkPoint[]>([]);
	const [viewer, setViewer] = useState<{ title: string; output: string } | null>(null);
	/** The persistent-goal start dialog. It is only reachable in auto mode. */
	const [goalOpen, setGoalOpen] = useState(false);
	const [connected, setConnected] = useState(false);
	/**
	 * Whether the active session is running right now. The server only broadcasts a
	 * snapshot when a run starts and ends, so the events are what keep this current
	 * during a run; every snapshot then re-states it authoritatively.
	 */
	const [runActive, setRunActive] = useState(false);
	/** Docker environment report: the console is locked while it is missing or failing. */
	const [envReport, setEnvReport] = useState<ZGEnvReport | null>(null);
	const [imageBuilding, setImageBuilding] = useState(false);
	const [buildLog, setBuildLog] = useState<string[]>([]);
	const [sourcesSavedAt, setSourcesSavedAt] = useState<number | null>(null);
	/** Messages sent from this console, shown optimistically until the snapshot absorbs them. */
	const [optimisticUserMessages, setOptimisticUserMessages] = useState<
		{ text: string; imageCount: number; userCountAtSend: number }[]
	>([]);
	/** Queued steering/follow-up texts reported by queue_update events. */
	const [queuedMessages, setQueuedMessages] = useState<{ kind: "steer" | "followUp"; text: string }[]>([]);
	const [filePath, setFilePath] = useState("/work");
	const [fileEntries, setFileEntries] = useState<ZGFileEntry[]>([]);
	const [filePreview, setFilePreview] = useState<ZGFilePreview | null>(null);
	const [fileBusy, setFileBusy] = useState(false);
	/** Loaded process steps per sub-agent run; a run absent here is not expanded. */
	const [subagentTranscripts, setSubagentTranscripts] = useState<Record<string, ZGSubagentEvent[]>>({});
	/** Vulnerability hub: the active project's findings, its counts, and the current filter. */
	const [vulnItems, setVulnItems] = useState<ZGVulnSummary[]>([]);
	const [vulnStats, setVulnStats] = useState<ZGVulnStats>({
		total: 0,
		bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
		byStatus: { pending: 0, confirmed: 0, false_positive: 0, fixed: 0 },
	});
	const [vulnFilters, setVulnFilters] = useState<ZGVulnFilters>({});
	/** The record the detail overlay shows, and the evidence file it is previewing. */
	const [vulnDetail, setVulnDetail] = useState<ZGVulnerability | null>(null);
	const [vulnPreview, setVulnPreview] = useState<ZGFilePreview | null>(null);
	/** Engineering mode: engines, doctrines, commander endpoint, and mirrored event logs. */
	const [engines, setEngines] = useState<ZGEngine[]>([]);
	const [doctrines, setDoctrines] = useState<ZGDoctrineView[]>([]);
	const [commanderConfig, setCommanderConfig] = useState<ZGModelConfig | null>(null);
	const [commanderEvents, setCommanderEvents] = useState<Record<string, ZGSubagentEvent[]>>({});
	const [engineTaskEvents, setEngineTaskEvents] = useState<Record<string, ZGSubagentEvent[]>>({});
	const connectionRef = useRef<ZGConnection | null>(null);
	const transcriptRef = useRef<HTMLDivElement | null>(null);
	const testResolverRef = useRef<((result: ZGTestResult | null) => void) | null>(null);
	const notifyTestResolverRef = useRef<((result: ZGTestResult | null) => void) | null>(null);
	const snapshotRef = useRef<ZGStateSnapshot | null>(null);
	/** Directory the file panel is showing; read by handlers that must re-list it. */
	const filePathRef = useRef("/work");
	/** Path the preview pane is showing, so a write can refresh it. */
	const previewPathRef = useRef<string | null>(null);
	/** Set while a hub evidence preview is in flight, so its reply does not feed the file panel. */
	const vulnPreviewPathRef = useRef<string | null>(null);

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
					// Drop optimistic bubbles whose message has landed in the snapshot:
					// once the persisted user-message count covers the send, it is rendered there.
					const userCount = message.snapshot.messages.filter(
						(entry) => (entry as { role?: string }).role === "user",
					).length;
					setOptimisticUserMessages((prev) => prev.filter((item) => userCount < item.userCountAtSend + 1));
					// The snapshot is authoritative: anything it already carries stops
					// being rendered from the event-built lists. A message is matched by
					// role plus timestamp, and by content when it has none.
					const persisted = new Set(
						message.snapshot.messages.map(
							(entry) => messageKey(entry as { role?: string; timestamp?: number }),
						),
					);
					setPendingMessages((prev) => prev.filter((entry) => !persisted.has(messageKey(entry))));
					setLiveTools((tools) =>
						tools.filter(
							(tool) =>
								!message.snapshot.messages.some(
									(entry) => (entry as { role?: string; toolCallId?: string }).role === "toolResult" && (entry as { toolCallId?: string }).toolCallId === tool.id,
								),
						),
					);
					setRunActive(message.snapshot.streaming);
					// Only the settled snapshot may drop the in-flight text: a snapshot
					// taken mid-run (a file operation, another window) must not erase it.
					if (!message.snapshot.streaming) {
						setLiveText("");
						setLiveThinking("");
					}
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
				case "permissions":
					setPermissions(message.config);
					setPermissionEffective(message.effectiveSubagent);
					setPermissionPresets(message.presets);
					setPermissionTools(message.tools);
					setPermissionBusy(false);
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
				case "environment": {
					setEnvReport(message.report);
					setImageBuilding(message.building);
					if (message.building) setBuildLog([]);
					return;
				}
				case "sources_saved": {
					if (message.error) {
						pushError(`构建源保存失败：${message.error}`);
						return;
					}
					setSourcesSavedAt(Date.now());
					return;
				}
				case "image_build_log":
					setBuildLog((prev) => [...prev.slice(-499), message.line]);
					return;
				case "image_build_result": {
					setImageBuilding(false);
					if (!message.ok) {
						pushError(`镜像构建失败：${message.error ?? "未知错误"}`);
					} else {
						pushError("工具镜像构建完成，可点击「复检」确认");
					}
					return;
				}
				case "stats":
					setStats(message.stats);
					break;
				case "engines":
					setEngines(message.engines);
					break;
				case "engine_update":
					setEngines((prev) => {
						const index = prev.findIndex((engine) => engine.id === message.engine.id);
						if (index === -1) return [message.engine, ...prev];
						const next = [...prev];
						next[index] = message.engine;
						return next;
					});
					break;
				case "engine_commander_events":
					setCommanderEvents((prev) => ({ ...prev, [message.id]: message.events }));
					break;
				case "engine_commander_event":
					setCommanderEvents((prev) => ({
						...prev,
						[message.engineId]: [...(prev[message.engineId] ?? []).slice(-499), message.event],
					}));
					break;
				case "engine_task_event":
					setEngineTaskEvents((prev) => ({
						...prev,
						[message.taskId]: [...(prev[message.taskId] ?? []).slice(-999), message.event],
					}));
					break;
				case "engine_task_events":
					setEngineTaskEvents((prev) => ({ ...prev, [message.taskId]: message.events }));
					break;
				case "engine_report": {
					const blob = new Blob([message.markdown], { type: "text/markdown" });
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = message.filename;
					anchor.click();
					URL.revokeObjectURL(url);
					break;
				}
				case "doctrines":
					setDoctrines(message.doctrines);
					break;
				case "doctrine_saved": {
					if (message.error) {
						pushError(`思路保存失败：${message.error}`);
						return;
					}
					send({ type: "list_doctrines" });
					break;
				}
				case "doctrine_deleted":
					if (!message.ok) pushError(`思路删除失败：${message.error ?? "未知错误"}`);
					else send({ type: "list_doctrines" });
					break;
				case "commander_config":
					setCommanderConfig(message.config);
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
					// A preview requested by the hub's evidence list must not overwrite
					// the file panel's own preview pane.
					if (vulnPreviewPathRef.current === message.preview.path) {
						vulnPreviewPathRef.current = null;
						setVulnPreview(message.preview);
						break;
					}
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
				case "vulns":
					setVulnItems(message.items);
					setVulnStats(message.stats);
					// The list is the hub's source of truth, so a refreshed record is
					// dropped into the open detail rather than closing it.
					setVulnDetail((prev) => {
						if (!prev) return prev;
						return message.items.some((item) => item.id === prev.id) ? prev : null;
					});
					break;
				case "vuln":
					setVulnDetail(message.vuln);
					setVulnPreview(null);
					break;
				case "vuln_result":
					if (!message.ok && message.error) pushError(message.error);
					if (message.ok && message.action === "删除") setVulnDetail(null);
					break;
				case "vuln_review_result":
					if (!message.ok) pushError(`重试评审失败：${message.error ?? "未知错误"}`);
					break;
				case "vulns_export": {
					// Markdown is text, so the download is built directly instead of
					// going through the base64 path the file panel uses.
					const url = URL.createObjectURL(new Blob([message.markdown], { type: "text/markdown;charset=utf-8" }));
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = message.filename;
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
					URL.revokeObjectURL(url);
					break;
				}
				case "error":
					// A protocol error naming a message this server does not know means
					// the page is newer than the process serving it: the browser keeps the
					// rebuilt bundle, the server keeps the code it loaded at startup.
					pushError(
						/未知消息类型/.test(message.message)
							? `${message.message}（服务端仍是旧版本，请重启控制台进程）`
							: message.message,
					);
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
		if (event.type === "agent_start") {
			setRunActive(true);
			return;
		}
		if (event.type === "message_start") {
			// A new assistant message streams into the live tail; the previous one was
			// already moved into the transcript when it ended.
			const role = (event.message as { role?: string } | undefined)?.role;
			if (role === "assistant") {
				setLiveText("");
				setLiveThinking("");
			}
			return;
		}
		if (event.type === "message_update" && event.assistantMessageEvent) {
			const delta = event.assistantMessageEvent as { type: string; delta?: string };
			if (delta.type === "text_delta" && typeof delta.delta === "string") {
				setLiveText((prev) => prev + delta.delta);
			} else if (delta.type === "thinking_delta" && typeof delta.delta === "string") {
				setLiveThinking((prev) => prev + delta.delta);
			}
			return;
		}
		if (event.type === "message_end") {
			const message = event.message as AgentMessageView | undefined;
			if (!message) return;
			if (message.role === "user") {
				// The server echoed the operator's prompt, so it renders in order from
				// the event list instead of the optimistic copy.
				setOptimisticUserMessages((prev) => prev.slice(1));
				setPendingMessages((prev) => [...prev, message]);
				return;
			}
			if (message.role === "system") return;
			if (message.role === "assistant") {
				setLiveText("");
				setLiveThinking("");
				// An assistant turn that only requests tools renders nothing on its own:
				// the tool card below carries it, so it is not added as an empty row.
				if (hasVisibleAssistantContent(message)) setPendingMessages((prev) => [...prev, message]);
				return;
			}
			setPendingMessages((prev) => [...prev, message]);
			if (message.role === "toolResult") {
				// The committed card replaces the running one.
				setLiveTools((prev) => prev.filter((tool) => tool.id !== message.toolCallId));
			}
			return;
		}
		if (event.type === "tool_execution_start") {
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
			return;
		}
		if (event.type === "tool_execution_update") {
			const partial = event.partialResult as { content?: unknown } | null;
			const text = partial ? textFromContent(partial.content) : "";
			if (text) {
				setLiveTools((prev) => prev.map((tool) => (tool.id === event.toolCallId ? { ...tool, output: text } : tool)));
			}
			return;
		}
		if (event.type === "tool_execution_end") {
			const text = event.result ? textFromContent(event.result.content) : "";
			setLiveTools((prev) =>
				prev.map((tool) =>
					tool.id === event.toolCallId
						? { ...tool, status: event.isError ? "error" : "done", output: text, durationMs: event.durationMs }
						: tool,
				),
			);
			return;
		}
		if (event.type === "queue_update") {
			setQueuedMessages([
				...event.steering.map((text) => ({ kind: "steer" as const, text })),
				...event.followUp.map((text) => ({ kind: "followUp" as const, text })),
			]);
			return;
		}
		if (event.type === "agent_settled") {
			setRunActive(false);
			// The run finished; any optimistic bubble not absorbed by the final
			// snapshot was consumed by an extension or dropped, so clear it. Messages
			// still queued are rendered from queue_update state.
			setOptimisticUserMessages([]);
			setQueuedMessages([]);
		}
	}, []);

	useEffect(() => {
		const connection = new ZGConnection(
			(message) => handleServerMessage(message),
			(open) => {
				setConnected(open);
				if (!open) return;
				// Every (re)connect re-reads the whole view. A dropped socket misses
				// events, so the snapshot and the listings are the only way to catch up.
				for (const request of [
					"list_sessions",
					"get_config",
					"get_notify_config",
					"get_permissions",
					"get_environment",
					"get_stats",
					"list_projects",
					"get_state",
				] as const) {
					connection.send({ type: request });
				}
			},
		);
		connectionRef.current = connection;
		connection.connect();
		const poll = window.setInterval(() => {
			if (connection.connected) connection.send({ type: "list_sessions" });
		}, 15000);
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

	const openPage = useCallback((next: ZGPageId) => {
		setPage(next);
	}, []);

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

	// Another session (or project) has a different transcript: the event-built
	// lists belong to the old one and would otherwise sit under the new messages
	// until the operator reloaded the page.
	useEffect(() => {
		setPendingMessages([]);
		setExpandedRuns(new Set());
		setLiveText("");
		setLiveThinking("");
		setLiveTools([]);
		setOptimisticUserMessages([]);
		setQueuedMessages([]);
	}, [snapshot?.activeSessionId, snapshot?.project?.id]);

	// A different project means a different container: drop anything cached from
	// the previous one and re-read the work directory when the files page is up.
	useEffect(() => {
		setFilePath("/work");
		filePathRef.current = "/work";
		setFileEntries([]);
		setFilePreview(null);
		setSubagentTranscripts({});
		if (filesOpen) loadFiles("/work");
	}, [snapshot?.project?.id, filesOpen, loadFiles]);

	// Opening the file browser always re-lists the directory it is showing.
	useEffect(() => {
		if (filesOpen) loadFiles(filePathRef.current);
	}, [filesOpen, loadFiles]);

	/** Re-read whatever the active page (or overlay) is showing. */
	const refreshPage = useCallback(() => {
		if (filesOpen) loadFiles(filePathRef.current);
		if (subagentsOpen) send({ type: "get_state" });
		switch (page) {
			case "chat":
				send({ type: "get_state" });
				refreshStats();
				break;
			case "projects":
				send({ type: "list_projects" });
				send({ type: "list_sessions" });
				break;
			case "vulns":
				send({ type: "list_vulns", filters: vulnFilters });
				break;
			case "settings.model":
				send({ type: "get_config" });
				break;
			case "settings.notify":
				send({ type: "get_notify_config" });
				break;
			case "settings.permissions":
				send({ type: "get_permissions" });
				break;
			case "settings.environment":
				send({ type: "get_environment" });
				break;
			case "about":
				send({ type: "get_config" });
				send({ type: "get_state" });
				refreshStats();
				break;
		}
	}, [page, filesOpen, subagentsOpen, send, refreshStats, loadFiles, vulnFilters]);

	/**
	 * The hub re-reads on every project change: findings are project-scoped, so
	 * what is on screen belongs to the previous project the moment it switches.
	 * The list is also read once on connect, so the sidebar badge is right even
	 * if the page is never opened.
	 */
	useEffect(() => {
		setVulnFilters({});
		setVulnDetail(null);
		setVulnPreview(null);
		if (connected) send({ type: "list_vulns" });
	}, [snapshot?.project?.id, connected, send]);

	/** Re-read the hub under the current filter. */
	const loadVulns = useCallback(
		(filters: ZGVulnFilters) => {
			setVulnFilters(filters);
			send({ type: "list_vulns", filters });
		},
		[send],
	);

	/** Open one finding in full; the reply replaces whatever the overlay showed. */
	const openVuln = useCallback(
		(id: string) => {
			setVulnPreview(null);
			vulnPreviewPathRef.current = null;
			send({ type: "get_vuln", id });
		},
		[send],
	);

	/** Preview an evidence file. It lives in the project's container, not the host. */
	const previewVulnFile = useCallback(
		(path: string) => {
			vulnPreviewPathRef.current = path;
			send({ type: "read_file", path });
		},
		[send],
	);

	const mode: ZGMode = snapshot?.mode ?? "review";
	const streaming = runActive;
	const pendingApprovals = snapshot?.pendingApprovals ?? [];
	const needsConfig = snapshot !== null && !snapshot.modelConfigured;
	/** No project means no container, so the console blocks the chat entirely. */
	const needsProject = snapshot !== null && snapshot.project === null;
	const subagentRuns = snapshot?.subagents ?? [];
	const subagentRunning = subagentRuns.filter((run) => run.status === "running").length;
	const goal = snapshot?.goal ?? null;
	/**
	 * Why the goal button is unavailable, or null when it can start one. The
	 * reasons mirror the server's own refusals, so the button never opens a dialog
	 * whose submission is guaranteed to fail.
	 */
	const goalDisabledReason = needsProject
		? "请先创建或选择一个项目"
		: envReport && !envReport.ok
			? "Docker 环境不可用，无法启动目标"
			: mode !== "auto"
				? "持续目标只在自动模式下可用：请先切到自动模式"
				: streaming
					? "Agent 正在运行，等本轮结束或中止后再启动"
					: snapshot?.compacting
						? "正在压缩上下文，压缩完成或中止后再启动目标"
						: goal && goal.status !== "completed"
							? "当前会话已有未结束的目标"
							: null;

	const visibleMessages = useMemo(
		() => (snapshot?.messages ?? []).filter((message) => message.role !== "system"),
		[snapshot],
	) as AgentMessageView[];

	/**
	 * Commands of the tool calls in the transcript, by tool-call id. A tool result
	 * message carries the output but not the command, so this is what lets a
	 * finished card still show what was run.
	 */
	const toolCommands = useMemo(() => {
		const commands = new Map<string, string>();
		for (const message of [...visibleMessages, ...pendingMessages]) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				const call = block as { type?: string; id?: string; arguments?: Record<string, unknown> };
				if (call.type === "toolCall" && call.id) commands.set(call.id, commandFromArgs(call.arguments));
			}
		}
		return commands;
	}, [visibleMessages, pendingMessages]);

	const forkEntryIds = useMemo(() => {
		const ids = new Map<string, string>();
		let index = 0;
		for (const message of visibleMessages) {
			if (message.role !== "user") continue;
			const entryId = forkPoints[index++]?.entryId;
			if (entryId) ids.set(messageKey(message), entryId);
		}
		return ids;
	}, [visibleMessages, forkPoints]);

	/**
	 * The transcript grouped into runs. A summary marker is its own group, and a
	 * stretch a compaction kept folds like any other run, even though the prompt it
	 * answered is no longer the first message in front of it.
	 */
	const runGroups = useMemo(
		() => groupRuns([...visibleMessages, ...pendingMessages]),
		[visibleMessages, pendingMessages],
	);

	/** Whether a run may fold, and whether it is folded right now. */
	const runFold = useCallback(
		(index: number) => runFoldState({ groups: runGroups, index, streaming, expanded: expandedRuns }),
		[runGroups, streaming, expandedRuns],
	);

	useEffect(() => {
		if (!streaming) send({ type: "get_tree" });
	}, [streaming, send, snapshot?.messages.length]);

	useEffect(() => {
		if (!streaming) refreshStats();
	}, [streaming, refreshStats, snapshot?.messages.length]);

	const activeSession = sessions.find((session) => session.id === snapshot?.activeSessionId);
	const sessionLabel = activeSession?.name ?? activeSession?.firstMessage.slice(0, 30) ?? "未选择会话";
	const sessionCount: Record<string, number> = {};
	for (const session of sessions) {
		const id = session.cwd.split("/").pop() ?? "";
		sessionCount[id] = (sessionCount[id] ?? 0) + 1;
	}

	return (
		<div className="app">
			<AppSider
				collapsed={sidebarCollapsed}
				onToggleCollapse={() => {
					setSidebarCollapsed((prev) => {
						const next = !prev;
						localStorage.setItem("zg-sidebar-collapsed", next ? "1" : "0");
						return next;
					});
				}}
				activePage={page}
				onNavigate={openPage}
				connected={connected}
				mode={mode}
				modelConfigured={snapshot?.modelConfigured ?? false}
				sessions={sessions}
				engines={engines}
				activeSessionId={snapshot?.activeSessionId ?? null}
				runningSessions={
					runActive && snapshot?.activeSessionId
						? [...new Set([...(snapshot.runningSessions ?? []), snapshot.activeSessionId])]
						: (snapshot?.runningSessions ?? [])
				}
				pendingApprovals={pendingApprovals.length}
				pendingVulns={vulnStats.byStatus.pending}
				onNewSession={() => {
					openPage("chat");
					send({ type: "new_session" });
				}}
				onSwitchSession={(path) => {
					openPage("chat");
					send({ type: "switch_session", path });
				}}
				onRenameSession={(path, name) => send({ type: "rename_session", path, name })}
				onDeleteSession={(path) => send({ type: "delete_session", path })}
				onSetSessionStatus={(path, status) => send({ type: "set_session_status", path, status })}
				onRefresh={refreshPage}
				projectSlot={
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
			/>
			<div className="app-body">
				<main className="app-content">
					{connected ? null : (
						<div className="conn-banner" role="status">
							<span className="conn-banner-dot" />
							<span>
								与后端连接已断开，正在自动重连… 若浏览器提示 ERR_ADDRESS_INVALID，请确认打开的是
								<code> http://127.0.0.1:端口 </code>
								（<code>0.0.0.0</code> 不是可访问地址）。
							</span>
						</div>
					)}
					{envReport && !envReport.ok ? (
						<div className="env-banner" role="status">
							<span className="env-banner-dot" />
							<span>
								Docker 环境不可用，对话已锁定：
								{envReport.items.find((entry) => entry.blocking && entry.status !== "ok")?.label ?? "环境检查未通过"}
								。请到
								<button type="button" className="link" onClick={() => setPage("settings.environment")}>
									设置 → 环境
								</button>
								查看原因并构建镜像。
							</span>
						</div>
					) : null}
					{/* The gate replaces the chat page only: settings and the project list
					    must stay reachable, or a first run could never build the image. */}
					{needsProject && page === "chat" ? (
						<ProjectGate
							projects={projects}
							busy={streaming}
							onCreate={addProject}
							onSwitch={(id) => send({ type: "switch_project", id })}
							onOpenSettings={() => openPage("settings.model")}
						/>
					) : page === "chat" ? (
						<div className="page-card">
							<div className="ws-panel__head">
								<div className="ws-panel__title">
									对话
									<span className="ws-panel__sub" title={activeSession?.firstMessage}>
										{sessionLabel}
									</span>
								</div>
							</div>
							<ChatToolbar
								mode={mode}
								streaming={streaming}
								pendingApprovals={pendingApprovals.length}
								subagentRunning={subagentRunning}
								thinkingLevel={snapshot?.thinkingLevel ?? "off"}
								availableThinkingLevels={snapshot?.availableThinkingLevels ?? []}
								branchOpen={branchOpen}
								filesOpen={filesOpen}
								subagentsOpen={subagentsOpen}
								allowedPrefixes={snapshot?.allowedPrefixes ?? []}
								sessionStatus={snapshot?.sessionStatus ?? null}
								onSetSessionStatus={(status) => send({ type: "set_session_status", status })}
								onToggleFiles={() => setFilesOpen((prev) => !prev)}
								onToggleSubagents={() => setSubagentsOpen((prev) => !prev)}
								onSetMode={(next) => send({ type: "set_mode", mode: next })}
								onSetThinkingLevel={(level) => send({ type: "set_thinking_level", level })}
								onToggleBranch={() => {
									setBranchOpen((prev) => {
										const next = !prev;
										localStorage.setItem("zg-branch-open", next ? "1" : "0");
										return next;
									});
									send({ type: "get_tree" });
								}}
								onCompact={() => send({ type: "compact" })}
								onAbortCompaction={() => send({ type: "abort_compaction" })}
								compacting={snapshot?.compacting ?? false}
								compactionStartedAt={snapshot?.compactionStartedAt ?? null}
								onAllowPrefix={(prefix) => send({ type: "allow_prefix", prefix })}
								onRemoveAllowedPrefix={(prefix) => send({ type: "remove_allowed_prefix", prefix })}
							/>
							{goal ? (
								<GoalBar
									goal={goal}
									streaming={streaming}
									onPause={() => send({ type: "pause_goal" })}
									onResume={() => send({ type: "resume_goal" })}
									onClear={() => send({ type: "clear_goal" })}
								/>
							) : null}
							<div className="ws-panel__body">
								<div className="transcript" ref={transcriptRef}>
									{visibleMessages.length === 0 && !liveText && !streaming ? (
										<div className="ws-empty">
											<span>等待第一条指令</span>
											<span>
												{needsConfig
													? "请先在「设置 → 模型」中配置 OpenAI 兼容端点。"
													: "例如：对 10.10.10.5 进行全端口侦察，或派子代理并行侦察多个目标。"}
											</span>
										</div>
									) : null}
									{runGroups.map((group, groupIndex) => {
										// A compaction or branch summary marks where the model's
										// context was cut; it stands between two stretches and never
										// folds, because it is the boundary, not a process step.
										if (group.marker) {
											return (
												<div className="run-group run-marker" key={group.key}>
													<MessageView
														message={group.marker}
														onFullscreen={openViewer}
														// A continuation badge shows how long the round it
														// closed took: the stretch since the previous
														// boundary (prompt or earlier round) started.
														{...((group.marker as { customType?: string }).customType === "zg-goal" &&
														goalMarkerElapsed(snapshotRef.current?.messages ?? [], group.marker)
															? {
																	goalElapsedMs: goalMarkerElapsed(
																		snapshotRef.current?.messages ?? [],
																		group.marker,
																	),
																}
															: {})}
													/>
												</div>
											);
										}
										const fold = runFold(groupIndex);
										const live = streaming && groupIndex === runGroups.length - 1;
										const summary = group.body[group.body.length - 1];
										return (
											<div className="run-group" key={group.key}>
												{group.prompt ? (
													<MessageView
														message={group.prompt}
														forkEntryId={forkEntryIds.get(messageKey(group.prompt))}
														onFork={streaming ? undefined : navigate}
														onFullscreen={openViewer}
													/>
												) : null}
												{fold ? (
													<RunFold
														digest={fold.digest}
														open={!fold.collapsed}
														onToggle={() =>
															setExpandedRuns((prev) => {
																const next = new Set(prev);
																if (next.has(group.key)) next.delete(group.key);
																else next.add(group.key);
																return next;
															})
														}
													/>
												) : null}
												{fold?.collapsed ? (
													<MessageView
														message={summary}
														toolCommand={toolCommandOf(summary, toolCommands)}
														onFullscreen={openViewer}
													/>
												) : (
													<div className="run-body">
														{group.body.map((message, bodyIndex) => (
															<MessageView
																key={`${group.key}-${bodyIndex}`}
																message={message}
																toolCommand={toolCommandOf(message, toolCommands)}
																onFullscreen={openViewer}
															/>
														))}
														{live && liveThinking ? (
															<AgentEntry>
																<details className="thinking" open>
																	<summary>思考中…</summary>
																	<pre>{liveThinking}</pre>
																</details>
															</AgentEntry>
														) : null}
														{live
															? liveTools.map((tool) => (
																	<ToolCard
																		key={tool.id}
																		name={tool.name}
																		status={tool.status}
																		durationMs={tool.durationMs}
																		command={tool.command}
																		output={tool.output}
																		onFullscreen={openViewer}
																	/>
																))
															: null}
														{live && liveText ? (
															<AgentEntry>
																<MarkdownText text={liveText} />
															</AgentEntry>
														) : null}
													</div>
												)}
											</div>
										);
									})}
									{snapshot?.goal &&
									  snapshot.goal.status !== "active" &&
									  !chattedAfterGoalEnd(snapshotRef.current?.messages ?? [], snapshot.goal) ? (
										<div className={`goal-end-badge ${snapshot.goal.status}`}>
											<span className="chip">
												<b>
													{snapshot.goal.status === "completed"
														? "✓ 目标完成"
														: snapshot.goal.status === "blocked"
															? "✕ 目标阻塞"
															: "⏸ 目标暂停"}
												</b>
												<span className="t">
													共 {snapshot.goal.rounds.length} 次迭代 · 总耗时{" "}
													{formatGoalTotalMs(
														(snapshot.goal.endedAt ?? Date.now()) - snapshot.goal.startedAt,
													)}
												</span>
											</span>
										</div>
									) : null}
									{optimisticUserMessages.map((item, index) => (
										<div key={`optimistic-${index}`} className="log-op pending">
											<span className="log-op-mark">&gt;</span>
											<div className="log-op-body">
												{item.text}
												{item.imageCount > 0 ? `（附 ${item.imageCount} 张图片）` : ""}
											</div>
										</div>
									))}
									{queuedMessages.map((item, index) => (
										<div key={`queued-${index}`} className="log-op queued">
											<span className="log-op-mark">{item.kind === "steer" ? "↳" : "…"}</span>
											<div className="log-op-body">
												{item.kind === "steer" ? "插话中：" : "排队中："}
												{item.text}
											</div>
										</div>
									))}
								</div>
								<Composer
									streaming={streaming}
									stats={stats}
									hasProject={snapshot?.project !== null && snapshot?.project !== undefined}
									blockedReason={
										envReport && !envReport.ok
											? `Docker 环境不可用：${
													envReport.items.find((entry) => entry.blocking && entry.status !== "ok")?.label ??
													"环境检查未通过"
												}。请到「设置 → 环境」修复。`
											: envReport
												? snapshot?.compacting
													? "正在压缩上下文，压缩完成后可继续发送；也可在工具栏点「中止压缩」放弃这次压缩"
													: null
												: "正在检查 Docker 环境…"
									}
									notifyRun={notifyRun ?? notifyConfig.enabled}
									onToggleNotifyRun={() => setNotifyRun(!(notifyRun ?? notifyConfig.enabled))}
									goalDisabledReason={goalDisabledReason}
									onOpenGoal={() => setGoalOpen(true)}
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
						</div>
					) : page === "projects" ? (
						<ProjectsPage
							projects={projects}
							activeProject={snapshot?.project ?? null}
							busy={streaming}
							onCreate={addProject}
							onSwitch={(id) => send({ type: "switch_project", id })}
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
							sessionCount={sessionCount}
						/>
					) : page === "vulns" ? (
						<VulnPage
							items={vulnItems}
							stats={vulnStats}
							filters={vulnFilters}
							projectName={snapshot?.project?.name ?? null}
							hasProject={snapshot?.project !== null && snapshot?.project !== undefined}
							onFiltersChange={loadVulns}
							onOpen={openVuln}
							onExport={(filters) => send({ type: "export_vulns", filters })}
							onRetryReview={(id) => send({ type: "retry_vuln_review", id })}
						/>
					) : page === "engine" ? (
						<EnginePage
							engines={snapshot?.project ? engines.filter((engine) => engine.projectId === snapshot.project?.id) : engines}
							doctrines={doctrines}
							commanderConfig={commanderConfig}
							onSend={(message) => send(message as ZGClientMessage)}
							onError={pushError}
							commanderEvents={commanderEvents}
							taskEvents={engineTaskEvents}
							onOpenTaskEvents={(taskId) => send({ type: "engine_task_events", taskId })}
							onOpenCommanderEvents={(engineId) => send({ type: "engine_commander_events", id: engineId })}
							hasProject={snapshot?.project !== null && snapshot?.project !== undefined}
						/>
					) : page === "settings.model" ? (
						<div className="page-card">
							<div className="ws-panel__head">
								<div className="ws-panel__title">
									设置
									<span className="ws-panel__sub">模型端点</span>
								</div>
							</div>
							<div className="ws-panel__body">
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
						</div>
					) : page === "settings.notify" ? (
						<div className="page-card">
							<div className="ws-panel__head">
								<div className="ws-panel__title">
									设置
									<span className="ws-panel__sub">钉钉通知</span>
								</div>
							</div>
							<div className="ws-panel__body">
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
							</div>
						</div>
					) : page === "settings.permissions" ? (
						<div className="page-card">
							<div className="ws-panel__head">
								<div className="ws-panel__title">
									设置
									<span className="ws-panel__sub">
										权限
										{permissionEffective
											? ` · 子代理实际可用 ${Object.values(permissionEffective).filter(Boolean).length} 项`
											: ""}
									</span>
								</div>
							</div>
							<div className="ws-panel__body">
								{permissions ? (
									<PermissionsPanel
										config={permissions}
										presets={permissionPresets}
										tools={permissionTools}
										busy={permissionBusy}
										onRefresh={() => send({ type: "get_permissions" })}
										onSave={(next) => {
											setPermissionBusy(true);
											send({ type: "save_permissions", config: next });
											// The rebuild is not instant; a refusal arrives as an error toast.
											window.setTimeout(() => setPermissionBusy(false), 20000);
										}}
									/>
								) : (
									<div className="ws-empty">
										<span>正在读取权限配置…</span>
									</div>
								)}
							</div>
						</div>
					) : page === "settings.environment" ? (
						<div className="page-card">
							<div className="ws-panel__head">
								<div className="ws-panel__title">
									设置
									<span className="ws-panel__sub">
										环境
										{envReport ? (envReport.ok ? " · 可用" : " · 不可用") : " · 检查中"}
									</span>
								</div>
							</div>
							<div className="ws-panel__body">
								<EnvironmentPanel
									report={envReport}
									building={imageBuilding}
									buildLog={buildLog}
									sourcesSavedAt={sourcesSavedAt}
									onSaveSources={(sources) => send({ type: "set_sources", sources })}
									onRefresh={() => send({ type: "check_environment" })}
									onBuild={() => {
										setBuildLog([]);
										setImageBuilding(true);
										send({ type: "build_image" });
									}}
									onAbortBuild={() => send({ type: "abort_image_build" })}
								/>
							</div>
						</div>
					) : (
						<AboutPage
							snapshot={snapshot}
							config={config}
							stats={stats}
							project={snapshot?.project ?? null}
							connected={connected}
						/>
					)}
				</main>
			</div>
			{filesOpen ? (
				<Overlay
					title="文件"
					subtitle={`${snapshot?.project?.name ?? "未选择项目"} · 容器工作目录 /work`}
					onClose={() => setFilesOpen(false)}
					actions={
						<span className="ws-kv">
							<span>
								<b>{fileEntries.length}</b> 项
							</span>
							{fileBusy ? <span>读取中…</span> : null}
						</span>
					}
				>
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
				</Overlay>
			) : null}
			{subagentsOpen ? (
				<Overlay
					title="子代理"
					subtitle={`当前会话 ${subagentRuns.length} 次派发${subagentRunning > 0 ? ` · ${subagentRunning} 个运行中` : ""}`}
					onClose={() => setSubagentsOpen(false)}
				>
					<SubagentPanel
						runs={subagentRuns}
						transcripts={subagentTranscripts}
						onLoad={(id) => send({ type: "get_subagent", id })}
						onAbort={(id) => send({ type: "abort_subagent", id })}
						onSteer={(id, text) => send({ type: "steer_subagent", id, text })}
						onFullscreen={(title, output) => setViewer({ title: `子代理 ${title} 输出`, output })}
					/>
				</Overlay>
			) : null}
			{vulnDetail ? (
				<VulnDetail
					vuln={vulnDetail}
					preview={vulnPreview}
					onClose={() => {
						setVulnDetail(null);
						setVulnPreview(null);
					}}
					onUpdate={(id, patch: ZGVulnUpdate) => send({ type: "update_vuln", id, patch })}
					onDelete={(id) => send({ type: "delete_vuln", id })}
					onRetryReview={(id) => send({ type: "retry_vuln_review", id })}
					onPreview={previewVulnFile}
				/>
			) : null}
			{branchOpen && page === "chat" ? (
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
			{goalOpen ? (
				<GoalStartDialog
					onClose={() => setGoalOpen(false)}
					onStart={(objective, criteria, roundLimit) =>
						send({
							type: "start_goal",
							objective,
							...(criteria.length > 0 ? { criteria } : {}),
							roundLimit,
						})
					}
				/>
			) : null}
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
