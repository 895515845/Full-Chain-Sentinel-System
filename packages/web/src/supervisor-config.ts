/**
 * Global supervision settings, stored in `supervisor.json`.
 *
 * Mode and delivery are not here: they belong to one conversation and are
 * chosen in the composer before its first message. This file only holds the
 * master switch and the thresholds every supervised conversation shares.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SentinelSupervisorConfig } from "./protocol.ts";

export const SUPERVISOR_DEFAULTS: SentinelSupervisorConfig = {
	enabled: true,
	batchToolCalls: 20,
	duplicateThreshold: 3,
	noProgressCalls: 10,
	errorStreak: 3,
	// A reasoning model can take minutes on a 20-call batch. 180s leaves room for
	// the first attempt and the 8192-token retry without a bare abort.
	timeoutMs: 180_000,
	redactSecrets: true,
};

const MIN_BATCH = 5;
const MAX_BATCH = 100;
const MIN_THRESHOLD = 2;
const MAX_THRESHOLD = 50;
const MIN_TIMEOUT = 5_000;
const MAX_TIMEOUT = 300_000;

export function supervisorJsonPath(agentDir: string): string {
	return `${agentDir}/supervisor.json`;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeSupervisorConfig(raw: unknown): SentinelSupervisorConfig {
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	return {
		enabled: typeof record.enabled === "boolean" ? record.enabled : SUPERVISOR_DEFAULTS.enabled,
		batchToolCalls: clamp(record.batchToolCalls, SUPERVISOR_DEFAULTS.batchToolCalls, MIN_BATCH, MAX_BATCH),
		duplicateThreshold: clamp(
			record.duplicateThreshold,
			SUPERVISOR_DEFAULTS.duplicateThreshold,
			MIN_THRESHOLD,
			MAX_THRESHOLD,
		),
		noProgressCalls: clamp(record.noProgressCalls, SUPERVISOR_DEFAULTS.noProgressCalls, MIN_THRESHOLD, MAX_THRESHOLD),
		errorStreak: clamp(record.errorStreak, SUPERVISOR_DEFAULTS.errorStreak, MIN_THRESHOLD, MAX_THRESHOLD),
		timeoutMs: clamp(record.timeoutMs, SUPERVISOR_DEFAULTS.timeoutMs, MIN_TIMEOUT, MAX_TIMEOUT),
		redactSecrets:
			typeof record.redactSecrets === "boolean" ? record.redactSecrets : SUPERVISOR_DEFAULTS.redactSecrets,
	};
}

export function readSupervisorConfig(agentDir: string): SentinelSupervisorConfig {
	const path = supervisorJsonPath(agentDir);
	if (!existsSync(path)) return { ...SUPERVISOR_DEFAULTS };
	try {
		return normalizeSupervisorConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		// A corrupt file must not disable a feature the operator cannot see.
		return { ...SUPERVISOR_DEFAULTS };
	}
}

export function writeSupervisorConfig(agentDir: string, config: SentinelSupervisorConfig): void {
	const path = supervisorJsonPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalizeSupervisorConfig(config), null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}
