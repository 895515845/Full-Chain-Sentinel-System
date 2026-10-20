/**
 * Full Chain Sentinel web console server.
 *
 * Serves the built browser UI over HTTP and exposes a JSON WebSocket protocol
 * (see protocol.ts) that drives one Full Chain Sentinel runtime. Designed for a single
 * local operator; every connected console receives the same event stream.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, posix, resolve } from "node:path";
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
	recreateProject,
	removeProject,
	resolveStartupProject,
	setLastActiveProject,
} from "./projects.ts";
import type {
	SentinelClientMessage,
	SentinelEnvReport,
	SentinelProjectInfo,
	SentinelServerMessage,
} from "./protocol.ts";
import { VulnReviewer } from "./reviewer.ts";
import type { WorkerSession } from "./worker.ts";

interface AcquiredTaskSession {
	session: WorkerSession;
	manager: SessionManager;
}

import {
	CONSENT_TEXT,
	CONSENT_VERSION,
	type ConsentStatus,
	consentStatus,
	isConsentExemptPath,
	writeConsentRecord,
} from "./consent.ts";
import {
	DEFAULT_CONTAINER_NETWORK,
	normalizeContainerNetwork,
	readContainerNetwork,
	writeContainerNetwork,
} from "./container-network.ts";
import { gateCookieHeader, generateGateToken, hasValidGate, isGateEntry, sendGateNotFound } from "./gate.ts";
import { getOfficialPlugin, listOfficialPlugins } from "./official-plugins.ts";
import { readPluginPackage } from "./plugin-package.ts";
import { effectivePluginHosts } from "./plugin-store.ts";
import { POC_IMPORT_MAX_BYTES, PocImportManager } from "./poc-import.ts";
import { SentinelRuntime } from "./sentinel-session.ts";
import { EMPTY_SOURCES, normalizeSources, readSources, writeSources } from "./sources.ts";
import { storeUpload } from "./upload.ts";

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
<head><meta charset="utf-8"><title>全链哨兵 控制台</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head>
<body style="background:#111418;color:#d7dde4;font-family:system-ui;padding:48px;line-height:1.7">
<h1>全链哨兵 Web 控制台</h1>
<p>前端资源尚未构建。请在仓库根目录执行：</p>
<pre style="background:#1b2027;padding:12px;border-radius:8px">npm --prefix packages/web run build</pre>
<p>构建完成后刷新本页。</p>
</body></html>`;

export interface SentinelServerOptions {
	cwd?: string;
	agentDir?: string;
	host?: string;
	port?: number;
	/**
	 * Console authentication (default on). Only the automated tests turn it off;
	 * the credential file is created on first visit.
	 */
	auth?: boolean;
	/**
	 * Secret entry URL (default: on exactly when authentication is). Opening
	 * `/<token>` sets a cookie and redirects to `/`; every other request without
	 * that cookie is answered with a plain 404, so a console bound to a public
	 * address cannot be fingerprinted or indexed. Off means `/` is the console.
	 */
	gate?: boolean;
	/** A fixed entry token; by default a fresh one is generated on every start. */
	gateToken?: string;
	/**
	 * Serve HTTPS (the page and its WebSocket over TLS on the same listener).
	 * Off means plain HTTP — the automated tests run that way; the CLI turns it
	 * on by default and hands the PEM contents here.
	 */
	tls?: { cert: string; key: string };
	/**
	 * First-visit authorization promise (default: on exactly when authentication
	 * is). Until the operator accepts the statement, `/api` and the WebSocket
	 * answer 403 and only the statement itself is served.
	 */
	consent?: boolean;
}

export function webuiDistDir(): string {
	// dist/server.js -> package root -> webui/dist
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "webui", "dist");
}

/**
 * Capability tokens for plugin UI assets.
 *
 * The iframe is sandboxed without allow-same-origin, so its document has an
 * opaque origin and the browser does not send the console's gate or session
 * cookie with its subresource requests. A cookie-protected /plugin-ui would
 * answer 404 for every script and stylesheet. Instead the console issues a
 * random token when the authenticated WebSocket asks to open a UI, and the
 * iframe URL carries it in the path so relative assets inherit it.
 */
const PLUGIN_UI_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const pluginUiTokens = new Map<string, { hostId: string; pluginId: string; expiresAt: number }>();

function issuePluginUiToken(hostId: string, pluginId: string): string {
	const now = Date.now();
	for (const [token, entry] of pluginUiTokens) {
		if (entry.expiresAt <= now) pluginUiTokens.delete(token);
	}
	const token = randomBytes(24).toString("base64url");
	pluginUiTokens.set(token, { hostId, pluginId, expiresAt: now + PLUGIN_UI_TOKEN_TTL_MS });
	return token;
}

/** A plugin's sidebar icon, proxied through the console session (same-origin <img>). */
async function servePluginIcon(
	runtime: SentinelRuntime,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const parts = (request.url ?? "/").split("?")[0].split("/").filter(Boolean);
	try {
		const hostId = decodeURIComponent(parts[1] ?? "");
		const pluginId = decodeURIComponent(parts[2] ?? "");
		const file = decodeURIComponent(parts[3] ?? "");
		if (!hostId || !pluginId || !/^[A-Za-z0-9._-]+\.(svg|png)$/.test(file)) {
			sendJson(response, { error: "没有这个图标" }, 404);
			return;
		}
		const asset = await runtime.getPluginUiFile(hostId, pluginId, file);
		response.writeHead(200, {
			"content-type": file.endsWith(".svg") ? "image/svg+xml" : "image/png",
			"content-length": String(asset.data.length),
			"cache-control": "private, max-age=60",
			"x-content-type-options": "nosniff",
		});
		response.end(asset.data);
	} catch {
		sendJson(response, { error: "没有这个图标" }, 404);
	}
}

/**
 * Serve a plugin's frontend through the console's own origin.
 *
 * The iframe cannot point at `http://127.0.0.1:<port>`: the console is HTTPS, so
 * the browser would block it as mixed content. Proxying under the console origin
 * also means the host token and the plugin container port never reach the page.
 * The response is a static asset, nothing else; the bridge is postMessage.
 */
async function servePluginUi(agentDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
	const url = new URL(request.url ?? "/", "http://localhost");
	const parts = url.pathname.split("/").filter(Boolean);
	const token = parts[1] ?? "";
	const grant = pluginUiTokens.get(token);
	if (!grant || grant.expiresAt <= Date.now()) {
		sendJson(response, { error: "没有这个界面" }, 404);
		return;
	}
	let hostId = "";
	try {
		hostId = parts[2] ? decodeURIComponent(parts[2]) : "";
	} catch {
		sendJson(response, { error: "插件主机 id 非法" }, 400);
		return;
	}
	let pluginId = "";
	try {
		pluginId = parts[3] ? decodeURIComponent(parts[3]) : "";
	} catch {
		sendJson(response, { error: "插件 id 非法" }, 400);
		return;
	}
	if (!hostId || !pluginId || grant.hostId !== hostId || grant.pluginId !== pluginId) {
		sendJson(response, { error: "没有这个界面" }, 404);
		return;
	}
	const host = effectivePluginHosts(agentDir).find((entry) => entry.id === hostId);
	if (!host) {
		sendJson(response, { error: "插件主机不存在" }, 404);
		return;
	}
	const rest: string[] = [];
	for (const raw of parts.slice(4)) {
		let segment: string;
		try {
			segment = decodeURIComponent(raw);
		} catch {
			sendJson(response, { error: "界面路径非法" }, 400);
			return;
		}
		if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
			sendJson(response, { error: "界面路径非法" }, 400);
			return;
		}
		rest.push(encodeURIComponent(segment));
	}
	const upstreamPath = `/plugins/${encodeURIComponent(pluginId)}/ui/${rest.join("/")}`;
	let upstream: Response;
	try {
		upstream = await fetch(`${host.url}${upstreamPath}${url.search}`, {
			headers: { authorization: `Bearer ${host.token}` },
			signal: AbortSignal.timeout(20000),
		});
	} catch (error) {
		sendJson(response, { error: `读取插件界面失败：${error instanceof Error ? error.message : String(error)}` }, 502);
		return;
	}
	const body = Buffer.from(await upstream.arrayBuffer());
	response.writeHead(upstream.status, {
		"content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
		"content-length": String(body.length),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		// A module script loaded from a sandboxed (opaque) origin is a CORS request.
		"access-control-allow-origin": "*",
	});
	response.end(body);
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

function sendTo(socket: WebSocket, message: SentinelServerMessage): void {
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
	// URL paths are POSIX. Using the platform `normalize` here turns them into
	// backslashes on Windows and breaks the embedded map, which is keyed with `/`.
	relative = posix.normalize(relative).replace(/^(\.\.[/\\])+/, "");
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

export async function startSentinelServer(
	options: SentinelServerOptions = {},
): Promise<{ close: () => void; url: string; environment: Promise<SentinelEnvReport> }> {
	const startupCwd = resolve(options.cwd ?? process.cwd());
	const clients = new Set<WebSocket>();
	const agentDir = options.agentDir;
	// The gate follows authentication by default: a console with no password to
	// protect (the automated tests) is not the deployment this guards, and one that
	// has a password should not be visible before its login page.
	const gateEnabled = options.gate ?? (options.auth !== false && Boolean(agentDir));
	const gateToken = gateEnabled ? (options.gateToken ?? generateGateToken()) : "";
	// The authorization promise follows authentication too: it is tied to the
	// account that accepts it, so a console with no account has nothing to record.
	const consentEnabled = options.consent ?? (options.auth !== false && Boolean(agentDir));
	const startup = agentDir ? await resolveStartupProject(agentDir) : {};
	const runtime = new SentinelRuntime({
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
			onSupervisorState: (view) => broadcast({ type: "supervisor_state", supervisor: view }),
			onSupervisorEpisode: (episode, calls) => broadcast({ type: "supervisor_episode", episode, calls }),
			onSupervisorLog: (sessionId, log) => broadcast({ type: "supervisor_log", sessionId, log }),
			onSupervisorAdvice: (advice) => broadcast({ type: "supervisor_advice", advice }),
		},
	});
	const pocImports = new PocImportManager((file, onProgress, signal) =>
		runtime.importPocBytes([file], { onProgress, signal }),
	);

	/**
	 * Docker environment state. The check runs once at startup and on demand; every
	 * prompt waits for it, because a run without a working container backend can
	 * only fail. `imageBuild` is set while a `docker build` is streaming.
	 */
	let envReport: SentinelEnvReport | undefined;
	let envCheck: Promise<SentinelEnvReport> | undefined;
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
		const view = { type: "engines", engines: engines.listEngines() } satisfies SentinelServerMessage;
		if (socket) sendTo(socket, view);
		else broadcast(view);
	}

	function consoleUrl(): string {
		const address = server.address();
		const boundPort = address && typeof address === "object" ? address.port : (options.port ?? 7777);
		const boundHost = options.host ?? "127.0.0.1";
		// A wildcard bind is not a browser address.
		const shownHost = boundHost === "0.0.0.0" || boundHost === "::" || boundHost === "[::]" ? "127.0.0.1" : boundHost;
		// With the gate on, the console address is the entry URL: it is the only one
		// that works, so this is what the environment page shows and what the startup
		// log prints.
		return `${options.tls ? "https" : "http"}://${shownHost}:${boundPort}${gateEnabled ? `/${gateToken}` : ""}`;
	}

	/** The current report, running the check first if there is none or `force` is set. */
	async function ensureEnvironment(force = false): Promise<SentinelEnvReport> {
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
	function blockedReason(report: SentinelEnvReport): string {
		const blocker = report.items.find((entry) => entry.blocking && entry.status !== "ok");
		const detail = blocker ? `${blocker.label}：${blocker.detail}` : "环境检查未通过";
		return `Docker 环境不可用（${detail}）。请在「设置 → 环境」中修复后复检。`;
	}

	function broadcast(message: SentinelServerMessage): void {
		let data: string;
		try {
			data = JSON.stringify(message);
		} catch (error) {
			console.error("[sentinel-server] broadcast serialization failed:", error);
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
		broadcast({
			type: "pocs",
			items: view.items,
			stats: view.stats,
			total: view.total,
			page: view.page,
			pageSize: view.pageSize,
		});
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
	function projectInfos(): SentinelProjectInfo[] {
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
		const view = { type: "sessions", sessions } satisfies SentinelServerMessage;
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
	/** The promise state for the account this request belongs to. */
	const consentFor = (username: string | null): ConsentStatus =>
		consentEnabled
			? consentStatus(agentDir, username)
			: { required: false, acceptedAt: null, version: CONSENT_VERSION };

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
	 * Records the promise for this account. The body has to say `accepted: true`:
	 * the checkbox is the point, so an empty POST must not be enough.
	 */
	async function handleConsentAccept(
		request: IncomingMessage,
		response: ServerResponse,
		username: string,
	): Promise<void> {
		if (!agentDir) {
			sendJson(response, { error: "缺少配置目录，无法记录承诺" }, 500);
			return;
		}
		const body = await readJsonBody(request);
		if (body?.accepted !== true) {
			sendJson(response, { error: "必须勾选承诺才能记录" }, 400);
			return;
		}
		const record = writeConsentRecord(agentDir, username);
		sendJson(response, { ok: true, acceptedAt: record.acceptedAt, version: CONSENT_VERSION });
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

	/**
	 * POC upload: the raw body is one file, streamed to a private temp file. The
	 * response is only an acceptance receipt; the import itself is a queued job
	 * polled through `/api/pocs/import/<id>`. This keeps an 18MB+ zip out of a
	 * WebSocket frame and keeps the event loop free while it is parsed.
	 */
	async function handlePocImport(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			const name = new URL(request.url ?? "/", "http://localhost").searchParams.get("name") ?? "poc.zip";
			const declared = Number(request.headers["content-length"] ?? 0);
			if (Number.isFinite(declared) && declared > POC_IMPORT_MAX_BYTES) {
				request.resume();
				sendJson(response, { error: `文件超过 ${Math.round(POC_IMPORT_MAX_BYTES / 1024 / 1024)}MB 上限` }, 413);
				return;
			}
			const accepted = await pocImports.accept(name, request);
			if (!accepted.ok) {
				// The body may still be arriving when the queue rejects it; drain it so
				// the client sees the JSON error instead of a connection reset.
				request.resume();
				sendJson(response, { error: accepted.error }, accepted.status);
				return;
			}
			sendJson(response, { ok: true, id: accepted.id }, 202);
		} catch (error) {
			if (!response.headersSent && !response.destroyed) {
				sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
			} else {
				response.destroy();
			}
		}
	}

	function handlePocImportStatus(response: ServerResponse, id: string): void {
		const job = pocImports.get(id);
		if (!job) {
			sendJson(response, { error: "导入任务不存在或已过期" }, 404);
			return;
		}
		sendJson(response, job);
	}

	// The device gateway owns the reverse WS the DroidBridge APK dials. The store
	// is the runtime's (its tools read the registry); the hooks route lifecycle
	// events into the console broadcasts and the server log.
	const droidGateway = new DroidGateway(runtime.droidRegistry, {
		onDeviceChange: () => broadcastDroidDevices(),
		log: (line: string) => console.error(`[sentinel-droid] ${line}`),
	});
	runtime.setDroidGateway(droidGateway);
	// Restore the persisted reverse-connection listener (address the operator
	// picked on the device page). Binding 0.0.0.0 is what lets a LAN phone dial in.
	const listenConfig = runtime.droidListenConfig();
	if (listenConfig) await droidGateway.listen(listenConfig.host, listenConfig.port);

	const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const path = url.pathname;
		// Swagger UI is rendered inside a sandboxed srcdoc iframe (opaque origin), so
		// that iframe cannot present the gate/session cookies. These two paths are
		// the generic reader library only — no console data — and must stay reachable
		// or the API document pane renders blank.
		if (path.startsWith("/assets/swagger-ui-")) {
			serveStatic(webuiDistDir(), path, response);
			return;
		}
		// The gate answers before anything else — before the auth endpoints too, so a
		// scanner that does not know the entry URL never learns that a console, or its
		// first-run setup flow, is here at all.
		if (gateEnabled) {
			if (isGateEntry(path, gateToken)) {
				response.writeHead(302, { location: "/", "set-cookie": gateCookieHeader(gateToken) });
				response.end();
				return;
			}
			if (!hasValidGate(request, gateToken) && !path.startsWith("/plugin-ui/")) {
				sendGateNotFound(response);
				return;
			}
		}
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
		// Plugin UI assets are authenticated by the capability token in the path;
		// the sandboxed iframe cannot present the console cookie.
		if (path.startsWith("/plugin-ui/")) {
			if (!agentDir) {
				sendJson(response, { error: "控制台没有配置目录，无法读取插件界面" }, 503);
				return;
			}
			void servePluginUi(agentDir, request, response);
			return;
		}
		if (authorized) {
			// The promise comes before every other route: until it is recorded, the
			// console answers 403 and only the statement itself, the promise that
			// records it, and the session status stay reachable. The WebSocket is
			// closed separately in the upgrade handler.
			if (path.startsWith("/api/") && !isConsentExemptPath(path) && consentFor(auth?.username ?? null).required) {
				sendJson(response, { error: "consent_required" }, 403);
				return;
			}
			if (path.startsWith("/plugin-icon/")) {
				void servePluginIcon(runtime, request, response);
				return;
			}
			if (path === "/api/pocs/import" && request.method === "POST") {
				void handlePocImport(request, response);
				return;
			}
			if (path.startsWith("/api/pocs/import/") && request.method === "GET") {
				const id = path.slice("/api/pocs/import/".length);
				if (!/^[0-9a-f-]{36}$/i.test(id)) {
					sendJson(response, { error: "导入任务 id 非法" }, 400);
					return;
				}
				handlePocImportStatus(response, id);
				return;
			}
			if (path === "/api/health") {
				sendJson(response, { ok: true, sessionId: runtime.currentSessionId, mode: runtime.currentMode });
				return;
			}
			if (path === "/api/auth/session") {
				const username = auth?.username ?? null;
				sendJson(response, { ok: true, username, consent: consentFor(username) });
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
			// The statement and the promise that records it. Both stay reachable
			// before the promise: the page has to be able to show the text, and the
			// operator has to be able to accept it.
			if (path === "/api/consent") {
				sendJson(response, { ...consentFor(auth?.username ?? null), text: CONSENT_TEXT });
				return;
			}
			if (path === "/api/consent/accept" && request.method === "POST") {
				if (!agentDir || !auth) {
					sendJson(response, { error: "缺少账号或配置目录，无法记录承诺" }, 500);
					return;
				}
				void handleConsentAccept(request, response, auth.username);
				return;
			}
		} else if (path.startsWith("/api/")) {
			sendJson(response, { error: "未登录" }, 401);
			return;
		}
		serveStatic(webuiDistDir(), path, response);
	};
	const server = options.tls
		? createSecureServer({ cert: options.tls.cert, key: options.tls.key }, requestHandler)
		: createServer(requestHandler);

	const wss = new WebSocketServer({ noServer: true });
	// The upgrade handshake is where the WebSocket is gated: no valid session, no console.
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		// The DroidBridge APK authenticates with its own device token, not the
		// console session, and must reach the gateway before the console's checks.
		if (droidGateway.handleUpgrade(request, socket, head)) return;
		// The console's own socket sits behind the same gate as its page: without the
		// entry cookie there is nothing here to talk to. The device gateway above is
		// exempt on purpose — the APK carries its own token and its URL is fixed in
		// the app, so it cannot be asked to present a browser cookie.
		if (gateEnabled && !hasValidGate(request, gateToken)) {
			socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		if (url.pathname !== "/ws" || (authEnabled && !hasValidSession(currentAuth(), request))) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		// A live console socket is the agent itself, so it waits for the promise.
		if (consentFor(currentAuth()?.username ?? null).required) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
	});
	wss.on("connection", (socket) => {
		clients.add(socket);
		socket.send(JSON.stringify({ type: "snapshot", snapshot: runtime.snapshot() } satisfies SentinelServerMessage));
		socket.send(
			JSON.stringify({
				type: "projects",
				projects: projectInfos(),
				activeProjectId: runtime.snapshot().project?.id ?? null,
			} satisfies SentinelServerMessage),
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
		if (agentDir) sendTo(socket, { type: "asset_config", config: runtime.getAssetConfig() });
		if (agentDir) sendTo(socket, { type: "websearch_config", config: runtime.getWebSearchConfig() });
		if (agentDir) sendTo(socket, { type: "mcp_servers", config: runtime.getMcpServers() });
	});

	async function handleClientMessage(socket: WebSocket, raw: string): Promise<void> {
		console.error(`[srv-recv] ${raw.slice(0, 70)}`);
		let message: SentinelClientMessage;
		try {
			message = JSON.parse(raw) as SentinelClientMessage;
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
					socket.send(JSON.stringify({ type: "tree", tree, leafId, forkPoints } satisfies SentinelServerMessage));
					return;
				}
				case "get_state":
					socket.send(
						JSON.stringify({ type: "snapshot", snapshot: runtime.snapshot() } satisfies SentinelServerMessage),
					);
					return;
				case "get_model_library":
					sendTo(socket, { type: "model_library", library: runtime.getModelLibrary() });
					return;
				case "lookup_model_defaults":
					sendTo(socket, {
						type: "model_defaults",
						modelId: message.modelId,
						matches: await runtime.lookupModelDefaults(message.modelId, message.baseUrl),
					});
					return;
				case "list_model_channels":
					sendTo(socket, {
						type: "model_channels",
						requestId: message.requestId,
						query: message.query,
						channels: await runtime.listModelChannels(message.query),
					});
					return;
				case "list_channel_models":
					sendTo(socket, {
						type: "channel_models",
						requestId: message.requestId,
						provider: message.provider,
						presets: await runtime.listChannelModels(message.provider),
					});
					return;
				case "save_model_entry":
					// The view comes back after every mutation, so the screen never has to
					// guess what the store did (ids, role usage, resolved endpoints).
					sendTo(socket, { type: "model_library", library: runtime.saveModelEntry(message) });
					// The engine keeps its own runtime for the commander; models.json just changed.
					engines?.markModelsDirty();
					broadcastSnapshot();
					return;
				case "remove_model_entry":
					sendTo(socket, { type: "model_library", library: runtime.removeModelEntry(message.id) });
					engines?.markModelsDirty();
					broadcastSnapshot();
					return;
				case "duplicate_model_entry":
					sendTo(socket, { type: "model_library", library: runtime.duplicateModelEntry(message.id) });
					engines?.markModelsDirty();
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
						} satisfies SentinelServerMessage),
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
						} satisfies SentinelServerMessage),
					);
					return;
				case "save_notify_config":
					runtime.saveNotifyConfig(message.config);
					socket.send(
						JSON.stringify({
							type: "notify_config",
							config: runtime.getNotifyConfig(),
							status: runtime.getNotifyStatus(),
						} satisfies SentinelServerMessage),
					);
					return;
				case "test_notify": {
					const result = await runtime.testNotify(message.config);
					socket.send(JSON.stringify({ type: "notify_test_result", result } satisfies SentinelServerMessage));
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
						} satisfies SentinelServerMessage);
						return;
					}
					sendTo(socket, { type: "sources_saved", sources } satisfies SentinelServerMessage);
					await ensureEnvironment(true);
					broadcastEnvironment();
					return;
				}
				case "set_container_network": {
					if (!agentDir) {
						sendError(socket, "未配置配置目录，无法保存容器网络");
						return;
					}
					// Only the next container creation reads this: existing containers keep
					// the network they were created with until the operator rebuilds them.
					const network = normalizeContainerNetwork(message.network);
					try {
						writeContainerNetwork(agentDir, network);
					} catch (error) {
						sendTo(socket, {
							type: "container_network_saved",
							network: readContainerNetwork(agentDir),
							error: error instanceof Error ? error.message : String(error),
						} satisfies SentinelServerMessage);
						return;
					}
					sendTo(socket, { type: "container_network_saved", network } satisfies SentinelServerMessage);
					await ensureEnvironment(true);
					broadcastEnvironment();
					return;
				}
				case "get_asset_config":
					sendTo(socket, { type: "asset_config", config: runtime.getAssetConfig() });
					return;
				case "save_asset_platform": {
					// The save also probes the key and rebuilds the live sessions, so the
					// tool set changes with the switch. A running session refuses it.
					try {
						const config = await runtime.saveAssetPlatform(message.platform);
						broadcast({ type: "asset_config", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "set_asset_query_limit": {
					try {
						const config = await runtime.setAssetQueryLimit(message.limit);
						broadcast({ type: "asset_config", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "test_asset_platform": {
					const result = await runtime.testAssetPlatform(message.platform, message.key);
					// A probe can flip a platform's usability, so the config follows the
					// result: the screen's "已挂载" state must match what the runtime did.
					broadcast({ type: "asset_config", config: runtime.getAssetConfig() });
					sendTo(socket, {
						type: "asset_test_result",
						platform: message.platform,
						result,
					} satisfies SentinelServerMessage);
					return;
				}
				case "get_websearch_config":
					sendTo(socket, { type: "websearch_config", config: runtime.getWebSearchConfig() });
					return;
				case "save_websearch_key": {
					// Saving also probes the key and rebuilds live sessions, so the tool
					// set follows the pool. A running session refuses the change — but the
					// config is broadcast either way, so the screen never shows a stale
					// pool after a refused or half-applied save.
					try {
						const config = await runtime.saveWebSearchKey(message.key);
						broadcast({ type: "websearch_config", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
						broadcast({ type: "websearch_config", config: runtime.getWebSearchConfig() });
					}
					return;
				}
				case "delete_websearch_key": {
					try {
						const config = await runtime.deleteWebSearchKey(message.id);
						broadcast({ type: "websearch_config", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
						broadcast({ type: "websearch_config", config: runtime.getWebSearchConfig() });
					}
					return;
				}
				case "set_websearch_query_limit": {
					try {
						const config = await runtime.setWebSearchQueryLimit(message.limit);
						broadcast({ type: "websearch_config", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
						broadcast({ type: "websearch_config", config: runtime.getWebSearchConfig() });
					}
					return;
				}
				case "test_websearch_key": {
					const result = await runtime.testWebSearchKey(message.id, message.key);
					broadcast({ type: "websearch_config", config: runtime.getWebSearchConfig() });
					sendTo(socket, { type: "websearch_test_result", result } satisfies SentinelServerMessage);
					return;
				}
				case "get_mcp_servers":
					sendTo(socket, { type: "mcp_servers", config: runtime.getMcpServers() });
					return;
				case "save_mcp_server": {
					// Saving rebuilds the live sessions, so the set of connected servers
					// changes with the form. A running session refuses it.
					try {
						const config = await runtime.saveMcpServer(message.server);
						broadcast({ type: "mcp_servers", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "delete_mcp_server": {
					try {
						const config = await runtime.deleteMcpServer(message.name);
						broadcast({ type: "mcp_servers", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "set_mcp_server_enabled": {
					// Same rebuild as a save: the switch decides whether the server is mounted.
					try {
						const config = await runtime.setMcpServerEnabled(message.name, message.enabled);
						broadcast({ type: "mcp_servers", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "test_mcp_server": {
					// A probe writes nothing but the status line, so no rebuild follows.
					const result = await runtime.testMcpServer(message.name, message.draft);
					broadcast({ type: "mcp_servers", config: runtime.getMcpServers() });
					sendTo(socket, {
						type: "mcp_test_result",
						name: message.name,
						result,
					} satisfies SentinelServerMessage);
					return;
				}
				case "get_plugins": {
					sendTo(socket, { type: "plugins", view: await runtime.getPlugins() } satisfies SentinelServerMessage);
					return;
				}
				case "save_plugin_host": {
					try {
						broadcast({ type: "plugins", view: await runtime.savePluginHost(message.host) });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "delete_plugin_host": {
					try {
						broadcast({ type: "plugins", view: await runtime.deletePluginHost(message.id) });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "test_plugin_host": {
					try {
						await runtime.testPluginHost(message.id);
						broadcast({ type: "plugins", view: await runtime.getPlugins() });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "inspect_plugin_package": {
					try {
						const uploaded = readPluginPackage(message.name, message.data);
						sendTo(socket, {
							type: "plugin_manifest",
							manifest: uploaded.manifest,
							source: uploaded.name,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "install_plugin": {
					try {
						await runtime.installPlugin({
							hostId: message.hostId,
							manifest: message.manifest,
							package: message.package,
							allowBuild: message.allowBuild,
							allowHostNetwork: message.allowHostNetwork,
							allowPrivileged: message.allowPrivileged,
							config: message.config,
						});
						broadcast({ type: "plugins", view: await runtime.getPlugins() });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "uninstall_plugin": {
					try {
						broadcast({
							type: "plugins",
							view: await runtime.uninstallPlugin(message.hostId, message.pluginId, message.purge),
						});
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "start_plugin": {
					try {
						broadcast({ type: "plugins", view: await runtime.startPlugin(message.hostId, message.pluginId) });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "stop_plugin": {
					try {
						broadcast({ type: "plugins", view: await runtime.stopPlugin(message.hostId, message.pluginId) });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "get_plugin_build_log": {
					void runtime
						.getPluginBuildLog(message.hostId, message.pluginId)
						.then((log) => {
							sendTo(socket, {
								type: "plugin_build_log",
								hostId: message.hostId,
								pluginId: message.pluginId,
								log,
							});
						})
						.catch((error: unknown) => {
							const detail = error instanceof Error ? error.message : String(error);
							const reason = /没有这个接口|404/.test(detail)
								? "插件主机版本过旧，没有构建日志接口；请重启插件主机后再安装"
								: detail;
							sendTo(socket, {
								type: "plugin_build_log",
								hostId: message.hostId,
								pluginId: message.pluginId,
								log: `读取构建日志失败：${reason}`,
							});
						});
					return;
				}
				case "list_official_plugins": {
					sendTo(socket, { type: "official_plugins", plugins: listOfficialPlugins() });
					return;
				}
				case "install_official_plugin": {
					const official = getOfficialPlugin(message.pluginId);
					if (!official) {
						sendError(socket, `没有这个官方插件：${message.pluginId}`);
						return;
					}
					void runtime
						.installPlugin({
							hostId: message.hostId,
							manifest: official.manifest,
							package: official.packageBase64,
							allowBuild: message.allowBuild,
							allowHostNetwork: message.allowHostNetwork,
							allowPrivileged: message.allowPrivileged,
							config: message.config,
						})
						.then(async () => {
							broadcast({ type: "plugins", view: await runtime.getPlugins() });
						})
						.catch((error: unknown) => {
							sendError(socket, error instanceof Error ? error.message : String(error));
						});
					return;
				}
				case "set_plugin_sidebar": {
					try {
						broadcast({
							type: "plugins",
							view: await runtime.setPluginSidebar(message.hostId, message.pluginId, message.pinned),
						});
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "set_plugin_enabled": {
					try {
						broadcast({
							type: "plugins",
							view: await runtime.setPluginEnabled(message.hostId, message.pluginId, message.enabled),
						});
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "save_plugin_config": {
					try {
						broadcast({
							type: "plugins",
							view: await runtime.setPluginConfig(message.hostId, message.pluginId, message.values),
						});
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "plugin_ui_open": {
					try {
						runtime.pluginUiOpen(message.hostId, message.pluginId);
						sendTo(socket, {
							type: "plugin_ui_opened",
							token: issuePluginUiToken(message.hostId, message.pluginId),
						});
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "plugin_ui_call": {
					try {
						const result = await runtime.pluginUiCall(
							message.hostId,
							message.pluginId,
							message.method,
							message.params,
						);
						sendTo(socket, {
							type: "plugin_ui_result",
							requestId: message.requestId,
							ok: true,
							result,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendTo(socket, {
							type: "plugin_ui_result",
							requestId: message.requestId,
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						} satisfies SentinelServerMessage);
					}
					return;
				}
				case "get_plugin_logs": {
					try {
						const logs = await runtime.pluginLogs(message.hostId, message.pluginId);
						sendTo(socket, {
							type: "plugin_logs",
							hostId: message.hostId,
							pluginId: message.pluginId,
							logs,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "list_plugin_artifacts": {
					try {
						const artifacts = await runtime.listPluginArtifacts(message.hostId, message.pluginId);
						sendTo(socket, {
							type: "plugin_artifacts",
							hostId: message.hostId,
							pluginId: message.pluginId,
							artifacts,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "fetch_plugin_artifact": {
					try {
						const savedTo = await runtime.fetchPluginArtifact(message.hostId, message.pluginId, message.path);
						sendTo(socket, {
							type: "plugin_artifact_saved",
							hostId: message.hostId,
							pluginId: message.pluginId,
							path: message.path,
							savedTo,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "get_stats": {
					const stats = runtime.getStats();
					if (stats) socket.send(JSON.stringify({ type: "stats", stats } satisfies SentinelServerMessage));
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
					const purgedAssets = runtime.purgeProjectAssets(message.id);
					const purgedWebSearch = runtime.purgeProjectWebSearch(message.id);
					const purgedSupervisor = runtime.purgeProjectSupervisor(message.id);
					console.error(
						`[sentinel-server] 删除项目 ${target.name}，连带删除 ${purged} 条漏洞记录、${purgedGates} 条守门记录、${purgedModels} 份业务模型、${purgedCaptures} 条抓包记录、${purgedAssets} 条资产测绘记录、${purgedWebSearch} 条 Web 搜索记录、${purgedSupervisor} 个监督会话`,
					);
					// The removed project's container is gone, so its sessions cannot run;
					// the console falls back to the project-required state.
					if (wasActive) await runtime.detachProject(target.workDir);
					broadcastProjects();
					broadcastSnapshot();
					return;
				}
				case "recreate_project": {
					if (!agentDir) {
						sendError(socket, "内部错误：agentDir 未初始化");
						return;
					}
					// Settings that shape a container (the network mode, the mounts) are read
					// when it is created, and Docker cannot change them afterwards, so
					// applying them means replacing the container. The project keeps its id,
					// name and work directory; in-flight commands in its container fail.
					const recreated = await recreateProject(agentDir, message.id);
					if (recreated.error) {
						sendError(socket, recreated.error);
						return;
					}
					broadcastProjects();
					await ensureEnvironment(true);
					broadcastEnvironment();
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
					const requested = message.limit ?? 100;
					const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.round(requested))) : 100;
					const offset = Number.isFinite(message.offset) ? Math.max(0, Math.round(message.offset ?? 0)) : 0;
					sendTo(socket, {
						type: "subagents",
						runs: runtime.listSubagents(limit, offset),
						offset,
						total: runtime.countSubagents(),
					});
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
						} satisfies SentinelServerMessage);
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
					const view = runtime.listPocs(message.filters, message.page, message.pageSize);
					sendTo(socket, {
						type: "pocs",
						items: view.items,
						stats: view.stats,
						total: view.total,
						page: view.page,
						pageSize: view.pageSize,
					});
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
					// Creation inserts the row before the commander's first turn; tell the
					// server to return now and let the insert's engine_update reach the page.
					void engines
						.createEngine(project, message.input)
						.then(() => broadcastEngines())
						.catch((error: unknown) => {
							sendError(socket, error instanceof Error ? error.message : String(error));
						});
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
					if (!engines) return;
					// Do not hold the socket's message loop for a whole commander turn;
					// the operator event is broadcast before this promise settles.
					void engines.steerCommander(message.id, message.text).catch((error: unknown) => {
						sendError(socket, error instanceof Error ? error.message : String(error));
					});
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
					// New engines resolve the commander from models.json; the cached
					// runtime must re-read it or the save only takes effect after a restart.
					engines?.markModelsDirty();
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
					sendTo(socket, {
						type: "gate_audit_stats",
						stats: runtime.getGateStats(message.filter),
						// Without the approval filter: the tab strip counts both tabs
						// whichever one is open.
						tabCounts: runtime.getGateBuckets(message.filter),
					});
					return;
				case "supervisor_arm": {
					const view = runtime.armSupervisor(
						message.mode,
						message.delivery,
						message.strategy,
						message.note,
						message.customStrategyId,
					);
					broadcast({ type: "supervisor_state", supervisor: view });
					return;
				}
				case "supervisor_stop": {
					const view = runtime.stopSupervisor();
					broadcast({ type: "supervisor_state", supervisor: view });
					return;
				}
				case "supervisor_set_mode": {
					const view = runtime.setSupervisorMode(message.mode, message.delivery);
					broadcast({ type: "supervisor_state", supervisor: view });
					return;
				}
				case "supervisor_set_strategy": {
					const view = runtime.setSupervisorStrategy(message.strategy, message.note, message.customStrategyId);
					broadcast({ type: "supervisor_state", supervisor: view });
					return;
				}
				case "supervisor_run_now":
					runtime.runSupervisorNow();
					return;
				case "supervisor_call_output": {
					try {
						const output = runtime.getSupervisorCallOutput(message.callId);
						sendTo(socket, {
							type: "supervisor_call_output",
							callId: message.callId,
							text: output.text,
							truncated: output.truncated,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendTo(socket, {
							type: "supervisor_call_output",
							callId: message.callId,
							text: "",
							truncated: false,
							error: error instanceof Error ? error.message : String(error),
						} satisfies SentinelServerMessage);
					}
					return;
				}
				case "supervisor_audit":
					sendTo(socket, {
						type: "supervisor_audit",
						page: runtime.listSupervisorAudit({
							page: message.page,
							pageSize: message.pageSize,
							projectId: message.projectId,
							search: message.search,
							mode: message.mode,
							progress: message.progress,
							strategy: message.strategy,
							customStrategyId: message.customStrategyId,
						}),
					} satisfies SentinelServerMessage);
					return;
				case "supervisor_detail": {
					const detail = runtime.getSupervisorDetail(message.sessionId);
					if (!detail) {
						sendError(socket, "监督记录不存在");
						return;
					}
					sendTo(socket, { type: "supervisor_detail", detail } satisfies SentinelServerMessage);
					return;
				}
				case "supervisor_advice_action": {
					const advice =
						message.action === "send"
							? runtime.sendSupervisorAdvice(message.id)
							: runtime.ignoreSupervisorAdvice(message.id);
					broadcast({ type: "supervisor_advice", advice });
					return;
				}
				case "save_supervisor_config": {
					const config = runtime.saveSupervisorConfig(message.config);
					broadcast({ type: "supervisor_config", config });
					broadcastSnapshot();
					return;
				}
				case "test_supervisor": {
					const outcome = await runtime.testSupervisor();
					sendTo(socket, {
						type: "supervisor_test_result",
						...outcome,
					} satisfies SentinelServerMessage);
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
			socket.send(JSON.stringify({ type: "error", message: messageText } satisfies SentinelServerMessage));
		}
	}

	await runtime.init();

	return await new Promise((resolvePromise) => {
		const port = options.port ?? 7777;
		const host = options.host ?? "127.0.0.1";
		server.listen(port, host, () => {
			// The check reports the console address, so it starts once the port is known.
			const environment = ensureEnvironment().then(
				(report) => {
					broadcastEnvironment();
					return report;
				},
				(error: unknown) => {
					console.error("[sentinel-server] 环境检查失败:", error);
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
						url: consoleUrl(),
						sources: { ...EMPTY_SOURCES },
						containerNetwork: agentDir ? readContainerNetwork(agentDir) : DEFAULT_CONTAINER_NETWORK,
					};
				},
			);
			resolvePromise({
				url: consoleUrl(),
				environment,
				close: () => {
					pocImports.close();
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
