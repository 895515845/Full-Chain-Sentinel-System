/**
 * A minimal MCP client for calls that do not come from a session.
 *
 * Plugin frontends can invoke their own tools, but there may be no active agent
 * session to borrow a connection from. The host opens a short-lived streamable
 * HTTP exchange instead: `initialize`, then `tools/call`. It is deliberately not
 * a general MCP client — only these two requests, no discovery, no resources.
 *
 * A streamable HTTP server may answer with plain JSON or with an SSE stream. The
 * SSE branch reads the whole body and picks the message whose id matches; that
 * is enough for a request/response exchange and avoids implementing a stream
 * reader for events we do not consume.
 */

import { t } from "../i18n.ts";
import type { McpToolOutcome } from "./types.ts";

const PROTOCOL_VERSION = "2025-03-26";

interface RpcResponse {
	id?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string };
}

async function readRpc(response: Response, id: number): Promise<RpcResponse> {
	const type = response.headers.get("content-type") ?? "";
	if (!type.includes("text/event-stream")) {
		const payload = (await response.json()) as RpcResponse | RpcResponse[];
		if (Array.isArray(payload)) {
			const match = payload.find((entry) => entry.id === id);
			if (!match) throw new Error(t("JSON-RPC 响应里没有匹配的 id"));
			return match;
		}
		return payload;
	}
	const text = await response.text();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const body = trimmed.slice(5).trim();
		if (!body) continue;
		try {
			const message = JSON.parse(body) as RpcResponse;
			if (message.id === id) return message;
		} catch {
			// A comment or a partial event; the matching message follows.
		}
	}
	throw new Error(t("SSE 流里没有收到 JSON-RPC 响应"));
}

/** Call one tool on the plugin's MCP endpoint. Throws on transport or JSON-RPC errors. */
export async function callPluginTool(
	port: number,
	path: string,
	name: string,
	args: Record<string, unknown>,
	timeoutMs: number,
): Promise<McpToolOutcome> {
	const base = `http://127.0.0.1:${port}${path}`;
	const signal = AbortSignal.timeout(timeoutMs);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	};
	const initialize = await fetch(base, {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "sentinel-plugin-host", version: "1" },
			},
		}),
	});
	if (!initialize.ok) throw new Error(t("initialize 失败：HTTP {status}", { status: initialize.status }));
	const sessionId = initialize.headers.get("mcp-session-id");
	const initialized = await readRpc(initialize, 1);
	if (initialized.error) throw new Error(initialized.error.message ?? t("initialize 被拒绝"));
	if (sessionId) headers["mcp-session-id"] = sessionId;

	const call = await fetch(base, {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	if (!call.ok) throw new Error(t("tools/call 失败：HTTP {status}", { status: call.status }));
	const answer = await readRpc(call, 2);
	if (answer.error) throw new Error(answer.error.message ?? t("工具调用被拒绝"));
	const result = (answer.result ?? {}) as {
		content?: unknown;
		isError?: boolean;
		_meta?: unknown;
	};
	return {
		content: Array.isArray(result.content) ? result.content : [],
		isError: result.isError === true,
		meta: result._meta ?? null,
	};
}
