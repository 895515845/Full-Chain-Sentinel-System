/** Wire protocol shared by the ZGAgent web console server and browser client. */

import type {
	AgentSessionEvent,
	ImageContent,
	SessionStats,
	SessionTreeNode,
	ThinkingLevel,
} from "@earendil-works/pi-coding-agent";
import type { ZGPermissionPreset, ZGPermissionSet, ZGPermissionsConfig } from "./permissions.ts";
import type { ZGSessionListEntry, ZGSessionStatus } from "./session-status.ts";

/**
 * Who decides whether a bash command may run.
 *
 * `review` asks the operator, `ai` asks the gatekeeper model, `auto` runs it.
 * `ai` is not a weaker `auto`: a judgment that fails is allowed through (so a
 * dead endpoint cannot stall an unattended run), but a missing endpoint refuses
 * the mode outright rather than silently degrading.
 */
export type ZGMode = "review" | "ai" | "auto";

/** The modes a session may carry; the order the console lists them in. */
export const ZG_MODES: readonly ZGMode[] = ["review", "ai", "auto"];

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

/** The three jobs a model can be assigned to. */
export type ZGModelRoleName = "main" | "judge" | "reviewer";

/**
 * One row of the model library as the settings screen sees it. The key itself is
 * never sent to the client; `hasKey` only says whether one is stored.
 */
export interface ZGModelEntryView {
	id: string;
	name: string;
	baseUrl: string;
	modelId: string;
	hasKey: boolean;
	/** Roles currently pointing at this entry. */
	roles: ZGModelRoleName[];
}

/** What a role resolves to right now, so the screen can show the effective endpoint. */
export interface ZGResolvedModelView {
	entryId: string;
	entryName: string;
	modelId: string;
	/** True when the role resolved through 主模型 instead of its own entry. */
	followedMain: boolean;
}

/**
 * The whole model screen: the library, the role assignments (entry id, or
 * "follow-main" for judge/reviewer, or null for an unset main), and what each
 * role currently resolves to.
 */
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
	/**
	 * How many characters of notification body to keep, counted per section (a run's
	 * closing summary, a goal's conclusion, a finding's raw packet). 0 keeps all of
	 * it. DingTalk rejects a request body over 20000 bytes, which is enforced
	 * separately, whatever this says.
	 */
	summaryLimit: number;
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

// ---------------------------------------------------------------------------
// Gatekeeper (守门审计)
// ---------------------------------------------------------------------------

/**
 * What the gatekeeper decided about one bash command.
 *
 * `failed` is deliberately separate from `allow`: a judgment that never arrived
 * is allowed through, but it is a different event from the gatekeeper reading
 * the command and clearing it, and the audit page has to keep them apart.
 */
export type ZGGateDecisionKind = "allow" | "block" | "failed";

/** One gatekeeper judgment, as stored and as streamed to the console. */
export interface ZGGateDecision {
	id: string;
	/** Epoch milliseconds when the judgment started. */
	at: number;
	projectId: string | null;
	projectName: string | null;
	/** Session that issued the command. */
	sessionId: string | null;
	/** Which agent issued it: 主代理 / 子代理 / 工程任务「X」. */
	source: string;
	tool: string;
	command: string;
	/** The stored command was cut to the per-record cap. */
	commandTruncated?: boolean;
	cwd: string | null;
	decision: ZGGateDecisionKind;
	/** The gatekeeper's BLOCK reason, or the failure text for `failed`. */
	reason?: string;
	latencyMs: number;
	/** Endpoint that produced the verdict, e.g. "judge-stub". */
	model?: string;
	/** Display name of the library entry the endpoint came from. */
	modelFrom?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	/** Raw error text when the judgment could not be completed. */
	error?: string;
}

/** Audit list filters; every field is optional and they combine with AND. */
export interface ZGGateFilter {
	decision?: ZGGateDecisionKind;
	projectId?: string;
	sessionId?: string;
	/** Exact source label, e.g. "子代理". */
	source?: string;
	/** Case-insensitive substring match on the command and the reason. */
	search?: string;
	/** Only judgments at or after this epoch millisecond. */
	since?: number;
}

/** Counts and cost figures for the audit page header. */
export interface ZGGateStats {
	total: number;
	byDecision: Record<ZGGateDecisionKind, number>;
	/** block / total, 0 when nothing was judged yet. */
	blockRate: number;
	avgLatencyMs: number;
	/** Judge tokens spent; never counted into a session's own usage. */
	totalTokens: number;
	/** Judgments in the last 24 hours, so the page can show whether it is alive. */
	last24h: number;
	/** Judgments that ended in a failure (all of which were allowed through). */
	failures: number;
	lastFailureAt: number | null;
	/** When the judge last answered at all, block included. */
	lastSuccessAt: number | null;
	lastError: string | null;
}

/** One page of audit records, newest first. */
export interface ZGGatePage {
	items: ZGGateDecision[];
	/** Records matching the filter, not the page size. */
	total: number;
	page: number;
	pageSize: number;
}

/** Gatekeeper settings persisted in gatekeeper.json. */
export interface ZGGatekeeperConfig {
	/** Console-wide default mode; a session may override it. */
	mode: ZGMode;
	/** How long one judgment may take before it counts as a failure. */
	timeoutMs: number;
	/** Judgments allowed in flight at once; 0 means no limit. */
	concurrency: number;
}

/** Live gatekeeper state carried in every snapshot. */
export interface ZGGatekeeperView {
	/** The console-wide default. */
	globalMode: ZGMode;
	/** Mode in effect for the active session (its override, or the global default). */
	sessionMode: ZGMode;
	/** The active session's own choice; null means it follows the global default. */
	sessionOverride: ZGMode | null;
	/** The endpoint the 守门模型 role resolves to; null when nothing resolves. */
	judgeResolved: ZGResolvedModelView | null;
	/** Judgments that failed and were allowed through. */
	failures: number;
	lastFailureAt: number | null;
	/** When the judge last answered; newer than `lastFailureAt` means it recovered. */
	lastSuccessAt: number | null;
	lastError: string | null;
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
	/** Gatekeeper judgments recorded for this project, for the same reason. */
	gateCount?: number;
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
/** The dedicated reviewer LLM's verdict on one finding. */
export interface ZGVulnReview {
	/** queued = waiting for the reviewer; done = verdict applied; failed = endpoint/parse error; skipped = operator acted first. */
	state: "queued" | "done" | "failed" | "skipped";
	/** The reviewer's own rating, present when state is "done". */
	severity?: ZGVulnSeverity;
	cvss?: number;
	cvssVector?: string;
	/** solid = evidence supports the finding; dubious = it does not (hallucination suspects). */
	verdict?: "solid" | "dubious";
	/** One-paragraph justification, always in Chinese for the operator. */
	reason?: string;
	/** Which model produced the verdict, e.g. "gpt-4o-mini". */
	model?: string;
	/** Failure reason, present when state is "failed". */
	error?: string;
	at: number;
}

export interface ZGVulnerability {
	/** The reviewer LLM's verdict; a fresh submission starts as "queued". */
	review: ZGVulnReview;
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
	/** Only records the reviewer marked as dubious (hallucination suspects). */
	dubious?: boolean;
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

// ---------------------------------------------------------------------------
// Engineering mode (工程模式)
// ---------------------------------------------------------------------------

/** Lifecycle of one engineering run. */
export type ZGEngineStatus = "running" | "paused" | "completed" | "stopped";

/**
 * How an engine's workers get their commands approved. Engineering mode is
 * unattended, so `review` is not offered: a worker would park on an approval
 * queue nobody is watching. `ai` routes every worker command through the
 * gatekeeper instead.
 */
export type ZGEngineGateMode = "auto" | "ai";

/** Lifecycle of one engine task. Paused means interrupted (e.g. a restart). */
export type ZGEngineTaskStatus = "queued" | "running" | "done" | "failed" | "blocked" | "aborted" | "paused";

/** One line of the operator's target list: a target plus an optional note. */
export interface ZGEngineTarget {
	target: string;
	note?: string;
}

/** Per-engine knobs; per-task limits derive from these unless overridden. */
export interface ZGEngineLimits {
	/** How many tasks of this engine may run at the same time. */
	concurrency: number;
	/** Automatic continuation rounds per task. */
	roundLimit: number;
	/** Total tokens per task; null means no token limit. */
	tokenLimit: number | null;
	/** Wall-clock minutes per task; null means no time limit. */
	timeLimitMin: number | null;
	/** Dispatch attempts allowed per target (the first one counts). */
	maxRetries: number;
}

/** One task the commander dispatched. Executed by its own agent session. */
export interface ZGEngineTask {
	id: string;
	engineId: string;
	title: string;
	/** Self-contained instructions for the worker, written by the commander. */
	objective: string;
	target: string | null;
	/** Directory inside the project work dir this task owns. */
	workspace: string;
	status: ZGEngineTaskStatus;
	/** Which dispatch attempt for its target this is; 1 is the first. */
	attempt: number;
	/** Acceptance criteria the commander attached; the worker's goal enforces them. */
	criteria: string[];
	roundLimit: number;
	/**
	 * Which preset agent this task runs as, fixed at dispatch. `presetName` is
	 * copied in rather than resolved from the preset library, so the board still
	 * shows what a finished task ran as after the preset is deleted or renamed.
	 */
	presetId: string | null;
	presetName: string | null;
	/** pi session id of the worker, once it exists. */
	sessionId: string | null;
	startedAt: number | null;
	endedAt: number | null;
	summary: string | null;
	error: string | null;
	usage: ZGGoalUsage | null;
	/** Findings submitted to the hub while this task ran. */
	vulns: number;
}

/** An engineering run: a commander plus its targets, tasks, and report. */
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
	/** Final report markdown, once the commander declared the engine done. */
	report: string | null;
	tasks: ZGEngineTask[];
}

/**
 * One step of the commander's decision log or a worker's process, in the same
 * shape as the sub-agent events so the console can render both alike.
 */
export type ZGEngineEvent = ZGSubagentEvent;

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
	/** Operator status of the active session, as a label the agent never sees. */
	sessionStatus: ZGSessionStatus | null;
	/** The preset agent the active session was created with; null means the default agent. */
	preset: ZGSessionPresetView | null;
	/** Which mode applies and how the gatekeeper model is doing. */
	gatekeeper: ZGGatekeeperView;
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
	/** Sets the active session's own mode; null makes it follow the global default. */
	| { type: "set_mode"; mode: ZGMode | null }
	/** Sets the console-wide default every session without an override follows. */
	| { type: "set_global_mode"; mode: ZGMode }
	| {
			type: "decide";
			decision: { id: string; approved: boolean; command?: string; alwaysAllowPrefix?: boolean };
	  }
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
	/** Create (`id` omitted) or update one library entry. `apiKey: null` keeps the stored key. */
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
	/** Point a role at an entry id, at "follow-main", or (main only) at null. */
	| { type: "set_model_role"; role: ZGModelRoleName; target: string | null }
	| { type: "set_reviewer_auto"; enabled: boolean }
	/** Probe one library entry with a plain chat request. */
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
	| { type: "retry_vuln_review"; id: string }
	| { type: "get_environment" }
	| { type: "check_environment" }
	| { type: "build_image" }
	| { type: "abort_image_build" }
	| { type: "set_sources"; sources: ZGSources }
	| { type: "list_engines" }
	| { type: "engine_create"; input: ZGEngineCreateInput }
	/** Change an engine's command gate; refused while a task is in flight. */
	| { type: "engine_set_gate_mode"; id: string; gateMode: ZGEngineGateMode }
	/**
	 * Replace this engine's preset whitelist. An empty list means "no restriction":
	 * the commander may use any enabled preset, which is what every engine created
	 * before presets existed does.
	 */
	| { type: "engine_set_presets"; id: string; presetIds: string[] }
	/**
	 * Whether the commander may leave a task without a preset, running it as the
	 * default agent. False means every dispatch must name one of the allowed
	 * presets, and a dispatch that names none is refused with the list of choices.
	 */
	| { type: "engine_set_preset_optional"; id: string; optional: boolean }
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
	 * Create or update a preset agent. `id` is present only when updating: the id
	 * is generated from the name, so the client never invents one.
	 */
	| {
			type: "save_preset";
			input: { id?: string; name: string; description?: string; tags?: string[]; text: string; enabled?: boolean };
	  }
	| { type: "delete_preset"; id: string }
	| { type: "set_preset_enabled"; id: string; enabled: boolean }
	/** Export the selected presets, or all of them when `ids` is omitted. */
	| { type: "export_presets"; ids?: string[] }
	/** Import an export file's text; existing presets are never overwritten. */
	| { type: "import_presets"; content: string }
	| { type: "get_commander_config" }
	| { type: "save_commander_config"; config: ZGModelConfig | null }
	| { type: "get_gatekeeper_config" }
	| { type: "save_gatekeeper_config"; config: ZGGatekeeperConfig }
	/** Probes whatever the 守门模型 role resolves to with one fixed sample command. */
	| { type: "test_judge" }
	| { type: "gate_audit_query"; filter?: ZGGateFilter; page?: number; pageSize?: number }
	| { type: "gate_audit_stats"; filter?: ZGGateFilter };

/** Server-to-client messages. */
export type ZGServerMessage =
	| { type: "snapshot"; snapshot: ZGStateSnapshot }
	| { type: "session_event"; event: AgentSessionEvent }
	| { type: "sessions"; sessions: ZGSessionListEntry[] }
	| { type: "tree"; tree: SessionTreeNode[]; leafId: string | null; forkPoints: ZGForkPoint[] }
	/** The whole model screen: library, role assignments, resolved endpoints. */
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
	| { type: "vuln_review_result"; id: string; ok: boolean; error?: string }
	| { type: "environment"; report: ZGEnvReport; building: boolean }
	| { type: "image_build_log"; line: string }
	| { type: "image_build_result"; ok: boolean; error?: string }
	| { type: "sources_saved"; sources: ZGSources; error?: string }
	| { type: "engines"; engines: ZGEngine[] }
	| { type: "engine_update"; engine: ZGEngine }
	| { type: "engine_commander_event"; engineId: string; event: ZGEngineEvent }
	| { type: "engine_task_event"; taskId: string; event: ZGEngineEvent }
	| { type: "engine_task_events"; taskId: string; events: ZGEngineEvent[] }
	| { type: "engine_commander_events"; id: string; events: ZGEngineEvent[] }
	| { type: "engine_report"; id: string; markdown: string; filename: string }
	| { type: "doctrines"; doctrines: ZGDoctrineView[] }
	| { type: "doctrine_saved"; doctrine: ZGDoctrineView; error?: string }
	| { type: "doctrine_deleted"; id: string; ok: boolean; error?: string }
	| { type: "presets"; presets: ZGPresetView[] }
	| { type: "preset_saved"; preset: ZGPresetView | null; error?: string }
	| { type: "preset_deleted"; id: string; ok: boolean; error?: string }
	/** The export file's text; the browser turns it into a download. */
	| { type: "presets_export"; filename: string; content: string }
	| {
			type: "presets_imported";
			imported: ZGPresetView[];
			skipped: Array<{ name: string; reason: string }>;
			error?: string;
	  }
	| { type: "commander_config"; config: ZGModelConfig | null }
	| { type: "gatekeeper_config"; config: ZGGatekeeperConfig }
	/** One sample judgment, so the operator can see the prompt and endpoint work. */
	| {
			type: "judge_test_result";
			result: ZGTestResult;
			/** The raw one-line answer, when a judgment actually came back. */
			raw?: string;
	  }
	| { type: "gate_audit"; page: ZGGatePage }
	| { type: "gate_audit_stats"; stats: ZGGateStats }
	/** One judgment, streamed live so an open audit page prepends it. */
	| { type: "gate_decision"; decision: ZGGateDecision }
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

/** A doctrine as the wire shows it (same shape as the stored one). */
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
}

/** Operator input when creating an engineering run. */
export interface ZGEngineCreateInput {
	name: string;
	/** One target per line, `target [note]`; blank lines dropped. */
	targets: string;
	doctrines: string[];
	/** Preset agents the commander may use; empty or omitted means no restriction. */
	presetIds?: string[];
	/** Whether a task may run without a preset; omitted means it may. */
	presetOptional?: boolean;
	limits: ZGEngineLimits;
	/** Defaults to `auto` when omitted, which is what engines predating it used. */
	gateMode?: ZGEngineGateMode;
}
