/**
 * Console-side plugin state: which hosts exist, which plugins the operator
 * turned off, and the last state each plugin was seen in.
 *
 * The host is the source of truth for what is installed. This file is the
 * console's side: it holds the bearer tokens (0600, like `mcp-servers.json`), the
 * switch state, and a small cache of the last known runtime state.
 *
 * The cache is not an optimization. Session creation needs the list of MCP
 * servers synchronously, and a session must not wait on a VPS to come back
 * before the model can be asked a question. A plugin whose host is unreachable
 * at that moment keeps its last state; the MCP client then reports the failed
 * connection in the normal way.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pluginKey, pluginServerName } from "./plugin-manifest.ts";

export const PLUGIN_STATE_VERSION = 1;

export interface PluginHostStatus {
	at: number | null;
	ok: boolean;
	error?: string;
	version?: string;
	mode?: "local" | "remote";
	/** The host's Docker daemon, when it answered. */
	docker?: { ok: boolean; version?: string; error?: string };
}

export interface PluginHostRecord {
	id: string;
	name: string;
	url: string;
	token: string;
	/** A host discovered from this machine's `plugin-host` state file. */
	local: boolean;
	addedAt: number;
	status: PluginHostStatus;
}

/** One plugin as the session mount cache remembers it. */
export interface PluginMountState {
	serverName: string;
	state: string;
	/** Per-request budget, already converted to the MCP client's seconds. */
	timeoutSeconds: number;
	at: number;
}

export interface PluginStateFile {
	version: number;
	/** Optional static index the operator subscribed to. */
	indexUrl: string;
	hosts: PluginHostRecord[];
	/** Plugin keys the operator switched off; absent means enabled. */
	disabled: string[];
	/** Plugin keys the operator explicitly hid from the sidebar, as `${hostId}/${pluginId}`. */
	sidebarHidden: string[];
	/** Last runtime state per plugin key, for synchronous session mounts. */
	lastKnown: Record<string, PluginMountState>;
	/** Status of the discovered local host; it has no saved record to hold one. */
	localStatus: PluginHostStatus;
}

export function pluginStatePath(agentDir: string): string {
	return join(agentDir, "plugins.json");
}

/** Where a local `plugin-host --local` writes its port and token. */
export function localPluginHostDir(): string {
	return process.env.SENTINEL_PLUGIN_HOST_DIR?.trim() || join(homedir(), ".sentinel", "plugin-host");
}

export function emptyPluginState(): PluginStateFile {
	return {
		version: PLUGIN_STATE_VERSION,
		indexUrl: "",
		hosts: [],
		disabled: [],
		sidebarHidden: [],
		lastKnown: {},
		localStatus: { at: null, ok: true },
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asStatus(value: unknown): PluginHostStatus {
	const raw = asRecord(value);
	const status: PluginHostStatus = {
		at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : null,
		ok: raw.ok !== false,
	};
	if (typeof raw.error === "string" && raw.error) status.error = raw.error;
	if (typeof raw.version === "string" && raw.version) status.version = raw.version;
	if (raw.mode === "local" || raw.mode === "remote") status.mode = raw.mode;
	const docker = asRecord(raw.docker);
	if (Object.keys(docker).length > 0) {
		status.docker = {
			ok: docker.ok === true,
			...(typeof docker.version === "string" ? { version: docker.version } : {}),
			...(typeof docker.error === "string" ? { error: docker.error } : {}),
		};
	}
	return status;
}

/** A host record, complete enough to dial. A record without a URL or token is dropped. */
export function normalizePluginHost(raw: unknown): PluginHostRecord | null {
	const value = asRecord(raw);
	const url = asText(value.url).replace(/\/+$/, "");
	const token = asText(value.token);
	if (!url || !token) return null;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	const local = value.local === true;
	return {
		id: asText(value.id) || hostIdFor(url),
		name: asText(value.name) || parsed.hostname,
		url,
		token,
		local,
		addedAt: typeof value.addedAt === "number" ? value.addedAt : Date.now(),
		status: asStatus(value.status),
	};
}

/** Stable id from the URL, so re-adding the same host edits it instead of duplicating it. */
export function hostIdFor(url: string): string {
	let hash = 0;
	for (let index = 0; index < url.length; index += 1) hash = (hash * 31 + url.charCodeAt(index)) >>> 0;
	return `host-${hash.toString(36)}`;
}

export function normalizePluginState(raw: unknown): PluginStateFile {
	const value = asRecord(raw);
	const hosts: PluginHostRecord[] = [];
	const seen = new Set<string>();
	for (const entry of Array.isArray(value.hosts) ? value.hosts : []) {
		const host = normalizePluginHost(entry);
		if (!host || seen.has(host.id)) continue;
		seen.add(host.id);
		hosts.push(host);
	}
	const lastKnown: Record<string, PluginMountState> = {};
	const rawKnown = asRecord(value.lastKnown);
	for (const [key, entry] of Object.entries(rawKnown)) {
		const known = asRecord(entry);
		const serverName = asText(known.serverName);
		const state = asText(known.state);
		if (!serverName || !state) continue;
		lastKnown[key] = {
			serverName,
			state,
			timeoutSeconds:
				typeof known.timeoutSeconds === "number" && known.timeoutSeconds > 0
					? Math.min(3600, Math.round(known.timeoutSeconds))
					: 300,
			at: typeof known.at === "number" ? known.at : 0,
		};
	}
	return {
		version: PLUGIN_STATE_VERSION,
		indexUrl: asText(value.indexUrl),
		hosts,
		disabled: Array.isArray(value.disabled)
			? value.disabled.filter((entry): entry is string => typeof entry === "string")
			: [],
		sidebarHidden: Array.isArray(value.sidebarHidden)
			? [...new Set(value.sidebarHidden.filter((entry): entry is string => typeof entry === "string"))]
			: [],
		lastKnown,
		localStatus: asStatus(value.localStatus),
	};
}

export function readPluginState(agentDir: string): PluginStateFile {
	const path = pluginStatePath(agentDir);
	if (!existsSync(path)) return emptyPluginState();
	try {
		return normalizePluginState(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return emptyPluginState();
	}
}

/**
 * The same read, for the paths that write the file back. A file that exists but
 * cannot be parsed still holds the operator's tokens; rewriting it from the
 * lenient empty read would delete them. Callers refuse the write instead.
 */
function readPluginStateForUpdate(agentDir: string): PluginStateFile | null {
	const path = pluginStatePath(agentDir);
	if (!existsSync(path)) return emptyPluginState();
	try {
		return normalizePluginState(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return null;
	}
}

function stateForWrite(agentDir: string): PluginStateFile {
	const state = readPluginStateForUpdate(agentDir);
	if (!state) throw new Error(`${pluginStatePath(agentDir)} 无法解析，请先修复或删除该文件`);
	return state;
}

export function writePluginState(agentDir: string, state: PluginStateFile): void {
	const path = pluginStatePath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalizePluginState(state), null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// best effort
	}
}

interface LocalHostState {
	port: number;
	token: string;
}

/** The state file of a `plugin-host --local` started on this machine, if any. */
export function readLocalPluginHost(): LocalHostState | null {
	const path = join(localPluginHostDir(), "host.json");
	if (!existsSync(path)) return null;
	try {
		const raw = asRecord(JSON.parse(readFileSync(path, "utf-8")));
		const port = raw.port;
		const token = asText(raw.token);
		if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || !token) return null;
		return { port, token };
	} catch {
		return null;
	}
}

/**
 * The hosts to dial: the operator's saved hosts, plus a local host that appeared
 * on this machine. The local entry is not persisted, so moving the console to a
 * new machine rediscovers it rather than carrying a dead URL.
 */
export function effectivePluginHosts(agentDir: string): PluginHostRecord[] {
	const state = readPluginState(agentDir);
	const hosts = [...state.hosts];
	const local = readLocalPluginHost();
	if (local) {
		const url = `http://127.0.0.1:${local.port}`;
		const id = hostIdFor(url);
		const index = hosts.findIndex((host) => host.id === id || host.url === url);
		const record: PluginHostRecord = {
			id: index >= 0 ? hosts[index].id : id,
			name: "本机插件主机",
			url,
			token: local.token,
			local: true,
			addedAt: index >= 0 ? hosts[index].addedAt : Date.now(),
			status: state.localStatus,
		};
		if (index >= 0) hosts[index] = record;
		else hosts.unshift(record);
	}
	return hosts;
}

/** Remember the outcome of the last dial, so the page is truthful before 测试连接 is pressed. */
export function recordPluginHostStatus(agentDir: string, id: string, local: boolean, status: PluginHostStatus): void {
	// A local host has no saved record; its status is a separate field. A corrupt
	// file must not make a status line fatal, so both paths are best effort.
	const state = readPluginStateForUpdate(agentDir);
	if (!state) return;
	if (local) {
		state.localStatus = status;
		writePluginState(agentDir, state);
		return;
	}
	const host = state.hosts.find((entry) => entry.id === id);
	if (!host) return;
	host.status = status;
	writePluginState(agentDir, state);
}

/** Save one host. A record whose id already exists is replaced, keeping its status if none is given. */
export function savePluginHost(agentDir: string, host: PluginHostRecord): PluginStateFile {
	const state = stateForWrite(agentDir);
	const index = state.hosts.findIndex((entry) => entry.id === host.id);
	if (index >= 0) state.hosts[index] = host;
	else state.hosts.push(host);
	writePluginState(agentDir, state);
	return state;
}

export function removePluginHost(agentDir: string, id: string): PluginStateFile {
	const state = stateForWrite(agentDir);
	state.hosts = state.hosts.filter((host) => host.id !== id);
	// Drop the cached state of that host's plugins too; nothing will ever refresh it.
	for (const key of Object.keys(state.lastKnown)) {
		if (key.startsWith(`${id}/`)) delete state.lastKnown[key];
	}
	writePluginState(agentDir, state);
	return state;
}

export function setPluginEnabled(
	agentDir: string,
	hostId: string,
	pluginId: string,
	enabled: boolean,
): PluginStateFile {
	const state = readPluginState(agentDir);
	const key = pluginKey(hostId, pluginId);
	const disabled = new Set(state.disabled);
	if (enabled) disabled.delete(key);
	else disabled.add(key);
	state.disabled = [...disabled].sort();
	writePluginState(agentDir, state);
	return state;
}

/** `ui.sidebar` defaults to visible; only an explicit hide is stored. */
export function pluginSidebarHidden(agentDir: string, hostId: string, pluginId: string): boolean {
	return readPluginState(agentDir).sidebarHidden.includes(pluginKey(hostId, pluginId));
}

export function setPluginSidebarHidden(
	agentDir: string,
	hostId: string,
	pluginId: string,
	hidden: boolean,
): PluginStateFile {
	const state = readPluginState(agentDir);
	const key = pluginKey(hostId, pluginId);
	const hiddenKeys = new Set(state.sidebarHidden);
	if (hidden) hiddenKeys.add(key);
	else hiddenKeys.delete(key);
	state.sidebarHidden = [...hiddenKeys].sort();
	writePluginState(agentDir, state);
	return state;
}

export function rememberPluginStates(
	agentDir: string,
	entries: Array<{ hostId: string; pluginId: string; state: string; timeoutSeconds?: number }>,
): void {
	// A cache update is never worth refusing a page load: a corrupt file is left
	// for the write paths above to report.
	const state = readPluginStateForUpdate(agentDir);
	if (!state) return;
	const now = Date.now();
	for (const entry of entries) {
		state.lastKnown[pluginKey(entry.hostId, entry.pluginId)] = {
			serverName: pluginServerName(entry.pluginId),
			state: entry.state,
			timeoutSeconds:
				typeof entry.timeoutSeconds === "number" && entry.timeoutSeconds > 0
					? Math.min(3600, Math.round(entry.timeoutSeconds))
					: 300,
			at: now,
		};
	}
	writePluginState(agentDir, state);
}

/** Drop one plugin's cached runtime state, e.g. after uninstalling it. */
export function forgetPluginState(agentDir: string, hostId: string, pluginId: string): void {
	const state = stateForWrite(agentDir);
	delete state.lastKnown[pluginKey(hostId, pluginId)];
	writePluginState(agentDir, state);
}

export interface PluginMountEntry {
	/** `${hostId}/${pluginId}`, the key 设置 → 权限 uses for its per-plugin switches. */
	key: string;
	serverName: string;
	url: string;
	token: string;
	/** The MCP client's per-request timeout, in seconds. */
	timeoutSeconds: number;
}

/**
 * The plugin MCP servers a session may connect, synchronously.
 *
 * A plugin is mounted only when the operator did not switch it off and its last
 * known state was running or starting. An unreachable host therefore removes
 * nothing from the session that was working; it only means a stopped plugin
 * stops offering tools until it is started again.
 */
export function pluginMountEntries(agentDir: string): PluginMountEntry[] {
	const state = readPluginState(agentDir);
	const disabled = new Set(state.disabled);
	const hosts = effectivePluginHosts(agentDir);
	const entries: PluginMountEntry[] = [];
	const used = new Set<string>();
	for (const host of hosts) {
		for (const [key, known] of Object.entries(state.lastKnown)) {
			const separator = key.indexOf("/");
			if (separator <= 0) continue;
			if (key.slice(0, separator) !== host.id) continue;
			const pluginId = key.slice(separator + 1);
			if (disabled.has(key)) continue;
			if (known.state !== "running" && known.state !== "starting") continue;
			if (used.has(known.serverName)) continue;
			used.add(known.serverName);
			entries.push({
				key,
				serverName: known.serverName,
				url: `${host.url}/plugins/${pluginId}/mcp`,
				token: host.token,
				timeoutSeconds: known.timeoutSeconds,
			});
		}
	}
	return entries;
}
