/**
 * Gatekeeper settings stored in gatekeeper.json: the console-wide default mode,
 * plus the judge's per-command timeout and concurrency budget.
 *
 * The mode is a global default rather than the live mode. A session may carry
 * its own override in its JSONL file (see session-mode.ts); this file is what
 * every session without one follows, and it is the only mode that survives a
 * console restart.
 *
 * The judge endpoint itself is not here: it is a provider entry in models.json
 * (zg-judge), so all three endpoints are configured the same way.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	SENTINEL_MODES,
	type SentinelGatekeeperConfig,
	type SentinelMcpToolGate,
	type SentinelMode,
} from "./protocol.ts";

/** One judgment may take this long before it counts as a failure. */
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;

/** Judgments allowed in flight at once; 0 means no limit. */
export const DEFAULT_CONCURRENCY = 0;
export const MAX_CONCURRENCY = 64;

/**
 * The default is the operator-approval mode: the console starts with the mode
 * that asks a human, never one that acts on its own.
 *
 * MCP judging is on by default but plugins are not: the request was "默认只守门
 * MCP", and plugin tools are the noisy ones — a single plugin can expose dozens
 * of tools, each costing a judgment. Both switches live in 设置 → 模型.
 */
const DEFAULT_CONFIG: SentinelGatekeeperConfig = {
	mode: "review",
	timeoutMs: DEFAULT_TIMEOUT_MS,
	concurrency: DEFAULT_CONCURRENCY,
	mcpTools: { enabled: true, includePlugins: false },
};

export function gatekeeperJsonPath(agentDir: string): string {
	return `${agentDir}/gatekeeper.json`;
}

function isMode(value: unknown): value is SentinelMode {
	return typeof value === "string" && (SENTINEL_MODES as readonly string[]).includes(value);
}

/** Clamp a stored number into its usable range; a bad value reads as the default. */
function coerceNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

/** A file written before these switches existed reads as the defaults. */
function normalizeMcpTools(raw: unknown): SentinelMcpToolGate {
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	return {
		enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_CONFIG.mcpTools.enabled,
		includePlugins:
			typeof record.includePlugins === "boolean" ? record.includePlugins : DEFAULT_CONFIG.mcpTools.includePlugins,
	};
}

/** Coerce an untrusted object into a usable config. */
export function normalizeGatekeeperConfig(raw: unknown): SentinelGatekeeperConfig {
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	return {
		mode: isMode(record.mode) ? record.mode : DEFAULT_CONFIG.mode,
		timeoutMs: coerceNumber(record.timeoutMs, DEFAULT_CONFIG.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
		concurrency: coerceNumber(record.concurrency, DEFAULT_CONFIG.concurrency, 0, MAX_CONCURRENCY),
		mcpTools: normalizeMcpTools(record.mcpTools),
	};
}

/** Read the persisted settings; a missing or corrupt file reads as the defaults. */
export function readGatekeeperConfig(agentDir: string): SentinelGatekeeperConfig {
	const path = gatekeeperJsonPath(agentDir);
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		return normalizeGatekeeperConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		// A corrupt file must not lock the console out of a usable mode.
		return { ...DEFAULT_CONFIG };
	}
}

export function writeGatekeeperConfig(agentDir: string, config: SentinelGatekeeperConfig): void {
	const path = gatekeeperJsonPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalizeGatekeeperConfig(config), null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}
