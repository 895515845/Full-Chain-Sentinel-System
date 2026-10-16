/**
 * One-shot connection probe for one MCP server entry.
 *
 * The session path (`McpServerConnection`) is reused rather than reimplemented, so a probe resolves
 * `${VAR}` and `!cmd` config values, expands `~`, resolves `cwd` against the working directory, and
 * reports a required sign-in exactly the way a session would. A second implementation would drift
 * from the one the agent actually uses, and a probe that disagrees with the session is worse than no
 * probe.
 *
 * It exists for callers that are not an agent session: the web console's settings screen, which has
 * to answer "does this server work, and what does it offer" before the operator saves it. Nothing is
 * registered anywhere — connect, read, close.
 */

import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { McpServerEntry } from "./config.ts";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
	McpServerLog,
	type McpTransportFactory,
} from "./runtime.ts";

/** Bound on one probe, so a hanging server cannot hold a settings screen open. */
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

export interface McpProbeResult {
	/** The server answered and its tool list was read. */
	ok: boolean;
	/**
	 * `connected`: the server answered. `needs-auth`: it answered 401 and wants OAuth, which this
	 * probe cannot complete. `failed`: anything else, including the probe timing out.
	 */
	state: "connected" | "needs-auth" | "failed";
	/** One-line outcome for direct display. */
	message: string;
	/** Failure text as the connection reported it, including the stdio server's stderr tail. */
	detail?: string;
	/** Tool names the server offers, in its own order. */
	tools: string[];
	/** Resources it listed at connect time. */
	resources: number;
	/** Server instructions from `initialize`, when it sent any. */
	instructions?: string;
}

export interface McpProbeOptions {
	/** Working directory relative `cwd` and stdio servers resolve against. */
	cwd: string;
	/** Defaults to stdio and streamable HTTP transports built from the entry. */
	createTransport?: McpTransportFactory;
	/** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
	logPath?: string;
	/** Defaults to 20000. */
	timeoutMs?: number;
}

/**
 * Connect once to `entry` and report what it offers. Never throws: a failed connection is the answer
 * this function exists to give, so it comes back as `ok: false` with the reason.
 */
export async function probeMcpServer(entry: McpServerEntry, options: McpProbeOptions): Promise<McpProbeResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const connection = new McpServerConnection({
		entry,
		cwd: options.cwd,
		createTransport: options.createTransport ?? createDefaultTransport,
		credentials: new McpOAuthCredentialStore(),
		// A standalone probe has no model registry, so a server configured with `auth.provider`
		// cannot get a token here and comes back as needing a sign-in. That is the honest answer.
		providerToken: async () => undefined,
		onTools: () => {},
		log: new McpServerLog(options.logPath ?? join(getAgentDir(), "mcp.log")),
	});
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			connection.getClient(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`连接超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
			}),
		]);
		const tools = connection.tools.map((tool) => tool.name);
		const resources = connection.resources.length;
		const parts = [`${tools.length} 个工具`];
		if (resources > 0) parts.push(`${resources} 个资源`);
		return {
			ok: true,
			state: "connected",
			message: `连接成功：${parts.join(" · ")}`,
			tools,
			resources,
			...(connection.instructions ? { instructions: connection.instructions } : {}),
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (connection.state === "needs-auth") {
			return {
				ok: false,
				state: "needs-auth",
				message: `服务器要求 OAuth 登录，本页不支持：请在终端执行 sentinel mcp login ${entry.name}，登录后再测试。`,
				detail,
				tools: [],
				resources: 0,
			};
		}
		return {
			ok: false,
			state: "failed",
			message: `连接失败：${detail}`,
			detail,
			tools: [],
			resources: 0,
		};
	} finally {
		clearTimeout(timer);
		await connection.close();
	}
}
