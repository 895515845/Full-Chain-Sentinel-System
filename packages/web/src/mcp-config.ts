/**
 * Custom MCP servers, stored in `mcp-servers.json`.
 *
 * The operator configures these from 设置 → MCP. A session does not read pi's own
 * `mcp.json`: `sentinel-session.ts` hands `createMcpExtension` a `loadConfig` that
 * returns this file's entries, so this console owns the whole list and a stale
 * hand-written file cannot quietly add a server the operator cannot see.
 *
 * The file is written 0600 because `env` and `headers` hold tokens, the same way
 * `assets.json` and `models.json` are.
 *
 * The important consequence of MCP is that a **stdio** server runs its command on
 * the console host: not in the project's Kali container, not through the bash
 * approval gate, and not through the gatekeeper model. It is the one place where
 * the console's container isolation does not hold, so an stdio entry is only
 * stored with `hostExecAcknowledged`, and only mounted with it. HTTP servers are
 * plain outbound requests and need no such flag.
 *
 * A missing or corrupt file reads as "nothing configured": an unusable entry must
 * never leave the console claiming a capability it does not have.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type LoadedMcpConfig,
	type McpExposure,
	type McpServerConfig,
	type McpServerEntry,
	mcpNamespace,
	validateMcpServerConfig,
} from "@earendil-works/pi-coding-agent";
import { t } from "./i18n.ts";
import { readPermissionsConfig } from "./permissions.ts";
import { pluginMountEntries, pluginStatePath } from "./plugin-store.ts";
import type {
	SentinelMcpConfigView,
	SentinelMcpExposure,
	SentinelMcpServerInput,
	SentinelMcpServerView,
	SentinelMcpStatus,
	SentinelMcpTransport,
} from "./protocol.ts";

/** One server as stored. The view adds `target`, which is derived from these fields. */
export type SentinelMcpServerRecord = Omit<SentinelMcpServerView, "target">;

/** Bumped only if the on-disk shape changes in a way a reader must migrate. */
export const MCP_SERVERS_VERSION = 1;

/** Exposures the page offers, in the order it lists them. */
export const MCP_EXPOSURES: readonly SentinelMcpExposure[] = ["codemode", "deferred", "direct", "hidden"];

/** Default exposure, matching the MCP extension: tools stay out of the model's tool list. */
export const DEFAULT_MCP_EXPOSURE: SentinelMcpExposure = "codemode";

/** Bounds of the per-request timeout, in seconds; null means the extension's own default. */
export const MIN_MCP_TIMEOUT_SECONDS = 1;
export const MAX_MCP_TIMEOUT_SECONDS = 3600;

export function mcpServersJsonPath(agentDir: string): string {
	return join(agentDir, "mcp-servers.json");
}

function emptyStatus(): SentinelMcpStatus {
	return { at: null, ok: true };
}

export function emptyMcpServer(name: string): SentinelMcpServerRecord {
	return {
		name,
		enabled: true,
		transport: "stdio",
		command: "",
		args: [],
		env: {},
		cwd: "",
		url: "",
		headers: {},
		description: "",
		exposure: DEFAULT_MCP_EXPOSURE,
		timeout: null,
		hostExecAcknowledged: false,
		status: emptyStatus(),
	};
}

function asText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the transport. `transport` is this store's field and `type` is pi's, so a
 * hand-written entry keeps its meaning either way.
 *
 * `streamable-http` is pi's alias for `http`. An explicit `sse` stays `sse` rather
 * than folding into `http`: they are two different protocols, and reading one as
 * the other would turn a working entry into a confusing failure against `/sse`.
 */
function asTransport(value: unknown, hasUrl: boolean): SentinelMcpTransport {
	if (value === "stdio") return "stdio";
	if (value === "http" || value === "streamable-http") return "http";
	if (value === "sse") return "sse";
	return hasUrl ? "http" : "stdio";
}

function asExposure(value: unknown): SentinelMcpExposure {
	return MCP_EXPOSURES.includes(value as SentinelMcpExposure) ? (value as SentinelMcpExposure) : DEFAULT_MCP_EXPOSURE;
}

/** A stored timeout, clamped into its usable range; anything else reads as "not set". */
function asTimeout(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const seconds = Math.round(value);
	if (seconds < MIN_MCP_TIMEOUT_SECONDS) return MIN_MCP_TIMEOUT_SECONDS;
	return Math.min(seconds, MAX_MCP_TIMEOUT_SECONDS);
}

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim());
}

/** A key-value block from disk: non-string values are dropped rather than stringified. */
function asStringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => typeof entry === "string")
		.map(([key, entry]) => [key.trim(), entry as string] as const)
		.filter(([key]) => key.length > 0);
	return Object.fromEntries(entries);
}

/** A status blob from disk; a bad timestamp reads as "never connected" rather than "Invalid Date". */
function asStatus(value: unknown): SentinelMcpStatus {
	if (!value || typeof value !== "object") return emptyStatus();
	const raw = value as Partial<SentinelMcpStatus>;
	const status: SentinelMcpStatus = {
		at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : null,
		ok: raw.ok !== false,
	};
	if (typeof raw.error === "string" && raw.error) status.error = raw.error;
	if (typeof raw.tools === "number" && Number.isFinite(raw.tools)) status.tools = raw.tools;
	if (typeof raw.resources === "number" && Number.isFinite(raw.resources)) status.resources = raw.resources;
	return status;
}

/**
 * Coerce one stored object (or one save input) into a complete record. Unknown
 * keys are dropped; a field that is missing or of the wrong type reads as its
 * empty value, so a hand-edited file degrades to "not configured" instead of
 * reaching the transport as a half-built config.
 */
export function normalizeMcpServer(raw: unknown): SentinelMcpServerRecord {
	const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const url = asText(value.url);
	const transport = asTransport(value.transport ?? value.type, url.length > 0);
	return {
		name: asText(value.name),
		enabled: value.enabled !== false,
		transport,
		command: asText(value.command),
		args: asStringList(value.args),
		env: asStringRecord(value.env),
		cwd: asText(value.cwd),
		url,
		headers: asStringRecord(value.headers),
		description: asText(value.description),
		exposure: asExposure(value.exposure),
		timeout: asTimeout(value.timeout),
		// The acknowledgment is about a command on the console host, so an HTTP entry never carries one.
		hostExecAcknowledged: transport === "stdio" && value.hostExecAcknowledged === true,
		status: asStatus(value.status),
	};
}

export interface SentinelMcpServersFile {
	version: number;
	servers: SentinelMcpServerRecord[];
}

export function emptyMcpServersFile(): SentinelMcpServersFile {
	return { version: MCP_SERVERS_VERSION, servers: [] };
}

/** Read a parsed file into complete records, dropping entries without a usable name. */
export function normalizeMcpServersFile(input: unknown): SentinelMcpServersFile {
	const raw = (input && typeof input === "object" ? input : {}) as { servers?: unknown };
	const list = Array.isArray(raw.servers) ? raw.servers : [];
	const servers: SentinelMcpServerRecord[] = [];
	const seen = new Set<string>();
	for (const entry of list) {
		const server = normalizeMcpServer(entry);
		// Two names that differ only in `-` and `_` share one tool namespace, so the
		// later entry would silently shadow the earlier one's tools.
		if (!server.name || seen.has(mcpNamespace(server.name))) continue;
		seen.add(mcpNamespace(server.name));
		servers.push(server);
	}
	return { version: MCP_SERVERS_VERSION, servers };
}

/** Read the stored servers; a missing or broken file means "nothing configured". */
export function readMcpServers(agentDir: string): SentinelMcpServersFile {
	const path = mcpServersJsonPath(agentDir);
	if (!existsSync(path)) return emptyMcpServersFile();
	try {
		return normalizeMcpServersFile(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return emptyMcpServersFile();
	}
}

/**
 * The same read, for the paths that write the file back.
 *
 * A file that exists but cannot be parsed still holds the operator's tokens, so
 * rewriting it from the lenient empty read would delete every one of them.
 * Callers refuse the write instead.
 */
function readMcpServersForUpdate(agentDir: string): SentinelMcpServersFile | null {
	const path = mcpServersJsonPath(agentDir);
	if (!existsSync(path)) return emptyMcpServersFile();
	try {
		return normalizeMcpServersFile(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return null;
	}
}

export function writeMcpServers(agentDir: string, file: SentinelMcpServersFile): void {
	const path = mcpServersJsonPath(agentDir);
	const normalized = normalizeMcpServersFile(file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalized, null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}

/** The one-line summary of a server: its command line, or its URL. */
export function mcpServerTarget(server: SentinelMcpServerRecord): string {
	if (server.transport !== "stdio") return server.url;
	return [server.command, ...server.args].filter(Boolean).join(" ");
}

function toView(server: SentinelMcpServerRecord): SentinelMcpServerView {
	return { ...server, target: mcpServerTarget(server) };
}

/**
 * Whether a session connects this server at all. A disabled server and an stdio
 * server whose host execution the operator has not accepted both contribute
 * nothing: no connection, no tools, and no prompt section.
 */
export function isMcpServerMounted(server: SentinelMcpServerRecord): boolean {
	if (!server.enabled) return false;
	if (server.transport === "stdio" && !server.hostExecAcknowledged) return false;
	return true;
}

/**
 * A structural gap the shared validator cannot see.
 *
 * `validateMcpServerConfig` checks the *type* of `command` and `url`, not that
 * they carry anything, so it accepts `command: ""` — which would reach the
 * transport as a spawn of nothing. A hand-edited file is the only way to get
 * there, and a config error is a better answer than a failed connection.
 */
function missingFieldProblem(server: SentinelMcpServerRecord): string | undefined {
	if (server.transport === "stdio") {
		return server.command ? undefined : `server "${server.name}" has no command`;
	}
	return server.url ? undefined : `server "${server.name}" has no url`;
}

/**
 * Validate one save input. Returns a message to show the operator, or undefined
 * when the entry can be stored.
 *
 * The stdio acknowledgment is checked here as well as at mount time: refusing the
 * save is what makes the checkbox a real gate rather than a decoration, since
 * nothing else on this page would ever run the command.
 */
export function validateMcpServerInput(input: SentinelMcpServerInput): string | undefined {
	const name = input.name.trim();
	if (!name) return t("请填写服务器名称");
	if (!/^[A-Za-z0-9_-]+$/.test(name)) return t("名称只能用字母、数字、下划线和短横线");
	if (input.transport === "stdio") {
		if (!input.command.trim()) return t("stdio 服务器需要填写命令");
		if (!input.hostExecAcknowledged) {
			return t("stdio 命令在控制台宿主机上直接执行（不在容器内，也不经过 bash 审批），请先勾选风险确认");
		}
	} else if (!input.url.trim()) {
		return t("{type} 服务器需要填写 URL", { type: input.transport === "sse" ? "SSE" : "HTTP" });
	}
	const validated = validateMcpServerConfig(name, toMcpServerConfig(normalizeMcpServer(input)));
	if (typeof validated === "string") return validated;
	return undefined;
}

/** One record as the MCP extension's config shape, dropping the fields that are empty. */
function toMcpServerConfig(server: SentinelMcpServerRecord): McpServerConfig {
	const base = {
		enabled: server.enabled,
		exposure: server.exposure as McpExposure,
		...(server.description ? { description: server.description } : {}),
		...(server.timeout === null ? {} : { timeout: server.timeout }),
	};
	if (server.transport !== "stdio") {
		const target = {
			url: server.url,
			...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
		};
		// `type` is required on the SSE member, and absent (defaulting to http) on the other.
		if (server.transport === "sse") return { ...base, ...target, type: "sse" };
		return { ...base, ...target };
	}
	return {
		...base,
		command: server.command,
		...(server.args.length > 0 ? { args: server.args } : {}),
		...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
		...(server.cwd ? { cwd: server.cwd } : {}),
	};
}

/** One record as the MCP extension's entry, as `loadConfig` returns it. */
export function mcpEntryFor(agentDir: string, server: SentinelMcpServerRecord): McpServerEntry {
	return {
		name: server.name,
		config: toMcpServerConfig(server),
		source: mcpServersJsonPath(agentDir),
		scope: "global",
	};
}

/**
 * The `loadConfig` handed to the MCP extension, so a session connects exactly the
 * servers this page manages.
 *
 * Entries are validated on the way out as well as on the way in: the file can be
 * hand-edited, and an entry that no longer validates must be reported as a config
 * error rather than reach a transport.
 */
export function loadSentinelMcpConfig(agentDir: string, allowPlugin?: (key: string) => boolean): LoadedMcpConfig {
	const path = mcpServersJsonPath(agentDir);
	const { servers } = readMcpServers(agentDir);
	const entries: McpServerEntry[] = [];
	const errors: string[] = [];
	for (const server of servers) {
		const problem = missingFieldProblem(server);
		if (problem) {
			errors.push(`${path}: ${problem}`);
			continue;
		}
		const validated = validateMcpServerConfig(server.name, toMcpServerConfig(server));
		if (typeof validated === "string") {
			errors.push(`${path}: ${validated}`);
			continue;
		}
		entries.push({ name: server.name, config: validated, source: path, scope: "global" });
	}
	// Installed plugins are MCP servers too. They are mounted from the cached state in
	// plugins.json rather than from this file, because the host, not the operator, owns
	// their lifecycle; the console only decides whether they are switched on.
	const used = new Set(entries.map((entry) => mcpNamespace(entry.name)));
	for (const plugin of pluginMountEntries(agentDir)) {
		// 设置 → 权限 decides which agent may mount this plugin. Not mounting is
		// the whole restriction: the server never connects, so its tools are never
		// registered and nothing can load them back.
		if (allowPlugin && !allowPlugin(plugin.key)) continue;
		if (used.has(mcpNamespace(plugin.serverName))) {
			errors.push(
				t("{path}: 插件服务器 {server} 与已有 MCP 服务器同名，已跳过", {
					path: pluginStatePath(agentDir),
					server: plugin.serverName,
				}),
			);
			continue;
		}
		const pluginConfig = {
			enabled: true,
			exposure: "direct" as const,
			url: plugin.url,
			headers: { authorization: `Bearer ${plugin.token}` },
			description: "社区插件",
			// The MCP client defaults to 60s, which is shorter than a real scan.
			timeout: plugin.timeoutSeconds,
		};
		const validated = validateMcpServerConfig(plugin.serverName, pluginConfig);
		if (typeof validated === "string") {
			errors.push(`${pluginStatePath(agentDir)}: ${validated}`);
			continue;
		}
		entries.push({ name: plugin.serverName, config: validated, source: pluginStatePath(agentDir), scope: "global" });
		used.add(mcpNamespace(plugin.serverName));
	}
	return { servers: entries, errors };
}

/** The view the console renders: every server, its switch, and its last probe result. */
export function mcpConfigView(agentDir: string): SentinelMcpConfigView {
	const { servers } = readMcpServers(agentDir);
	const views = servers.map(toView);
	return {
		servers: views,
		mounted: servers.filter(isMcpServerMounted).length,
		permissionOn: readPermissionsConfig(agentDir).main.mcp,
		path: mcpServersJsonPath(agentDir),
	};
}

/**
 * Add or replace one server. The status of an existing entry is kept: the last
 * probe result describes the connection, not the form that was just saved.
 */
export function saveMcpServer(agentDir: string, input: SentinelMcpServerInput): SentinelMcpConfigView {
	const failure = validateMcpServerInput(input);
	if (failure) throw new Error(failure);
	const file = readMcpServersForUpdate(agentDir);
	if (!file) throw new Error(t("{path} 无法解析，请先修复或删除该文件再保存", { path: mcpServersJsonPath(agentDir) }));
	const server = normalizeMcpServer(input);
	const index = file.servers.findIndex((entry) => mcpNamespace(entry.name) === mcpNamespace(server.name));
	if (index >= 0) {
		// The name is the identity, but a save may also correct its spelling (`a-b` to `a_b`).
		server.status = file.servers[index].status;
		file.servers[index] = server;
	} else {
		file.servers.push(server);
	}
	writeMcpServers(agentDir, file);
	return mcpConfigView(agentDir);
}

/** Remove one server. Removing a name that is not stored is not an error. */
export function deleteMcpServer(agentDir: string, name: string): SentinelMcpConfigView {
	const file = readMcpServersForUpdate(agentDir);
	if (!file) throw new Error(t("{path} 无法解析，请先修复或删除该文件再删除", { path: mcpServersJsonPath(agentDir) }));
	const namespace = mcpNamespace(name.trim());
	file.servers = file.servers.filter((entry) => mcpNamespace(entry.name) !== namespace);
	writeMcpServers(agentDir, file);
	return mcpConfigView(agentDir);
}

/**
 * Remember how the last probe went, so the page still shows the truth after the
 * session that hit the failure is gone. Skipped rather than overwritten when the
 * file cannot be parsed: a status line is never worth the operator's tokens.
 */
export function recordMcpStatus(agentDir: string, name: string, status: SentinelMcpStatus): void {
	const file = readMcpServersForUpdate(agentDir);
	if (!file) return;
	const namespace = mcpNamespace(name.trim());
	const server = file.servers.find((entry) => mcpNamespace(entry.name) === namespace);
	if (!server) return;
	server.status = asStatus(status);
	writeMcpServers(agentDir, file);
}

/**
 * Apply an `enabled`/`exposure` change made through the MCP extension's own
 * manager (`/mcp` in a terminal), so both entry points write the same file.
 */
export function updateMcpServerRecord(
	agentDir: string,
	name: string,
	patch: { enabled?: boolean; exposure?: McpExposure },
): void {
	const file = readMcpServersForUpdate(agentDir);
	if (!file) throw new Error(t("{path} 无法解析，请先修复或删除该文件再修改", { path: mcpServersJsonPath(agentDir) }));
	const namespace = mcpNamespace(name.trim());
	const server = file.servers.find((entry) => mcpNamespace(entry.name) === namespace);
	if (!server) throw new Error(t('{path} 未定义 MCP 服务器 "{name}"', { path: mcpServersJsonPath(agentDir), name }));
	if (patch.enabled !== undefined) server.enabled = patch.enabled;
	if (patch.exposure !== undefined) server.exposure = patch.exposure;
	writeMcpServers(agentDir, file);
}
