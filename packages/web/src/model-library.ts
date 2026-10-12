/**
 * The model library: every OpenAI-compatible endpoint the operator entered, plus
 * which entry each role uses.
 *
 * Problem it solves: the old layout had three fixed slots (`zg-endpoint`,
 * `zg-commander`, `zg-judge`), so "add a second model and use it for the
 * reviewer" was impossible without hand-editing models.json. Now models.json
 * holds one provider per library entry and this file holds what the SDK schema
 * has no place for: display names, role assignments, and the reviewer switch.
 *
 * Roles are references, not copies. `main` names an entry (or null when nothing
 * is configured); `judge` and `reviewer` may instead be "follow-main", which is
 * the old fallback chain made explicit. Deleting an entry that a role still
 * points at is refused, because a silently swapped judge changes security
 * behavior.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	NO_AUTH_PLACEHOLDER_KEY,
	readProviderModelConfig,
	removeProviderModelConfig,
	writeProviderModelConfig,
	ZG_COMMANDER_PROVIDER_ID,
	ZG_JUDGE_PROVIDER_ID,
	ZG_PROVIDER_ID,
} from "./model-config.ts";
import type {
	ZGModelConfig,
	ZGModelEntryView,
	ZGModelLibraryView,
	ZGModelRoleName,
	ZGResolvedModelView,
} from "./protocol.ts";

export const MODEL_LIBRARY_VERSION = 1;
/** New entries get ids in this namespace; the three legacy slot ids stay as they are. */
export const NEW_ENTRY_ID_PREFIX = "zg-model-";
/** The value a role holds when it should use whatever `main` uses. */
export const FOLLOW_MAIN = "follow-main";

export const ZG_MODEL_ROLE_NAMES: ZGModelRoleName[] = ["main", "judge", "reviewer"];
export const ZG_MODEL_ROLE_LABELS: Record<ZGModelRoleName, string> = {
	main: "主模型",
	judge: "守门模型",
	reviewer: "漏洞评审",
};

export interface ZGModelEntry {
	id: string;
	name: string;
}

/** `main` cannot follow itself, so it is either an entry or nothing. */
export type ZGRoleMainRef = { kind: "model"; id: string } | null;
export type ZGRoleRef = { kind: "model"; id: string } | { kind: "follow-main" };

export interface ZGModelLibrary {
	version: number;
	entries: ZGModelEntry[];
	roles: {
		main: ZGRoleMainRef;
		judge: ZGRoleRef;
		reviewer: ZGRoleRef;
	};
	/** When off, submissions are not queued for the reviewer at all. */
	reviewerAuto: boolean;
}

export interface ZGResolvedModel {
	config: ZGModelConfig;
	entryId: string;
	entryName: string;
	/** True when the role resolved through `main` rather than its own entry. */
	followedMain: boolean;
}

export interface ZGModelEntryInput {
	name: string;
	baseUrl: string;
	apiKey: string;
	modelId: string;
}

/** `apiKey: null` keeps the stored key; "" clears it (unauthenticated endpoint). */
export interface ZGModelEntryPatch {
	name: string;
	baseUrl: string;
	apiKey: string | null;
	modelId: string;
}

export function modelLibraryPath(agentDir: string): string {
	return `${agentDir}/model-library.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Tolerant parse: an unreadable or hand-edited file degrades to "fewer entries",
 * never to a crash. References to entries that no longer exist are dropped.
 */
export function normalizeModelLibrary(value: unknown): ZGModelLibrary {
	const source = isRecord(value) ? value : {};
	const entries: ZGModelEntry[] = [];
	if (Array.isArray(source.entries)) {
		for (const raw of source.entries) {
			if (!isRecord(raw)) continue;
			const id = nonEmptyString(raw.id);
			if (!id || entries.some((entry) => entry.id === id)) continue;
			entries.push({ id, name: nonEmptyString(raw.name) ?? id });
		}
	}
	const has = (id: string): boolean => entries.some((entry) => entry.id === id);
	const roleRef = (raw: unknown, fallback: ZGRoleRef): ZGRoleRef => {
		if (!isRecord(raw)) return fallback;
		if (raw.kind === "follow-main") return { kind: "follow-main" };
		const id = nonEmptyString(raw.id);
		return raw.kind === "model" && id && has(id) ? { kind: "model", id } : fallback;
	};
	const rawRoles = isRecord(source.roles) ? source.roles : {};
	const rawMain = isRecord(rawRoles.main) ? rawRoles.main : null;
	const mainId = rawMain?.kind === "model" ? nonEmptyString(rawMain.id) : null;
	return {
		version: typeof source.version === "number" ? source.version : MODEL_LIBRARY_VERSION,
		entries,
		roles: {
			main: mainId && has(mainId) ? { kind: "model", id: mainId } : null,
			judge: roleRef(rawRoles.judge, { kind: "follow-main" }),
			reviewer: roleRef(rawRoles.reviewer, { kind: "follow-main" }),
		},
		reviewerAuto: typeof source.reviewerAuto === "boolean" ? source.reviewerAuto : true,
	};
}

/** The persisted library, or null when the file does not exist yet. */
export function readStoredModelLibrary(agentDir: string): ZGModelLibrary | null {
	const path = modelLibraryPath(agentDir);
	if (!existsSync(path)) return null;
	try {
		return normalizeModelLibrary(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return null;
	}
}

/**
 * The library in effect. When no library file exists yet the legacy slots are
 * translated in memory, so a runtime read before the operator ever opens
 * 设置 → 模型 behaves exactly as before the upgrade.
 */
export function readModelLibrary(agentDir: string): ZGModelLibrary {
	return readStoredModelLibrary(agentDir) ?? migrateModelLibrary(agentDir);
}

export function writeModelLibrary(agentDir: string, library: ZGModelLibrary): void {
	const path = modelLibraryPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalizeModelLibrary(library), null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}

/**
 * Translate the fixed slots into library entries.
 *
 * The entry ids are the slot ids, so models.json needs no rewrite and a
 * downgrade still finds `zg-endpoint` / `zg-commander` / `zg-judge`. Role
 * assignment reproduces what the old code resolved at runtime: the reviewer used
 * `commander ?? main`, the judge used `judge ?? commander ?? main`.
 */
export function migrateModelLibrary(agentDir: string): ZGModelLibrary {
	const entries: ZGModelEntry[] = [];
	const add = (providerId: string, name: string): void => {
		if (readProviderModelConfig(agentDir, providerId)) entries.push({ id: providerId, name });
	};
	add(ZG_PROVIDER_ID, "主端点");
	add(ZG_COMMANDER_PROVIDER_ID, "指挥官端点");
	add(ZG_JUDGE_PROVIDER_ID, "守门端点");
	const has = (id: string): boolean => entries.some((entry) => entry.id === id);
	const judge: ZGRoleRef = has(ZG_JUDGE_PROVIDER_ID)
		? { kind: "model", id: ZG_JUDGE_PROVIDER_ID }
		: has(ZG_COMMANDER_PROVIDER_ID)
			? { kind: "model", id: ZG_COMMANDER_PROVIDER_ID }
			: { kind: "follow-main" };
	const reviewer: ZGRoleRef = has(ZG_COMMANDER_PROVIDER_ID)
		? { kind: "model", id: ZG_COMMANDER_PROVIDER_ID }
		: { kind: "follow-main" };
	return normalizeModelLibrary({
		version: MODEL_LIBRARY_VERSION,
		entries,
		roles: { main: has(ZG_PROVIDER_ID) ? { kind: "model", id: ZG_PROVIDER_ID } : null, judge, reviewer },
		reviewerAuto: true,
	});
}

/** Roles that currently point at this entry, for the delete guard and the table. */
export function rolesUsing(library: ZGModelLibrary, entryId: string): ZGModelRoleName[] {
	const roles: ZGModelRoleName[] = [];
	for (const role of ZG_MODEL_ROLE_NAMES) {
		const ref = library.roles[role];
		if (ref && ref.kind === "model" && ref.id === entryId) roles.push(role);
	}
	return roles;
}

/** Wire form of a resolved role, for the settings screen and the snapshot. */
export function toResolvedModelView(resolved: ZGResolvedModel | null): ZGResolvedModelView | null {
	if (!resolved) return null;
	return {
		entryId: resolved.entryId,
		entryName: resolved.entryName,
		modelId: resolved.config.modelId,
		followedMain: resolved.followedMain,
	};
}

function resolveEntry(
	agentDir: string,
	library: ZGModelLibrary,
	id: string,
	followedMain: boolean,
): ZGResolvedModel | null {
	const entry = library.entries.find((candidate) => candidate.id === id);
	if (!entry) return null;
	const config = readProviderModelConfig(agentDir, id);
	if (!config) return null;
	return { config, entryId: id, entryName: entry.name, followedMain };
}

/** Resolve one role to a usable endpoint, or null when nothing resolves. */
export function resolveLibraryRole(agentDir: string, role: ZGModelRoleName): ZGResolvedModel | null {
	const library = readModelLibrary(agentDir);
	const mainRef = library.roles.main;
	if (role === "main") {
		return mainRef ? resolveEntry(agentDir, library, mainRef.id, false) : null;
	}
	const ref: ZGRoleRef = role === "judge" ? library.roles.judge : library.roles.reviewer;
	if (ref.kind === "model") return resolveEntry(agentDir, library, ref.id, false);
	return mainRef ? resolveEntry(agentDir, library, mainRef.id, true) : null;
}

/** The settings-page view: entries with their endpoint and role usage, never the key itself. */
export function libraryView(agentDir: string): ZGModelLibraryView {
	const library = readModelLibrary(agentDir);
	const entries: ZGModelEntryView[] = library.entries.map((entry) => {
		const config = readProviderModelConfig(agentDir, entry.id);
		return {
			id: entry.id,
			name: entry.name,
			baseUrl: config?.baseUrl ?? "",
			modelId: config?.modelId ?? "",
			hasKey: Boolean(config?.apiKey && config.apiKey !== NO_AUTH_PLACEHOLDER_KEY),
			roles: rolesUsing(library, entry.id),
		};
	});
	return {
		entries,
		roles: {
			main: library.roles.main?.id ?? null,
			judge: library.roles.judge.kind === "model" ? library.roles.judge.id : FOLLOW_MAIN,
			reviewer: library.roles.reviewer.kind === "model" ? library.roles.reviewer.id : FOLLOW_MAIN,
		},
		reviewerAuto: library.reviewerAuto,
		resolved: {
			main: toResolvedModelView(resolveLibraryRole(agentDir, "main")),
			judge: toResolvedModelView(resolveLibraryRole(agentDir, "judge")),
			reviewer: toResolvedModelView(resolveLibraryRole(agentDir, "reviewer")),
		},
	};
}

/** Next free `zg-model-N` id. */
export function nextEntryId(entries: ZGModelEntry[]): string {
	let max = 0;
	for (const entry of entries) {
		if (!entry.id.startsWith(NEW_ENTRY_ID_PREFIX)) continue;
		const suffix = Number.parseInt(entry.id.slice(NEW_ENTRY_ID_PREFIX.length), 10);
		if (Number.isFinite(suffix) && suffix > max) max = suffix;
	}
	return `${NEW_ENTRY_ID_PREFIX}${max + 1}`;
}

function requireEntry(library: ZGModelLibrary, id: string): ZGModelEntry {
	const entry = library.entries.find((candidate) => candidate.id === id);
	if (!entry) throw new Error("模型不存在，可能已被删除");
	return entry;
}

function cleanInput(input: ZGModelEntryPatch): { name: string; baseUrl: string; modelId: string } {
	const baseUrl = input.baseUrl.trim();
	const modelId = input.modelId.trim();
	if (!baseUrl) throw new Error("Base URL 不能为空");
	if (!modelId) throw new Error("模型 ID 不能为空");
	return { name: input.name.trim() || modelId, baseUrl, modelId };
}

/** Add an entry. The first entry becomes the main model, so the app is usable at once. */
export function addLibraryEntry(agentDir: string, input: ZGModelEntryInput): ZGModelEntry {
	const library = readModelLibrary(agentDir);
	const clean = cleanInput(input);
	const entry: ZGModelEntry = { id: nextEntryId(library.entries), name: clean.name };
	writeProviderModelConfig(agentDir, entry.id, entry.name, {
		baseUrl: clean.baseUrl,
		apiKey: input.apiKey.trim(),
		modelId: clean.modelId,
	});
	library.entries.push(entry);
	if (!library.roles.main) library.roles.main = { kind: "model", id: entry.id };
	writeModelLibrary(agentDir, library);
	return entry;
}

export function updateLibraryEntry(agentDir: string, id: string, patch: ZGModelEntryPatch): ZGModelEntry {
	const library = readModelLibrary(agentDir);
	const entry = requireEntry(library, id);
	const clean = cleanInput(patch);
	const previous = readProviderModelConfig(agentDir, id);
	// null keeps the stored key: the form never renders it back.
	const apiKey = patch.apiKey === null ? (previous?.apiKey ?? "") : patch.apiKey.trim();
	writeProviderModelConfig(agentDir, id, clean.name, { baseUrl: clean.baseUrl, apiKey, modelId: clean.modelId });
	entry.name = clean.name;
	writeModelLibrary(agentDir, library);
	return entry;
}

export function duplicateLibraryEntry(agentDir: string, id: string): ZGModelEntry {
	const library = readModelLibrary(agentDir);
	const source = requireEntry(library, id);
	const config = readProviderModelConfig(agentDir, id);
	if (!config) throw new Error("这个模型没有可复制的端点配置");
	const entry: ZGModelEntry = { id: nextEntryId(library.entries), name: `${source.name} 副本` };
	writeProviderModelConfig(agentDir, entry.id, entry.name, config);
	library.entries.push(entry);
	writeModelLibrary(agentDir, library);
	return entry;
}

/** Delete an entry. Refused while any role still points at it. */
export function removeLibraryEntry(agentDir: string, id: string): void {
	const library = readModelLibrary(agentDir);
	const entry = requireEntry(library, id);
	const used = rolesUsing(library, id);
	if (used.length > 0) {
		const labels = used.map((role) => ZG_MODEL_ROLE_LABELS[role]).join("、");
		throw new Error(`「${entry.name}」正被 ${labels} 使用，请先改掉这些角色再删除`);
	}
	library.entries = library.entries.filter((candidate) => candidate.id !== id);
	writeModelLibrary(agentDir, library);
	removeProviderModelConfig(agentDir, id);
}

/** Point a role at an entry, or at `main` for judge/reviewer. */
export function setLibraryRole(agentDir: string, role: ZGModelRoleName, target: string | null): ZGModelLibrary {
	const library = readModelLibrary(agentDir);
	if (role === "main") {
		if (target === null) {
			library.roles.main = null;
		} else {
			if (target === FOLLOW_MAIN) throw new Error("主模型不能跟随主模型");
			requireEntry(library, target);
			library.roles.main = { kind: "model", id: target };
		}
	} else if (target === FOLLOW_MAIN) {
		library.roles[role] = { kind: "follow-main" };
	} else if (target === null) {
		throw new Error("这个角色必须选择一条模型或跟随主模型");
	} else {
		requireEntry(library, target);
		library.roles[role] = { kind: "model", id: target };
	}
	writeModelLibrary(agentDir, library);
	return library;
}

export function setReviewerAuto(agentDir: string, enabled: boolean): ZGModelLibrary {
	const library = readModelLibrary(agentDir);
	library.reviewerAuto = enabled;
	writeModelLibrary(agentDir, library);
	return library;
}
