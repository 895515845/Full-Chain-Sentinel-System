/** Wire protocol shared by the ZGAgent web console server and browser client. */

import type {
	AgentSessionEvent,
	ImageContent,
	SessionInfo,
	SessionStats,
	SessionTreeNode,
	ThinkingLevel,
} from "@earendil-works/pi-coding-agent";
import type { ZGPermissionPreset, ZGPermissionSet, ZGPermissionsConfig } from "./permissions.ts";

/** Operator approval mode for bash tool calls. */
export type ZGMode = "review" | "auto";

/** Model endpoint configuration persisted in models.json. */
export interface ZGModelConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
}

/** DingTalk notification configuration persisted in notifications.json. */
export interface ZGNotifyConfig {
	/** Master switch. A run may still force a notification from the composer. */
	enabled: boolean;
	/** Custom-robot webhook URL, including its access_token. */
	webhook: string;
	/** Optional signing secret ("加签"). Empty sends an unsigned request. */
	secret: string;
	/** Optional custom keyword, prepended to the body for keyword-secured robots. */
	keyword: string;
}

/** Outcome of the most recent notification send, for the settings screen. */
export interface ZGNotifyStatus {
	/** Epoch milliseconds of the attempt, or null when nothing was sent yet. */
	at: number | null;
	ok: boolean;
	/** Failure reason, or the DingTalk error code when the robot rejected it. */
	error?: string;
	/** What the notification was for, e.g. the session title. */
	subject?: string;
}

/**
 * One mounted tool of the live session, listed on the permissions screen so the
 * operator can check what the switches actually produced.
 */
export interface ZGToolInfo {
	name: string;
	/** Where the tool came from, e.g. "base", "extension", "sdk", "mcp". */
	source: string;
	/** Whether the model sees it right now (as opposed to codemode/deferred only). */
	active: boolean;
}

/** Result of probing an endpoint configuration without saving it. */
export interface ZGTestResult {
	ok: boolean;
	/** Human-readable summary in Chinese for direct display. */
	message: string;
	/** Technical detail, e.g. the response body excerpt or error cause. */
	detail?: string;
}

/** A bash command awaiting operator approval. */
export interface ZGApprovalRequest {
	id: string;
	command: string;
	cwd: string;
	/** Which agent issued the command, e.g. "主代理" or "子代理". */
	source?: string;
}

/** A registered project (named working directory). */
export interface ZGProjectInfo {
	id: string;
	name: string;
	cwd: string;
	/** Docker container executing this project's tools. */
	container?: string | null;
}

/** One directory entry in the container work directory. */
export interface ZGFileEntry {
	name: string;
	/** Absolute path inside the container. */
	path: string;
	type: "dir" | "file";
	size: number;
	/** Unix seconds. */
	mtime: number;
}

/** Bounded inline view of one file. */
export interface ZGFilePreview {
	path: string;
	kind: "text" | "image" | "binary";
	size: number;
	truncated: boolean;
	/** Present for kind "text". */
	text?: string;
	/** Base64 payload, present for kind "image". */
	data?: string;
	mimeType?: string;
}

/** Lifecycle of one sub-agent run. */
export type ZGSubagentStatus = "running" | "done" | "error" | "aborted";

/** One normalized step of a sub-agent's process, in order. */
export interface ZGSubagentEvent {
	seq: number;
	kind: "text" | "thinking" | "tool_start" | "tool_end" | "turn" | "status";
	at: number;
	text?: string;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	output?: string;
	isError?: boolean;
	status?: ZGSubagentStatus;
	note?: string;
	/** Set when the stored payload exceeded the per-step cap and was cut down. */
	truncated?: boolean;
}

/** A sub-agent run: live state plus the summary retained in the history list. */
export interface ZGSubagentRun {
	id: string;
	sessionId: string;
	task: string;
	status: ZGSubagentStatus;
	turns: number;
	startedAt: string;
	endedAt?: string;
	result?: string;
	error?: string;
	/** Buffered process steps; only sent for one run on demand, never in a snapshot. */
	events?: ZGSubagentEvent[];
}

/** Snapshot of the runtime state sent on connect and after state changes. */
export interface ZGStateSnapshot {
	mode: ZGMode;
	streaming: boolean;
	cwd: string;
	/** Active project; null means no project is selected and the chat is unavailable. */
	project: ZGProjectInfo | null;
	model: { provider: string; id: string } | null;
	modelConfigured: boolean;
	/** Reasoning effort for the active session; "off" when the model has no reasoning. */
	thinkingLevel: ThinkingLevel;
	/** Levels the active model accepts, in ascending effort order. */
	availableThinkingLevels: ThinkingLevel[];
	activeSessionId: string | null;
	/** Serialized AgentMessage[] for the active session. */
	messages: unknown[];
	/** Bash commands awaiting an operator decision, oldest first. */
	pendingApprovals: ZGApprovalRequest[];
	/** Command prefixes (first word) auto-approved this session, e.g. ["nmap"]. */
	allowedPrefixes: string[];
	/** Session ids with an active run (background included). */
	runningSessions: string[];
	/** Sub-agent runs of the active session, newest first, without their process steps. */
	subagents: ZGSubagentRun[];
}

/** A point the conversation can branch from. */
export interface ZGForkPoint {
	entryId: string;
	text: string;
}

/** Client-to-server messages. */
export type ZGClientMessage =
	| {
			type: "prompt";
			text: string;
			streamingBehavior?: "steer" | "followUp";
			images?: ImageContent[];
			notify?: boolean;
	  }
	| { type: "abort" }
	| { type: "compact" }
	| { type: "set_thinking_level"; level: ThinkingLevel }
	| { type: "set_mode"; mode: ZGMode }
	| {
			type: "decide";
			decision: { id: string; approved: boolean; command?: string; alwaysAllowPrefix?: boolean };
	  }
	| { type: "decide_all"; approved: boolean }
	| { type: "allow_prefix"; prefix: string }
	| { type: "remove_allowed_prefix"; prefix: string }
	| { type: "new_session" }
	| { type: "switch_session"; path: string }
	| { type: "rename_session"; path: string; name: string }
	| { type: "delete_session"; path: string }
	| { type: "list_sessions" }
	| { type: "navigate"; entryId: string; summarize?: boolean }
	| { type: "rename_branch"; entryId: string; label: string }
	| { type: "get_tree" }
	| { type: "get_config" }
	| { type: "get_state" }
	| { type: "save_config"; config: ZGModelConfig }
	| { type: "test_config"; config: ZGModelConfig }
	| { type: "get_permissions" }
	| { type: "save_permissions"; config: ZGPermissionsConfig }
	| { type: "get_notify_config" }
	| { type: "save_notify_config"; config: ZGNotifyConfig }
	| { type: "test_notify"; config: ZGNotifyConfig }
	| { type: "get_stats" }
	| { type: "list_projects" }
	| { type: "add_project"; name: string }
	| { type: "remove_project"; id: string; confirmName: string }
	| { type: "switch_project"; id: string }
	| { type: "list_files"; path: string }
	| { type: "read_file"; path: string }
	| { type: "write_file"; path: string; text: string }
	| { type: "upload_file"; path: string; data: string }
	| { type: "download_file"; path: string }
	| { type: "delete_path"; path: string }
	| { type: "rename_path"; from: string; to: string }
	| { type: "make_directory"; path: string }
	| { type: "list_subagents" }
	| { type: "get_subagent"; id: string }
	| { type: "abort_subagent"; id: string }
	| { type: "steer_subagent"; id: string; text: string }
	| { type: "get_environment" }
	| { type: "check_environment" }
	| { type: "build_image" }
	| { type: "abort_image_build" }
	| { type: "set_sources"; sources: ZGSources };

/** Server-to-client messages. */
export type ZGServerMessage =
	| { type: "snapshot"; snapshot: ZGStateSnapshot }
	| { type: "session_event"; event: AgentSessionEvent }
	| { type: "sessions"; sessions: SessionInfo[] }
	| { type: "tree"; tree: SessionTreeNode[]; leafId: string | null; forkPoints: ZGForkPoint[] }
	| { type: "config"; config: ZGModelConfig | null }
	| { type: "test_result"; result: ZGTestResult }
	| {
			type: "permissions";
			config: ZGPermissionsConfig;
			effectiveSubagent: ZGPermissionSet;
			presets: ZGPermissionPreset[];
			tools: ZGToolInfo[];
	  }
	| { type: "notify_config"; config: ZGNotifyConfig; status: ZGNotifyStatus }
	| { type: "notify_test_result"; result: ZGTestResult }
	| { type: "stats"; stats: SessionStats }
	| { type: "projects"; projects: ZGProjectInfo[]; activeProjectId: string | null }
	| { type: "files"; path: string; entries: ZGFileEntry[] }
	| { type: "file_preview"; preview: ZGFilePreview }
	| { type: "file_download"; path: string; size: number; data: string; mimeType: string }
	| { type: "file_result"; action: string; path: string; ok: boolean; error?: string }
	| { type: "subagents"; runs: ZGSubagentRun[] }
	| { type: "subagent_run"; run: ZGSubagentRun }
	| { type: "subagent_event"; runId: string; event: ZGSubagentEvent }
	| { type: "subagent_result"; action: string; id: string; ok: boolean; error?: string }
	| { type: "environment"; report: ZGEnvReport; building: boolean }
	| { type: "image_build_log"; line: string }
	| { type: "image_build_result"; ok: boolean; error?: string }
	| { type: "sources_saved"; sources: ZGSources; error?: string }
	| { type: "error"; message: string };

/**
 * One environment prerequisite. `blocking` items decide whether the console runs
 * at all: Docker is not optional here, because every tool call is a `docker exec`
 * into a project container.
 */
export interface ZGEnvItem {
	id: string;
	/** Section the item is listed under, e.g. Docker 运行时. */
	group: string;
	label: string;
	status: "ok" | "warn" | "fail" | "skipped";
	detail: string;
	/** What to do about a warn or fail. */
	hint?: string;
	blocking: boolean;
}

/**
 * Base image and package mirrors for the toolbox image build. Empty means the
 * official source; the values are baked into the image at build time.
 */
export interface ZGSources {
	baseImage: string;
	aptMirror: string;
	pipIndex: string;
	npmRegistry: string;
	goProxy: string;
}

export interface ZGEnvReport {
	/** ISO timestamp of the check that produced this report. */
	at: string;
	/** Every blocking item is ok. */
	ok: boolean;
	items: ZGEnvItem[];
	/** Console address, shown in the environment page. */
	url: string;
	/** Build sources as configured (empty fields mean the official source). */
	sources: ZGSources;
}
