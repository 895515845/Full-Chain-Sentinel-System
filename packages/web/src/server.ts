/**
 * ZGAgent web console server.
 *
 * Serves the built browser UI over HTTP and exposes a JSON WebSocket protocol
 * (see protocol.ts) that drives one ZGAgent runtime. Designed for a single
 * local operator; every connected console receives the same event stream.
 */

import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { readWebuiFile } from "./assets.ts";
import { buildImage } from "./docker.ts";
import { testModelConfig } from "./endpoint-probe.ts";
import { checkEnvironment } from "./env-check.ts";
import { guessMimeType } from "./files.ts";
import {
	addProject,
	ensureProjectReady,
	listProjects,
	removeProject,
	resolveStartupProject,
	setLastActiveProject,
} from "./projects.ts";
import type { ZGClientMessage, ZGEnvReport, ZGProjectInfo, ZGServerMessage } from "./protocol.ts";
import { EMPTY_SOURCES, normalizeSources, readSources, writeSources } from "./sources.ts";
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

function sendFile(response: ServerResponse, body: Buffer, relativePath: string): void {
	const type = MIME_TYPES[extname(relativePath)] ?? "application/octet-stream";
	response.writeHead(200, {
		"content-type": type,
		"content-length": body.byteLength,
		// Hashed assets are immutable, but index.html must always revalidate so a
		// rebuilt frontend is picked up without a hard refresh.
		...(relativePath.endsWith(".html") ? { "cache-control": "no-cache" } : {}),
	});
	response.end(body);
}

/**
 * Serve the frontend from disk when the file is there (a checkout), otherwise from
 * the copy embedded in the executable (a single-file binary). Unknown paths fall
 * back to index.html so client-side routing survives a reload.
 */
function serveStatic(distDir: string, requestPath: string, response: ServerResponse): void {
	let relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
	relative = normalize(relative).replace(/^(\.\.[/\\])+/, "");
	const filePath = join(distDir, relative);
	const insideDist = filePath.startsWith(distDir);
	if (insideDist) {
		const body = readWebuiFile(relative, distDir);
		if (body) {
			sendFile(response, body, relative);
			return;
		}
	}
	const index = readWebuiFile("index.html", distDir);
	if (!index) {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(FALLBACK_PAGE);
		return;
	}
	sendFile(response, index, "index.html");
}

export async function startZGServer(
	options: ZGServerOptions = {},
): Promise<{ close: () => void; url: string; environment: Promise<ZGEnvReport> }> {
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
			onVulnChange: () => broadcastVulns(),
		},
	});

	/**
	 * Docker environment state. The check runs once at startup and on demand; every
	 * prompt waits for it, because a run without a working container backend can
	 * only fail. `imageBuild` is set while a `docker build` is streaming.
	 */
	let envReport: ZGEnvReport | undefined;
	let envCheck: Promise<ZGEnvReport> | undefined;
	let imageBuild: AbortController | undefined;

	function consoleUrl(): string {
		const address = server.address();
		const boundPort = address && typeof address === "object" ? address.port : (options.port ?? 7777);
		const boundHost = options.host ?? "127.0.0.1";
		// A wildcard bind is not a browser address.
		const shownHost = boundHost === "0.0.0.0" || boundHost === "::" || boundHost === "[::]" ? "127.0.0.1" : boundHost;
		return `http://${shownHost}:${boundPort}`;
	}

	/** The current report, running the check first if there is none or `force` is set. */
	async function ensureEnvironment(force = false): Promise<ZGEnvReport> {
		if (!force && envReport) return envReport;
		if (!force && envCheck) return await envCheck;
		const run = (async () => {
			const report = await checkEnvironment({ agentDir, url: consoleUrl() });
			envReport = report;
			return report;
		})();
		envCheck = run;
		try {
			return await run;
		} finally {
			if (envCheck === run) envCheck = undefined;
		}
	}

	function broadcastEnvironment(): void {
		if (!envReport) return;
		broadcast({ type: "environment", report: envReport, building: imageBuild !== undefined });
	}

	/** Why a run cannot start, phrased for the operator. */
	function blockedReason(report: ZGEnvReport): string {
		const blocker = report.items.find((entry) => entry.blocking && entry.status !== "ok");
		const detail = blocker ? `${blocker.label}：${blocker.detail}` : "环境检查未通过";
		return `Docker 环境不可用（${detail}）。请在「设置 → 环境」中修复后复检。`;
	}

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

	/** Findings of the active project, pushed when one is submitted or reviewed. */
	function broadcastVulns(): void {
		const view = runtime.listVulns();
		broadcast({ type: "vulns", items: view.items, stats: view.stats });
	}

	/** Project list with each project's finding count, for the hub's delete warning. */
	function projectInfos(): ZGProjectInfo[] {
		if (!agentDir) return [];
		return listProjects(agentDir).projects.map(({ id, name, workDir, container }) => ({
			id,
			name,
			cwd: workDir,
			container,
			vulnCount: runtime.countProjectVulns(id),
		}));
	}

	function broadcastProjects(): void {
		const registry = agentDir ? listProjects(agentDir) : { projects: [] };
		broadcast({
			type: "projects",
			projects: projectInfos(),
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
				projects: projectInfos(),
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
					// A run needs the container backend, so the environment check gates it.
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						broadcastEnvironment();
						return;
					}
					await runtime.prompt(message.text, message.streamingBehavior, images, message.notify);
					return;
				}
				case "compact": {
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						return;
					}
					await runtime.compact();
					return;
				}
				case "set_thinking_level":
					runtime.setThinkingLevel(message.level);
					return;
				case "start_goal": {
					// A goal runs the agent, so it needs the same container backend.
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						broadcastEnvironment();
						return;
					}
					await runtime.startGoal(message.objective, message.criteria ?? [], message.roundLimit);
					return;
				}
				case "pause_goal":
					await runtime.pauseGoal();
					return;
				case "resume_goal":
					runtime.resumeGoal(message.extraRounds);
					return;
				case "clear_goal":
					await runtime.clearGoal();
					return;
				case "abort":
					await runtime.abort();
					return;
				case "abort_compaction":
					runtime.abortCompaction();
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
				case "get_permissions": {
					const view = runtime.getPermissions();
					socket.send(
						JSON.stringify({
							type: "permissions",
							config: view.config,
							effectiveSubagent: view.effectiveSubagent,
							presets: [...view.presets],
							tools: view.tools,
						} satisfies ZGServerMessage),
					);
					return;
				}
				case "save_permissions": {
					try {
						await runtime.savePermissions(message.config);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
						return;
					}
					const view = runtime.getPermissions();
					broadcast({
						type: "permissions",
						config: view.config,
						effectiveSubagent: view.effectiveSubagent,
						presets: [...view.presets],
						tools: view.tools,
					});
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
				case "get_environment":
					sendTo(socket, {
						type: "environment",
						report: await ensureEnvironment(),
						building: imageBuild !== undefined,
					});
					return;
				case "check_environment": {
					const report = await ensureEnvironment(true);
					broadcast({ type: "environment", report, building: imageBuild !== undefined });
					return;
				}
				case "build_image": {
					if (imageBuild) {
						sendError(socket, "镜像构建已在进行中");
						return;
					}
					const controller = new AbortController();
					imageBuild = controller;
					await ensureEnvironment();
					broadcastEnvironment();
					const result = await buildImage(
						{
							onLog: (line) => broadcast({ type: "image_build_log", line }),
							signal: controller.signal,
						},
						agentDir ? readSources(agentDir) : { ...EMPTY_SOURCES },
					);
					imageBuild = undefined;
					broadcast({
						type: "image_build_result",
						ok: result.ok,
						...(result.error ? { error: result.error } : {}),
					});
					// The build may have fixed the only failing item, so re-check.
					await ensureEnvironment(true);
					broadcastEnvironment();
					return;
				}
				case "abort_image_build":
					imageBuild?.abort();
					return;
				case "set_sources": {
					if (!agentDir) {
						sendError(socket, "未配置配置目录，无法保存构建源");
						return;
					}
					// The sources are baked into the image, so this only records them;
					// the operator rebuilds the image when they want them applied.
					const sources = normalizeSources(message.sources ?? {});
					try {
						writeSources(agentDir, sources);
					} catch (error) {
						sendTo(socket, {
							type: "sources_saved",
							sources: readSources(agentDir),
							error: error instanceof Error ? error.message : String(error),
						} satisfies ZGServerMessage);
						return;
					}
					sendTo(socket, { type: "sources_saved", sources } satisfies ZGServerMessage);
					await ensureEnvironment(true);
					broadcastEnvironment();
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
					// Unregister, stop+remove the container, and delete the findings: a
					// finding cannot outlive the scope it was found in. The project's
					// session files stay on the host until the operator removes them.
					const wasActive = runtime.snapshot().project?.id === message.id;
					const result = await removeProject(agentDir, message.id);
					if (result.error) {
						sendError(socket, result.error);
						return;
					}
					const purged = runtime.purgeProjectVulns(message.id);
					console.error(`[zg-server] 删除项目 ${target.name}，连带删除 ${purged} 条漏洞记录`);
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
				case "list_vulns": {
					const view = runtime.listVulns(message.filters);
					sendTo(socket, { type: "vulns", items: view.items, stats: view.stats });
					return;
				}
				case "get_vuln": {
					const vuln = runtime.getVuln(message.id);
					if (!vuln) {
						sendError(socket, "该漏洞记录不存在（可能属于其他项目，或已被删除）");
						return;
					}
					sendTo(socket, { type: "vuln", vuln });
					return;
				}
				case "update_vuln": {
					const updated = runtime.updateVuln(message.id, message.patch);
					if (!updated) {
						sendTo(socket, {
							type: "vuln_result",
							action: "复核",
							id: message.id,
							ok: false,
							error: "该漏洞记录不存在（可能属于其他项目，或已被删除）",
						} satisfies ZGServerMessage);
						return;
					}
					sendTo(socket, { type: "vuln", vuln: updated });
					sendTo(socket, { type: "vuln_result", action: "复核", id: updated.id, ok: true });
					return;
				}
				case "delete_vuln": {
					const ok = runtime.deleteVuln(message.id);
					sendTo(socket, {
						type: "vuln_result",
						action: "删除",
						id: message.id,
						ok,
						...(ok ? {} : { error: "该漏洞记录不存在" }),
					});
					return;
				}
				case "export_vulns": {
					const report = runtime.exportVulns(message.filters);
					sendTo(socket, { type: "vulns_export", filename: report.filename, markdown: report.markdown });
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
					const steerEnv = await ensureEnvironment();
					if (!steerEnv.ok) {
						sendError(socket, blockedReason(steerEnv));
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
			// A wildcard bind is not a browser address: Chrome answers
			// ERR_ADDRESS_INVALID for http://0.0.0.0:<port>, so print the loopback
			// address an operator can actually open.
			const shownHost = host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
			const shownPort =
				server.address() && typeof server.address() === "object"
					? (server.address() as { port: number }).port
					: port;
			// The check reports the console address, so it starts once the port is known.
			const environment = ensureEnvironment().then(
				(report) => {
					broadcastEnvironment();
					return report;
				},
				(error: unknown) => {
					console.error("[zg-server] 环境检查失败:", error);
					return {
						at: new Date().toISOString(),
						ok: false,
						items: [
							{
								id: "check-failed",
								group: "Docker 运行时",
								label: "环境检查",
								status: "fail" as const,
								detail: error instanceof Error ? error.message : String(error),
								blocking: true,
							},
						],
						url: `http://${shownHost}:${shownPort}`,
						sources: { ...EMPTY_SOURCES },
					};
				},
			);
			resolvePromise({
				url: `http://${shownHost}:${shownPort}`,
				environment,
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
