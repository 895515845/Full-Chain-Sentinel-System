/**
 * Asset-mapping platform configuration, stored in assets.json.
 *
 * The three platforms (FOFA, 360 Quake, 奇安信 Hunter) are internet-wide search
 * engines for exposed assets. Each holds an API key that bills the operator's own
 * account, so the file is written 0600 like models.json and notifications.json,
 * and the key is write-only: the console sends it once and never reads it back.
 *
 * The console calls these platforms itself, from the console process. The key is
 * therefore never written into a bash command, never enters the project
 * container, and never lands in the gatekeeper audit — which is exactly what
 * would happen if the agent were told to curl the API through its own shell.
 *
 * A missing or corrupt file reads as "nothing configured": an unusable key must
 * never leave the console claiming a capability it does not have.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { t } from "./i18n.ts";
import type {
	SentinelAssetConfigView,
	SentinelAssetPlatform,
	SentinelAssetPlatformInput,
	SentinelAssetPlatformView,
	SentinelAssetStatus,
} from "./protocol.ts";

/** One platform as stored, including the key that never leaves the host. */
export interface SentinelAssetPlatformConfig {
	enabled: boolean;
	key: string;
	/** Custom origin or reverse-proxy prefix; empty means the official platform URL. */
	baseUrl: string;
	/** Outcome of the last probe or query, so the console can show what happened. */
	status: SentinelAssetStatus;
}

/** Bumped only if the on-disk shape changes in a way a reader must migrate. */
export const ASSET_CONFIG_VERSION = 1;

/** Platform order in the settings screen and in tool output. */
export const ASSET_PLATFORMS: readonly SentinelAssetPlatform[] = ["fofa", "quake", "hunter"];

export const ASSET_PLATFORM_LABELS: Record<SentinelAssetPlatform, string> = {
	fofa: "FOFA",
	quake: "360 Quake",
	hunter: "奇安信 Hunter",
};

/** Queries per session per platform; 0 means unlimited. */
export const DEFAULT_ASSET_SESSION_QUERY_LIMIT = 0;
export const MAX_ASSET_SESSION_QUERY_LIMIT = 1000;

export function assetsJsonPath(agentDir: string): string {
	return join(agentDir, "assets.json");
}

function emptyStatus(): SentinelAssetStatus {
	return { at: null, ok: true };
}

function emptyPlatform(): SentinelAssetPlatformConfig {
	return { enabled: false, key: "", baseUrl: "", status: emptyStatus() };
}

export function emptyAssetConfig(): SentinelAssetConfig {
	return {
		version: ASSET_CONFIG_VERSION,
		sessionQueryLimit: DEFAULT_ASSET_SESSION_QUERY_LIMIT,
		platforms: {
			fofa: emptyPlatform(),
			quake: emptyPlatform(),
			hunter: emptyPlatform(),
		},
	};
}

/** A stored key is whatever the operator typed, minus surrounding whitespace. */
function asKey(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalize a custom platform base URL to `origin` plus an optional path prefix.
 * The path below the prefix is appended by the platform client, so a stored
 * trailing slash is noise and a query or fragment cannot be part of a base.
 *
 * Invalid values read as empty, which means the official URL: a hand-edited
 * assets.json must not make a platform silently unusable.
 */
export function normalizeAssetBaseUrl(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = value.trim();
	if (!text) return "";
	try {
		const url = new URL(text);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		if (url.username || url.password || url.search || url.hash) return "";
		return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return "";
	}
}

/**
 * Validate a base URL the operator explicitly saved. Unlike the lenient reader,
 * a typo is an error here: quietly falling back to the official URL would send
 * the operator's queries somewhere they did not choose.
 */
function asBaseUrlInput(value: unknown): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) return "";
	const normalized = normalizeAssetBaseUrl(text);
	if (!normalized) {
		throw new Error(t("BaseURL 必须是完整的 http(s) 地址，且不能带查询参数、锚点或登录信息"));
	}
	return normalized;
}

function asLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ASSET_SESSION_QUERY_LIMIT;
	const limit = Math.floor(value);
	if (limit <= 0) return 0;
	return Math.min(limit, MAX_ASSET_SESSION_QUERY_LIMIT);
}

/**
 * A status blob from disk. The timestamp is kept only when it is a real number,
 * so a hand-edited file cannot make the settings screen print "Invalid Date".
 */
function asStatus(value: unknown): SentinelAssetStatus {
	if (!value || typeof value !== "object") return emptyStatus();
	const raw = value as Partial<SentinelAssetStatus>;
	const status: SentinelAssetStatus = {
		at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : null,
		ok: raw.ok !== false,
	};
	if (typeof raw.error === "string" && raw.error) status.error = raw.error;
	if (typeof raw.quota === "string" && raw.quota) status.quota = raw.quota;
	return status;
}

function asPlatform(value: unknown): SentinelAssetPlatformConfig {
	if (!value || typeof value !== "object") return emptyPlatform();
	const raw = value as Partial<SentinelAssetPlatformConfig>;
	return {
		enabled: raw.enabled === true,
		key: asKey(raw.key),
		baseUrl: normalizeAssetBaseUrl(raw.baseUrl),
		status: asStatus(raw.status),
	};
}

/** Normalize a parsed file (or a partial input) into a complete config. */
export function normalizeAssetConfig(input: unknown): SentinelAssetConfig {
	const raw = (input && typeof input === "object" ? input : {}) as {
		sessionQueryLimit?: unknown;
		platforms?: Partial<Record<SentinelAssetPlatform, unknown>>;
	};
	const platforms = (raw.platforms ?? {}) as Partial<Record<SentinelAssetPlatform, unknown>>;
	return {
		version: ASSET_CONFIG_VERSION,
		sessionQueryLimit: asLimit(raw.sessionQueryLimit),
		platforms: {
			fofa: asPlatform(platforms.fofa),
			quake: asPlatform(platforms.quake),
			hunter: asPlatform(platforms.hunter),
		},
	};
}

export interface SentinelAssetConfig {
	version: number;
	sessionQueryLimit: number;
	platforms: Record<SentinelAssetPlatform, SentinelAssetPlatformConfig>;
}

/** Read the stored config; a missing or broken file means "nothing configured". */
export function readAssetConfig(agentDir: string): SentinelAssetConfig {
	const path = assetsJsonPath(agentDir);
	if (!existsSync(path)) return emptyAssetConfig();
	try {
		return normalizeAssetConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return emptyAssetConfig();
	}
}

/**
 * The same read, for the paths that write the file back.
 *
 * A file that exists but cannot be parsed is not the same as an absent one: it
 * still holds the operator's keys, so rewriting it from the lenient empty read
 * would silently delete every key. Callers either refuse the write or skip it.
 */
function readAssetConfigForUpdate(agentDir: string): SentinelAssetConfig | null {
	const path = assetsJsonPath(agentDir);
	if (!existsSync(path)) return emptyAssetConfig();
	try {
		return normalizeAssetConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return null;
	}
}

export function writeAssetConfig(agentDir: string, config: SentinelAssetConfig): void {
	const path = assetsJsonPath(agentDir);
	const normalized = normalizeAssetConfig(config);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalized, null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}

/**
 * Whether a platform is handed to the agent: switched on, holding a key, and
 * verified by a successful probe.
 *
 * The verification requirement is the point of this predicate. A platform that
 * was never probed, or whose last probe failed, is not mounted — so an unusable
 * key never turns into a tool that fails on every call. The operator recovers by
 * pressing 测试连接, which records a fresh status.
 */
export function isPlatformUsable(config: SentinelAssetConfig, platform: SentinelAssetPlatform): boolean {
	const entry = config.platforms[platform];
	return entry.enabled && entry.key.length > 0 && entry.status.ok && entry.status.at !== null;
}

/** The platforms whose tools should be mounted, in fixed order. */
export function usablePlatforms(agentDir: string): SentinelAssetPlatform[] {
	const config = readAssetConfig(agentDir);
	return ASSET_PLATFORMS.filter((platform) => isPlatformUsable(config, platform));
}

/** The view the console renders: switches, a key-present flag, and last status. */
export function assetConfigView(agentDir: string): SentinelAssetConfigView {
	const config = readAssetConfig(agentDir);
	const platforms: SentinelAssetPlatformView[] = ASSET_PLATFORMS.map((platform) => {
		const entry = config.platforms[platform];
		return {
			id: platform,
			label: ASSET_PLATFORM_LABELS[platform],
			enabled: entry.enabled,
			hasKey: entry.key.length > 0,
			baseUrl: entry.baseUrl,
			verified: entry.status.ok && entry.status.at !== null,
			status: entry.status,
		};
	});
	return {
		platforms,
		sessionQueryLimit: config.sessionQueryLimit,
		usable: platforms.filter((platform) => platform.enabled && platform.hasKey && platform.verified).length,
	};
}

/**
 * Save one platform. `key: null` keeps whatever is stored, which is what an
 * untouched password field sends; `""` clears it, which is how the operator
 * removes a key without deleting the platform row.
 */
export function saveAssetPlatform(agentDir: string, input: SentinelAssetPlatformInput): SentinelAssetConfigView {
	const config = readAssetConfigForUpdate(agentDir);
	if (!config) throw new Error(t("{path} 无法解析，请先修复或删除该文件再保存", { path: assetsJsonPath(agentDir) }));
	const entry = config.platforms[input.id];
	const key = input.key === null ? entry.key : asKey(input.key);
	const baseUrl = input.baseUrl === undefined ? entry.baseUrl : asBaseUrlInput(input.baseUrl);
	config.platforms[input.id] = { enabled: input.enabled, key, baseUrl, status: entry.status };
	writeAssetConfig(agentDir, config);
	return assetConfigView(agentDir);
}

export function setAssetQueryLimit(agentDir: string, limit: number): SentinelAssetConfigView {
	const config = readAssetConfigForUpdate(agentDir);
	if (!config) throw new Error(t("{path} 无法解析，请先修复或删除该文件再保存", { path: assetsJsonPath(agentDir) }));
	config.sessionQueryLimit = asLimit(limit);
	writeAssetConfig(agentDir, config);
	return assetConfigView(agentDir);
}

/**
 * Remember how the last call to one platform went. Written on every query, so
 * the settings screen shows the truth after a failure rather than only what the
 * operator last tested by hand.
 */
export function recordAssetStatus(
	agentDir: string,
	platform: SentinelAssetPlatform,
	status: SentinelAssetStatus,
): void {
	// Skip rather than overwrite: a status line is never worth the operator's keys.
	const config = readAssetConfigForUpdate(agentDir);
	if (!config) return;
	config.platforms[platform].status = asStatus(status);
	writeAssetConfig(agentDir, config);
}
