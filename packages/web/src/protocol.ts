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

/** Lifecycle of a persistent goal. Only the model ends one successfully. */
export type ZGGoalStatus = "active" | "paused" | "blocked" | "completed";

/** Why an active goal stopped. Manual covers the operator's pause and abort. */
export type ZGGoalPauseReason = "manual" | "limit" | "no-progress" | "interrupted";

/** The initial run, or one automatic continuation. */
export type ZGGoalRoundKind = "initial" | "continue";

/** How a round ended, for the timeline. */
export type ZGGoalRoundOutcome = "continued" | "completed" | "blocked" | "paused" | "aborted" | "error";

/** Token and cost counters. Cost is null when the endpoint reports no price. */
export interface ZGGoalUsage {
	input: number;
	output: number;
	total: number;
	cost: number | null;
}

/** What the model last reported through `goal_progress`. */
export interface ZGGoalProgress {
	done: string[];
	todo: string[];
	blockers: string[];
}

/** One acceptance criterion with the verdict given at completion. */
export interface ZGGoalCriterionResult {
	criterion: string;
	met: boolean;
	evidence: string;
}

/** The evidence a completed goal carries. */
export interface ZGGoalCompletion {
	summary: string;
	evidence: string[];
	/** Findings submitted to the hub during this goal, as verified by the runtime. */
	submitted: number;
	/** Required when nothing was submitted: why the run found nothing to report. */
	findingsNote: string;
	criteria: ZGGoalCriterionResult[];
	at: number;
}

/** The blocker report that stopped a goal. */
export interface ZGGoalBlocked {
	reason: string;
	evidence: string[];
	/** Consecutive rounds the same blocker was reported. */
	streak: number;
	at: number;
}

/** One round of a goal: the initial run, or one automatic continuation. */
export interface ZGGoalRound {
	/** 0 is the initial run; continuations count up from 1. */
	index: number;
	kind: ZGGoalRoundKind;
	startedAt: number;
	endedAt?: number;
	/** Tool calls the round made; zero for three rounds running trips the fuse. */
	toolCalls: number;
	usage?: ZGGoalUsage;
	/** Closing summary: what `goal_progress` said, or the round's last prose. */
	summary?: string;
	summaryFromTool?: boolean;
	outcome?: ZGGoalRoundOutcome;
	blockerReason?: string;
}

/**
 * One persistent goal. Stored in the session file as a state entry, so it
 * survives a reload, a compaction, and a branch switch with the session it
 * belongs to.
 */
export interface ZGGoal {
	id: string;
	objective: string;
	/** Acceptance criteria; empty means the operator left them out. */
	criteria: string[];
	/** Automatic continuations allowed. The initial run is not counted. */
	roundLimit: number;
	roundsUsed: number;
	/** Consecutive rounds without a tool call. */
	noProgressStreak: number;
	/** Consecutive rounds reporting the same blocker. */
	blockerStreak: number;
	status: ZGGoalStatus;
	pauseReason?: ZGGoalPauseReason;
	pauseNote?: string;
	/** Usage when the goal started, so the bar can show what this goal cost. */
	baseline: ZGGoalUsage;
	progress: ZGGoalProgress;
	rounds: ZGGoalRound[];
	lastBlocker?: string;
	/** Findings submitted to the hub while this goal ran. */
	submitted: number;
	completion?: ZGGoalCompletion;
	blocked?: ZGGoalBlocked;
	createdAt: number;
	startedAt: number;
	endedAt?: number;
	updatedAt: number;
}

/** A goal as the console shows it: the stored record plus live counters. */
export interface ZGGoalView extends ZGGoal {
	/** Main-agent usage since the goal started. */
	usage: ZGGoalUsage;
	/** Sub-agent work of this goal. Shown for context; it does not consume rounds. */
	subagent: { runs: number; turns: number };
	/** Whether the goal's session has a run in flight right now. */
	running: boolean;
}

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
	/** Findings recorded for this project, so its deletion can state what it takes. */
	vulnCount?: number;
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
	/** How long the call ran, on `tool_end` only; lets the panel show a slow step. */
	durationMs?: number;
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

/** Severity buckets of the vulnerability hub. */
export type ZGVulnSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * Lifecycle of one finding. The agent always creates `pending`; only the
 * operator moves a record on from there, because a finding the model believes in
 * is still a hypothesis until someone reproduces it.
 */
export type ZGVulnStatus = "pending" | "confirmed" | "false_positive" | "fixed";

/** One piece of supporting evidence: a command with its output, or a container file. */
export interface ZGVulnEvidence {
	kind: "command" | "file";
	command?: string;
	output?: string;
	/** Absolute path inside the project container (/work/...), previewed in place. */
	path?: string;
	note?: string;
}

/** One entry of a finding's timeline: a status change or a free-text remark. */
export interface ZGVulnNote {
	at: string;
	author: "agent" | "operator" | "system";
	text: string;
	statusFrom?: ZGVulnStatus;
	statusTo?: ZGVulnStatus;
}

/**
 * One finding in the hub. `packet` holds the raw request or packet that proves
 * it, which is why it is a required field rather than part of the description.
 */
export interface ZGVulnerability {
	id: string;
	/** Human-readable id, `<project prefix>-<sequence>`, e.g. "E2E-PROJECT-0003". */
	label: string;
	/** Sequence within the project, starting at 1. */
	number: number;
	projectId: string;
	projectName: string;
	/** Main session the submission belongs to. */
	sessionId?: string;
	/** Who submitted it: "主代理" or "子代理 <runId>". */
	source: string;
	title: string;
	severity: ZGVulnSeverity;
	/** CVSS base score, 0.0-10.0. */
	cvss: number;
	/** Optional CVSS vector string. */
	cvssVector?: string;
	status: ZGVulnStatus;
	/** Affected target: host, URL, IP:port or service. */
	target: string;
	/** Vulnerability class, e.g. "SQL 注入" or "未授权访问". */
	category?: string;
	description: string;
	/** Raw request or packet, verbatim. */
	packet: string;
	repro?: string;
	remediation?: string;
	references?: string[];
	createdAt: string;
	updatedAt: string;
	evidence: ZGVulnEvidence[];
	notes: ZGVulnNote[];
	/** True when the CVSS score maps to a different bucket than `severity`. */
	severityMismatch: boolean;
}

/** A finding without its heavy fields, for the list and for the agent's query. */
export type ZGVulnSummary = Omit<ZGVulnerability, "packet" | "evidence" | "notes">;

/** List filters; every field is optional and they combine with AND. */
export interface ZGVulnFilters {
	status?: ZGVulnStatus;
	severity?: ZGVulnSeverity;
	/** Case-insensitive substring match on the affected target. */
	target?: string;
	/** Case-insensitive substring match on label, title, category and description. */
	search?: string;
}

/** Operator edits; the agent may not change a record after submitting it. */
export interface ZGVulnUpdate {
	status?: ZGVulnStatus;
	severity?: ZGVulnSeverity;
	cvss?: number;
	/** Appended to the timeline. */
	note?: string;
}

/** Counts for the hub page header. */
export interface ZGVulnStats {
	total: number;
	bySeverity: Record<ZGVulnSeverity, number>;
	byStatus: Record<ZGVulnStatus, number>;
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
	/** Persistent goal of the active session, with live counters; null when there is none. */
	goal: ZGGoalView | null;
	/**
	 * Compaction (or branch summarization) is running for the active session. It
	 * blocks prompts, and a slow model can hold it for minutes, so the console has
	 * to show it and offer a way out.
	 */
	compacting: boolean;
	/** When the current compaction started, for the elapsed time; null when idle. */
	compactionStartedAt: number | null;
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
	/** Cancel a compaction that is still running (a stalled model request). */
	| { type: "abort_compaction" }
	| {
			type: "start_goal";
			objective: string;
			/** One criterion per line; empty means the operator left them out. */
			criteria?: string[];
			roundLimit: number;
	  }
	| { type: "pause_goal" }
	| { type: "resume_goal"; extraRounds?: number }
	| { type: "clear_goal" }
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
	| { type: "list_vulns"; filters?: ZGVulnFilters }
	| { type: "get_vuln"; id: string }
	| { type: "update_vuln"; id: string; patch: ZGVulnUpdate }
	| { type: "delete_vuln"; id: string }
	| { type: "export_vulns"; filters?: ZGVulnFilters }
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
	| { type: "vulns"; items: ZGVulnSummary[]; stats: ZGVulnStats }
	| { type: "vuln"; vuln: ZGVulnerability }
	| { type: "vuln_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "vulns_export"; filename: string; markdown: string }
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
