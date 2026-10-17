/**
 * The console's client for plugin hosts.
 *
 * Every call is a plain HTTPS request with the host's bearer token. There is no
 * SDK and no local mirror of the host's state: the host owns installation, this
 * layer only translates the operator's actions into requests and remembers the
 * one fact sessions need synchronously — which plugins were running.
 *
 * A host that does not answer is not an error that blocks the page. It is one
 * `problem` line while the other hosts remain usable, because a laptop's local
 * host and a VPS will often be up at different times.
 */

import { appendPluginAudit, type PluginAuditEntry } from "./plugin-audit.ts";
import type { PluginView as HostPluginView } from "./plugin-host/store.ts";
import type { SentinelPluginManifest } from "./plugin-manifest.ts";
import { pluginKey } from "./plugin-manifest.ts";
import {
	effectivePluginHosts,
	forgetPluginState,
	hostIdFor,
	type PluginHostRecord,
	type PluginHostStatus,
	readPluginState,
	recordPluginHostStatus,
	rememberPluginStates,
	removePluginHost,
	savePluginHost,
	setPluginEnabled as setStoredPluginEnabled,
} from "./plugin-store.ts";

const DEFAULT_TIMEOUT_MS = 20000;
/** Starting a container and waiting for health can legitimately take minutes. */
const LONG_TIMEOUT_MS = 900000;
/** Building the image from the uploaded package is slower than any other call. */
const INSTALL_TIMEOUT_MS = 1800000;

export class PluginServiceError extends Error {
	status: number;

	constructor(message: string, status = 0) {
		super(message);
		this.status = status;
	}
}

export interface PluginHostView {
	id: string;
	name: string;
	url: string;
	local: boolean;
	status: PluginHostStatus;
}

export interface PluginView {
	hostId: string;
	hostName: string;
	hostLocal: boolean;
	manifest: SentinelPluginManifest;
	state: HostPluginView["state"];
	healthy: boolean;
	enabled: boolean;
	configured: string[];
	/** Non-secret values, so the edit form can show what is stored. */
	values: Record<string, string>;
	hostPort: number | null;
	installedAt: number;
	lastError: string | null;
}

export interface PluginListView {
	hosts: PluginHostView[];
	plugins: PluginView[];
	problems: string[];
}

export interface PluginHostInput {
	id?: string;
	name: string;
	url: string;
	token: string;
}

function isLoopbackUrl(url: URL): boolean {
	return (
		url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]"
	);
}

/** Only loopback may be plain HTTP: the token would otherwise cross the network in the clear. */
export function validatePluginHostInput(input: PluginHostInput): string | undefined {
	const url = input.url.trim();
	if (!url) return "请填写 host 地址";
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "host 地址必须是完整 URL，例如 http://127.0.0.1:7800";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "只支持 http 和 https";
	if (parsed.protocol === "http:" && !isLoopbackUrl(parsed)) {
		return "非回环地址必须用 HTTPS：token 走明文 HTTP 等于公开";
	}
	if (parsed.username || parsed.password) return "地址里不要带用户名密码，token 单独填";
	if (!input.token.trim()) return "请填写 host token（plugin-host 启动时打印）";
	if (!input.name.trim()) return "请填写名称";
	return undefined;
}

async function hostFetch(
	host: PluginHostRecord,
	path: string,
	init: RequestInit = {},
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
	const url = `${host.url}${path}`;
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			headers: {
				...(init.headers ?? {}),
				authorization: `Bearer ${host.token}`,
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new PluginServiceError(`连接 ${host.name || host.url} 失败：${message}`);
	}
	return response;
}

async function hostJson<T>(
	host: PluginHostRecord,
	path: string,
	init: RequestInit = {},
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
	const response = await hostFetch(host, path, init, timeoutMs);
	const text = await response.text();
	let payload: unknown = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = null;
	}
	if (!response.ok) {
		const message =
			payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
				? (payload as { error: string }).error
				: `HTTP ${response.status}`;
		throw new PluginServiceError(message, response.status);
	}
	return payload as T;
}

function findHost(agentDir: string, hostId: string): PluginHostRecord {
	const host = effectivePluginHosts(agentDir).find((entry) => entry.id === hostId);
	if (!host) throw new PluginServiceError(`未找到插件主机 ${hostId}`, 404);
	return host;
}

function toHostView(host: PluginHostRecord): PluginHostView {
	return { id: host.id, name: host.name, url: host.url, local: host.local, status: host.status };
}

function knownEnabled(agentDir: string, hostId: string, pluginId: string): boolean {
	const state = readPluginState(agentDir);
	return !state.disabled.includes(pluginKey(hostId, pluginId));
}

function toPluginView(agentDir: string, host: PluginHostRecord, plugin: HostPluginView): PluginView {
	return {
		hostId: host.id,
		hostName: host.name,
		hostLocal: host.local,
		manifest: plugin.manifest,
		state: plugin.state,
		healthy: plugin.healthy,
		enabled: knownEnabled(agentDir, host.id, plugin.manifest.id),
		configured: plugin.configured,
		values: plugin.values,
		hostPort: plugin.hostPort,
		installedAt: plugin.installedAt,
		lastError: plugin.lastError,
	};
}

/**
 * Ask every host what it has. A host that fails contributes a problem line and
 * keeps its last known plugin states, so a rebooted VPS does not silently remove
 * tools from the next session.
 */
export async function listPlugins(agentDir: string): Promise<PluginListView> {
	const hosts = effectivePluginHosts(agentDir);
	const problems: string[] = [];
	const plugins: PluginView[] = [];
	const known: Array<{ hostId: string; pluginId: string; state: string; timeoutSeconds: number }> = [];
	for (const host of hosts) {
		try {
			const payload = await hostJson<{ plugins: HostPluginView[] }>(host, "/v1/plugins");
			for (const plugin of payload.plugins) {
				plugins.push(toPluginView(agentDir, host, plugin));
				known.push({
					hostId: host.id,
					pluginId: plugin.manifest.id,
					state: plugin.state,
					timeoutSeconds: Math.ceil(plugin.manifest.mcp.requestTimeoutMs / 1000),
				});
			}
			recordPluginHostStatus(agentDir, host.id, host.local, { at: Date.now(), ok: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			problems.push(`${host.name || host.url}：${message}`);
			recordPluginHostStatus(agentDir, host.id, host.local, { at: Date.now(), ok: false, error: message });
		}
	}
	if (known.length > 0) rememberPluginStates(agentDir, known);
	return { hosts: hosts.map(toHostView), plugins, problems };
}

/** Probe one host and persist the result, so the page shows the truth after a reload. */
export async function testPluginHost(agentDir: string, hostId: string): Promise<PluginHostStatus> {
	const host = findHost(agentDir, hostId);
	const at = Date.now();
	let status: PluginHostStatus;
	try {
		const info = await hostJson<{
			version: string;
			mode: "local" | "remote";
			docker: { ok: boolean; version?: string; error?: string };
		}>(host, "/v1/host");
		status = { at, ok: true, version: info.version, mode: info.mode, docker: info.docker };
	} catch (error) {
		status = { at, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	recordPluginHostStatus(agentDir, host.id, host.local, status);
	return status;
}

export function saveHost(agentDir: string, input: PluginHostInput): PluginHostView {
	const url = input.url.trim().replace(/\/+$/, "");
	const previous = readPluginState(agentDir).hosts.find((host) => host.id === (input.id ?? hostIdFor(url)));
	// Editing without retyping the token keeps the stored one; the token is never sent to the page.
	const token = input.token.trim() || previous?.token || "";
	const failure = validatePluginHostInput({ ...input, token });
	if (failure) throw new PluginServiceError(failure, 400);
	const record: PluginHostRecord = {
		id: input.id ?? hostIdFor(url),
		name: input.name.trim(),
		url,
		token,
		local: false,
		addedAt: previous?.addedAt ?? Date.now(),
		status: previous?.status ?? { at: null, ok: true },
	};
	savePluginHost(agentDir, record);
	appendPluginAudit(agentDir, { action: "host-add", hostId: record.id, ok: true, detail: { url: record.url } });
	return toHostView(record);
}

export function deleteHost(agentDir: string, hostId: string): void {
	try {
		removePluginHost(agentDir, hostId);
		appendPluginAudit(agentDir, { action: "host-remove", hostId, ok: true });
	} catch (error) {
		appendPluginAudit(agentDir, {
			action: "host-remove",
			hostId,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export interface InstallPluginInput {
	hostId: string;
	manifest: SentinelPluginManifest;
	/** The uploaded zip, base64; the host extracts and builds it. */
	package: string;
	allowBuild: boolean;
	allowHostNetwork: boolean;
	allowPrivileged: boolean;
	config: Record<string, string>;
}

/** Run one operation and record it, whether it succeeded or not. */
async function audited<T>(
	agentDir: string,
	entry: Omit<PluginAuditEntry, "at" | "ok">,
	run: () => Promise<T>,
): Promise<T> {
	try {
		const result = await run();
		appendPluginAudit(agentDir, { ...entry, ok: true });
		return result;
	} catch (error) {
		appendPluginAudit(agentDir, {
			...entry,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export async function installPlugin(agentDir: string, input: InstallPluginInput): Promise<PluginView> {
	const host = findHost(agentDir, input.hostId);
	const payload = await audited(
		agentDir,
		{
			action: "install",
			hostId: host.id,
			pluginId: input.manifest.id,
			version: input.manifest.version,
			// Never the config values: they may hold secrets.
			detail: {
				network: input.manifest.permissions.network,
				allowBuild: input.allowBuild,
				allowHostNetwork: input.allowHostNetwork,
				allowPrivileged: input.allowPrivileged,
				configKeys: Object.keys(input.config),
			},
		},
		() =>
			hostJson<{ plugin: HostPluginView }>(
				host,
				"/v1/plugins",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						manifest: input.manifest,
						package: input.package,
						allowBuild: input.allowBuild,
						allowHostNetwork: input.allowHostNetwork,
						allowPrivileged: input.allowPrivileged,
						config: input.config,
					}),
				},
				INSTALL_TIMEOUT_MS,
			),
	);
	rememberPluginStates(agentDir, [
		{
			hostId: host.id,
			pluginId: payload.plugin.manifest.id,
			state: payload.plugin.state,
			timeoutSeconds: Math.ceil(payload.plugin.manifest.mcp.requestTimeoutMs / 1000),
		},
	]);
	return toPluginView(agentDir, host, payload.plugin);
}

/** Update config values and redeploy. Env is fixed at create time, so this recreates the container. */
export async function updatePluginConfig(
	agentDir: string,
	hostId: string,
	pluginId: string,
	values: Record<string, string>,
): Promise<PluginView> {
	const host = findHost(agentDir, hostId);
	const payload = await audited(
		agentDir,
		{ action: "config", hostId, pluginId, detail: { keys: Object.keys(values) } },
		() =>
			hostJson<{ plugin: HostPluginView }>(
				host,
				`/v1/plugins/${encodeURIComponent(pluginId)}/config`,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ values }),
				},
				LONG_TIMEOUT_MS,
			),
	);
	rememberPluginStates(agentDir, [
		{
			hostId,
			pluginId,
			state: payload.plugin.state,
			timeoutSeconds: Math.ceil(payload.plugin.manifest.mcp.requestTimeoutMs / 1000),
		},
	]);
	return toPluginView(agentDir, host, payload.plugin);
}

export async function uninstallPlugin(
	agentDir: string,
	hostId: string,
	pluginId: string,
	purge: boolean,
): Promise<void> {
	const host = findHost(agentDir, hostId);
	await audited(agentDir, { action: "uninstall", hostId, pluginId, detail: { purge } }, () =>
		hostJson(host, `/v1/plugins/${encodeURIComponent(pluginId)}${purge ? "?purge=1" : ""}`, {
			method: "DELETE",
		}),
	);
	forgetPluginState(agentDir, hostId, pluginId);
}

async function lifecycle(
	agentDir: string,
	hostId: string,
	pluginId: string,
	action: "start" | "stop",
): Promise<PluginView> {
	const host = findHost(agentDir, hostId);
	const payload = await audited(agentDir, { action, hostId, pluginId }, () =>
		hostJson<{ plugin: HostPluginView }>(
			host,
			`/v1/plugins/${encodeURIComponent(pluginId)}/${action}`,
			{ method: "POST" },
			LONG_TIMEOUT_MS,
		),
	);
	rememberPluginStates(agentDir, [
		{
			hostId,
			pluginId,
			state: payload.plugin.state,
			timeoutSeconds: Math.ceil(payload.plugin.manifest.mcp.requestTimeoutMs / 1000),
		},
	]);
	return toPluginView(agentDir, host, payload.plugin);
}

export function startPlugin(agentDir: string, hostId: string, pluginId: string): Promise<PluginView> {
	return lifecycle(agentDir, hostId, pluginId, "start");
}

export function stopPlugin(agentDir: string, hostId: string, pluginId: string): Promise<PluginView> {
	return lifecycle(agentDir, hostId, pluginId, "stop");
}

/** The console-side switch. It only stops mounting tools; the container keeps running. */
export function setPluginEnabled(agentDir: string, hostId: string, pluginId: string, enabled: boolean): void {
	try {
		setStoredPluginEnabled(agentDir, hostId, pluginId, enabled);
		appendPluginAudit(agentDir, { action: enabled ? "enable" : "disable", hostId, pluginId, ok: true });
	} catch (error) {
		appendPluginAudit(agentDir, {
			action: enabled ? "enable" : "disable",
			hostId,
			pluginId,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export async function pluginLogs(agentDir: string, hostId: string, pluginId: string, tail = 200): Promise<string> {
	const host = findHost(agentDir, hostId);
	const payload = await hostJson<{ logs: string }>(
		host,
		`/v1/plugins/${encodeURIComponent(pluginId)}/logs?tail=${tail}`,
	);
	return payload.logs;
}

export interface PluginArtifact {
	path: string;
	size: number;
}

export interface PluginToolResult {
	content: unknown[];
	isError: boolean;
	meta: unknown;
}

/** Call one of the plugin's own tools on behalf of its frontend. */
export async function callPluginTool(
	agentDir: string,
	hostId: string,
	pluginId: string,
	name: string,
	args: Record<string, unknown>,
): Promise<PluginToolResult> {
	if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new PluginServiceError("工具名非法", 400);
	const host = findHost(agentDir, hostId);
	return audited(
		agentDir,
		{ action: "ui-tool", hostId, pluginId, detail: { tool: name, argKeys: Object.keys(args) } },
		() =>
			hostJson<PluginToolResult>(
				host,
				`/v1/plugins/${encodeURIComponent(pluginId)}/call`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name, arguments: args }),
				},
				LONG_TIMEOUT_MS,
			),
	);
}

/** Non-secret config values of one installed plugin, for its own frontend. */
export async function getPluginValues(
	agentDir: string,
	hostId: string,
	pluginId: string,
): Promise<Record<string, string>> {
	const host = findHost(agentDir, hostId);
	const payload = await hostJson<{ plugins: HostPluginView[] }>(host, "/v1/plugins");
	const plugin = payload.plugins.find((entry) => entry.manifest.id === pluginId);
	if (!plugin) throw new PluginServiceError(`未找到插件 ${pluginId}`, 404);
	return plugin.values;
}

export async function getPluginUiStorage(
	agentDir: string,
	hostId: string,
	pluginId: string,
	key: string,
): Promise<string | null> {
	const host = findHost(agentDir, hostId);
	const payload = await hostJson<{ value: string | null }>(
		host,
		`/v1/plugins/${encodeURIComponent(pluginId)}/storage?key=${encodeURIComponent(key)}`,
	);
	return payload.value;
}

export async function setPluginUiStorage(
	agentDir: string,
	hostId: string,
	pluginId: string,
	key: string,
	value: string,
): Promise<void> {
	const host = findHost(agentDir, hostId);
	await audited(agentDir, { action: "ui-storage", hostId, pluginId, detail: { key } }, () =>
		hostJson(host, `/v1/plugins/${encodeURIComponent(pluginId)}/storage`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key, value }),
		}),
	);
}

export async function deletePluginUiStorage(
	agentDir: string,
	hostId: string,
	pluginId: string,
	key: string,
): Promise<void> {
	const host = findHost(agentDir, hostId);
	await audited(agentDir, { action: "ui-storage", hostId, pluginId, detail: { key } }, () =>
		hostJson(host, `/v1/plugins/${encodeURIComponent(pluginId)}/storage?key=${encodeURIComponent(key)}`, {
			method: "DELETE",
		}),
	);
}

export async function listPluginArtifacts(
	agentDir: string,
	hostId: string,
	pluginId: string,
): Promise<PluginArtifact[]> {
	const host = findHost(agentDir, hostId);
	const payload = await hostJson<{ artifacts: PluginArtifact[] }>(
		host,
		`/v1/plugins/${encodeURIComponent(pluginId)}/artifacts`,
	);
	return payload.artifacts;
}

export async function downloadPluginArtifact(
	agentDir: string,
	hostId: string,
	pluginId: string,
	path: string,
): Promise<Buffer> {
	const host = findHost(agentDir, hostId);
	const data = await audited(agentDir, { action: "artifact", hostId, pluginId, detail: { path } }, async () => {
		const response = await hostFetch(
			host,
			`/v1/plugins/${encodeURIComponent(pluginId)}/artifacts?path=${encodeURIComponent(path)}`,
		);
		if (!response.ok) throw new PluginServiceError(`下载产物失败：HTTP ${response.status}`, response.status);
		return Buffer.from(await response.arrayBuffer());
	});
	return data;
}
