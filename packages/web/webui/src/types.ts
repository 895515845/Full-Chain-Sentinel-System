/** Client-side view of the ZGAgent wire protocol (mirrors packages/web/src/protocol.ts). */

export type ZGMode = "review" | "auto";

/** Reasoning effort levels pi accepts, ascending. */
export type ZGThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Image attachment carried with a prompt (base64 payload, no data-URL prefix). */
export interface ZGImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ZGModelConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
}

export interface ZGTestResult {
	ok: boolean;
	message: string;
	detail?: string;
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
}

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
	  }
	| { role: "bashExecution"; command: string; output: string; exitCode?: number; cancelled?: boolean }
	| { role: "compactionSummary"; summary?: string }
	| { role: "branchSummary"; summary?: string }
	| { role: "custom"; customType: string; content: unknown };

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
	  }
	| { type: "abort" }
	| { type: "compact" }
	| { type: "set_thinking_level"; level: ZGThinkingLevel }
	| { type: "set_mode"; mode: ZGMode }
	| { type: "decide"; decision: { id: string; approved: boolean; command?: string; alwaysAllowPrefix?: boolean } }
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
	| { type: "get_stats" }
	| { type: "list_projects" }
	| { type: "add_project"; name: string }
	| { type: "remove_project"; id: string; confirmName: string }
	| { type: "switch_project"; id: string | null };

export type ZGServerMessage =
	| { type: "snapshot"; snapshot: ZGStateSnapshot }
	| { type: "session_event"; event: SessionEventView }
	| { type: "sessions"; sessions: SessionInfoView[] }
	| { type: "tree"; tree: SessionTreeNodeView[]; leafId: string | null; forkPoints: ZGForkPoint[] }
	| { type: "config"; config: ZGModelConfig | null }
	| { type: "test_result"; result: ZGTestResult }
	| { type: "stats"; stats: ZGStatsView }
	| { type: "projects"; projects: ZGProjectInfo[]; activeProjectId: string | null }
	| { type: "error"; message: string };

/** Union of the session events the UI reacts to. */
export type SessionEventView =
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
