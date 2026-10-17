/**
 * The MCP reverse proxy.
 *
 * The console talks to `https://<host>/plugins/<id>/mcp`; this forwards that
 * request to `http://127.0.0.1:<published port><manifest path>`. Proxying rather
 * than publishing container ports keeps one public listener, one token, and one
 * place to refuse a stopped plugin.
 *
 * The forwarding is streamed in both directions because MCP over HTTP uses
 * server-sent events for progress: buffering a response would turn live output
 * into one delivery at the end, and would break the long-lived GET stream.
 *
 * Two headers are dropped: `authorization` (the host token never reaches third
 * party code) and the hop-by-hop set, which describes this connection rather
 * than the message.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function forwardableHeaders(request: IncomingMessage, port: number): Record<string, string | string[]> {
	const headers: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined) continue;
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower) || lower === "authorization" || lower === "host") continue;
		headers[name] = value;
	}
	headers.host = `127.0.0.1:${port}`;
	return headers;
}

export interface ProxyOptions {
	request: IncomingMessage;
	response: ServerResponse;
	port: number;
	/** Container-relative path, already joined with any query string. */
	path: string;
}

/** Forward one request to the plugin and stream the answer back. Never throws. */
export function proxyToPlugin(options: ProxyOptions): void {
	const { request, response, port, path } = options;
	const upstream = httpRequest(
		{
			host: "127.0.0.1",
			port,
			method: request.method,
			path,
			headers: forwardableHeaders(request, port),
			timeout: 0,
		},
		(answer) => {
			const headers: Record<string, string | string[]> = {};
			for (const [name, value] of Object.entries(answer.headers)) {
				if (value === undefined) continue;
				if (HOP_BY_HOP.has(name.toLowerCase())) continue;
				headers[name] = value;
			}
			response.writeHead(answer.statusCode ?? 502, headers);
			answer.pipe(response);
			answer.on("error", () => response.destroy());
		},
	);
	upstream.on("error", (error) => {
		if (response.headersSent) {
			response.destroy();
			return;
		}
		response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ error: `插件端点不可达：${error.message}` }));
	});
	// A browser or agent that gives up must not leave the container's handler writing into a dead socket.
	response.on("close", () => {
		if (!response.writableEnded) upstream.destroy();
	});
	request.pipe(upstream);
}
