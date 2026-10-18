/**
 * The tool-call gate: the gatekeeper's second entrance.
 *
 * bash is judged inside the bash tool, at the point where the command would
 * enter the container (see `createGatedBash`). MCP tools have no such seam in
 * this console — they are registered by the MCP extension and executed by an MCP
 * client — so this gate hangs off the agent's `tool_call` event instead, which
 * fires for every tool before it runs and can veto the call with a reason the
 * model then reads.
 *
 * Three rules keep it honest:
 *
 * - bash and droid_shell never reach this gate. They are already judged at their
 *   own entrance; judging them here too would spend a second judgment per
 *   command and could reach the opposite verdict. The name filter does that, not
 *   a special case: only `mcp__` tools are considered.
 * - The decision is read per call, never captured when the session is built. The
 *   operator flipping the switch in 设置 → 模型 applies to sessions that are
 *   already open, which is the same promise the bash gate makes about modes.
 * - A failed judgment is allowed through, exactly like bash: an unattended run
 *   must not lose a plugin because the judge endpoint is down. The audit page
 *   records it as 「请求失败」.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Gatekeeper } from "./gatekeeper.ts";
import { readGatekeeperConfig } from "./gatekeeper-config.ts";
import type { SentinelGatekeeperConfig, SentinelMode } from "./protocol.ts";

/** MCP tools are registered as `mcp__<server>__<tool>`. */
const MCP_PREFIX = "mcp__";

/** Plugin-host servers are named `plugin-<id>`; anything else is a custom MCP server. */
const PLUGIN_SERVER_PREFIX = "plugin-";

/** The server part of an MCP tool name, or null when this is not an MCP tool. */
export function mcpToolServer(toolName: string): string | null {
	if (!toolName.startsWith(MCP_PREFIX)) return null;
	const rest = toolName.slice(MCP_PREFIX.length);
	const end = rest.indexOf("__");
	return end > 0 ? rest.slice(0, end) : null;
}

/** Whether the tool comes from a plugin-host server rather than a configured MCP server. */
export function isPluginTool(toolName: string): boolean {
	return mcpToolServer(toolName)?.startsWith(PLUGIN_SERVER_PREFIX) ?? false;
}

/**
 * Whether this call is judged at all.
 *
 * `mode` is the session's effective mode: `auto` and `review` have their own
 * answer for every tool call, and the judge only exists in `ai`.
 */
export function shouldJudgeTool(input: {
	toolName: string;
	mode: SentinelMode;
	config: SentinelGatekeeperConfig;
}): boolean {
	if (input.mode !== "ai") return false;
	if (!input.config.mcpTools.enabled) return false;
	const server = mcpToolServer(input.toolName);
	if (server === null) return false;
	if (server.startsWith(PLUGIN_SERVER_PREFIX) && !input.config.mcpTools.includePlugins) return false;
	return true;
}

/**
 * The argument JSON as one string, for both the judge and the audit row.
 *
 * A plugin's `upload_file_base64` carries a whole file in one argument; the store
 * and the judge each cap what they keep, so this only has to be honest about
 * being JSON.
 */
export function stringifyToolArgs(args: unknown): string {
	try {
		return JSON.stringify(args ?? {});
	} catch {
		// Cyclic or otherwise unrepresentable: the judge still gets something.
		return String(args);
	}
}

/** What the gate needs to know about the session that issued the call. */
export interface ToolGateContext {
	/** Who issued it: 主代理 / 子代理 / 工程任务「X」. */
	label: () => string;
	/** The session's effective mode, read at call time. */
	modeOf: () => SentinelMode;
	projectId: string | null;
	projectName: string | null;
	sessionId: () => string | null;
}

/**
 * The extension that judges MCP tool calls.
 *
 * It is registered on every console session, including ones without MCP mounted:
 * the prefix check is what makes it free there, and a session can gain MCP tools
 * later (a plugin enabled, a server added) without being rebuilt.
 */
export function createToolGateExtension(options: {
	gatekeeper: Gatekeeper;
	agentDir: string;
	context: ToolGateContext;
}): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", async (event) => {
			// Cheapest rejection first: this handler sits on every tool call's path,
			// and almost none of them are MCP tools.
			const server = mcpToolServer(event.toolName);
			if (server === null) return undefined;
			const config = readGatekeeperConfig(options.agentDir);
			if (!shouldJudgeTool({ toolName: event.toolName, mode: options.context.modeOf(), config })) {
				return undefined;
			}
			const outcome = await options.gatekeeper.guard({
				tool: event.toolName,
				server,
				command: stringifyToolArgs(event.input),
				cwd: "/work",
				source: options.context.label(),
				projectId: options.context.projectId,
				projectName: options.context.projectName,
				sessionId: options.context.sessionId(),
			});
			// `allow` and `failed` both run: a missing verdict is not a block.
			if (outcome.kind !== "block") return undefined;
			return { block: true, reason: outcome.message };
		});
	};
}
