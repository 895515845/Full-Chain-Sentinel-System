/**
 * Web-search (Tavily) key-pool configuration, stored in websearch.json.
 *
 * Unlike the asset platforms (one key each), Tavily accounts are cheap and meter
 * hard, so this plugin holds a pool of keys and rotates them by remaining
 * credits. Every entry stores its own key plus the last call's status; the file
 * is written 0600 like assets.json, and keys are write-only: the console sends
 * them once and never reads them back.
 *
 * A missing or corrupt file reads as "no keys": the console must not claim a
 * search capability it cannot serve.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SentinelAssetStatus, SentinelWebSearchConfigView } from "./protocol.ts";

export const WEBSEARCH_CONFIG_VERSION = 1;

/** Queries per session; 0 means unlimited. Same semantics as the asset limit. */
export const DEFAULT_WEBSEARCH_SESSION_QUERY_LIMIT = 0;
export const MAX_WEBSEARCH_SESSION_QUERY_LIMIT = 1000;

/** Keys one pool may hold. A pool bigger than this is unmanageable in the UI. */
export const MAX_WEBSEARCH_KEYS = 20;

export interface SentinelWebSearchKeyConfig {
	id: string;
	/** A free-form label so the operator can tell accounts apart. */
	label: string;
	key: string;
	enabled: boolean;
	status: SentinelAssetStatus;
}

export interface SentinelWebSearchConfig {
	version: number;
	sessionQueryLimit: number;
	keys: SentinelWebSearchKeyConfig[];
}

export function websearchJsonPath(agentDir: string): string {
	return join(agentDir, "websearch.json");
}

function emptyStatus(): SentinelAssetStatus {
	return { at: null, ok: true };
}

export function emptyWebSearchConfig(): SentinelWebSearchConfig {
	return { version: WEBSEARCH_CONFIG_VERSION, sessionQueryLimit: DEFAULT_WEBSEARCH_SESSION_QUERY_LIMIT, keys: [] };
}

function asKey(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WEBSEARCH_SESSION_QUERY_LIMIT;
	const limit = Math.floor(value);
	if (limit <= 0) return 0;
	return Math.min(limit, MAX_WEBSEARCH_SESSION_QUERY_LIMIT);
}

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

function asKeys(value: unknown): SentinelWebSearchKeyConfig[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, MAX_WEBSEARCH_KEYS).map((row) => {
		const raw = (row ?? {}) as Partial<SentinelWebSearchKeyConfig>;
		return {
			id: typeof raw.id === "string" && raw.id ? raw.id : `tvk-${randomUUID().slice(0, 8)}`,
			label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : "未命名 Key",
			key: asKey(raw.key),
			enabled: raw.enabled === true,
			status: asStatus(raw.status),
		};
	});
}

export function normalizeWebSearchConfig(input: unknown): SentinelWebSearchConfig {
	const raw = (input && typeof input === "object" ? input : {}) as {
		sessionQueryLimit?: unknown;
		keys?: unknown;
	};
	return {
		version: WEBSEARCH_CONFIG_VERSION,
		sessionQueryLimit: asLimit(raw.sessionQueryLimit),
		keys: asKeys(raw.keys),
	};
}

export function readWebSearchConfig(agentDir: string): SentinelWebSearchConfig {
	const path = websearchJsonPath(agentDir);
	if (!existsSync(path)) return emptyWebSearchConfig();
	try {
		return normalizeWebSearchConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return emptyWebSearchConfig();
	}
}

/**
 * The same read, for paths that write the file back. A file that exists but
 * cannot be parsed still holds the operator's keys, so rewriting from the empty
 * read would delete them; callers refuse or skip instead.
 */
function readForUpdate(agentDir: string): SentinelWebSearchConfig | null {
	const path = websearchJsonPath(agentDir);
	if (!existsSync(path)) return emptyWebSearchConfig();
	try {
		return normalizeWebSearchConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return null;
	}
}

export function writeWebSearchConfig(agentDir: string, config: SentinelWebSearchConfig): void {
	const path = websearchJsonPath(agentDir);
	const normalized = normalizeWebSearchConfig(config);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalized, null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}

/**
 * A key serves the pool when it is switched on, holds a key, and passed its last
 * probe. A failed key stays configured but contributes nothing until 测试连接
 * (or the next query, which refreshes the status) says otherwise.
 */
export function isKeyUsable(entry: SentinelWebSearchKeyConfig): boolean {
	return entry.enabled && entry.key.length > 0 && entry.status.ok && entry.status.at !== null;
}

export function usableKeys(agentDir: string): SentinelWebSearchKeyConfig[] {
	return readWebSearchConfig(agentDir).keys.filter(isKeyUsable);
}

/** Add or update one key. `key: null` keeps the stored secret; `""` is rejected. */
export function saveWebSearchKey(
	agentDir: string,
	input: { id?: string; label: string; key?: string | null; enabled: boolean },
): SentinelWebSearchConfig {
	const config = readForUpdate(agentDir);
	if (!config) throw new Error(`${websearchJsonPath(agentDir)} 无法解析，请先修复或删除该文件再保存`);
	const existing = input.id ? config.keys.find((entry) => entry.id === input.id) : undefined;
	const key = input.key === null || input.key === undefined ? (existing?.key ?? "") : asKey(input.key);
	if (existing) {
		existing.label = input.label.trim() || existing.label;
		if (input.key !== null && input.key !== undefined && asKey(input.key) !== existing.key) {
			// A replaced key is unverified until the next probe proves it.
			existing.key = asKey(input.key);
			existing.status = emptyStatus();
		}
		existing.enabled = input.enabled;
	} else {
		if (!key) throw new Error("新 Key 必须填写密钥");
		if (config.keys.length >= MAX_WEBSEARCH_KEYS) throw new Error(`号池最多 ${MAX_WEBSEARCH_KEYS} 个 Key`);
		config.keys.push({
			id: `tvk-${randomUUID().slice(0, 8)}`,
			label: input.label.trim() || "未命名 Key",
			key,
			enabled: input.enabled,
			status: emptyStatus(),
		});
	}
	writeWebSearchConfig(agentDir, config);
	return readWebSearchConfig(agentDir);
}

export function deleteWebSearchKey(agentDir: string, id: string): SentinelWebSearchConfig {
	const config = readForUpdate(agentDir);
	if (!config) throw new Error(`${websearchJsonPath(agentDir)} 无法解析，请先修复或删除该文件再保存`);
	config.keys = config.keys.filter((entry) => entry.id !== id);
	writeWebSearchConfig(agentDir, config);
	return readWebSearchConfig(agentDir);
}

export function setWebSearchQueryLimit(agentDir: string, limit: number): SentinelWebSearchConfig {
	const config = readForUpdate(agentDir);
	if (!config) throw new Error(`${websearchJsonPath(agentDir)} 无法解析，请先修复或删除该文件再保存`);
	config.sessionQueryLimit = asLimit(limit);
	writeWebSearchConfig(agentDir, config);
	return readWebSearchConfig(agentDir);
}

export function recordWebSearchKeyStatus(agentDir: string, id: string, status: SentinelAssetStatus): void {
	const config = readForUpdate(agentDir);
	if (!config) return;
	const entry = config.keys.find((candidate) => candidate.id === id);
	if (!entry) return;
	entry.status = asStatus(status);
	writeWebSearchConfig(agentDir, config);
}

/** Alias used by the session runtime; reads as the same list. */
export const usablePoolKeys = usableKeys;

/** The view the console renders: rows without secrets, plus the pool headline. */
export function webSearchConfigView(agentDir: string): SentinelWebSearchConfigView {
	const config = readWebSearchConfig(agentDir);
	const keys = config.keys.map((entry) => ({
		id: entry.id,
		label: entry.label,
		enabled: entry.enabled,
		hasKey: entry.key.length > 0,
		verified: entry.status.ok && entry.status.at !== null,
		status: entry.status,
		...(entry.key.length >= 4 ? { tail: entry.key.slice(-4) } : {}),
	}));
	return {
		keys,
		sessionQueryLimit: config.sessionQueryLimit,
		usable: keys.filter((key) => key.enabled && key.hasKey && key.verified).length,
	};
}
