/**
 * Global supervision settings, stored in `supervisor.json`.
 *
 * Mode, delivery and the strategy note belong to one conversation and are
 * chosen in the composer before its first message. This file holds the master
 * switch, the thresholds, and the default strategy for new conversations.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	SentinelSupervisorConfig,
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorStrategy,
} from "./protocol.ts";

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
	defaultStrategy: "steady",
	customStrategies: [],
	defaultCustomStrategyId: null,
};

const MIN_BATCH = 5;
const MAX_BATCH = 100;
const MIN_THRESHOLD = 2;
const MAX_THRESHOLD = 50;
const MIN_TIMEOUT = 5_000;
const MAX_TIMEOUT = 300_000;
const MAX_CUSTOM_STRATEGIES = 12;
const MAX_CUSTOM_NAME = 30;
const MAX_CUSTOM_DESCRIPTION = 80;
const MAX_CUSTOM_INSTRUCTIONS = 500;

export function isSupervisorStrategy(value: unknown): value is SentinelSupervisorStrategy {
	return value === "steady" || value === "validation" || value === "offensive" || value === "stealth";
}

function customText(value: unknown, limit: number): string {
	return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function normalizeCustomStrategies(raw: unknown): SentinelSupervisorCustomStrategy[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const result: SentinelSupervisorCustomStrategy[] = [];
	for (const entry of raw.slice(0, MAX_CUSTOM_STRATEGIES)) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const name = customText(record.name, MAX_CUSTOM_NAME);
		const instructions = customText(record.instructions, MAX_CUSTOM_INSTRUCTIONS);
		if (!name || !instructions) continue;
		let id = customText(record.id, 80);
		if (!id.startsWith("custom-")) id = `custom-${randomUUID()}`;
		while (seen.has(id)) id = `custom-${randomUUID()}`;
		seen.add(id);
		const now = Date.now();
		result.push({
			id,
			name,
			base: isSupervisorStrategy(record.base) ? record.base : "steady",
			description: customText(record.description, MAX_CUSTOM_DESCRIPTION) || name,
			instructions,
			createdAt: typeof record.createdAt === "number" ? record.createdAt : now,
			updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : now,
		});
	}
	return result;
}

export function supervisorJsonPath(agentDir: string): string {
	return `${agentDir}/supervisor.json`;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeSupervisorConfig(raw: unknown): SentinelSupervisorConfig {
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const customStrategies = normalizeCustomStrategies(record.customStrategies);
	const defaultCustomStrategyId =
		typeof record.defaultCustomStrategyId === "string" &&
		customStrategies.some((strategy) => strategy.id === record.defaultCustomStrategyId)
			? record.defaultCustomStrategyId
			: null;
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
		defaultStrategy: isSupervisorStrategy(record.defaultStrategy)
			? record.defaultStrategy
			: SUPERVISOR_DEFAULTS.defaultStrategy,
		customStrategies,
		defaultCustomStrategyId,
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
