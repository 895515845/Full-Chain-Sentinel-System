/**
 * The plugin host's HTTP API.
 *
 * One process, one port, one bearer token. It owns the Docker lifecycle, the
 * per-plugin secrets, the health checks, and the reverse proxy the console's MCP
 * client connects to. It has no user interface and no knowledge of projects: a
 * plugin is installed once per host and shared by every session.
 *
 * The console is the only intended client. That is why there is no CORS, no
 * cookie session, and no per-plugin token in this version: the host is a service
 * the operator runs for their own console, not a multi-tenant service.
 */

import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join, relative, resolve, sep } from "node:path";
import {
	PLUGIN_ID_PATTERN,
	parsePluginManifest,
	pluginConfigEnv,
	type SentinelPluginManifest,
	validatePluginConfig,
} from "../plugin-manifest.ts";
import type { DockerContext } from "./docker.ts";
import {
	ALLOWED_CAPS,
	containerHostPort,
	containerLogs,
	createContainer,
	dockerVersion,
	inspectContainer,
	probeHealth,
	pullPluginImage,
	removeContainer,
	renameContainer,
	runtimeState,
	startContainer,
	stopContainer,
	waitHealthy,
} from "./docker.ts";
import { proxyToPlugin } from "./proxy.ts";
import {
	configuredKeys,
	containerNameFor,
	deletePluginRecord,
	listPluginRecords,
	type PluginView,
	pluginArtifactsDir,
	pluginDataDir,
	readPluginConfigValues,
	readPluginRecord,
	type StoredPluginRecord,
	writePluginConfigValues,
	writePluginRecord,
} from "./store.ts";

export const PLUGIN_HOST_VERSION = 1;
export const MAX_PLUGINS = 32;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES = 500;

export interface PluginHostOptions {
	dataDir: string;
	token: string;
	/** `local` refuses `remote-only` plugins, `remote` refuses `local-only` ones. */
	mode: "local" | "remote";
	host?: string;
	port: number;
	/** PEM pair for HTTPS. Without it the host serves HTTP and must sit behind a proxy. */
	tls?: { cert: string; key: string };
	docker?: DockerContext;
	log?: (line: string) => void;
}

export interface RunningPluginHost {
	url: string;
	port: number;
	close(): Promise<void>;
}

class HttpError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(payload));
}

function tokenMatches(provided: string, expected: string): boolean {
	const left = Buffer.from(provided);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolveBody, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new HttpError(413, "请求体过大"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf-8").trim();
			if (!text) {
				resolveBody({});
				return;
			}
			try {
				resolveBody(JSON.parse(text));
			} catch {
				reject(new HttpError(400, "请求体不是合法 JSON"));
			}
		});
		request.on("error", () => reject(new HttpError(400, "读取请求体失败")));
	});
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Values as the container receives them: JSON scalars stringified, nulls dropped. */
function configValuesFromInput(
	input: Record<string, unknown>,
	manifest: SentinelPluginManifest,
): Record<string, string> {
	const values: Record<string, string> = {};
	for (const field of manifest.config) {
		const value = input[field.key];
		if (value === undefined || value === null || value === "") continue;
		if (typeof value === "boolean") values[field.key] = value ? "true" : "false";
		else if (typeof value === "number") values[field.key] = String(value);
		else if (typeof value === "string") values[field.key] = value;
	}
	return values;
}

/** A file under a plugin's artifacts directory, relative to it. */
interface ArtifactEntry {
	path: string;
	size: number;
}

function listArtifacts(root: string): ArtifactEntry[] {
	if (!existsSync(root)) return [];
	const entries: ArtifactEntry[] = [];
	const walk = (directory: string): void => {
		if (entries.length >= MAX_ARTIFACT_ENTRIES) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entries.length >= MAX_ARTIFACT_ENTRIES) return;
			if (entry.isSymbolicLink()) continue;
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			const info = statSync(full);
			entries.push({ path: relative(root, full).split(sep).join("/"), size: info.size });
		}
	};
	walk(root);
	return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/** Resolve a requested artifact path without allowing it to escape the plugin's directory. */
function resolveArtifact(root: string, requested: string): string | null {
	const base = resolve(root);
	const target = resolve(base, requested);
	if (target !== base && !target.startsWith(`${base}${sep}`)) return null;
	try {
		const realRoot = realpathSync(base);
		const realTarget = realpathSync(target);
		if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) return null;
		return realTarget;
	} catch {
		return null;
	}
}

export async function startPluginHost(options: PluginHostOptions): Promise<RunningPluginHost> {
	const docker: DockerContext = options.docker ?? {};
	const log = options.log ?? ((line: string) => console.error(`[plugin-host] ${line}`));

	function loadRecord(id: string): StoredPluginRecord {
		if (!PLUGIN_ID_PATTERN.test(id)) throw new HttpError(400, "插件 id 非法");
		const record = readPluginRecord(options.dataDir, id);
		if (!record) throw new HttpError(404, `未安装插件 ${id}`);
		return record;
	}

	async function viewOf(record: StoredPluginRecord): Promise<PluginView> {
		const state = await inspectContainer(docker, record.containerName);
		const port = record.hostPort ?? (await containerHostPort(docker, record.containerName, record.manifest.mcp.port));
		const health =
			state?.running === true
				? await probeHealth(port, record.manifest.healthcheck.path, record.manifest.healthcheck.timeoutMs)
				: { ok: false };
		const values = readPluginConfigValues(options.dataDir, record.manifest.id);
		const secretKeys = new Set(
			record.manifest.config.filter((field) => field.type === "secret").map((field) => field.key),
		);
		const exposed = Object.fromEntries(Object.entries(values).filter(([key]) => !secretKeys.has(key)));
		return {
			manifest: record.manifest,
			installedAt: record.installedAt,
			updatedAt: record.updatedAt,
			state: runtimeState(state, health.ok),
			healthy: health.ok,
			hostPort: port,
			allowHostNetwork: record.allowHostNetwork,
			configured: configuredKeys(record.manifest, values),
			values: exposed,
			lastError: record.lastError,
		};
	}

	/**
	 * Pull and start a candidate container under a temporary name, and only then
	 * replace the canonical one. A failed upgrade therefore leaves the working
	 * version running instead of deleting it before the new one is healthy.
	 */
	async function deploy(record: StoredPluginRecord, values: Record<string, string>): Promise<void> {
		const { manifest } = record;
		const imageError = await pullPluginImage(docker, manifest.image);
		if (imageError) throw new HttpError(502, imageError);
		const containerName = record.containerName;
		const candidateName = `${containerName}-next`;
		// A leftover candidate from an interrupted run must not block this one.
		await removeContainer(docker, candidateName);
		const candidate: StoredPluginRecord = { ...record, containerName: candidateName, hostPort: null };
		const created = await createContainer(docker, {
			manifest,
			record: candidate,
			dataDir: pluginDataDir(options.dataDir, manifest.id),
			artifactsDir: pluginArtifactsDir(options.dataDir, manifest.id),
			env: pluginConfigEnv(manifest.config, values),
		});
		if ("error" in created) {
			await removeContainer(docker, candidateName);
			throw new HttpError(502, created.error);
		}
		const started = await startContainer(docker, candidateName);
		if (started) {
			await removeContainer(docker, candidateName);
			throw new HttpError(502, started);
		}
		const health = await waitHealthy(docker, candidate, created.hostPort);
		if (!health.ok) {
			await removeContainer(docker, candidateName);
			throw new HttpError(502, health.error ?? "健康检查未通过");
		}
		await removeContainer(docker, containerName);
		const renamed = await renameContainer(docker, candidateName, containerName);
		if (renamed) throw new HttpError(502, renamed);
		record.hostPort = created.hostPort;
		record.updatedAt = Date.now();
		record.lastError = null;
	}

	function checkInstallPolicy(manifest: SentinelPluginManifest, body: Record<string, unknown>): void {
		if (manifest.permissions.network === "none") {
			// A plugin that cannot serve HTTP cannot serve MCP; accepting the install would only
			// produce a container nobody can reach.
			throw new HttpError(400, "network: none 的插件无法提供 MCP 端点");
		}
		if (options.mode === "local" && manifest.locality === "remote-only") {
			throw new HttpError(409, "该插件需要公网出口，只能装在远端 host 上");
		}
		if (options.mode === "remote" && manifest.locality === "local-only") {
			throw new HttpError(409, "该插件需要本地网络视角，只能装在本地 host 上");
		}
		for (const cap of manifest.permissions.capAdd) {
			if (!ALLOWED_CAPS.includes(cap)) throw new HttpError(400, `不允许的能力：${cap}`);
		}
		if (manifest.permissions.network === "host" && body.allowHostNetwork !== true) {
			throw new HttpError(403, "host 网络需要在安装时明确同意");
		}
		if (manifest.permissions.privileged && body.allowPrivileged !== true) {
			throw new HttpError(403, "privileged 需要在安装时明确同意");
		}
		const others = records().filter((record) => record.manifest.id !== manifest.id).length;
		if (others >= MAX_PLUGINS) throw new HttpError(409, `插件数量已达上限 ${MAX_PLUGINS}`);
	}

	function records(): StoredPluginRecord[] {
		return listPluginRecords(options.dataDir);
	}

	async function handleInstall(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = asRecord(await readJsonBody(request));
		const parsed = parsePluginManifest(body.manifest);
		if (!parsed.ok) throw new HttpError(400, parsed.errors.join("；"));
		const manifest = parsed.manifest;
		const existing = readPluginRecord(options.dataDir, manifest.id);
		checkInstallPolicy(manifest, body);
		const values = configValuesFromInput(asRecord(body.config), manifest);
		// Keep previously stored values the form did not resend (secrets are write-only),
		// then validate the merged set: an upgrade that changes nothing must not fail
		// because the operator cannot see the stored secret.
		if (existing) {
			const previous = readPluginConfigValues(options.dataDir, manifest.id);
			for (const [key, value] of Object.entries(previous)) {
				if (values[key] === undefined && manifest.config.some((field) => field.key === key)) {
					values[key] = value;
				}
			}
		}
		const failure = validatePluginConfig(manifest.config, values);
		if (failure) throw new HttpError(400, failure);

		const record: StoredPluginRecord = {
			manifest,
			installedAt: existing?.installedAt ?? Date.now(),
			updatedAt: Date.now(),
			allowHostNetwork: body.allowHostNetwork === true,
			containerName: containerNameFor(manifest.id),
			hostPort: null,
			lastError: null,
		};
		try {
			await deploy(record, values);
		} catch (error) {
			log(`install ${manifest.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
		// Persist only after the new container is healthy: a failed install leaves the
		// previous version's files (and container) untouched.
		writePluginRecord(options.dataDir, record);
		writePluginConfigValues(options.dataDir, manifest.id, values);
		log(`installed ${manifest.id}@${manifest.version}`);
		sendJson(response, 200, { plugin: await viewOf(record) });
	}

	async function handleConfig(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const id = url.pathname.split("/")[3] ?? "";
		const record = loadRecord(id);
		const body = asRecord(await readJsonBody(request));
		const incoming = asRecord(body.values);
		const previous = readPluginConfigValues(options.dataDir, id);
		const merged: Record<string, string> = { ...previous };
		for (const [key, value] of Object.entries(incoming)) {
			const field = record.manifest.config.find((entry) => entry.key === key);
			if (value === "" || value === null || value === undefined) {
				// A blank secret means "keep the stored one"; there is no way to read it back.
				if (field?.type === "secret") continue;
				delete merged[key];
				continue;
			}
			if (typeof value === "boolean") merged[key] = value ? "true" : "false";
			else if (typeof value === "number") merged[key] = String(value);
			else if (typeof value === "string") merged[key] = value;
		}
		const failure = validatePluginConfig(record.manifest.config, merged, {
			keepSecrets: new Set(
				Object.keys(previous).filter((key) =>
					record.manifest.config.some((f) => f.key === key && f.type === "secret"),
				),
			),
		});
		if (failure) throw new HttpError(400, failure);
		// Env is baked into the container, so a config change is a redeploy. The new
		// values are persisted only after it is healthy; a failure keeps both the old
		// container and the old config.
		await deploy(record, merged);
		writePluginConfigValues(options.dataDir, id, merged);
		writePluginRecord(options.dataDir, record);
		sendJson(response, 200, { plugin: await viewOf(record) });
	}

	async function handleLifecycle(
		request: IncomingMessage,
		response: ServerResponse,
		action: "start" | "stop",
	): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const id = url.pathname.split("/")[3] ?? "";
		const record = loadRecord(id);
		if (action === "stop") {
			const error = await stopContainer(docker, record.containerName);
			if (error) throw new HttpError(502, error);
			record.lastError = null;
			writePluginRecord(options.dataDir, record);
			sendJson(response, 200, { plugin: await viewOf(record) });
			return;
		}
		const error = await startContainer(docker, record.containerName);
		if (error) throw new HttpError(502, error);
		const port = await containerHostPort(docker, record.containerName, record.manifest.mcp.port);
		const health = await waitHealthy(docker, record, port);
		record.hostPort = port;
		record.lastError = health.ok ? null : (health.error ?? "健康检查未通过");
		writePluginRecord(options.dataDir, record);
		if (!health.ok) throw new HttpError(502, record.lastError ?? "启动失败");
		sendJson(response, 200, { plugin: await viewOf(record) });
	}

	async function handleUninstall(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const id = url.pathname.split("/")[3] ?? "";
		const record = loadRecord(id);
		await removeContainer(docker, record.containerName);
		deletePluginRecord(options.dataDir, id, url.searchParams.get("purge") === "1");
		log(`uninstalled ${id}`);
		sendJson(response, 200, { ok: true });
	}

	async function handleLogs(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const id = url.pathname.split("/")[3] ?? "";
		const record = loadRecord(id);
		const tail = Math.min(2000, Math.max(1, Number(url.searchParams.get("tail") ?? 200) || 200));
		sendJson(response, 200, { logs: await containerLogs(docker, record.containerName, tail) });
	}

	async function handleArtifacts(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const id = url.pathname.split("/")[3] ?? "";
		const record = loadRecord(id);
		const root = pluginArtifactsDir(options.dataDir, id);
		const requested = url.searchParams.get("path");
		if (!requested) {
			sendJson(response, 200, { artifacts: listArtifacts(root) });
			return;
		}
		const target = resolveArtifact(root, requested);
		if (!target) throw new HttpError(404, "产物不存在");
		const info = statSync(target);
		if (!info.isFile()) throw new HttpError(404, "产物不是文件");
		if (info.size > record.manifest.artifacts.maxFileBytes) {
			throw new HttpError(413, `产物超过 ${record.manifest.artifacts.maxFileBytes} 字节上限`);
		}
		response.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": String(info.size),
			"content-disposition": `attachment; filename="${encodeURIComponent(target.split(sep).pop() ?? "artifact")}"`,
		});
		createReadStream(target).pipe(response);
	}

	async function handleHostInfo(response: ServerResponse): Promise<void> {
		const dockerInfo = await dockerVersion(docker).catch((error: unknown) => ({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}));
		sendJson(response, 200, {
			ok: true,
			version: PLUGIN_HOST_VERSION,
			mode: options.mode,
			dataDir: options.dataDir,
			docker: dockerInfo,
			plugins: records().length,
		});
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		const path = url.pathname;

		if (path === "/healthz") {
			sendJson(response, 200, { ok: true });
			return;
		}

		const header = request.headers.authorization ?? "";
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		const provided = match?.[1] ?? "";
		if (!provided || !tokenMatches(provided, options.token)) {
			sendJson(response, 401, { error: "token 无效" });
			return;
		}

		if (path === "/v1/host" && request.method === "GET") {
			await handleHostInfo(response);
			return;
		}
		if (path === "/v1/plugins" && request.method === "GET") {
			const plugins = await Promise.all(records().map(viewOf));
			sendJson(response, 200, { plugins });
			return;
		}
		if (path === "/v1/plugins" && request.method === "POST") {
			await handleInstall(request, response);
			return;
		}

		// /v1/plugins/<id>/<action>
		const parts = path.split("/").filter(Boolean);
		if (parts[0] === "v1" && parts[1] === "plugins" && parts[2] && !parts[3] && request.method === "DELETE") {
			await handleUninstall(request, response);
			return;
		}
		if (parts[0] === "v1" && parts[1] === "plugins" && parts[2] && parts[3] && parts.length === 4) {
			if (parts[3] === "start" && request.method === "POST") {
				await handleLifecycle(request, response, "start");
				return;
			}
			if (parts[3] === "stop" && request.method === "POST") {
				await handleLifecycle(request, response, "stop");
				return;
			}
			if (parts[3] === "config" && request.method === "PUT") {
				await handleConfig(request, response);
				return;
			}
			if (parts[3] === "logs" && request.method === "GET") {
				await handleLogs(request, response);
				return;
			}
			if (parts[3] === "artifacts" && request.method === "GET") {
				await handleArtifacts(request, response);
				return;
			}
		}

		// The MCP endpoint. Only streamable HTTP is part of the plugin contract.
		if (parts[0] === "plugins" && parts[1] && parts[2] === "mcp" && parts.length === 3) {
			const id = parts[1];
			if (!PLUGIN_ID_PATTERN.test(id)) throw new HttpError(400, "插件 id 非法");
			const record = readPluginRecord(options.dataDir, id);
			if (!record) throw new HttpError(404, "未安装插件");
			const state = await inspectContainer(docker, record.containerName);
			if (!state?.running) throw new HttpError(503, "插件未运行");
			const port =
				record.hostPort ?? (await containerHostPort(docker, record.containerName, record.manifest.mcp.port));
			if (port === null) throw new HttpError(503, "插件没有可用的端口");
			proxyToPlugin({ request, response, port, path: record.manifest.mcp.path + url.search });
			return;
		}

		throw new HttpError(404, "没有这个接口");
	}

	const handler = (request: IncomingMessage, response: ServerResponse): void => {
		void handle(request, response).catch((error: unknown) => {
			const status = error instanceof HttpError ? error.status : 500;
			const message = error instanceof Error ? error.message : String(error);
			if (status >= 500) log(`${request.method ?? "?"} ${request.url ?? ""} failed: ${message}`);
			if (!response.headersSent) sendJson(response, status, { error: message });
			else response.end();
		});
	};
	const server: Server = options.tls
		? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handler)
		: createHttpServer(handler);

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(options.port, options.host ?? "127.0.0.1", () => {
			server.removeListener("error", rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;
	const host = options.host ?? "127.0.0.1";
	const scheme = options.tls ? "https" : "http";
	log(`listening on ${scheme}://${host}:${port} (${options.mode})`);

	return {
		url: `${scheme}://${host}:${port}`,
		port,
		close: () =>
			new Promise<void>((resolveClose, rejectClose) => {
				server.closeAllConnections();
				server.close((error) => (error ? rejectClose(error) : resolveClose()));
			}),
	};
}
