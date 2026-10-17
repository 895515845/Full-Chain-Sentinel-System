/**
 * A minimal MCP server over streamable HTTP.
 *
 * This is the smallest useful plugin: two tools, one artifact, no dependencies.
 * It exists to show the contract the plugin host expects — `/healthz` for the
 * startup gate and an MCP endpoint that answers JSON-RPC — and to be a template
 * for a real plugin.
 *
 * Streamable HTTP allows a server to answer a POST with a plain JSON body
 * instead of an SSE stream, which is what this server does. Progress
 * notifications are optional; a long-running plugin can add them later without
 * changing the manifest.
 */

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 7801);
const ARTIFACTS_DIR = process.env.PLUGIN_ARTIFACTS_DIR ?? "/artifacts";
const GREETING = process.env.PLUGIN_GREETING ?? "hello";
const PROTOCOL_VERSION = "2025-03-26";
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");
const UI_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
};

const TOOLS = [
	{
		name: "hello_echo",
		description: "回显一段文本，用来确认插件链路是通的。",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string", description: "要回显的文本" } },
			required: ["text"],
		},
	},
	{
		name: "hello_artifact",
		description: "写一个文本产物到 /artifacts，返回相对路径，用来验证产物回传。",
		inputSchema: {
			type: "object",
			properties: { note: { type: "string", description: "产物内容" } },
		},
	},
];

function sendJson(response, status, payload) {
	const body = JSON.stringify(payload);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	response.end(body);
}

function result(id, value) {
	return { jsonrpc: "2.0", id, result: value };
}

function error(id, code, message) {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function callTool(name, args) {
	if (name === "hello_echo") {
		const text = typeof args.text === "string" ? args.text : "";
		return {
			content: [{ type: "text", text: `${GREETING}: ${text}` }],
		};
	}
	if (name === "hello_artifact") {
		const runId = `run-${Date.now()}`;
		const relative = `${runId}/hello.txt`;
		mkdirSync(join(ARTIFACTS_DIR, runId), { recursive: true });
		writeFileSync(join(ARTIFACTS_DIR, runId, "hello.txt"), String(args.note ?? "artifact from hello-world"));
		return {
			content: [{ type: "text", text: `产物已写入 ${relative}` }],
			_meta: { artifacts: [relative] },
		};
	}
	return null;
}

function handleRpc(message) {
	if (!message || typeof message !== "object") return error(null, -32600, "invalid request");
	const id = message.id;
	const method = message.method;
	if (method === "initialize") {
		return result(id, {
			protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: "sentinel-hello-world", version: "0.1.0" },
		});
	}
	if (method === "ping") return result(id, {});
	if (method === "tools/list") return result(id, { tools: TOOLS });
	if (method === "tools/call") {
		const name = message.params?.name;
		const args = message.params?.arguments ?? {};
		const called = callTool(name, args);
		if (!called) return error(id, -32602, `unknown tool ${String(name)}`);
		return result(id, called);
	}
	if (method === "resources/list") return result(id, { resources: [] });
	if (method === "prompts/list") return result(id, { prompts: [] });
	// Notifications carry no id and expect no body.
	if (id === undefined) return null;
	return error(id, -32601, `method not found: ${String(method)}`);
}

const server = createServer((request, response) => {
	if (request.method === "GET" && request.url === "/healthz") {
		sendJson(response, 200, { ok: true });
		return;
	}
	if (request.method === "GET" && request.url.startsWith("/ui/")) {
		const relative = decodeURIComponent((request.url.split("?")[0] ?? "").slice(4));
		if (!relative || relative.split("/").includes("..")) {
			response.writeHead(404).end();
			return;
		}
		const file = join(UI_DIR, relative);
		if (!file.startsWith(UI_DIR) || !existsSync(file) || !statSync(file).isFile()) {
			response.writeHead(404).end();
			return;
		}
		const body = readFileSync(file);
		const dot = relative.lastIndexOf(".");
		const type = (dot >= 0 ? UI_TYPES[relative.slice(dot)] : undefined) ?? "application/octet-stream";
		response.writeHead(200, {
			"content-type": type,
			"content-length": String(body.length),
			"cache-control": "no-store",
		});
		response.end(body);
		return;
	}
	if (request.url === "/mcp" && request.method === "GET") {
		// No server-initiated stream: the transport allows refusing this GET.
		sendJson(response, 405, { error: "this server has no server-initiated stream" });
		return;
	}
	if (request.url !== "/mcp" || request.method !== "POST") {
		sendJson(response, 404, { error: "not found" });
		return;
	}
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		let payload;
		try {
			payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
		} catch {
			sendJson(response, 400, error(null, -32700, "parse error"));
			return;
		}
		if (Array.isArray(payload)) {
			const answers = payload.map(handleRpc).filter((entry) => entry !== null);
			if (answers.length === 0) {
				response.writeHead(202).end();
				return;
			}
			sendJson(response, 200, answers);
			return;
		}
		const answer = handleRpc(payload);
		if (!answer) {
			response.writeHead(202).end();
			return;
		}
		sendJson(response, 200, answer);
	});
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`hello-world plugin listening on :${PORT}`);
});
