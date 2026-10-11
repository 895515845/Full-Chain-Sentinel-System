/** Client-side view of the ZGAgent wire protocol (mirrors packages/web/src/protocol.ts). */

export type ZGMode = "review" | "auto";

/**
 * Every page the console can show in the content area. The sider navigates
 * between them; 文件 and 子代理 are overlays opened from the chat page.
 */
export type ZGPageId =
	| "chat"
	| "projects"
	| "vulns"
	| "engine"
	| "settings.model"
	| "settings.notify"
	| "settings.permissions"
	| "settings.environment"
	| "about";


/** Reasoning effort levels pi accepts, ascending. */
export type ZGThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Image attachment carried with a prompt (base64 payload, no data-URL prefix). */
export interface ZGImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
}

/** One directory entry in the container work directory. */
export interface ZGFileEntry {
	name: string;
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
	text?: string;
	data?: string;
	mimeType?: string;
}

export type ZGSubagentStatus = "running" | "done" | "error" | "aborted";

/** One normalized step of a sub-agent's process. */
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
	events?: ZGSubagentEvent[];
}

export interface ZGModelConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
}

/** Every tool switch the permissions screen offers. */
export type ZGPermissionKey =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "codemode"
	| "tool_search"
	| "mcp"
	| "spawn_agent"
	| "vuln_submit"
	| "vuln_read";

/** The switches of one agent; a missing entry means "not allowed". */
export type ZGPermissionSet = Record<ZGPermissionKey, boolean>;

export type ZGCommanderPermissionKey = "bash" | "read";

export type ZGCommanderPermissionSet = Record<ZGCommanderPermissionKey, boolean>;

export interface ZGPermissionsConfig {
	main: ZGPermissionSet;
	subagent: ZGPermissionSet;
	commander: ZGCommanderPermissionSet;
}

export interface ZGPermissionPreset {
	commander: ZGCommanderPermissionSet;
	id: string;
	label: string;
	hint: string;
	main: ZGPermissionSet;
	subagent: ZGPermissionSet;
}

/** One tool the live session actually mounted, for the read-only inventory. */
export interface ZGToolInfo {
	name: string;
	source: string;
	/** Whether the model sees it right now, as opposed to codemode/deferred only. */
	active: boolean;
}

export interface ZGTestResult {
	ok: boolean;
	message: string;
	detail?: string;
}

/** DingTalk notification configuration (mirrors notifications.json). */
export interface ZGNotifyConfig {
	enabled: boolean;
	webhook: string;
	secret: string;
	keyword: string;
	/** Characters of notification body to keep per section; 0 keeps all of it. */
	summaryLimit: number;
}

/** Outcome of the most recent notification send. */
export interface ZGNotifyStatus {
	at: number | null;
	ok: boolean;
	error?: string;
	subject?: string;
}

export interface ZGApprovalRequest {
	id: string;
	command: string;
	cwd: string;
	source?: string;
}

export interface ZGProjectInfo {
	id: string;
	name: string;
	cwd: string;
	/** Docker container executing this project's tools. */
	container?: string | null;
	/** Findings recorded for this project, so its deletion can state what it takes. */
	vulnCount?: number;
}

/** Severity buckets of the vulnerability hub. */
export type ZGVulnSeverity = "critical" | "high" | "medium" | "low" | "info";

/** Lifecycle of one finding; the agent always creates `pending`. */
export type ZGVulnStatus = "pending" | "confirmed" | "false_positive" | "fixed";

export const ZG_VULN_SEVERITIES: readonly ZGVulnSeverity[] = ["critical", "high", "medium", "low", "info"];

export const ZG_VULN_SEVERITY_LABELS: Record<ZGVulnSeverity, string> = {
	critical: "严重",
	high: "高危",
	medium: "中危",
	low: "低危",
	info: "信息",
};

export const ZG_VULN_STATUS_LABELS: Record<ZGVulnStatus, string> = {
	pending: "待确认",
	confirmed: "已确认",
	false_positive: "误报",
	fixed: "已修复",
};

/** One piece of supporting evidence: a command with its output, or a container file. */
export interface ZGVulnEvidence {
	kind: "command" | "file";
	command?: string;
	output?: string;
	path?: string;
	note?: string;
}

/** One entry of a finding's timeline. */
export interface ZGVulnNote {
	at: string;
	author: "agent" | "operator" | "system";
	text: string;
	statusFrom?: ZGVulnStatus;
	statusTo?: ZGVulnStatus;
}

export interface ZGVulnerability {
	id: string;
	label: string;
	number: number;
	projectId: string;
	projectName: string;
	sessionId?: string;
	source: string;
	title: string;
	severity: ZGVulnSeverity;
	cvss: number;
	cvssVector?: string;
	status: ZGVulnStatus;
	target: string;
	category?: string;
	description: string;
	packet: string;
	repro?: string;
	remediation?: string;
	references?: string[];
	createdAt: string;
	updatedAt: string;
	evidence: ZGVulnEvidence[];
	notes: ZGVulnNote[];
	/** The CVSS score maps to a different bucket than `severity`. */
	severityMismatch: boolean;
}

export type ZGVulnSummary = Omit<ZGVulnerability, "packet" | "evidence" | "notes">;

export interface ZGVulnFilters {
	status?: ZGVulnStatus;
	severity?: ZGVulnSeverity;
	target?: string;
	search?: string;
}

export interface ZGVulnUpdate {
	status?: ZGVulnStatus;
	severity?: ZGVulnSeverity;
	cvss?: number;
	note?: string;
}

export interface ZGVulnStats {
	total: number;
	bySeverity: Record<ZGVulnSeverity, number>;
	byStatus: Record<ZGVulnStatus, number>;
}

export interface ZGStateSnapshot {
	mode: ZGMode;
	streaming: boolean;
	cwd: string;
	project: ZGProjectInfo | null;
	model: { provider: string; id: string } | null;
	modelConfigured: boolean;
	thinkingLevel: ZGThinkingLevel;
	availableThinkingLevels: ZGThinkingLevel[];
	activeSessionId: string | null;
	messages: AgentMessageView[];
	pendingApprovals: ZGApprovalRequest[];
	allowedPrefixes: string[];
	/** Session ids with an active run (background included). */
	runningSessions: string[];
	/** Sub-agent runs of the active session, newest first, without process steps. */
	subagents: ZGSubagentRun[];
	/** Persistent goal of the active session, with live counters; null when there is none. */
	goal: ZGGoalView | null;
	/** Operator status of the active session, as a label the agent never sees. */
	sessionStatus: ZGSessionStatus | null;
	/** Compaction is running for the active session, which blocks prompts. */
	compacting: boolean;
	/** When that compaction started, for the elapsed time; null when idle. */
	compactionStartedAt: number | null;
}

export interface SessionInfoView {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	/** Operator status, absent when the session was never labeled. */
	status?: ZGSessionStatus;
	/** Present when this session is an engineering task's conversation. */
	engine?: { engineId: string; engineName: string; taskStatus: string };
}

/** The operator's manual label for a session. The agent never sees it. */
export type ZGSessionStatus = "todo" | "active" | "done" | "ignored";

export interface SessionTreeNodeView {
	entry: {
		id: string;
		type: string;
		parentId: string | null;
		timestamp: string;
		/** Present on message entries; used for readable branch labels. */
		message?: { role?: string; content?: unknown };
	};
	children: SessionTreeNodeView[];
	label?: string;
}

export interface ZGForkPoint {
	entryId: string;
	text: string;
}

export interface ZGStatsView {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
}

/** Lifecycle of the persistent goal of the viewed session. */
export type ZGGoalStatus = "active" | "paused" | "blocked" | "completed";
export type ZGGoalPauseReason = "manual" | "limit" | "no-progress" | "interrupted";
export type ZGGoalRoundOutcome = "continued" | "completed" | "blocked" | "paused" | "aborted" | "error";

export interface ZGGoalUsage {
	input: number;
	output: number;
	total: number;
	cost: number | null;
}

export interface ZGGoalRound {
	index: number;
	kind: "initial" | "continue";
	startedAt: number;
	endedAt?: number;
	toolCalls: number;
	usage?: ZGGoalUsage;
	summary?: string;
	summaryFromTool?: boolean;
	outcome?: ZGGoalRoundOutcome;
	blockerReason?: string;
}

export interface ZGGoalCriterionResult {
	criterion: string;
	met: boolean;
	evidence: string;
}

export interface ZGGoalView {
	id: string;
	objective: string;
	criteria: string[];
	roundLimit: number;
	roundsUsed: number;
	noProgressStreak: number;
	blockerStreak: number;
	status: ZGGoalStatus;
	pauseReason?: ZGGoalPauseReason;
	pauseNote?: string;
	baseline: ZGGoalUsage;
	progress: { done: string[]; todo: string[]; blockers: string[] };
	rounds: ZGGoalRound[];
	lastBlocker?: string;
	submitted: number;
	completion?: {
		summary: string;
		evidence: string[];
		submitted: number;
		findingsNote: string;
		criteria: ZGGoalCriterionResult[];
		at: number;
	};
	blocked?: { reason: string; evidence: string[]; streak: number; at: number };
	createdAt: number;
	startedAt: number;
	endedAt?: number;
	updatedAt: number;
	/** Main-agent usage since the goal started. */
	usage: ZGGoalUsage;
	/** Sub-agent work of this goal; shown for context, it consumes no rounds. */
	subagent: { runs: number; turns: number };
	running: boolean;
}

/** Subset of pi AgentMessage shapes the UI renders. */
export type AgentMessageView =
	| { role: "system"; content?: unknown }
	| { role: "user"; content: ContentBlockView[]; timestamp?: number }
	| {
			role: "assistant";
			content: ContentBlockView[];
			timestamp?: number;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: ContentBlockView[];
			isError?: boolean;
			durationMs?: number;
			timestamp?: number;
	  }
	| {
			role: "bashExecution";
			command: string;
			output: string;
			exitCode?: number;
			cancelled?: boolean;
			timestamp?: number;
	  }
	| { role: "compactionSummary"; summary?: string; tokensBefore?: number; timestamp?: number }
	| { role: "branchSummary"; summary?: string; timestamp?: number }
	| { role: "custom"; customType: string; content: unknown; timestamp?: number };

export type ContentBlockView =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "image"; data: string; mimeType: string }
	| { type: string };

export type ZGClientMessage =
	| {
			type: "prompt";
			text: string;
			streamingBehavior?: "steer" | "followUp";
			images?: ZGImageAttachment[];
			/** Composer choice: force a notification for this run. */
			notify?: boolean;
	  }
	| { type: "abort" }
	| { type: "compact" }
	| { type: "abort_compaction" }
	| { type: "start_goal"; objective: string; criteria?: string[]; roundLimit: number }
	| { type: "pause_goal" }
	| { type: "resume_goal"; extraRounds?: number }
	| { type: "clear_goal" }
	| { type: "set_thinking_level"; level: ZGThinkingLevel }
	| { type: "set_mode"; mode: ZGMode }
	| { type: "decide"; decision: { id: string; approved: boolean; command?: string; alwaysAllowPrefix?: boolean } }
	| { type: "decide_all"; approved: boolean }
	| { type: "allow_prefix"; prefix: string }
	| { type: "remove_allowed_prefix"; prefix: string }
	| { type: "new_session" }
	| { type: "switch_session"; path: string }
	| { type: "rename_session"; path: string; name: string }
	| { type: "set_session_status"; path?: string; status: ZGSessionStatus | null }
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
	| { type: "set_sources"; sources: ZGSources }
	| { type: "list_engines" }
	| { type: "engine_create"; input: ZGEngineCreateInput }
	| { type: "engine_pause"; id: string }
	| { type: "engine_resume"; id: string }
	| { type: "engine_abort"; id: string }
	| { type: "engine_delete"; id: string }
	| { type: "engine_add_targets"; id: string; targets: string }
	| { type: "engine_steer_commander"; id: string; text: string }
	| { type: "engine_abort_task"; taskId: string }
	| { type: "engine_task_events"; taskId: string }
	| { type: "engine_open_task_session"; taskId: string }
	| { type: "engine_commander_events"; id: string }
	| { type: "engine_report_snapshot"; id: string }
	| { type: "list_doctrines" }
	| { type: "save_doctrine"; input: { id?: string; name: string; text: string } }
	| { type: "delete_doctrine"; id: string }
	| { type: "get_commander_config" }
	| { type: "save_commander_config"; config: ZGModelConfig | null };

export type ZGServerMessage =
	| { type: "snapshot"; snapshot: ZGStateSnapshot }
	| { type: "session_event"; event: SessionEventView }
	| { type: "sessions"; sessions: SessionInfoView[] }
	| { type: "tree"; tree: SessionTreeNodeView[]; leafId: string | null; forkPoints: ZGForkPoint[] }
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
	| { type: "stats"; stats: ZGStatsView }
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
	| { type: "engines"; engines: ZGEngine[] }
	| { type: "engine_update"; engine: ZGEngine }
	| { type: "engine_commander_event"; engineId: string; event: ZGSubagentEvent }
	| { type: "engine_task_event"; taskId: string; event: ZGSubagentEvent }
	| { type: "engine_task_events"; taskId: string; events: ZGSubagentEvent[] }
	| { type: "engine_commander_events"; id: string; events: ZGSubagentEvent[] }
	| { type: "engine_report"; id: string; markdown: string; filename: string }
	| { type: "doctrines"; doctrines: ZGDoctrineView[] }
	| { type: "doctrine_saved"; doctrine: ZGDoctrineView; error?: string }
	| { type: "doctrine_deleted"; id: string; ok: boolean; error?: string }
	| { type: "commander_config"; config: ZGModelConfig | null }
	| { type: "error"; message: string };

/**
 * One environment prerequisite. Blocking items decide whether the console runs at
 * all: every tool call is a `docker exec`, so Docker is not optional.
 */
export interface ZGEnvItem {
	id: string;
	group: string;
	label: string;
	status: "ok" | "warn" | "fail" | "skipped";
	detail: string;
	hint?: string;
	blocking: boolean;
}

/** Base image and package mirrors the toolbox image is built with. */
export interface ZGSources {
	baseImage: string;
	aptMirror: string;
	pipIndex: string;
	npmRegistry: string;
	goProxy: string;
}

export interface ZGEnvReport {
	at: string;
	ok: boolean;
	items: ZGEnvItem[];
	url: string;
	/** Build sources as configured; an empty field means the official source. */
	sources: ZGSources;
}

/** Union of the session events the UI reacts to. */
export type SessionEventView =
	| { type: "message_start"; message: AgentMessageView }
	| {
			type: "message_update";
			message: AgentMessageView;
			assistantMessageEvent:
				| { type: "text_delta"; delta: string }
				| { type: "thinking_delta"; delta: string }
				| { type: string };
	  }
	| { type: "message_end"; message: AgentMessageView }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }
	| { type: "tool_execution_update"; toolCallId: string; partialResult: unknown }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: { content?: ContentBlockView[] } | null;
			isError: boolean;
			durationMs?: number;
	  }
	| { type: "agent_start" }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "queue_update"; steering: string[]; followUp: string[] };


// ---------------------------------------------------------------------------
// Engineering mode (mirrors packages/web/src/protocol.ts)
// ---------------------------------------------------------------------------

export type ZGEngineStatus = "running" | "paused" | "completed" | "stopped";

export type ZGEngineTaskStatus = "queued" | "running" | "done" | "failed" | "blocked" | "aborted" | "paused";

export interface ZGEngineTarget {
	target: string;
	note?: string;
}

export interface ZGEngineLimits {
	concurrency: number;
	roundLimit: number;
	tokenLimit: number | null;
	timeLimitMin: number | null;
	maxRetries: number;
}

export interface ZGEngineTask {
	id: string;
	engineId: string;
	title: string;
	objective: string;
	target: string | null;
	workspace: string;
	status: ZGEngineTaskStatus;
	attempt: number;
	criteria: string[];
	roundLimit: number;
	sessionId: string | null;
	startedAt: number | null;
	endedAt: number | null;
	summary: string | null;
	error: string | null;
	usage: ZGGoalUsage | null;
	vulns: number;
}

export interface ZGEngine {
	id: string;
	projectId: string;
	projectName: string;
	name: string;
	status: ZGEngineStatus;
	pauseNote: string | null;
	targets: ZGEngineTarget[];
	doctrines: string[];
	limits: ZGEngineLimits;
	createdAt: number;
	endedAt: number | null;
	report: string | null;
	tasks: ZGEngineTask[];
}

export interface ZGDoctrineView {
	id: string;
	name: string;
	text: string;
	builtin: boolean;
}

export interface ZGEngineCreateInput {
	name: string;
	targets: string;
	doctrines: string[];
	limits: ZGEngineLimits;
}
