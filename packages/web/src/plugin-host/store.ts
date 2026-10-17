/**
 * On-disk state of one plugin host.
 *
 * Everything the host needs to survive a restart lives under one directory:
 *
 *   host.json                 token, port, pid (0640: the console reads it)
 *   plugins/<id>/manifest.json
 *   plugins/<id>/record.json  install metadata; no secrets
 *   plugins/<id>/config.json  PLUGIN_* values (0600, never returned by the API)
 *   plugins/<id>/data/        mounted at /data
 *   plugins/<id>/artifacts/   mounted at /artifacts
 *
 * The manifest is stored rather than re-read from the author's repository: an
 * installed plugin is pinned to the digest it was installed with, and a later
 * change to the repository must not change what is already running.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SentinelPluginManifest } from "../plugin-manifest.ts";
import { parsePluginManifest } from "../plugin-manifest.ts";

export const PLUGIN_HOST_STATE_VERSION = 1;

export interface PluginHostState {
	version: number;
	token: string;
	port: number;
	pid: number;
	startedAt: number;
}

/** One installed plugin, without its secrets and without live container state. */
export interface StoredPluginRecord {
	manifest: SentinelPluginManifest;
	installedAt: number;
	updatedAt: number;
	/** What the operator approved at install time; a later edit cannot widen it. */
	allowHostNetwork: boolean;
	containerName: string;
	hostPort: number | null;
	lastError: string | null;
}

export type PluginRuntimeState = "running" | "starting" | "stopped" | "failed" | "missing";

export interface PluginView {
	manifest: SentinelPluginManifest;
	installedAt: number;
	updatedAt: number;
	/** Whether the container answers its health check right now. */
	state: PluginRuntimeState;
	healthy: boolean;
	hostPort: number | null;
	allowHostNetwork: boolean;
	/** Which config keys have a stored value. */
	configured: string[];
	/** Stored values of non-secret fields; secrets are only reported as configured. */
	values: Record<string, string>;
	lastError: string | null;
}

export function hostStatePath(dataDir: string): string {
	return join(dataDir, "host.json");
}

export function pluginsRoot(dataDir: string): string {
	return join(dataDir, "plugins");
}

export function pluginDir(dataDir: string, id: string): string {
	return join(pluginsRoot(dataDir), id);
}

export function pluginManifestPath(dataDir: string, id: string): string {
	return join(pluginDir(dataDir, id), "manifest.json");
}

export function pluginRecordPath(dataDir: string, id: string): string {
	return join(pluginDir(dataDir, id), "record.json");
}

export function pluginConfigPath(dataDir: string, id: string): string {
	return join(pluginDir(dataDir, id), "config.json");
}

export function pluginDataDir(dataDir: string, id: string): string {
	return join(pluginDir(dataDir, id), "data");
}

export function pluginArtifactsDir(dataDir: string, id: string): string {
	return join(pluginDir(dataDir, id), "artifacts");
}

function writeFileAtomic(path: string, body: string, mode: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, body, { mode });
	renameSync(temporary, path);
	try {
		chmodSync(path, mode);
	} catch {
		// chmod is best effort on filesystems that do not implement it
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

export function writeHostState(dataDir: string, state: PluginHostState): void {
	mkdirSync(dataDir, { recursive: true });
	writeFileAtomic(hostStatePath(dataDir), `${JSON.stringify(state, null, "\t")}\n`, 0o640);
}

/** The running host's state file, or null when no host was started in this directory. */
export function readHostState(dataDir: string): PluginHostState | null {
	const raw = readJson(hostStatePath(dataDir));
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Partial<PluginHostState>;
	if (typeof value.token !== "string" || !value.token) return null;
	if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port <= 0) return null;
	return {
		version: typeof value.version === "number" ? value.version : PLUGIN_HOST_STATE_VERSION,
		token: value.token,
		port: value.port,
		pid: typeof value.pid === "number" ? value.pid : 0,
		startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
	};
}

/** Write one installed plugin. The manifest is re-parsed so a hand-edited file cannot smuggle a tag-only image in. */
export function writePluginRecord(dataDir: string, record: StoredPluginRecord): void {
	const parsed = parsePluginManifest(record.manifest);
	if (!parsed.ok) throw new Error(`manifest 无效：${parsed.errors.join("；")}`);
	const dir = pluginDir(dataDir, parsed.manifest.id);
	mkdirSync(dir, { recursive: true });
	mkdirSync(pluginDataDir(dataDir, parsed.manifest.id), { recursive: true });
	mkdirSync(pluginArtifactsDir(dataDir, parsed.manifest.id), { recursive: true });
	writeFileAtomic(
		pluginManifestPath(dataDir, parsed.manifest.id),
		`${JSON.stringify(parsed.manifest, null, "\t")}\n`,
		0o644,
	);
	const stored: StoredPluginRecord = { ...record, manifest: parsed.manifest };
	writeFileAtomic(pluginRecordPath(dataDir, parsed.manifest.id), `${JSON.stringify(stored, null, "\t")}\n`, 0o644);
}

export function readPluginRecord(dataDir: string, id: string): StoredPluginRecord | null {
	if (!existsSync(pluginRecordPath(dataDir, id))) return null;
	const raw = readJson(pluginManifestPath(dataDir, id));
	const parsed = parsePluginManifest(raw);
	if (!parsed.ok) return null;
	const meta = readJson(pluginRecordPath(dataDir, id));
	const value = meta && typeof meta === "object" ? (meta as Partial<StoredPluginRecord>) : {};
	return {
		manifest: parsed.manifest,
		installedAt: typeof value.installedAt === "number" ? value.installedAt : 0,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
		allowHostNetwork: value.allowHostNetwork === true,
		containerName:
			typeof value.containerName === "string" ? value.containerName : containerNameFor(parsed.manifest.id),
		hostPort: typeof value.hostPort === "number" ? value.hostPort : null,
		lastError: typeof value.lastError === "string" ? value.lastError : null,
	};
}

/** Every installed plugin, sorted by id so lists and tests are stable. */
export function listPluginRecords(dataDir: string): StoredPluginRecord[] {
	if (!existsSync(pluginsRoot(dataDir))) return [];
	const records: StoredPluginRecord[] = [];
	for (const entry of readdirSync(pluginsRoot(dataDir), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const record = readPluginRecord(dataDir, entry.name);
		if (record) records.push(record);
	}
	return records.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

export function deletePluginRecord(dataDir: string, id: string, purge: boolean): void {
	const dir = pluginDir(dataDir, id);
	if (purge) rmSync(dir, { recursive: true, force: true });
	else {
		// Keep /data and /artifacts: reinstalling should not silently discard evidence.
		rmSync(pluginManifestPath(dataDir, id), { force: true });
		rmSync(pluginRecordPath(dataDir, id), { force: true });
		rmSync(pluginConfigPath(dataDir, id), { force: true });
	}
}

/** Config values as stored; secrets included, so callers must not log or return this. */
export function readPluginConfigValues(dataDir: string, id: string): Record<string, string> {
	const raw = readJson(pluginConfigPath(dataDir, id));
	if (!raw || typeof raw !== "object") return {};
	const values = (raw as { values?: unknown }).values;
	if (!values || typeof values !== "object" || Array.isArray(values)) return {};
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

export function writePluginConfigValues(dataDir: string, id: string, values: Record<string, string>): void {
	mkdirSync(pluginDir(dataDir, id), { recursive: true });
	writeFileAtomic(pluginConfigPath(dataDir, id), `${JSON.stringify({ values }, null, "\t")}\n`, 0o600);
}

/** Which declared keys have a stored value; the console shows this instead of the values. */
export function configuredKeys(manifest: SentinelPluginManifest, values: Record<string, string>): string[] {
	return manifest.config.filter((field) => values[field.key]).map((field) => field.key);
}

export function containerNameFor(id: string): string {
	return `sentinel-plugin-${id.replace(/[^a-z0-9]+/g, "-")}`;
}
