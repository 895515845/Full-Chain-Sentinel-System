/**
 * The pass-through half of the audit trail: 「自动审批」.
 *
 * The gatekeeper records what it judged (see `gatekeeper.guard`). That leaves a
 * hole: in 自动执行, in 审批模式, and for every tool the judge does not cover
 * (read, edit, write, MCP with the switch off), nothing is written at all — so
 * the audit page could not answer "what did this session actually do".
 *
 * This extension closes the hole and nothing else. It never blocks, never waits,
 * and never talks to a model: it writes one row per tool call that is not
 * already recorded somewhere else, then gets out of the way.
 *
 * Two calls are skipped on purpose, and both for the same reason — they are
 * recorded where their outcome is actually known:
 *
 * - `bash` and `droid_shell` record themselves inside their own execution path
 *   (see `createGatedBash` / `guardDroidCommand`). 审批模式 has an answer only
 *   after the operator replies, and a row written here would have to guess it.
 * - the evidence capture (`replay_capture`) reaches the target through
 *   `guardReplayCommand`, which records the payload and the outcome the same way.
 * - MCP tools that the AI gate will judge are recorded by the gate itself;
 *   recording them here as well would put two rows on one call.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readGatekeeperConfig } from "./gatekeeper-config.ts";
import type { GatekeeperStore } from "./gatekeeper-store.ts";
import { shouldJudgeTool, stringifyToolArgs, type ToolGateContext } from "./tool-gate.ts";

/** Tools whose own execution path writes the audit row, outcome included. */
const SELF_RECORDED = new Set(["bash", "droid_shell", "replay_capture"]);

export function createToolAuditExtension(options: {
	store: GatekeeperStore;
	agentDir: string;
	context: ToolGateContext;
}): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", (event) => {
			if (SELF_RECORDED.has(event.toolName)) return undefined;
			// Read per call, like every other gate decision: the operator can turn
			// the MCP switch off while a session is running.
			const config = readGatekeeperConfig(options.agentDir);
			const mode = options.context.modeOf();
			if (shouldJudgeTool({ toolName: event.toolName, mode, config })) return undefined;
			options.store.record({
				at: Date.now(),
				projectId: options.context.projectId,
				projectName: options.context.projectName,
				sessionId: options.context.sessionId(),
				source: options.context.label(),
				tool: event.toolName,
				command: stringifyToolArgs(event.input),
				cwd: null,
				// Only the two own-entrance tools can be human-approved; everything
				// that reaches this point was let through without anyone looking.
				approval: "auto",
				decision: "allow",
				latencyMs: 0,
			});
			return undefined;
		});
	};
}
