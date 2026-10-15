/** Client-side view of the ZGAgent wire protocol (mirrors packages/web/src/protocol.ts). */

export type ZGMode = "review" | "ai" | "auto";

/** The three modes in the order the toolbar offers them. */
export const ZG_MODES: readonly ZGMode[] = ["review", "ai", "auto"];

export const ZG_MODE_LABELS: Record<ZGMode, string> = {
	review: "审批模式",
	ai: "AI 审批",
	auto: "自动执行",
};

/**
 * Every page the console can show in the content area. The sider navigates
 * between them; 文件 and 子代理 are overlays opened from the chat page.
 */
export type ZGPageId =
	| "chat"
	| "projects"
	| "vulns"
	| "pocs"
	| "apimodels"
	| "droid"
	| "engine"
	| "gates"
	| "settings.model"
	| "settings.notify"
	| "settings.permissions"
	| "settings.environment"
	| "settings.security"
	| "settings.presets"
	| "settings.pocs"
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

/** The three jobs a model can be assigned to. */
export type ZGModelRoleName = "main" | "judge" | "reviewer";

/** One row of the model library. The key itself never leaves the server. */
export interface ZGModelEntryView {
	id: string;
	name: string;
	baseUrl: string;
	modelId: string;
	hasKey: boolean;
	roles: ZGModelRoleName[];
}

/** What a role resolves to right now. */
export interface ZGResolvedModelView {
	entryId: string;
	entryName: string;
	modelId: string;
	followedMain: boolean;
}

/** The whole model screen: library, role assignments, resolved endpoints. */
export interface ZGModelLibraryView {
	entries: ZGModelEntryView[];
	roles: {
		main: string | null;
		judge: string;
		reviewer: string;
	};
	reviewerAuto: boolean;
	resolved: {
		main: ZGResolvedModelView | null;
		judge: ZGResolvedModelView | null;
		reviewer: ZGResolvedModelView | null;
	};
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
	| "vuln_read"
	| "poc_read";

/** The switches of one agent; a missing entry means "not allowed". */
export type ZGPermissionSet = Record<ZGPermissionKey, boolean>;

export type ZGCommanderPermissionKey = "bash" | "read";

export type ZGCommanderPermissionSet = Record<ZGCommanderPermissionKey, boolean>;

export interface ZGPermissionsConfig {
	main: ZGPermissionSet;
	subagent: ZGPermissionSet;
	commander: ZGCommanderPermissionSet;
	/** Turn budget before one sub-agent run is aborted. */
	subagentMaxTurns: number;
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
	/** Which notifications to push once the master switch is on; all default on. */
	kinds: { runs: boolean; vulns: boolean; goals: boolean; engines: boolean; pocs: boolean };
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
	/** Gatekeeper judgments recorded for this project, for the same reason. */
	gateCount?: number;
}

// ---------------------------------------------------------------------------
// Gatekeeper (守门审计)
// ---------------------------------------------------------------------------

export type ZGGateDecisionKind = "allow" | "block" | "failed";

/** One gatekeeper judgment. */
export interface ZGGateDecision {
	id: string;
	at: number;
	projectId: string | null;
	projectName: string | null;
	sessionId: string | null;
	/** Which agent issued it: 主代理 / 子代理 / 工程任务「X」. */
	source: string;
	tool: string;
	command: string;
	commandTruncated?: boolean;
	cwd: string | null;
	decision: ZGGateDecisionKind;
	reason?: string;
	latencyMs: number;
	model?: string;
	/** Display name of the library entry the endpoint came from. */
	modelFrom?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	error?: string;
}

/** Audit list filters; every field is optional and they combine with AND. */
export interface ZGGateFilter {
	decision?: ZGGateDecisionKind;
	projectId?: string;
	sessionId?: string;
	source?: string;
	search?: string;
	since?: number;
}

export interface ZGGateStats {
	total: number;
	byDecision: Record<ZGGateDecisionKind, number>;
	blockRate: number;
	avgLatencyMs: number;
	totalTokens: number;
	last24h: number;
	failures: number;
	lastFailureAt: number | null;
	lastSuccessAt: number | null;
	lastError: string | null;
}

export interface ZGGatePage {
	items: ZGGateDecision[];
	total: number;
	page: number;
	pageSize: number;
}

export interface ZGGatekeeperConfig {
	mode: ZGMode;
	timeoutMs: number;
	concurrency: number;
}

/** Live gatekeeper state carried in every snapshot. */
export interface ZGGatekeeperView {
	globalMode: ZGMode;
	sessionMode: ZGMode;
	sessionOverride: ZGMode | null;
	/** The endpoint the 守门模型 role resolves to; null when nothing resolves. */
	judgeResolved: ZGResolvedModelView | null;
	failures: number;
	lastFailureAt: number | null;
	/** When the judge last answered; newer than `lastFailureAt` means it recovered. */
	lastSuccessAt: number | null;
	lastError: string | null;
}

export const ZG_GATE_DECISION_LABELS: Record<ZGGateDecisionKind, string> = {
	allow: "放行",
	block: "拦截",
	failed: "请求失败",
};

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

export interface ZGVulnReview {
	state: "queued" | "done" | "failed" | "skipped";
	severity?: ZGVulnSeverity;
	cvss?: number;
	cvssVector?: string;
	verdict?: "solid" | "dubious";
	reason?: string;
	model?: string;
	error?: string;
	at: number;
}

export interface ZGVulnerability {
	/** The reviewer LLM's verdict; a fresh submission starts as "queued". */
	review: ZGVulnReview;
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
	/** Only records the reviewer marked as dubious (hallucination suspects). */
	dubious?: boolean;
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

// --- POC 库（Nuclei 模板中心；对 agent 只读） ---

export type ZGPocSeverity = ZGVulnSeverity;

export interface ZGPoc {
	id: string;
	name: string;
	severity: ZGPocSeverity;
	tags: string[];
	references: string[];
	content: string;
	sourceFile: string;
	importedAt: string;
}

export type ZGPocSummary = Omit<ZGPoc, "content">;

export interface ZGPocFilters {
	search?: string;
	severity?: ZGPocSeverity;
	tag?: string;
}

export interface ZGPocStats {
	total: number;
	bySeverity: Record<ZGPocSeverity, number>;
}

export interface ZGPocImportFile {
	name: string;
	data: string;
}

export interface ZGPocImportOutcome {
	imported: number;
	replaced: number;
	skipped: { name: string; reason: string }[];
}

// --- POC 订阅（远程 zip 源；只增不减） ---

/**
 * Id of the source the one-click official sync owns. Mirrors
 * `OFFICIAL_SOURCE_ID` in the server: the button compares against it to show
 * that row as busy, and the page uses it to read that source's last outcome.
 */
export const ZG_OFFICIAL_POC_SOURCE_ID = "official";

export interface ZGPocSource {
	id: string;
	name: string;
	url: string;
	headerName?: string;
	headerSet: boolean;
	intervalHours: number;
	enabled: boolean;
	lastSyncAt: string | null;
	lastResult: ZGPocSyncRecord | null;
	/** Recent sync outcomes, newest first (bounded server-side). */
	history: ZGPocSyncRecord[];
}

export interface ZGPocSyncRecord {
	at: string;
	ok: boolean;
	trigger: "manual" | "auto";
	durationMs: number;
	imported: number;
	replaced: number;
	skipped: number;
	error?: string;
}

export interface ZGPocSourceSave {
	id?: string;
	name: string;
	url: string;
	headerName?: string;
	headerValue?: string;
	intervalHours: number;
	enabled: boolean;
}

// ---------------------------------------------------------------------------
// 业务建模（Business modeling）
// ---------------------------------------------------------------------------

export type ZGApiModelStatus = "modeling" | "done" | "manual" | "failed";

export const ZG_API_MODEL_STATUS_LABELS: Record<ZGApiModelStatus, string> = {
	modeling: "建模中",
	done: "已完成",
	manual: "人工结束",
	failed: "失败",
};

/** One field of a business entity. */
export interface ZGApiModelField {
	name: string;
	type?: string;
	description?: string;
}

/** One relation between two business entities. */
export interface ZGApiModelRelation {
	target: string;
	kind?: string;
	description?: string;
}

/** A business entity: the object the API is about, not a schema of the document. */
export interface ZGApiModelEntity {
	name: string;
	description?: string;
	fields?: ZGApiModelField[];
	relations?: ZGApiModelRelation[];
}

/** One stored modeling run. */
export interface ZGApiModel {
	id: string;
	projectId: string | null;
	sessionId: string | null;
	sessionPath: string | null;
	title: string;
	target: string;
	status: ZGApiModelStatus;
	openapi: Record<string, unknown>;
	entities: ZGApiModelEntity[];
	pathCount: number;
	operationCount: number;
	submissions: number;
	error?: string;
	createdAt: string;
	updatedAt: string;
	doneAt: string | null;
}

/** A run without the document body, for the list. */
export type ZGApiModelSummary = Omit<ZGApiModel, "openapi" | "entities"> & { entityCount: number };

export interface ZGApiModelFilters {
	status?: ZGApiModelStatus;
	projectId?: string;
	search?: string;
}

/** One line of a run's audit trail. */
export interface ZGApiModelEvent {
	at: string;
	kind: "created" | "submitted" | "done" | "manual" | "failed";
	note?: string;
	pathCount?: number;
	operationCount?: number;
}

/** Live state of the modeling run in the viewed session. */
export interface ZGModelingState {
	runId: string;
	title: string;
	target: string;
	startedAt: string;
	pathCount: number;
	operationCount: number;
	entityCount: number;
}

// ---------------------------------------------------------------------------
// 安卓设备（Droid 插件）
// ---------------------------------------------------------------------------

/** One Android device the DroidBridge APK registered. */
export interface DroidDevice {
	id: string;
	name: string;
	model: string;
	androidVersion: string;
	sdkInt: number;
	rooted: boolean;
	online: boolean;
	tokenId: string;
	firstSeen: string;
	lastSeen: string;
}

/** One reverse-connection token; the value is shown once for typing into the APK. */
export interface DroidToken {
	id: string;
	label: string;
	token: string;
	createdAt: string;
	lastUsedAt: string | null;
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
	/** Mode state and judge health, for the toolbar switch and the fail-open banner. */
	gatekeeper: ZGGatekeeperView;
	/** The preset agent the active session was created with; null means the default agent. */
	preset: ZGSessionPresetView | null;
	/**
	 * The business-modeling run in force for the active session, with live
	 * counters; null when this session is not modeling. The two modeling tools
	 * exist only while this is set.
	 */
	modeling: ZGModelingState | null;
	/**
	 * Modeling records attached to the active session from the composer (带建模
	 * 数据); empty when none. While set, api_model_read is mounted for the agent.
	 */
	modelingAttached: Array<{ id: string; title: string }>;
	/** Compaction is running for the active session, which blocks prompts. */
	compacting: boolean;
	/** When that compaction started, for the elapsed time; null when idle. */
	compactionStartedAt: number | null;
	/** The Droid plugin's toolset switch (device page persists it; the chat toggles it). */
	droidEnabled: boolean;
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
export type ZGGoalPauseReason = "manual" | "limit" | "no-progress" | "interrupted" | "loop-guard";
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
			/**
			 * 带建模数据: records whose catalog rides this first message of a fresh
			 * conversation. Honored only then; unchecked means the field is absent.
			 */
			attachModelIds?: string[];
	  }
	| { type: "abort" }
	| { type: "compact" }
	| { type: "abort_compaction" }
	| { type: "start_goal"; objective: string; criteria?: string[]; roundLimit: number }
	| { type: "pause_goal" }
	| { type: "resume_goal"; extraRounds?: number }
	| { type: "clear_goal" }
	| { type: "set_thinking_level"; level: ZGThinkingLevel }
	/** null makes the active session follow the console-wide default again. */
	| { type: "set_mode"; mode: ZGMode | null }
	| { type: "set_global_mode"; mode: ZGMode }
	| { type: "decide"; decision: { id: string; approved: boolean; command?: string; alwaysAllowPrefix?: boolean } }
	| { type: "decide_all"; approved: boolean }
	| { type: "allow_prefix"; prefix: string }
	| { type: "remove_allowed_prefix"; prefix: string }
	| { type: "new_session"; presetId?: string }
	/** Re-brief the viewed session; `presetId: null` drops back to the default agent. */
	| { type: "set_session_preset"; presetId: string | null }
	| { type: "switch_session"; path: string }
	| { type: "rename_session"; path: string; name: string }
	| { type: "set_session_status"; path?: string; status: ZGSessionStatus | null }
	| { type: "delete_session"; path: string }
	| { type: "list_sessions" }
	| { type: "navigate"; entryId: string; summarize?: boolean }
	| { type: "rename_branch"; entryId: string; label: string }
	| { type: "get_tree" }
	| { type: "get_state" }
	| { type: "get_model_library" }
	/** Create (`id` omitted) or update one entry. `apiKey: null` keeps the stored key. */
	| {
			type: "save_model_entry";
			id?: string;
			name: string;
			baseUrl: string;
			apiKey: string | null;
			modelId: string;
	  }
	| { type: "remove_model_entry"; id: string }
	| { type: "duplicate_model_entry"; id: string }
	| { type: "set_model_role"; role: ZGModelRoleName; target: string | null }
	| { type: "set_reviewer_auto"; enabled: boolean }
	| { type: "test_model_entry"; id: string }
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
	| { type: "retry_vuln_review"; id: string; force?: boolean }
	| { type: "review_pending_vulns" }
	| { type: "list_pocs"; filters?: ZGPocFilters }
	| { type: "get_poc"; id: string }
	| { type: "import_pocs"; files: ZGPocImportFile[] }
	| { type: "delete_poc"; id: string }
	| { type: "list_poc_sources" }
	| { type: "save_poc_source"; source: ZGPocSourceSave }
	| { type: "delete_poc_source"; id: string }
	| { type: "sync_poc_source"; id: string }
	| { type: "sync_official_pocs" }
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
	| { type: "list_presets" }
	/**
	 * Create or update a preset agent. `id` is present only when updating: the
	 * server generates ids, and a save never overwrites another entry.
	 */
	| {
			type: "save_preset";
			input: {
				id?: string;
				name: string;
				description?: string;
				tags?: string[];
				placeholder?: string;
				text: string;
				enabled?: boolean;
			};
	  }
	| { type: "delete_preset"; id: string }
	| { type: "set_preset_enabled"; id: string; enabled: boolean }
	/** Export the selected presets, or all of them when `ids` is omitted. */
	| { type: "export_presets"; ids?: string[] }
	| { type: "import_presets"; content: string }
	| { type: "get_commander_config" }
	| { type: "save_commander_config"; config: ZGModelConfig | null }
	| { type: "get_gatekeeper_config" }
	| { type: "save_gatekeeper_config"; config: ZGGatekeeperConfig }
	| { type: "test_judge" }
	| { type: "gate_audit_query"; filter?: ZGGateFilter; page?: number; pageSize?: number }
	| { type: "gate_audit_stats"; filter?: ZGGateFilter }
	/** Start business modeling in the viewed session; the objective comes from the conversation. */
	| { type: "start_modeling" }
	| { type: "end_modeling" }
	| { type: "detach_modeling" }
	| { type: "end_api_model"; id: string }
	/** The Android device page: pull the full gateway state. */
	| { type: "droid_state" }
	| { type: "droid_token_create"; label: string }
	| { type: "droid_token_delete"; id: string }
	| { type: "droid_device_rename"; id: string; name: string }
	| { type: "droid_device_remove"; id: string }
	| { type: "droid_set_enabled"; enabled: boolean }
	| { type: "droid_set_listen"; host: string; port: number }
	| { type: "list_api_models"; filters?: ZGApiModelFilters }
	| { type: "get_api_model"; id: string }
	| { type: "delete_api_model"; id: string }
	| { type: "export_api_model"; id: string; format: "json" | "yaml" }
	| { type: "engine_set_gate_mode"; id: string; gateMode: ZGEngineGateMode }
	/**
	 * Replace this engine's preset whitelist. An empty list means "no restriction":
	 * the commander may use any enabled preset.
	 */
	| { type: "engine_set_presets"; id: string; presetIds: string[] }
	/**
	 * Whether the commander may leave a task without a preset, running it as the
	 * default agent. False means every dispatch must name one of the allowed
	 * presets, and a dispatch that names none is refused with the list of choices.
	 */
	| { type: "engine_set_preset_optional"; id: string; optional: boolean };

export type ZGServerMessage =
	| { type: "snapshot"; snapshot: ZGStateSnapshot }
	| { type: "session_event"; event: SessionEventView }
	| { type: "sessions"; sessions: SessionInfoView[] }
	| { type: "tree"; tree: SessionTreeNodeView[]; leafId: string | null; forkPoints: ZGForkPoint[] }
	| { type: "model_library"; library: ZGModelLibraryView }
	| { type: "model_test_result"; result: ZGTestResult }
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
	| { type: "vuln_review_result"; id: string; ok: boolean; error?: string }
	| { type: "pocs"; items: ZGPocSummary[]; stats: ZGPocStats }
	| { type: "poc"; poc: ZGPoc }
	| { type: "poc_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "pocs_imported"; outcome: ZGPocImportOutcome }
	| { type: "poc_sources"; sources: ZGPocSource[] }
	| { type: "poc_source_result"; action: string; id?: string; ok: boolean; error?: string }
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
	| { type: "presets"; presets: ZGPresetView[] }
	| { type: "preset_saved"; preset: ZGPresetView | null; error?: string }
	| { type: "preset_deleted"; id: string; ok: boolean; error?: string }
	| { type: "presets_export"; filename: string; content: string }
	| {
			type: "presets_imported";
			imported: ZGPresetView[];
			skipped: Array<{ name: string; reason: string }>;
			error?: string;
	  }
	| { type: "commander_config"; config: ZGModelConfig | null }
	| { type: "gatekeeper_config"; config: ZGGatekeeperConfig }
	| { type: "judge_test_result"; result: ZGTestResult; raw?: string }
	| { type: "gate_audit"; page: ZGGatePage }
	| { type: "gate_audit_stats"; stats: ZGGateStats }
	| { type: "gate_decision"; decision: ZGGateDecision }
	| { type: "api_models"; items: ZGApiModelSummary[] }
	| { type: "api_model"; model: ZGApiModel; events: ZGApiModelEvent[] }
	| { type: "api_model_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "api_model_export"; filename: string; format: "json" | "yaml"; text: string }
	| {
			type: "droid_state";
			enabled: boolean;
			devices: DroidDevice[];
			tokens: DroidToken[];
			listen: { host: string; port: number } | null;
			listenConfig: { host: string; port: number } | null;
			lanIps: string[];
	  }
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

/**
 * How an engine's workers get their commands approved. Engineering mode is
 * unattended, so `review` is not offered.
 */
export type ZGEngineGateMode = "auto" | "ai";

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
	/**
	 * Which preset agent this task runs as, fixed at dispatch. `presetName` is
	 * copied in rather than resolved from the preset library, so the board still
	 * shows what a finished task ran as after the preset is deleted or renamed.
	 */
	presetId: string | null;
	presetName: string | null;
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
	/**
	 * Preset agents the commander may dispatch with. Empty means no restriction:
	 * the brief lists every enabled preset. A non-empty list narrows the choice,
	 * and `dispatch_task` refuses a preset outside it.
	 */
	presetIds: string[];
	/**
	 * Whether a task may run without a preset, as the default agent. True is how
	 * every engine behaved before this switch existed, and it stays the default.
	 * False makes `dispatch_task` refuse a dispatch that names no preset, so every
	 * worker runs under an identity the operator allowed.
	 */
	presetOptional: boolean;
	limits: ZGEngineLimits;
	/** How this engine's worker commands are gated; see ZGEngineGateMode. */
	gateMode: ZGEngineGateMode;
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

/**
 * One preset agent: a named block of extra system-prompt context.
 *
 * Metadata only. The prompt body lives in `presets/<id>.md` and is loaded on
 * demand, so the session list can be read without pulling every preset's text
 * into memory.
 */
export interface ZGPreset {
	id: string;
	name: string;
	description: string;
	tags: string[];
	/** The composer's idle hint while this preset is in force; empty means the default text. */
	placeholder: string;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

/** A preset as the settings screen needs it: metadata plus the loaded body. */
export interface ZGPresetView extends ZGPreset {
	text: string;
	/** The body file is gone; the entry is unusable until the operator rewrites it. */
	textMissing: boolean;
	/** Rough token cost of `text`, so a huge preset is visible before it is used. */
	tokens: number;
}

/**
 * The preset agent a session was created with, as the console shows it. `null`
 * on the snapshot means the session runs the plain default agent.
 */
export interface ZGSessionPresetView {
	id: string;
	/** The current name; falls back to the id when the preset was deleted. */
	name: string;
	/** The preset is gone or its body file is missing: the session runs the default agent. */
	missing: boolean;
	/** The preset's composer hint; empty when it has none, or when the preset is gone. */
	placeholder: string;
}

export interface ZGEngineCreateInput {
	name: string;
	targets: string;
	doctrines: string[];
	/** Preset agents the commander may use; empty or omitted means no restriction. */
	presetIds?: string[];
	/** Whether a task may run without a preset; omitted means it may. */
	presetOptional?: boolean;
	limits: ZGEngineLimits;
	gateMode?: ZGEngineGateMode;
}
