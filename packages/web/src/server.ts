/**
 * ZGAgent web console server.
 *
 * Serves the built browser UI over HTTP and exposes a JSON WebSocket protocol
 * (see protocol.ts) that drives one ZGAgent runtime. Designed for a single
 * local operator; every connected console receives the same event stream.
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { testModelConfig } from "./endpoint-probe.ts";
import { guessMimeType } from "./files.ts";
import {
	addProject,
	ensureProjectReady,
	listProjects,
	removeProject,
	resolveStartupProject,
	setLastActiveProject,
} from "./projects.ts";
import type { ZGClientMessage, ZGServerMessage } from "./protocol.ts";
import { ZGAgentRuntime } from "./zg-session.ts";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json; charset=utf-8",
	".woff2": "font/woff2",
};

const FALLBACK_PAGE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>ZGAgent</title></head>
<body style="background:#111418;color:#d7dde4;font-family:system-ui;padding:48px;line-height:1.7">
<h1>ZGAgent Web 控制台</h1>
<p>前端资源尚未构建。请在仓库根目录执行：</p>
<pre style="background:#1b2027;padding:12px;border-radius:8px">npm --prefix packages/web run build</pre>
<p>构建完成后刷新本页。</p>
</body></html>`;

export interface ZGServerOptions {
	cwd?: string;
	agentDir?: string;
	host?: string;
	port?: number;
}

export function webuiDistDir(): string {
	// dist/server.js -> package root -> webui/dist
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "webui", "dist");
}

function sendJson(response: ServerResponse, payload: unknown): void {
	response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(payload));
}

function sendTo(socket: WebSocket, message: ZGServerMessage): void {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** File mutations report their own outcome so the panel can show it in place. */
async function runFileAction(
	socket: WebSocket,
	action: string,
	path: string,
	run: () => Promise<unknown>,
): Promise<void> {
	try {
		await run();
		sendTo(socket, { type: "file_result", action, path, ok: true });
	} catch (error) {
		sendTo(socket, {
			type: "file_result",
			action,
			path,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function serveStatic(distDir: string, requestPath: string, response: ServerResponse): void {
	let relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
	relative = normalize(relative).replace(/^(\.\.[/\\])+/, "");
	const filePath = join(distDir, relative);
	if (!filePath.startsWith(distDir) || !existsSync(filePath)) {
		const indexPath = join(distDir, "index.html");
		if (!existsSync(indexPath)) {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(FALLBACK_PAGE);
			return;
		}
		response.writeHead(200, {
			"content-type": MIME_TYPES[".html"],
			// Hashed assets are immutable, but index.html must always revalidate
			// so a rebuilt frontend is picked up without a hard refresh.
			"cache-control": "no-cache",
		});
		response.end(readFileSync(indexPath));
		return;
	}
	const type = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
	response.writeHead(200, { "content-type": type });
	response.end(readFileSync(filePath));
}

export async function startZGServer(options: ZGServerOptions = {}): Promise<{ close: () => void; url: string }> {
	const startupCwd = resolve(options.cwd ?? process.cwd());
	const clients = new Set<WebSocket>();
	const agentDir = options.agentDir;
	const startup = agentDir ? await resolveStartupProject(agentDir) : {};
	const runtime = new ZGAgentRuntime({
		cwd: startup.project?.workDir ?? startupCwd,
		agentDir,
		activeProject: startup.project
			? {
					id: startup.project.id,
					name: startup.project.name,
					container: startup.project.container,
					cwd: startup.project.workDir,
				}
			: undefined,
		hooks: {
			onSessionEvent: (event) => broadcast({ type: "session_event", event }),
			onStateChange: () => broadcastSnapshot(),
			onSubagentEvent: (runId, event) => broadcast({ type: "subagent_event", runId, event }),
			onNotifyStatus: (status) => broadcast({ type: "notify_config", config: runtime.getNotifyConfig(), status }),
		},
	});

	function broadcast(message: ZGServerMessage): void {
		let data: string;
		try {
			data = JSON.stringify(message);
		} catch (error) {
			console.error("[zg-server] broadcast serialization failed:", error);
			return;
		}
		for (const client of clients) {
			if (client.readyState === WebSocket.OPEN) client.send(data);
		}
	}

	function broadcastSnapshot(): void {
		broadcast({ type: "snapshot", snapshot: runtime.snapshot() });
	}

	function broadcastProjects(): void {
		const registry = agentDir ? listProjects(agentDir) : { projects: [] };
		broadcast({
			type: "projects",
			projects: registry.projects.map(({ id, name, workDir, container }) => ({
				id,
				name,
				cwd: workDir,
				container,
			})),
			activeProjectId: runtime.snapshot().project?.id ?? registry.lastActiveProjectId ?? null,
		});
	}

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname === "/api/health") {
			sendJson(response, { ok: true, sessionId: runtime.currentSessionId, mode: runtime.currentMode });
			return;
		}
		serveStatic(webuiDistDir(), url.pathname, response);
	});

	const wss = new WebSocketServer({ server, path: "/ws" });
	wss.on("connection", (socket) => {
		clients.add(socket);
		socket.send(JSON.stringify({ type: "snapshot", snapshot: runtime.snapshot() } satisfies ZGServerMessage));
		socket.send(
			JSON.stringify({
				type: "projects",
				projects: (agentDir ? listProjects(agentDir).projects : []).map(({ id, name, workDir, container }) => ({
					id,
					name,
					cwd: workDir,
					container,
				})),
				activeProjectId: runtime.snapshot().project?.id ?? null,
			} satisfies ZGServerMessage),
		);
		socket.on("message", (data) => {
			void handleClientMessage(socket, data.toString());
		});
		socket.on("close", () => clients.delete(socket));
		socket.on("error", () => clients.delete(socket));
	});

	async function handleClientMessage(socket: WebSocket, raw: string): Promise<void> {
		console.error(`[srv-recv] ${raw.slice(0, 70)}`);
		let message: ZGClientMessage;
		try {
			message = JSON.parse(raw) as ZGClientMessage;
		} catch {
			sendError(socket, "无法解析的消息格式");
			return;
		}
		try {
			switch (message.type) {
				case "prompt": {
					const images = message.images ?? [];
					if (!message.text.trim() && images.length === 0) {
						sendError(socket, "消息不能为空");
						return;
					}
					await runtime.prompt(message.text, message.streamingBehavior, images, message.notify);
					return;
				}
				case "compact":
					await runtime.compact();
					return;
				case "set_thinking_level":
					runtime.setThinkingLevel(message.level);
					return;
				case "abort":
					await runtime.abort();
					return;
				case "set_mode":
					runtime.setMode(message.mode);
					return;
				case "decide": {
					const ok = runtime.decide(
						message.decision.id,
						message.decision.approved,
						message.decision.command,
						message.decision.alwaysAllowPrefix === true,
					);
					if (!ok) sendError(socket, "该审批请求已失效（可能已被其他窗口处理或运行已中止）");
					return;
				}
				case "decide_all": {
					const count = runtime.decideAll(message.approved);
					if (count === 0) sendError(socket, "没有待处理的审批请求");
					return;
				}
				case "allow_prefix":
					runtime.allowPrefix(message.prefix);
					return;
				case "remove_allowed_prefix":
					runtime.removeAllowedPrefix(message.prefix);
					return;
				case "new_session":
					await runtime.newSession();
					return;
				case "switch_session":
					await runtime.switchSession(message.path);
					return;
				case "list_sessions": {
					const sessions = await runtime.listSessions();
					broadcast({ type: "sessions", sessions });
					return;
				}
				case "rename_session": {
					if (!message.name.trim()) {
						sendError(socket, "会话名称不能为空");
						return;
					}
					await runtime.renameSession(message.path, message.name.trim());
					const sessions = await runtime.listSessions();
					broadcast({ type: "sessions", sessions });
					return;
				}
				case "delete_session": {
					await runtime.deleteSession(message.path);
					const sessions = await runtime.listSessions();
					broadcast({ type: "sessions", sessions });
					return;
				}
				case "navigate":
					await runtime.navigate(message.entryId, message.summarize);
					return;
				case "rename_branch": {
					try {
						runtime.renameBranch(message.entryId, message.label);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
						return;
					}
					const current = runtime.getTree();
					broadcast({
						type: "tree",
						tree: current.tree,
						leafId: current.leafId,
						forkPoints: current.forkPoints,
					});
					return;
				}
				case "get_tree": {
					const { tree, leafId, forkPoints } = runtime.getTree();
					socket.send(JSON.stringify({ type: "tree", tree, leafId, forkPoints } satisfies ZGServerMessage));
					return;
				}
				case "get_state":
					socket.send(
						JSON.stringify({ type: "snapshot", snapshot: runtime.snapshot() } satisfies ZGServerMessage),
					);
					return;
				case "get_config":
					socket.send(JSON.stringify({ type: "config", config: runtime.getConfig() } satisfies ZGServerMessage));
					return;
				case "save_config":
					await runtime.saveConfig(message.config);
					socket.send(JSON.stringify({ type: "config", config: runtime.getConfig() } satisfies ZGServerMessage));
					return;
				case "test_config": {
					const result = await testModelConfig(message.config);
					socket.send(JSON.stringify({ type: "test_result", result } satisfies ZGServerMessage));
					return;
				}
				case "get_notify_config":
					socket.send(
						JSON.stringify({
							type: "notify_config",
							config: runtime.getNotifyConfig(),
							status: runtime.getNotifyStatus(),
						} satisfies ZGServerMessage),
					);
					return;
				case "save_notify_config":
					runtime.saveNotifyConfig(message.config);
					socket.send(
						JSON.stringify({
							type: "notify_config",
							config: runtime.getNotifyConfig(),
							status: runtime.getNotifyStatus(),
						} satisfies ZGServerMessage),
					);
					return;
				case "test_notify": {
					const result = await runtime.testNotify(message.config);
					socket.send(JSON.stringify({ type: "notify_test_result", result } satisfies ZGServerMessage));
					return;
				}
				case "get_stats": {
					const stats = runtime.getStats();
					if (stats) socket.send(JSON.stringify({ type: "stats", stats } satisfies ZGServerMessage));
					return;
				}
				case "list_projects": {
					broadcastProjects();
					return;
				}
				case "add_project": {
					if (!agentDir) {
						sendError(socket, "内部错误：agentDir 未初始化");
						return;
					}
					const result = await addProject(agentDir, { name: message.name });
					if (result.error) {
						sendError(socket, result.error);
						return;
					}
					broadcastProjects();
					return;
				}
				case "remove_project": {
					if (!agentDir) {
						sendError(socket, "内部错误：agentDir 未初始化");
						return;
					}
					const registry = listProjects(agentDir);
					const target = registry.projects.find((project) => project.id === message.id);
					if (!target) {
						sendError(socket, "项目不存在");
						return;
					}
					if (message.confirmName !== target.name) {
						sendError(socket, `确认失败：请输入完整项目名「${target.name}」`);
						return;
					}
					// Unregister, stop+remove the container; sessions for its workDir stay
					// on the host until the operator removes them from the sidebar.
					const wasActive = runtime.snapshot().project?.id === message.id;
					const result = await removeProject(agentDir, message.id);
					if (result.error) {
						sendError(socket, result.error);
						return;
					}
					// The removed project's container is gone, so its sessions cannot run;
					// the console falls back to the project-required state.
					if (wasActive) await runtime.detachProject(target.workDir);
					broadcastProjects();
					broadcastSnapshot();
					return;
				}
				case "switch_project": {
					if (!agentDir) {
						sendError(socket, "内部错误：agentDir 未初始化");
						return;
					}
					const registry = listProjects(agentDir);
					const target = registry.projects.find((project) => project.id === message.id);
					if (!target) {
						sendError(socket, "项目不存在");
						return;
					}
					if (!(await ensureProjectReady(target))) {
						sendError(socket, `项目容器 ${target.container} 无法启动，请检查 Docker`);
						return;
					}
					setLastActiveProject(agentDir, target.id);
					await runtime.switchProject({
						id: target.id,
						name: target.name,
						container: target.container,
						cwd: target.workDir,
					});
					broadcastProjects();
					const sessions = await runtime.listSessions();
					broadcast({ type: "sessions", sessions });
					return;
				}
				case "list_files": {
					const listing = await runtime.listFiles(message.path);
					sendTo(socket, { type: "files", path: listing.path, entries: listing.entries });
					return;
				}
				case "read_file": {
					const preview = await runtime.readFile(message.path);
					sendTo(socket, { type: "file_preview", preview });
					return;
				}
				case "download_file": {
					const file = await runtime.downloadFile(message.path);
					sendTo(socket, {
						type: "file_download",
						path: file.path,
						size: file.size,
						data: file.data,
						mimeType: guessMimeType(file.path),
					});
					return;
				}
				case "write_file":
					await runFileAction(socket, "保存", message.path, () => runtime.writeFile(message.path, message.text));
					return;
				case "upload_file":
					await runFileAction(socket, "上传", message.path, () => runtime.uploadFile(message.path, message.data));
					return;
				case "delete_path":
					await runFileAction(socket, "删除", message.path, () => runtime.deletePath(message.path));
					return;
				case "rename_path":
					await runFileAction(socket, "重命名", message.from, () => runtime.renamePath(message.from, message.to));
					return;
				case "make_directory":
					await runFileAction(socket, "新建目录", message.path, () => runtime.makeDirectory(message.path));
					return;
				case "list_subagents": {
					sendTo(socket, { type: "subagents", runs: runtime.listSubagents() });
					return;
				}
				case "get_subagent": {
					const run = runtime.getSubagent(message.id);
					if (!run) {
						sendError(socket, "该子代理记录不存在");
						return;
					}
					sendTo(socket, { type: "subagent_run", run });
					return;
				}
				case "abort_subagent": {
					const ok = await runtime.abortSubagent(message.id);
					sendTo(socket, {
						type: "subagent_result",
						action: "中止",
						id: message.id,
						ok,
						...(ok ? {} : { error: "该子代理已结束，无需中止" }),
					});
					return;
				}
				case "steer_subagent": {
					if (!message.text.trim()) {
						sendError(socket, "追加指令不能为空");
						return;
					}
					const ok = await runtime.steerSubagent(message.id, message.text);
					sendTo(socket, {
						type: "subagent_result",
						action: "追加指令",
						id: message.id,
						ok,
						...(ok ? {} : { error: "该子代理已结束，无法追加指令" }),
					});
					return;
				}
				default:
					sendError(socket, `未知消息类型: ${(message as { type?: string }).type ?? "?"}`);
			}
		} catch (error) {
			sendError(socket, error instanceof Error ? error.message : String(error));
		}
	}

	function sendError(socket: WebSocket, messageText: string): void {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "error", message: messageText } satisfies ZGServerMessage));
		}
	}

	await runtime.init();

	return await new Promise((resolvePromise) => {
		const port = options.port ?? 7777;
		const host = options.host ?? "127.0.0.1";
		server.listen(port, host, () => {
			resolvePromise({
				url: `http://${host}:${server.address() && typeof server.address() === "object" ? (server.address() as { port: number }).port : port}`,
				close: () => {
					runtime.dispose();
					for (const client of clients) client.terminate();
					wss.close();
					server.close();
				},
			});
		});
	});
}
