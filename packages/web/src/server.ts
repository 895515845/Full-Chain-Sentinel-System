/**
 * ZGAgent web console server.
 *
 * Serves the built browser UI over HTTP and exposes a JSON WebSocket protocol
 * (see protocol.ts) that drives one ZGAgent runtime. Designed for a single
 * local operator; every connected console receives the same event stream.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { WebSocket, WebSocketServer } from "ws";
import { readWebuiFile } from "./assets.ts";
import {
	changePassword,
	clearSessionCookieHeader,
	createAuth,
	createLoginLimiter,
	hasValidSession,
	issueSessionToken,
	readStoredAuth,
	revokeSessions,
	type StoredAuth,
	sessionCookieHeader,
	validateCredentials,
	verifyLogin,
} from "./auth.ts";
import { buildImage } from "./docker.ts";
import { deleteDoctrine, listDoctrines, saveDoctrine } from "./doctrines.ts";
import { DroidGateway } from "./droid-gateway.ts";
import { testModelConfig } from "./endpoint-probe.ts";
import { EngineManager } from "./engine.ts";
import { checkEnvironment } from "./env-check.ts";
import { guessMimeType } from "./files.ts";
import { readCommanderModelConfig, readProviderModelConfig, writeCommanderModelConfig } from "./model-config.ts";
import {
	deletePreset,
	exportFileName,
	exportPresets,
	importPresets,
	presetView,
	presetViews,
	savePreset,
	setPresetEnabled,
} from "./presets.ts";
import {
	addProject,
	ensureProjectReady,
	listProjects,
	removeProject,
	resolveStartupProject,
	setLastActiveProject,
} from "./projects.ts";
import type { ZGClientMessage, ZGEnvReport, ZGProjectInfo, ZGServerMessage } from "./protocol.ts";
import { VulnReviewer } from "./reviewer.ts";
import type { WorkerSession } from "./worker.ts";

interface AcquiredTaskSession {
	session: WorkerSession;
	manager: SessionManager;
}

import { EMPTY_SOURCES, normalizeSources, readSources, writeSources } from "./sources.ts";
import { storeUpload } from "./upload.ts";
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
	/**
	 * Console authentication (default on). Only the automated tests turn it off;
	 * the credential file is created on first visit.
	 */
	auth?: boolean;
}

export function webuiDistDir(): string {
	// dist/server.js -> package root -> webui/dist
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "webui", "dist");
}

function sendJson(response: ServerResponse, payload: unknown, status = 200): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(payload));
}

/** Read one JSON request body; oversize or malformed bodies become null. */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).byteLength;
		if (size > 64 * 1024) return null;
		chunks.push(chunk as Buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function textField(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	return typeof value === "string" ? value : "";
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
			onSessionRenamed: () => void broadcastSessions(),
			onVulnSubmitted: (id) => reviewer?.enqueue(id),
			// Every judgment is broadcast: a console with the audit page open appends
			// the new row live instead of waiting for a refresh.
			onGateDecision: (decision) => broadcast({ type: "gate_decision", decision }),
			onPocChange: () => broadcastPocs(),
			onPocSourceChange: () => broadcast({ type: "poc_sources", sources: runtime.listPocSources() }),
			// A modeling run changed (started, submitted, ended): the page is a list
			// of records, so the whole list is what goes out.
			onApiModelChange: () => broadcastApiModels(),
			onDroidChange: () => broadcastDroidDevices(),
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

	/**
	 * Engineering mode. One manager owns every engine across projects; the
	 * hooks push engine state and the commander's decision log to all consoles.
	 */
	const engines = agentDir
		? new EngineManager(
				agentDir,
				{
					onChange: (engine) => {
						broadcast({ type: "engine_update", engine });
						// Task statuses feed the sidebar badges.
						void broadcastSessions();
					},
					onCommanderEvent: (engineId, event) => broadcast({ type: "engine_commander_event", engineId, event }),
					onTaskEvent: (taskId, event) => broadcast({ type: "engine_task_event", taskId, event }),
				},
				// Task sessions are created by the runtime in the project's normal
				// session directory, so they are first-class conversations.
				(options) => runtime.acquireTaskSession(options) as unknown as Promise<AcquiredTaskSession>,
			)
		: undefined;

	/**
	 * The vulnerability reviewer: a dedicated LLM calibrating every fresh
	 * finding's severity/CVSS and flagging hallucination suspects. Hub layer
	 * only — the main agent never sees or waits for it. Shares the commander's
	 * endpoint configuration, falling back to the main endpoint.
	 */
	const reviewer = agentDir
		? new VulnReviewer(
				runtime.vulnerabilityStore(),
				{
					onSettled: (vuln) => {
						void broadcastVulns();
						if (vuln && (vuln.severity === "critical" || vuln.severity === "high")) {
							runtime.notifyReviewedHighSeverity(vuln);
						}
					},
				},
				agentDir,
			)
		: undefined;
	reviewer?.recover();

	function broadcastEngines(socket?: WebSocket): void {
		if (!engines) return;
		const view = { type: "engines", engines: engines.listEngines() } satisfies ZGServerMessage;
		if (socket) sendTo(socket, view);
		else broadcast(view);
	}

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

	/** The POC library, pushed when the operator imports or deletes templates. */
	function broadcastPocs(): void {
		const view = runtime.listPocs();
		broadcast({ type: "pocs", items: view.items, stats: view.stats });
	}

	/**
	 * The business-modeling runs. The list is project-scoped on the page, so the
	 * whole set goes out and the console filters it, the way the engine board does.
	 */
	function broadcastApiModels(): void {
		broadcast({ type: "api_models", items: runtime.listApiModels() });
	}

	/** Non-internal IPv4 addresses of this host, for the listen-address picker. */
	function lanIps(): string[] {
		const ips: string[] = [];
		for (const addresses of Object.values(networkInterfaces())) {
			for (const address of addresses ?? []) {
				if (address.family === "IPv4" && !address.internal) ips.push(address.address);
			}
		}
		return ips;
	}

	/** Device gateway state, pushed whenever a device or token changes. */
	function broadcastDroidDevices(): void {
		const state = runtime.droidState();
		broadcast({
			type: "droid_state",
			enabled: state.enabled,
			devices: state.devices,
			tokens: state.tokens,
			listen: droidGateway.listenInfo() ?? null,
			listenConfig: runtime.droidListenConfig(),
			lanIps: lanIps(),
		});
	}

	/** Project list with each project's finding and gate-record counts, for the delete warning. */
	function projectInfos(): ZGProjectInfo[] {
		if (!agentDir) return [];
		return listProjects(agentDir).projects.map(({ id, name, workDir, container }) => ({
			id,
			name,
			cwd: workDir,
			container,
			vulnCount: runtime.countProjectVulns(id),
			gateCount: runtime.countProjectGates(id),
		}));
	}

	/**
	 * The session list with engineering badges: a session that belongs to an
	 * engine task carries the engine's name and the task's live status, which
	 * is what the sidebar's 对话/工程 filter and badges read.
	 */
	async function sessionViews() {
		const sessions = await runtime.listSessions();
		const index = engines?.taskSessionIndex() ?? new Map();
		return sessions.map((session) => ({ ...session, engine: index.get(session.id) }));
	}

	async function broadcastSessions(socket?: WebSocket): Promise<void> {
		const sessions = await sessionViews();
		const view = { type: "sessions", sessions } satisfies ZGServerMessage;
		if (socket) sendTo(socket, view);
		else broadcast(view);
	}

	function broadcastProjects(): void {
		const registry = agentDir ? listProjects(agentDir) : { projects: [] };
		broadcast({
			type: "projects",
			projects: projectInfos(),
			activeProjectId: runtime.snapshot().project?.id ?? registry.lastActiveProjectId ?? null,
		});
	}

	// --- Console authentication -------------------------------------------
	// Static files carry no secrets and stay open; everything under /api and the
	// WebSocket needs the session cookie. The credential file is created by the
	// first visitor (设置引导), so a fresh install has no default password.
	const authEnabled = options.auth !== false && Boolean(agentDir);
	const currentAuth = (): StoredAuth | null => (authEnabled && agentDir ? readStoredAuth(agentDir) : null);
	const limiter = createLoginLimiter();

	async function handleSetup(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!agentDir) {
			sendJson(response, { error: "缺少配置目录，无法创建账号" }, 500);
			return;
		}
		if (readStoredAuth(agentDir)) {
			sendJson(response, { error: "管理员账号已存在，请直接登录" }, 409);
			return;
		}
		const body = await readJsonBody(request);
		if (!body) {
			sendJson(response, { error: "请求体不是合法的 JSON" }, 400);
			return;
		}
		const username = textField(body, "username").trim();
		const password = textField(body, "password");
		const problem = validateCredentials(username, password);
		if (problem) {
			sendJson(response, { error: problem }, 400);
			return;
		}
		const stored = createAuth(agentDir, username, password);
		const token = issueSessionToken(stored);
		response.setHeader("set-cookie", sessionCookieHeader(token.value, token.maxAge));
		sendJson(response, { ok: true, username: stored.username });
	}

	async function handleLogin(
		request: IncomingMessage,
		response: ServerResponse,
		stored: StoredAuth | null,
	): Promise<void> {
		if (!stored) {
			sendJson(response, { error: "还没有管理员账号，请先创建" }, 409);
			return;
		}
		const key = request.socket.remoteAddress ?? "unknown";
		const lockedFor = limiter.blocked(key);
		if (lockedFor > 0) {
			sendJson(response, { error: `尝试次数过多，请 ${Math.ceil(lockedFor / 1000)} 秒后再试` }, 429);
			return;
		}
		const body = await readJsonBody(request);
		if (!body) {
			sendJson(response, { error: "请求体不是合法的 JSON" }, 400);
			return;
		}
		const username = textField(body, "username").trim();
		const password = textField(body, "password");
		if (!verifyLogin(stored, username, password)) {
			limiter.failure(key);
			sendJson(response, { error: "用户名或密码不正确" }, 401);
			return;
		}
		limiter.success(key);
		const token = issueSessionToken(stored);
		// 记住登录 keeps the cookie across browser restarts (30 days); otherwise it
		// dies with the browser session. The token's own expiry never moves.
		const remember = body.remember !== false;
		response.setHeader("set-cookie", sessionCookieHeader(token.value, remember ? token.maxAge : 0));
		sendJson(response, { ok: true, username: stored.username });
	}

	async function handleChangePassword(
		request: IncomingMessage,
		response: ServerResponse,
		stored: StoredAuth,
	): Promise<void> {
		if (!agentDir) {
			sendJson(response, { error: "缺少配置目录" }, 500);
			return;
		}
		const body = await readJsonBody(request);
		if (!body) {
			sendJson(response, { error: "请求体不是合法的 JSON" }, 400);
			return;
		}
		if (!verifyLogin(stored, stored.username, textField(body, "current"))) {
			sendJson(response, { error: "当前密码不正确" }, 400);
			return;
		}
		try {
			// Rotates the signing secret: every other session is logged out.
			changePassword(agentDir, stored, textField(body, "next"));
		} catch (error) {
			sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 400);
			return;
		}
		const updated = readStoredAuth(agentDir) ?? stored;
		const token = issueSessionToken(updated);
		response.setHeader("set-cookie", sessionCookieHeader(token.value, token.maxAge));
		sendJson(response, { ok: true });
	}

	/**
	 * One chat attachment: the raw request body is the file, `name` says what to
	 * call it. It is streamed into the project's uploads directory (see upload.ts)
	 * and the answer carries the absolute path the message will hand the model.
	 */
	async function handleUpload(request: IncomingMessage, response: ServerResponse, workDir: string): Promise<void> {
		const name = new URL(request.url ?? "/", "http://localhost").searchParams.get("name") ?? "";
		const stored = await storeUpload(workDir, name, request);
		if (!stored.ok) {
			sendJson(response, { error: stored.error }, stored.status);
			return;
		}
		sendJson(response, { ok: true, name: stored.name, path: stored.path, size: stored.size });
	}

	// The device gateway owns the reverse WS the DroidBridge APK dials. The store
	// is the runtime's (its tools read the registry); the hooks route lifecycle
	// events into the console broadcasts and the server log.
	const droidGateway = new DroidGateway(runtime.droidRegistry, {
		onDeviceChange: () => broadcastDroidDevices(),
		log: (line: string) => console.error(`[zg-droid] ${line}`),
	});
	runtime.setDroidGateway(droidGateway);
	// Restore the persisted reverse-connection listener (address the operator
	// picked on the device page). Binding 0.0.0.0 is what lets a LAN phone dial in.
	const listenConfig = runtime.droidListenConfig();
	if (listenConfig) await droidGateway.listen(listenConfig.host, listenConfig.port);

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const path = url.pathname;
		const auth = currentAuth();
		if (authEnabled) {
			if (path === "/api/auth/state") {
				sendJson(response, { configured: Boolean(auth), username: auth?.username ?? null });
				return;
			}
			if (path === "/api/auth/setup" && request.method === "POST") {
				void handleSetup(request, response);
				return;
			}
			if (path === "/api/auth/login" && request.method === "POST") {
				void handleLogin(request, response, auth);
				return;
			}
			if (path === "/api/auth/logout" && request.method === "POST") {
				// The cookie is stateless, so revocation is recorded in auth.json:
				// sessions issued before now stop working, including this one.
				if (auth && agentDir) revokeSessions(agentDir, auth);
				response.setHeader("set-cookie", clearSessionCookieHeader());
				sendJson(response, { ok: true });
				return;
			}
		}
		const authorized = authEnabled ? hasValidSession(auth, request) : true;
		if (authorized) {
			if (path === "/api/health") {
				sendJson(response, { ok: true, sessionId: runtime.currentSessionId, mode: runtime.currentMode });
				return;
			}
			if (path === "/api/auth/session") {
				sendJson(response, { ok: true, username: auth?.username ?? null });
				return;
			}
			if (path === "/api/auth/change-password" && request.method === "POST") {
				if (!auth) {
					sendJson(response, { error: "Not logged in" }, 401);
					return;
				}
				void handleChangePassword(request, response, auth);
				return;
			}
			// One chat attachment: the raw body is the file, `name` is what to call
			// it. It lands in the active project's work dir, which is the directory
			// the agent reads in a container session and in a host session alike.
			if (path === "/api/upload" && request.method === "POST") {
				const active = runtime.snapshot();
				if (!active.project) {
					sendJson(response, { error: "请先创建或选择一个项目，再上传附件" }, 409);
					return;
				}
				void handleUpload(request, response, active.cwd);
				return;
			}
		} else if (path.startsWith("/api/")) {
			sendJson(response, { error: "未登录" }, 401);
			return;
		}
		serveStatic(webuiDistDir(), path, response);
	});

	const wss = new WebSocketServer({ noServer: true });
	// The upgrade handshake is where the WebSocket is gated: no valid session, no console.
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		// The DroidBridge APK authenticates with its own device token, not the
		// console session, and must reach the gateway before the console's checks.
		if (droidGateway.handleUpgrade(request, socket, head)) return;
		if (url.pathname !== "/ws" || (authEnabled && !hasValidSession(currentAuth(), request))) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
	});
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
		// Engineering mode: the board and doctrine list are pushed per connect.
		broadcastEngines(socket);
		if (agentDir) sendTo(socket, { type: "doctrines", doctrines: listDoctrines(agentDir) });
		if (agentDir) sendTo(socket, { type: "commander_config", config: readCommanderModelConfig(agentDir) });
		if (agentDir) sendTo(socket, { type: "gatekeeper_config", config: runtime.getGatekeeperConfig() });
		if (agentDir) sendTo(socket, { type: "model_library", library: runtime.getModelLibrary() });
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
					await runtime.prompt(
						message.text,
						message.streamingBehavior,
						images,
						message.notify,
						message.attachModelIds,
					);
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
				case "set_global_mode":
					runtime.setGlobalMode(message.mode);
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
					// An unknown or disabled preset id throws, which the handler reports to
					// the browser; the session is not created at all rather than silently
					// falling back to the default agent.
					await runtime.newSession(message.presetId?.trim() || undefined);
					return;
				case "set_session_preset":
					// Throws on an unknown/disabled preset or a running session; the
					// handler reports it and the conversation keeps its old briefing.
					await runtime.setSessionPreset(message.presetId);
					return;
				case "switch_session":
					await runtime.switchSession(message.path);
					return;
				case "list_sessions":
					await broadcastSessions(socket);
					return;
				case "rename_session": {
					if (!message.name.trim()) {
						sendError(socket, "会话名称不能为空");
						return;
					}
					await runtime.renameSession(message.path, message.name.trim());
					await broadcastSessions();
					return;
				}
				case "set_session_status": {
					// The toolbar labels the session it is showing; the list passes a path.
					const statusPath = message.path ?? runtime.currentSessionPath;
					if (!statusPath) {
						sendError(socket, "没有活动会话");
						return;
					}
					// Setting it on a loaded session also refreshes the snapshot, which is
					// where the toolbar reads the active session's status from.
					await runtime.setSessionStatus(statusPath, message.status);
					await broadcastSessions();
					return;
				}
				case "delete_session": {
					await runtime.deleteSession(message.path);
					await broadcastSessions();
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
				case "get_model_library":
					sendTo(socket, { type: "model_library", library: runtime.getModelLibrary() });
					return;
				case "save_model_entry":
					// The view comes back after every mutation, so the screen never has to
					// guess what the store did (ids, role usage, resolved endpoints).
					sendTo(socket, { type: "model_library", library: runtime.saveModelEntry(message) });
					broadcastSnapshot();
					return;
				case "remove_model_entry":
					sendTo(socket, { type: "model_library", library: runtime.removeModelEntry(message.id) });
					broadcastSnapshot();
					return;
				case "duplicate_model_entry":
					sendTo(socket, { type: "model_library", library: runtime.duplicateModelEntry(message.id) });
					return;
				case "set_model_role":
					sendTo(socket, { type: "model_library", library: runtime.setModelRole(message.role, message.target) });
					broadcastSnapshot();
					return;
				case "set_reviewer_auto":
					sendTo(socket, { type: "model_library", library: runtime.setReviewerAuto(message.enabled) });
					return;
				case "test_model_entry": {
					const config = agentDir ? readProviderModelConfig(agentDir, message.id) : null;
					const result = config
						? await testModelConfig(config)
						: { ok: false, message: "这个模型没有可用的端点配置" };
					sendTo(socket, { type: "model_test_result", result });
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
					// The project's container is gone: its engines cannot run and
					// their task sessions die with the project, so cascade.
					if (engines) await engines.purgeProject(message.id);
					const purged = runtime.purgeProjectVulns(message.id);
					const purgedGates = runtime.purgeProjectGates(message.id);
					const purgedModels = runtime.purgeProjectApiModels(message.id);
					const purgedCaptures = runtime.purgeProjectCaptures(message.id);
					console.error(
						`[zg-server] 删除项目 ${target.name}，连带删除 ${purged} 条漏洞记录、${purgedGates} 条守门记录、${purgedModels} 份业务模型`,
					);
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
					await broadcastSessions();
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
				case "retry_vuln_review": {
					if (!reviewer) {
						sendError(socket, "未配置配置目录，无法评审");
						return;
					}
					const result = message.force ? reviewer.requeue(message.id) : reviewer.retry(message.id);
					sendTo(socket, {
						type: "vuln_review_result",
						id: message.id,
						ok: result.ok,
						...(result.error ? { error: result.error } : {}),
					});
					return;
				}
				case "review_pending_vulns": {
					if (!reviewer) {
						sendError(socket, "未配置配置目录，无法评审");
						return;
					}
					// The requeue itself is the feedback: the refreshed list shows
					// every record flipping to 评审中.
					reviewer.requeueAll(runtime.pendingVulnIds());
					broadcastVulns();
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
				case "list_pocs": {
					const view = runtime.listPocs(message.filters);
					sendTo(socket, { type: "pocs", items: view.items, stats: view.stats });
					return;
				}
				case "get_poc": {
					const poc = runtime.getPoc(message.id);
					if (!poc) {
						sendError(socket, `POC 库中没有 id 为 ${message.id} 的模板`);
						return;
					}
					sendTo(socket, { type: "poc", poc });
					return;
				}
				case "import_pocs": {
					if (message.files.length === 0) {
						sendError(socket, "没有可导入的文件");
						return;
					}
					if (message.files.length > 2000) {
						sendError(socket, "一次最多导入 2000 个文件，请分批上传");
						return;
					}
					try {
						const outcome = runtime.importPocs(message.files);
						sendTo(socket, { type: "pocs_imported", outcome });
						broadcastPocs();
					} catch (error) {
						sendError(socket, `导入失败：${error instanceof Error ? error.message : String(error)}`);
					}
					return;
				}
				case "list_poc_sources": {
					sendTo(socket, { type: "poc_sources", sources: runtime.listPocSources() });
					return;
				}
				case "save_poc_source": {
					const result = runtime.savePocSource(message.source);
					if ("error" in result) {
						sendTo(socket, { type: "poc_source_result", action: "保存", ok: false, error: result.error });
						return;
					}
					sendTo(socket, { type: "poc_source_result", action: "保存", id: result.source.id, ok: true });
					sendTo(socket, { type: "poc_sources", sources: runtime.listPocSources() });
					return;
				}
				case "delete_poc_source": {
					const ok = runtime.deletePocSource(message.id);
					sendTo(socket, {
						type: "poc_source_result",
						action: "删除",
						id: message.id,
						ok,
						...(ok ? {} : { error: "该订阅源不存在" }),
					});
					return;
				}
				case "sync_poc_source": {
					const result = await runtime.syncPocSource(message.id);
					if ("error" in result) {
						sendTo(socket, {
							type: "poc_source_result",
							action: "同步",
							id: message.id,
							ok: false,
							error: result.error,
						});
						return;
					}
					sendTo(socket, { type: "poc_source_result", action: "同步", id: message.id, ok: true });
					// The sync itself already broadcast the refreshed list.
					return;
				}
				case "sync_official_pocs": {
					const result = await runtime.syncOfficialPocs();
					if ("error" in result) {
						sendTo(socket, { type: "poc_source_result", action: "同步官方 POC", ok: false, error: result.error });
						return;
					}
					sendTo(socket, { type: "poc_source_result", action: "同步官方 POC", ok: true });
					// The sync itself already broadcast the refreshed list.
					return;
				}
				case "delete_poc": {
					const ok = runtime.deletePoc(message.id);
					sendTo(socket, {
						type: "poc_result",
						action: "删除",
						id: message.id,
						ok,
						...(ok ? {} : { error: "该模板不存在" }),
					});
					return;
				}
				case "start_modeling": {
					// Modeling runs the agent, so it needs the same container backend.
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						broadcastEnvironment();
						return;
					}
					await runtime.startModeling();
					return;
				}
				case "end_modeling":
					await runtime.endModeling();
					return;
				case "detach_modeling":
					await runtime.detachModeling();
					return;
				case "list_api_models":
					sendTo(socket, { type: "api_models", items: runtime.listApiModels(message.filters) });
					return;
				case "get_api_model": {
					const view = runtime.getApiModel(message.id);
					if (!view) {
						sendError(socket, `没有 id 为 ${message.id} 的业务建模记录`);
						return;
					}
					sendTo(socket, { type: "api_model", model: view.model, events: view.events });
					return;
				}
				case "end_api_model": {
					// The page's way out of a run whose session is gone; a loaded
					// session ends it through the normal path (tools off, marker).
					const ok = runtime.finishApiModel(message.id, "manual", "操作员在业务建模页结束");
					sendTo(socket, {
						type: "api_model_result",
						action: "结束",
						id: message.id,
						ok,
						...(ok ? {} : { error: "该记录不存在" }),
					});
					return;
				}
				case "delete_api_model": {
					const ok = runtime.deleteApiModel(message.id);
					sendTo(socket, {
						type: "api_model_result",
						action: "删除",
						id: message.id,
						ok,
						...(ok ? {} : { error: "该记录不存在" }),
					});
					return;
				}
				case "droid_state": {
					const state = runtime.droidState();
					sendTo(socket, {
						type: "droid_state",
						enabled: state.enabled,
						devices: state.devices,
						tokens: state.tokens,
						listen: droidGateway.listenInfo() ?? null,
						listenConfig: runtime.droidListenConfig(),
						lanIps: lanIps(),
					});
					return;
				}
				case "droid_token_create": {
					await runtime.droidCreateToken(message.label);
					return;
				}
				case "droid_token_delete": {
					try {
						await runtime.droidDeleteToken(message.id);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "droid_device_rename": {
					try {
						await runtime.droidRenameDevice(message.id, message.name);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "droid_device_remove": {
					try {
						await runtime.droidRemoveDevice(message.id);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "droid_set_enabled": {
					await runtime.setDroidEnabled(message.enabled);
					return;
				}
				case "droid_set_listen": {
					try {
						await runtime.droidSetListen(message.host, message.port);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "export_api_model": {
					const file = runtime.exportApiModel(message.id, message.format);
					if (!file) {
						sendError(socket, "该记录不存在");
						return;
					}
					sendTo(socket, {
						type: "api_model_export",
						filename: file.filename,
						format: message.format,
						text: file.text,
					});
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
				case "list_engines":
					broadcastEngines(socket);
					return;
				case "engine_create": {
					if (!engines) {
						sendError(socket, "未配置配置目录，无法使用工程模式");
						return;
					}
					const project = runtime.snapshot().project;
					if (!project) {
						sendError(socket, "请先创建或选择一个项目，工程属于项目");
						return;
					}
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						broadcastEnvironment();
						return;
					}
					await engines.createEngine(project, message.input);
					broadcastEngines();
					return;
				}
				case "engine_set_gate_mode": {
					if (!engines) {
						sendError(socket, "未配置配置目录，无法使用工程模式");
						return;
					}
					engines.setGateMode(message.id, message.gateMode);
					broadcastEngines();
					return;
				}
				case "engine_set_presets": {
					if (!engines) {
						sendError(socket, "未配置配置目录，无法使用工程模式");
						return;
					}
					engines.setPresets(message.id, message.presetIds);
					broadcastEngines();
					return;
				}
				case "engine_set_preset_optional": {
					if (!engines) {
						sendError(socket, "未配置配置目录，无法使用工程模式");
						return;
					}
					engines.setPresetOptional(message.id, message.optional);
					broadcastEngines();
					return;
				}
				case "engine_pause":
					if (engines) await engines.pauseEngine(message.id);
					return;
				case "engine_resume": {
					if (!engines) return;
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						return;
					}
					await engines.resumeEngine(message.id);
					return;
				}
				case "engine_abort":
					if (engines) await engines.abortEngine(message.id);
					return;
				case "engine_delete":
					if (engines) {
						await engines.deleteEngine(message.id);
						broadcastEngines();
					}
					return;
				case "engine_add_targets":
					if (engines) engines.addTargets(message.id, message.targets);
					return;
				case "engine_steer_commander":
					if (engines) await engines.steerCommander(message.id, message.text);
					return;
				case "engine_abort_task": {
					if (!engines) return;
					const aborted = await engines.abortTask(message.taskId, "操作员在工程页中止");
					if (!aborted.ok) sendError(socket, aborted.error ?? "任务未能中止");
					return;
				}
				case "engine_task_events": {
					if (!engines) return;
					sendTo(socket, {
						type: "engine_task_events",
						taskId: message.taskId,
						events: engines.taskEvents(message.taskId),
					});
					return;
				}
				case "engine_commander_events": {
					if (!engines) return;
					sendTo(socket, {
						type: "engine_commander_events",
						id: message.id,
						events: engines.commanderEvents(message.id),
					});
					return;
				}
				case "engine_open_task_session": {
					if (!engines) return;
					try {
						const path = engines.taskSessionPath(message.taskId);
						await runtime.switchSession(path);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "engine_report_snapshot": {
					if (!engines) return;
					const reportView = engines.reportSnapshot(message.id);
					sendTo(socket, {
						type: "engine_report",
						id: message.id,
						markdown: reportView.markdown,
						filename: reportView.filename,
					});
					return;
				}
				case "list_doctrines":
					sendTo(socket, {
						type: "doctrines",
						doctrines: agentDir ? listDoctrines(agentDir) : [],
					});
					return;
				case "save_doctrine": {
					if (!agentDir) {
						sendError(socket, "未配置配置目录，无法保存指挥思路");
						return;
					}
					const result = saveDoctrine(agentDir, message.input);
					sendTo(socket, {
						type: "doctrine_saved",
						doctrine: result.doctrine ?? {
							id: message.input.id ?? "",
							name: message.input.name,
							text: message.input.text,
							builtin: false,
						},
						...(result.error ? { error: result.error } : {}),
					});
					return;
				}
				case "delete_doctrine": {
					if (!agentDir) return;
					const result = agentDir ? deleteDoctrine(agentDir, message.id) : { ok: false, error: "未配置配置目录" };
					sendTo(socket, {
						type: "doctrine_deleted",
						id: message.id,
						ok: result.ok,
						...(result.error ? { error: result.error } : {}),
					});
					return;
				}
				case "list_presets":
					sendTo(socket, { type: "presets", presets: agentDir ? presetViews(agentDir) : [] });
					return;
				case "save_preset": {
					if (!agentDir) {
						sendError(socket, "未配置配置目录，无法保存预设 Agent");
						return;
					}
					const result = savePreset(agentDir, message.input);
					sendTo(socket, {
						type: "preset_saved",
						preset: result.preset ? presetView(agentDir, result.preset.id) : null,
						...(result.error ? { error: result.error } : {}),
					});
					// The snapshot carries the active session's preset view — its name and
					// the composer hint — so an edit has to reach an open chat page too,
					// not just the settings page that made it.
					if (result.preset) broadcastSnapshot();
					return;
				}
				case "delete_preset": {
					if (!agentDir) return;
					const result = deletePreset(agentDir, message.id);
					sendTo(socket, {
						type: "preset_deleted",
						id: message.id,
						ok: result.ok,
						...(result.error ? { error: result.error } : {}),
					});
					if (result.ok) broadcastSnapshot();
					return;
				}
				case "set_preset_enabled": {
					if (!agentDir) {
						sendError(socket, "未配置配置目录，无法修改预设 Agent");
						return;
					}
					const result = setPresetEnabled(agentDir, message.id, message.enabled);
					sendTo(socket, {
						type: "preset_saved",
						preset: result.preset ? presetView(agentDir, result.preset.id) : null,
						...(result.error ? { error: result.error } : {}),
					});
					if (result.preset) broadcastSnapshot();
					return;
				}
				case "export_presets": {
					if (!agentDir) {
						sendError(socket, "未配置配置目录，无法导出预设 Agent");
						return;
					}
					// The file is built here and handed over as text: the browser turns it
					// into a download, so no server route has to serve operator data.
					const exported = exportPresets(agentDir, message.ids);
					sendTo(socket, {
						type: "presets_export",
						filename: exportFileName(new Date()),
						content: `${JSON.stringify(exported, null, "\t")}\n`,
					});
					return;
				}
				case "import_presets": {
					if (!agentDir) {
						sendError(socket, "未配置配置目录，无法导入预设 Agent");
						return;
					}
					let parsed: unknown;
					try {
						parsed = JSON.parse(message.content) as unknown;
					} catch {
						sendError(socket, "导入失败：文件内容不是合法的 JSON");
						return;
					}
					const result = importPresets(agentDir, parsed);
					sendTo(socket, {
						type: "presets_imported",
						imported: result.imported.map((preset) => ({
							...preset,
							text: presetView(agentDir, preset.id)?.text ?? "",
							textMissing: false,
							tokens: presetView(agentDir, preset.id)?.tokens ?? 0,
						})),
						skipped: result.skipped,
						...(result.error ? { error: result.error } : {}),
					});
					return;
				}
				case "get_commander_config":
					sendTo(socket, {
						type: "commander_config",
						config: agentDir ? readCommanderModelConfig(agentDir) : null,
					});
					return;
				case "save_commander_config": {
					if (!agentDir) {
						sendError(socket, "未配置配置目录，无法保存指挥官配置");
						return;
					}
					writeCommanderModelConfig(agentDir, message.config);
					sendTo(socket, { type: "commander_config", config: readCommanderModelConfig(agentDir) });
					return;
				}
				case "get_gatekeeper_config":
					sendTo(socket, { type: "gatekeeper_config", config: runtime.getGatekeeperConfig() });
					return;
				case "save_gatekeeper_config": {
					runtime.saveGatekeeperConfig(message.config);
					sendTo(socket, { type: "gatekeeper_config", config: runtime.getGatekeeperConfig() });
					// The saved mode is the global default, so it can change the active
					// session's effective mode and the toolbar switch that shows it.
					broadcastSnapshot();
					return;
				}
				case "test_judge": {
					const result = await runtime.testJudge();
					sendTo(socket, { type: "judge_test_result", ...result });
					return;
				}
				case "gate_audit_query": {
					const page = runtime.listGateDecisions(message.filter, message.page, message.pageSize);
					sendTo(socket, { type: "gate_audit", page });
					return;
				}
				case "gate_audit_stats":
					sendTo(socket, { type: "gate_audit_stats", stats: runtime.getGateStats(message.filter) });
					return;
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
					engines?.dispose();
					runtime.dispose();
					for (const client of clients) client.terminate();
					wss.close();
					server.close();
				},
			});
		});
	});
}
