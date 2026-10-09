/** Wire protocol shared by the ZGAgent web console server and browser client. */

import type {
	AgentSessionEvent,
	ImageContent,
	SessionInfo,
	SessionStats,
	SessionTreeNode,
	ThinkingLevel,
} from "@earendil-works/pi-coding-agent";

/** Operator approval mode for bash tool calls. */
export type ZGMode = "review" | "auto";

/** Model endpoint configuration persisted in models.json. */
export interface ZGModelConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
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

/** Snapshot of the runtime state sent on connect and after state changes. */
export interface ZGStateSnapshot {
	mode: ZGMode;
	streaming: boolean;
	cwd: string;
	/** Active project, or null when running on the server startup directory. */
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
}

/** A point the conversation can branch from. */
export interface ZGForkPoint {
	entryId: string;
	text: string;
}

/** Client-to-server messages. */
export type ZGClientMessage =
	| { type: "prompt"; text: string; streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] }
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
	| { type: "get_stats" }
	| { type: "list_projects" }
	| { type: "add_project"; name: string }
	| { type: "remove_project"; id: string; confirmName: string }
	| { type: "switch_project"; id: string | null };

/** Server-to-client messages. */
export type ZGServerMessage =
	| { type: "snapshot"; snapshot: ZGStateSnapshot }
	| { type: "session_event"; event: AgentSessionEvent }
	| { type: "sessions"; sessions: SessionInfo[] }
	| { type: "tree"; tree: SessionTreeNode[]; leafId: string | null; forkPoints: ZGForkPoint[] }
	| { type: "config"; config: ZGModelConfig | null }
	| { type: "test_result"; result: ZGTestResult }
	| { type: "stats"; stats: SessionStats }
	| { type: "projects"; projects: ZGProjectInfo[]; activeProjectId: string | null }
	| { type: "error"; message: string };
