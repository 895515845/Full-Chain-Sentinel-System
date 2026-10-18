/**
 * The community plugin manifest (`plugin.json`).
 *
 * A plugin is one Docker image exposing one MCP endpoint. The manifest is the
 * whole contract between the author, the plugin host and the console: where the
 * Dockerfile is, the container's declared needs, the configuration form, and
 * where the container writes artifacts.
 *
 * Parsing is deliberately strict and total. It never throws: a manifest either
 * yields a complete, normalized record or a list of messages to show the
 * operator. Anything the manifest declares is shown before installation and is
 * applied by the host; nothing in it is trusted to enforce itself.
 *
 * The package is built on the plugin host: the zip carries a Dockerfile and its
 * context, and the host runs `docker build` before starting the container. There
 * is no registry dependency, so a local plugin never needs a push.
 *
 * The source repository is still required. The host executes the Dockerfile on
 * the operator's machine, and an install shows the source link and asks for
 * explicit approval before the build starts.
 */

/** Bump only when a field changes meaning; the parser accepts older versions. */
export const PLUGIN_SCHEMA_VERSION = 1;

/** Bridge protocol between the console frame and the plugin's SDK. */
export const PLUGIN_UI_PROTOCOL = 1;

export type SentinelPluginNetwork = "none" | "bridge" | "host";

/**
 * Where a plugin makes sense. `local-only` covers anything that needs the
 * operator's own network vantage (LAN scanning, local capture); `remote-only`
 * covers anything that needs a clean public egress or a long-lived public
 * address. The host refuses a mismatched install instead of starting something
 * that cannot work.
 */
export type SentinelPluginLocality = "local-only" | "remote-only" | "any";

export type SentinelPluginConfigType = "string" | "secret" | "number" | "boolean" | "enum";

/**
 * Only streamable HTTP is supported. stdio and SSE have to be converted by the
 * plugin author: a stdio process has no port to proxy, and an SSE server names
 * its message endpoint in a way that does not survive a reverse proxy.
 */
export type SentinelPluginMcpTransport = "http";

export interface SentinelPluginConfigField {
	key: string;
	label: string;
	type: SentinelPluginConfigType;
	required: boolean;
	/** Pre-filled value; `null` means the field starts empty. */
	default: string | number | boolean | null;
	/** Allowed values for `enum`, empty otherwise. */
	options: string[];
	description: string;
}

export interface SentinelPluginMcp {
	transport: SentinelPluginMcpTransport;
	port: number;
	path: string;
	/** How long the host waits for the health endpoint while the container starts. */
	startupTimeoutMs: number;
	/** Per-request budget of an MCP call, in milliseconds. */
	requestTimeoutMs: number;
}

export interface SentinelPluginPermissions {
	network: SentinelPluginNetwork;
	/** Extra Linux capabilities, e.g. `NET_RAW` for a scanner that needs raw sockets. */
	capAdd: string[];
	privileged: boolean;
}

export interface SentinelPluginResources {
	cpus: number;
	/** Docker size string, lower case, e.g. `512m` or `2g`. */
	memory: string;
	pidsLimit: number;
}

export interface SentinelPluginHealthcheck {
	path: string;
	intervalMs: number;
	timeoutMs: number;
	retries: number;
}

export interface SentinelPluginArtifacts {
	path: string;
	maxFileBytes: number;
}

/**
 * The optional frontend. The console serves the plugin's `/ui/` files behind a
 * sandboxed iframe; `entry` is the container path of the HTML document and every
 * other asset is resolved relative to it.
 */
export interface SentinelPluginUiSidebar {
	/** Sidebar label; falls back to the UI title or plugin name. */
	label: string;
	/** Icon under /ui/, e.g. `/ui/icon.svg`; empty falls back to the generic icon. */
	icon: string;
}

export interface SentinelPluginUi {
	/** Container path of the entry document, e.g. `/ui/index.html`. */
	entry: string;
	/** Title shown in the console's frame around the iframe. */
	title: string;
	/** Bridge protocol; only 1 is understood for now. */
	protocol: number;
	/** Author's suggestion to offer a sidebar entry; the operator still opts in. */
	sidebar: SentinelPluginUiSidebar | null;
}

/**
 * How the plugin host builds the image from the uploaded package. Paths are
 * relative to the directory that contains `plugin.json`.
 */
export interface SentinelPluginBuild {
	/** Dockerfile path inside the package. */
	dockerfile: string;
	/** Build context, relative to the plugin root. */
	context: string;
	/** Optional --build-arg values, e.g. a mirror for the base image. */
	args: Record<string, string>;
}

/** A tool as advertised before install; the running MCP server remains authoritative. */
export interface SentinelPluginToolHint {
	name: string;
	description: string;
}

export interface SentinelPluginManifest {
	schema: number;
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	source: string;
	license: string;
	build: SentinelPluginBuild;
	mcp: SentinelPluginMcp;
	config: SentinelPluginConfigField[];
	permissions: SentinelPluginPermissions;
	locality: SentinelPluginLocality;
	resources: SentinelPluginResources;
	healthcheck: SentinelPluginHealthcheck;
	artifacts: SentinelPluginArtifacts;
	tools: SentinelPluginToolHint[];
	/** Null when the plugin ships no frontend. */
	ui: SentinelPluginUi | null;
}

export type SentinelPluginParseResult =
	| { ok: true; manifest: SentinelPluginManifest }
	| { ok: false; errors: string[] };

/** Reverse-DNS identifier; it is also the container's data directory name. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/** Relative path inside the package: no absolute paths, no `..`. */
const BUILD_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const BUILD_ARG_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_BUILD_ARGS = 16;
const MAX_BUILD_ARG_CHARS = 300;

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CONFIG_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MEMORY_PATTERN = /^(\d+(?:\.\d+)?)([bkmg])$/;
const CAP_PATTERN = /^[A-Z0-9_]+$/;

export const PLUGIN_LIMITS = {
	maxIdChars: 128,
	maxNameChars: 60,
	maxDescriptionChars: 400,
	maxConfigFields: 32,
	maxUiEntryChars: 256,
	maxBuildPathChars: 200,
	maxToolHints: 64,
	minCpus: 0.1,
	maxCpus: 2,
	minMemoryBytes: 32 * 1024 * 1024,
	maxMemoryBytes: 2 * 1024 * 1024 * 1024,
	maxPids: 1024,
	maxArtifactFileBytes: 200 * 1024 * 1024,
	minStartupTimeoutMs: 1000,
	maxStartupTimeoutMs: 120000,
	minRequestTimeoutMs: 5000,
	maxRequestTimeoutMs: 1800000,
	minHealthIntervalMs: 1000,
	maxHealthIntervalMs: 60000,
} as const;

export const PLUGIN_DEFAULTS = {
	buildDockerfile: "Dockerfile",
	buildContext: ".",
	mcpPath: "/mcp",
	mcpStartupTimeoutMs: 20000,
	// Long enough for a real scan (subfinder + naabu), short enough that a hung
	// plugin does not block a session forever.
	mcpRequestTimeoutMs: 300000,
	healthPath: "/healthz",
	healthIntervalMs: 10000,
	healthTimeoutMs: 3000,
	healthRetries: 3,
	artifactPath: "/artifacts",
	artifactMaxFileBytes: 50 * 1024 * 1024,
	cpus: 1,
	memory: "512m",
	pidsLimit: 256,
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim());
}

function asPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/** Bytes of a Docker size string; `null` when it is not one. */
export function pluginMemoryBytes(memory: string): number | null {
	const match = MEMORY_PATTERN.exec(memory.trim().toLowerCase());
	if (!match) return null;
	const value = Number(match[1]);
	const unit = match[2];
	const scale = unit === "b" ? 1 : unit === "k" ? 1024 : unit === "m" ? 1024 * 1024 : 1024 * 1024 * 1024;
	return Math.round(value * scale);
}

function normalizeMemory(value: unknown): string {
	const text = asText(value).toLowerCase();
	if (!text) return PLUGIN_DEFAULTS.memory;
	const bytes = pluginMemoryBytes(text);
	if (bytes === null) return PLUGIN_DEFAULTS.memory;
	return bytes < PLUGIN_LIMITS.minMemoryBytes
		? `${Math.ceil(PLUGIN_LIMITS.minMemoryBytes / (1024 * 1024))}m`
		: bytes > PLUGIN_LIMITS.maxMemoryBytes
			? `${Math.floor(PLUGIN_LIMITS.maxMemoryBytes / (1024 * 1024 * 1024))}g`
			: text;
}

function normalizeConfigField(raw: unknown): SentinelPluginConfigField | null {
	const value = asRecord(raw);
	if (!value) return null;
	const type = value.type;
	const fieldType: SentinelPluginConfigType =
		type === "secret" || type === "number" || type === "boolean" || type === "enum" ? type : "string";
	const fallback =
		fieldType === "number" ? null : fieldType === "boolean" ? false : fieldType === "enum" ? null : null;
	const rawDefault = value.default;
	const defaultValue =
		fieldType === "number"
			? typeof rawDefault === "number" && Number.isFinite(rawDefault)
				? rawDefault
				: fallback
			: fieldType === "boolean"
				? typeof rawDefault === "boolean"
					? rawDefault
					: fallback
				: typeof rawDefault === "string"
					? rawDefault
					: typeof rawDefault === "number" && fieldType !== "secret"
						? String(rawDefault)
						: fallback;
	return {
		key: asText(value.key),
		label: asText(value.label) || asText(value.key),
		type: fieldType,
		required: value.required === true,
		default: defaultValue,
		options: asStringList(value.options),
		description: asText(value.description),
	};
}

function normalizeToolHint(raw: unknown): SentinelPluginToolHint | null {
	const value = asRecord(raw);
	if (!value) return null;
	const name = asText(value.name);
	if (!name) return null;
	return { name, description: asText(value.description) };
}

function normalizeBuildArgs(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const args: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "string") args[key] = raw;
	}
	return args;
}

/** The manifest as the host stores it: every optional field filled in. */
function normalize(raw: Record<string, unknown>): SentinelPluginManifest {
	const mcpRaw = asRecord(raw.mcp) ?? {};
	const permissionsRaw = asRecord(raw.permissions) ?? {};
	const resourcesRaw = asRecord(raw.resources) ?? {};
	const healthRaw = asRecord(raw.healthcheck) ?? {};
	const artifactsRaw = asRecord(raw.artifacts) ?? {};
	const buildRaw = asRecord(raw.build) ?? {};
	const uiRaw = asRecord(raw.ui);
	const hasUi = raw.ui !== undefined && raw.ui !== null;
	const sidebarRaw = asRecord(uiRaw?.sidebar);
	const sidebar: SentinelPluginUiSidebar | null =
		hasUi && uiRaw?.sidebar !== undefined && uiRaw.sidebar !== false
			? {
					label: asText(sidebarRaw?.label) || asText(uiRaw?.title),
					icon: asText(sidebarRaw?.icon),
				}
			: null;
	const ui: SentinelPluginUi | null = hasUi
		? {
				entry: asText(uiRaw?.entry),
				title: asText(uiRaw?.title),
				protocol: typeof uiRaw?.protocol === "number" ? Math.round(uiRaw.protocol) : PLUGIN_UI_PROTOCOL,
				sidebar,
			}
		: null;
	const network = permissionsRaw.network;
	const locality = raw.locality;
	return {
		schema: typeof raw.schema === "number" ? Math.round(raw.schema) : PLUGIN_SCHEMA_VERSION,
		id: asText(raw.id),
		name: asText(raw.name),
		version: asText(raw.version),
		description: asText(raw.description),
		author: asText(raw.author),
		source: asText(raw.source),
		license: asText(raw.license),
		build: {
			dockerfile: asText(buildRaw.dockerfile) || PLUGIN_DEFAULTS.buildDockerfile,
			context: asText(buildRaw.context) || PLUGIN_DEFAULTS.buildContext,
			args: normalizeBuildArgs(buildRaw.args),
		},
		mcp: {
			transport: "http",
			port: asPositiveInt(mcpRaw.port, 7801, 1, 65535),
			path: asText(mcpRaw.path) || PLUGIN_DEFAULTS.mcpPath,
			startupTimeoutMs: asPositiveInt(
				mcpRaw.startupTimeoutMs,
				PLUGIN_DEFAULTS.mcpStartupTimeoutMs,
				PLUGIN_LIMITS.minStartupTimeoutMs,
				PLUGIN_LIMITS.maxStartupTimeoutMs,
			),
			requestTimeoutMs: asPositiveInt(
				mcpRaw.requestTimeoutMs,
				PLUGIN_DEFAULTS.mcpRequestTimeoutMs,
				PLUGIN_LIMITS.minRequestTimeoutMs,
				PLUGIN_LIMITS.maxRequestTimeoutMs,
			),
		},
		config: Array.isArray(raw.config)
			? raw.config
					.map(normalizeConfigField)
					.filter((entry): entry is SentinelPluginConfigField => entry !== null)
					.slice(0, PLUGIN_LIMITS.maxConfigFields)
			: [],
		permissions: {
			network: network === "none" || network === "host" ? network : "bridge",
			capAdd: asStringList(permissionsRaw.capAdd),
			privileged: permissionsRaw.privileged === true,
		},
		locality: locality === "local-only" || locality === "remote-only" ? locality : "any",
		resources: {
			cpus:
				typeof resourcesRaw.cpus === "number" && Number.isFinite(resourcesRaw.cpus)
					? resourcesRaw.cpus
					: PLUGIN_DEFAULTS.cpus,
			memory: normalizeMemory(resourcesRaw.memory),
			pidsLimit: asPositiveInt(resourcesRaw.pidsLimit, PLUGIN_DEFAULTS.pidsLimit, 16, PLUGIN_LIMITS.maxPids),
		},
		healthcheck: {
			path: asText(healthRaw.path) || PLUGIN_DEFAULTS.healthPath,
			intervalMs: asPositiveInt(
				healthRaw.intervalMs,
				PLUGIN_DEFAULTS.healthIntervalMs,
				PLUGIN_LIMITS.minHealthIntervalMs,
				PLUGIN_LIMITS.maxHealthIntervalMs,
			),
			timeoutMs: asPositiveInt(healthRaw.timeoutMs, PLUGIN_DEFAULTS.healthTimeoutMs, 500, 30000),
			retries: asPositiveInt(healthRaw.retries, PLUGIN_DEFAULTS.healthRetries, 1, 20),
		},
		artifacts: {
			path: asText(artifactsRaw.path) || PLUGIN_DEFAULTS.artifactPath,
			maxFileBytes: asPositiveInt(
				artifactsRaw.maxFileBytes,
				PLUGIN_DEFAULTS.artifactMaxFileBytes,
				1,
				PLUGIN_LIMITS.maxArtifactFileBytes,
			),
		},
		tools: Array.isArray(raw.tools)
			? raw.tools
					.map(normalizeToolHint)
					.filter((entry): entry is SentinelPluginToolHint => entry !== null)
					.slice(0, PLUGIN_LIMITS.maxToolHints)
			: [],
		ui,
	};
}

function isHttpUrl(text: string): boolean {
	try {
		const url = new URL(text);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Parse and validate one manifest. Every problem is collected, so the operator
 * sees the whole list rather than fixing fields one reload at a time.
 */
export function parsePluginManifest(input: unknown): SentinelPluginParseResult {
	const raw = asRecord(input);
	if (!raw) return { ok: false, errors: ["plugin.json 必须是 JSON 对象"] };
	const manifest = normalize(raw);
	const errors: string[] = [];

	if (manifest.schema !== PLUGIN_SCHEMA_VERSION) {
		errors.push(`schema 必须是 ${PLUGIN_SCHEMA_VERSION}，收到 ${String(raw.schema ?? "空")}`);
	}
	if (!manifest.id) errors.push("缺少 id");
	else if (!PLUGIN_ID_PATTERN.test(manifest.id)) errors.push("id 必须是反向域名写法，例如 com.example.recon");
	else if (manifest.id.length > PLUGIN_LIMITS.maxIdChars)
		errors.push(`id 不能超过 ${PLUGIN_LIMITS.maxIdChars} 个字符`);

	if (!manifest.name) errors.push("缺少 name");
	else if (manifest.name.length > PLUGIN_LIMITS.maxNameChars) {
		errors.push(`name 不能超过 ${PLUGIN_LIMITS.maxNameChars} 个字符`);
	}
	if (!manifest.version) errors.push("缺少 version");
	else if (!SEMVER_PATTERN.test(manifest.version)) errors.push("version 必须是语义化版本，例如 0.1.0");

	if (!manifest.description) errors.push("缺少 description");
	else if (manifest.description.length > PLUGIN_LIMITS.maxDescriptionChars) {
		errors.push(`description 不能超过 ${PLUGIN_LIMITS.maxDescriptionChars} 个字符`);
	}
	if (!manifest.author) errors.push("缺少 author，写成 github:<用户名>");
	if (!manifest.source) errors.push("缺少 source：本项目只分发带源码链接的开源插件");
	else if (!isHttpUrl(manifest.source)) errors.push("source 必须是 http(s) 链接");
	if (!manifest.license) errors.push("缺少 license");
	if (raw.image !== undefined) {
		errors.push("不再支持 image：插件包现在包含 Dockerfile，由插件主机本地构建");
	}
	const buildPaths: Array<[string, string]> = [
		["build.dockerfile", manifest.build.dockerfile],
		["build.context", manifest.build.context],
	];
	for (const [label, value] of buildPaths) {
		if (!value) {
			errors.push(`${label} 不能为空`);
			continue;
		}
		if (value.startsWith("/") || value.split("/").includes("..") || !BUILD_PATH_PATTERN.test(value)) {
			errors.push(`${label} 必须是插件包内的相对路径，不能以 / 开头或包含 ..`);
			continue;
		}
		if (value.length > PLUGIN_LIMITS.maxBuildPathChars) {
			errors.push(`${label} 不能超过 ${PLUGIN_LIMITS.maxBuildPathChars} 个字符`);
		}
	}
	if (manifest.build.dockerfile === "." || manifest.build.dockerfile.endsWith("/")) {
		errors.push("build.dockerfile 必须指向一个文件");
	}
	const buildArgEntries = Object.entries(manifest.build.args);
	if (buildArgEntries.length > MAX_BUILD_ARGS) errors.push(`build.args 不能超过 ${MAX_BUILD_ARGS} 项`);
	for (const [key, value] of buildArgEntries) {
		if (!BUILD_ARG_KEY_PATTERN.test(key)) errors.push(`build.args 的键 ${key} 必须匹配 ^[A-Z][A-Z0-9_]*$`);
		if (typeof value !== "string" || value.length > MAX_BUILD_ARG_CHARS || value.includes("\n")) {
			errors.push(`build.args.${key} 必须是 ${MAX_BUILD_ARG_CHARS} 字符以内的单行字符串`);
		}
	}

	if (!manifest.mcp.path.startsWith("/")) errors.push("mcp.path 必须以 / 开头");
	if (/\s/.test(manifest.mcp.path)) errors.push("mcp.path 不能包含空白字符");
	const rawMcp = asRecord(raw.mcp);
	if (rawMcp?.transport !== undefined && rawMcp.transport !== "http") {
		errors.push('mcp.transport 只支持 "http"（streamable HTTP）；stdio 和 SSE 需要插件作者自行转换');
	}
	if (rawMcp?.requestTimeoutMs !== undefined) {
		const timeout = rawMcp.requestTimeoutMs;
		if (
			typeof timeout !== "number" ||
			!Number.isFinite(timeout) ||
			timeout < PLUGIN_LIMITS.minRequestTimeoutMs ||
			timeout > PLUGIN_LIMITS.maxRequestTimeoutMs
		) {
			errors.push(
				`mcp.requestTimeoutMs 必须是 ${PLUGIN_LIMITS.minRequestTimeoutMs}–${PLUGIN_LIMITS.maxRequestTimeoutMs} 之间的毫秒数`,
			);
		}
	}

	for (const cap of manifest.permissions.capAdd) {
		if (!CAP_PATTERN.test(cap)) errors.push(`permissions.capAdd 含非法能力名 "${cap}"`);
	}

	if (!Number.isFinite(manifest.resources.cpus) || manifest.resources.cpus < PLUGIN_LIMITS.minCpus) {
		errors.push(`resources.cpus 不能小于 ${PLUGIN_LIMITS.minCpus}`);
	} else if (manifest.resources.cpus > PLUGIN_LIMITS.maxCpus) {
		errors.push(`resources.cpus 不能超过 ${PLUGIN_LIMITS.maxCpus}`);
	}
	const rawResources = asRecord(raw.resources);
	if (typeof rawResources?.memory === "string" && pluginMemoryBytes(rawResources.memory) === null) {
		errors.push("resources.memory 必须是类似 512m、1g 的 Docker 尺寸");
	}

	if (!manifest.healthcheck.path.startsWith("/")) errors.push("healthcheck.path 必须以 / 开头");
	if (!manifest.artifacts.path.startsWith("/")) errors.push("artifacts.path 必须是容器内的绝对路径");

	const configKeys = new Set<string>();
	for (const field of manifest.config) {
		if (!CONFIG_KEY_PATTERN.test(field.key)) {
			errors.push(`config.key "${field.key}" 必须是大写字母、数字和下划线，且以字母开头`);
		}
		if (configKeys.has(field.key)) errors.push(`config.key "${field.key}" 重复`);
		configKeys.add(field.key);
		if (field.type === "enum") {
			if (field.options.length === 0) errors.push(`config "${field.key}" 是 enum，但没有 options`);
			else if (typeof field.default === "string" && !field.options.includes(field.default)) {
				errors.push(`config "${field.key}" 的默认值不在 options 里`);
			}
		}
		if (field.required && field.default !== null && field.type !== "boolean") {
			errors.push(`config "${field.key}" 必填时不应给默认值`);
		}
	}

	for (const hint of manifest.tools) {
		if (!TOOL_NAME_PATTERN.test(hint.name)) errors.push(`tools 里的工具名 "${hint.name}" 非法`);
	}

	if (manifest.ui) {
		if (manifest.ui.sidebar) {
			if (manifest.ui.sidebar.label.length > PLUGIN_LIMITS.maxNameChars) {
				errors.push(`ui.sidebar.label 不能超过 ${PLUGIN_LIMITS.maxNameChars} 个字符`);
			}
			const icon = manifest.ui.sidebar.icon;
			if (icon) {
				if (!/^\/ui\/[A-Za-z0-9._-]+\.(svg|png)$/.test(icon) || icon.split("/").includes("..")) {
					errors.push("ui.sidebar.icon 必须是 /ui/ 下的 .svg 或 .png 路径");
				}
			}
		}
		if (!manifest.ui.title) manifest.ui.title = manifest.name;
		const entry = manifest.ui.entry;
		if (!entry) errors.push("ui.entry 不能为空");
		else if (!entry.startsWith("/") || !entry.endsWith(".html")) {
			errors.push("ui.entry 必须是容器内的绝对路径，并以 .html 结尾");
		} else if (entry.length > PLUGIN_LIMITS.maxUiEntryChars) {
			errors.push(`ui.entry 不能超过 ${PLUGIN_LIMITS.maxUiEntryChars} 个字符`);
		} else if (/\s/.test(entry) || entry.split("/").includes("..")) {
			errors.push("ui.entry 不能包含空白或 .. 路径段");
		}
		if (manifest.ui.protocol !== PLUGIN_UI_PROTOCOL) {
			errors.push(`ui.protocol 只支持 ${PLUGIN_UI_PROTOCOL}`);
		}
		const uiRaw = asRecord(raw.ui);
		if (uiRaw?.network === true) {
			errors.push("v1 不支持插件界面直接访问外网；需要外网时由插件容器自己请求");
		}
	}

	return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest };
}

/**
 * The MCP server name a plugin is mounted as.
 *
 * MCP server names are `[A-Za-z0-9_-]+`, but plugin ids are reverse-DNS, so the
 * dots collapse. The console shows the manifest name; the tool names still carry
 * `mcp__<server>__<tool>`, so the mapping has to be stable across restarts.
 */
export function pluginServerName(id: string): string {
	const slug = id
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	return `plugin-${slug}`;
}

/** Key of one plugin on one host; used as the console's state key. */
export function pluginKey(hostId: string, pluginId: string): string {
	return `${hostId}/${pluginId}`;
}

/** Config values as the container receives them: `PLUGIN_<KEY>`, strings only. */
export function pluginConfigEnv(
	fields: readonly SentinelPluginConfigField[],
	values: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const field of fields) {
		const value = values[field.key];
		if (value === undefined || value === "") continue;
		env[`PLUGIN_${field.key}`] = value;
	}
	return env;
}

/**
 * Check one config save against the manifest: unknown keys are refused, required
 * keys must be present, numbers must parse, enums must be one of their options.
 * Secret values are never returned by the host, so a missing secret means "keep
 * the stored one" rather than "clear it".
 */
export function validatePluginConfig(
	fields: readonly SentinelPluginConfigField[],
	values: Record<string, unknown>,
	options: { keepSecrets?: ReadonlySet<string> } = {},
): string | undefined {
	const known = new Set(fields.map((field) => field.key));
	for (const key of Object.keys(values)) {
		if (!known.has(key)) return `未知的配置项 "${key}"`;
	}
	for (const field of fields) {
		const value = values[field.key];
		if (value === undefined || value === "") {
			if (field.required && !(field.type === "secret" && options.keepSecrets?.has(field.key))) {
				return `配置项 "${field.label}" 不能为空`;
			}
			continue;
		}
		if (field.type === "number") {
			const parsed = typeof value === "number" ? value : Number(value);
			if (!Number.isFinite(parsed)) return `配置项 "${field.label}" 必须是数字`;
		} else if (field.type === "boolean") {
			if (typeof value !== "boolean" && value !== "true" && value !== "false") {
				return `配置项 "${field.label}" 必须是布尔值`;
			}
		} else if (field.type === "enum") {
			if (typeof value !== "string" || !field.options.includes(value)) {
				return `配置项 "${field.label}" 必须从 ${field.options.join(" / ")} 中选择`;
			}
		} else if (typeof value !== "string") {
			return `配置项 "${field.label}" 必须是字符串`;
		}
	}
	return undefined;
}
