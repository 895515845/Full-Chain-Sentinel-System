/**
 * Preset agents: named blocks of extra system-prompt context.
 *
 * A preset is context, not capability. It contributes text to a session's
 * system prompt and nothing else — no tools, no skills, no model. That keeps
 * "which agent am I working with" a question about knowledge and framing, while
 * "what may it do" stays with the permission switches, where exactly one place
 * decides it. A preset that could widen tools would be a second answer to that
 * question, and the operator would have to check both.
 *
 * Storage is split on purpose. `presets.json` holds metadata (name, description,
 * tags, enabled); `presets/<id>.md` holds the body. Prompt text is what
 * operators actually write, and a markdown file is diffable, greppable and
 * copyable between machines — burying it in a JSON string would make every edit
 * a JSON edit. The metadata file is the index, so a preset whose body went
 * missing is reported as broken instead of silently contributing nothing.
 *
 * A missing or corrupt `presets.json` reads as an empty list: a broken config
 * file must not lock the console, which is the rule every other reader follows.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SentinelPreset, SentinelPresetView } from "./protocol.ts";

/** Metadata file, next to the other console config. */
export const PRESETS_FILE = "presets.json";
/** Directory holding one `<id>.md` per preset. */
export const PRESETS_DIR = "presets";

/** Longest accepted preset name; the sidebar and brief both show it inline. */
export const MAX_PRESET_NAME_CHARS = 60;
/** Longest accepted description. The brief shows only its first 80 characters. */
export const MAX_PRESET_DESCRIPTION_CHARS = 200;
/** Longest accepted composer hint. It has to read as one line above the input. */
export const MAX_PRESET_PLACEHOLDER_CHARS = 120;
/** Longest accepted tag, and how many a preset may carry. */
export const MAX_PRESET_TAG_CHARS = 24;
export const MAX_PRESET_TAGS = 12;

/**
 * Commander-brief limits. The preset list enters the commander's context on
 * every round, so an operator with forty presets must not push the board and the
 * target list out of it. Beyond `PRESET_BRIEF_MAX` the brief names the overflow
 * and asks for a shorter list rather than silently dropping entries.
 */
export const PRESET_BRIEF_MAX = 30;
export const PRESET_BRIEF_DESCRIPTION_CHARS = 80;
export const PRESET_BRIEF_MAX_TAGS = 5;

/** Rough token-cost thresholds the settings screen colours against. */
export const PRESET_TOKEN_WARN = 2000;
export const PRESET_TOKEN_DANGER = 8000;

/** Format marker and version of an exported preset file. */
export const PRESETS_EXPORT_FORMAT = "sentinel-presets";
export const PRESETS_EXPORT_VERSION = 1;

/** One preset with its body, as written to and read from an export file. */
export interface SentinelPresetExportEntry extends SentinelPreset {
	text: string;
}

export interface SentinelPresetExport {
	format: typeof PRESETS_EXPORT_FORMAT;
	version: number;
	exportedAt: number;
	presets: SentinelPresetExportEntry[];
}

export interface SentinelPresetImportResult {
	imported: SentinelPreset[];
	/** Entries that could not be imported, with the reason shown to the operator. */
	skipped: Array<{ name: string; reason: string }>;
	/** Set when the file itself is unusable; per-entry problems go to `skipped`. */
	error?: string;
}

export type SentinelPresetTokenLevel = "ok" | "warn" | "danger";

export function presetsPath(agentDir: string): string {
	return join(agentDir, PRESETS_FILE);
}

export function presetsDir(agentDir: string): string {
	return join(agentDir, PRESETS_DIR);
}

/**
 * The presets every fresh console ships with. They are seeded, not mounted: the
 * first start writes them into the operator's store as ordinary presets, which
 * keeps the rest of the code free of a second preset source. Seeding matches by
 * name and id and only fills a gap — an operator's own edit to a same-named
 * preset is the more valuable copy, so it is never overwritten, and a preset
 * the operator deleted stays deleted.
 */
const BUILTIN_PRESETS: readonly {
	id: string;
	name: string;
	description: string;
	tags: string[];
	placeholder: string;
	text: string;
}[] = [
	{
		id: "web-pentest",
		name: "Web 渗透测试",
		description: "Web 渗透测试，深度渗透测试，以 RCE 为目标",
		tags: ["web"],
		placeholder: "输入目标 URL，敲回车即可。",
		text: "深度渗透测试，以 RCE 为目标进行深度渗透测试，中途挖到的漏洞也要，尽量多的扩大战果，挖到 RCE 之后，不允许影响系统业务正常运行，只允许执行 pwd 来验证，在整个漏洞挖掘的过程中，不允许对系统业务正常运行产生影响，比如删除用户、修改用户密码、删除任何东西、修改系统配置等等。",
	},
	{
		id: "app-client",
		name: "APP 客户端漏洞挖掘",
		description: "APP 客户端漏洞挖掘",
		tags: ["app"],
		placeholder: "确认“安卓设备”内有设备连接，并且安装好 APP，然后再右方点击“安卓”，最后说明你想测试的 APP 即可。",
		text: "你是一名APP 客户端漏洞挖掘，你需要对用户提供的目标 APP 进行客户端漏洞挖掘（不涉及服务端），深入漏洞挖掘，以客户端 RCE 漏洞为目标进行测试，其中遇到的其他漏洞也要上报漏洞中枢。如果你没有远程连接安卓相关的工具，那么请提醒用户把“安卓”权限放开。",
	},
	{
		id: "app-server",
		name: "APP 服务端漏洞挖掘",
		description: "APP 服务端漏洞挖掘",
		tags: ["app"],
		placeholder: "确认“安卓设备”内有设备连接，并且安装好 APP，然后再右方点击“安卓”，最后说明你想测试的 APP 即可。",
		text: [
			"你是一名渗透测试专家，需要对目标 APP 做渗透测试，目标是测试 APP 对应的服务端进行测试，通常，你的任务工作流是->逆向 APP->分析源码->对目标业务系统进行业务建模->开始挖掘漏洞。",
			"挖掘漏洞的目标：以 RCE 为目标，进行渗透测试，注意：如果挖到 RCE 漏洞，只允许执行 pwd、dir 命令，并且，在整个漏洞挖掘过程中，不允许对目标业务系统造成影响。",
			"",
			"如果你没有远程连接安卓相关的工具，那么请提醒用户把“安卓”权限放开。",
		].join("\n"),
	},
	{
		id: "wechat-miniprogram",
		name: "微信小程序渗透测试",
		description: "微信小程序渗透测试",
		tags: ["app"],
		placeholder: "上传反编译后的微信小程序包即可。",
		text: [
			"你的任务是对目标微信小程序进行渗透测试，大致分两类：",
			"1.针对微信小程序生态的：比如 AKSK 泄露、JDBC 泄露之类的。",
			"2.针对远程目标服务器的，一般情况下流程如下：查看用户上传的微信小程序包并解压->对目标进行业务建模->根据业务建模结果继续渗透测试,以数据和权限为目标，尝试 RCE 远程服务器。",
			"",
			"注意：渗透测试过程中，不允许影响目标服务器的正常运行，不允许删除、修改用户密码，不允许对业务正常运行造成影响。",
		].join("\n"),
	},
];

/**
 * Write any built-in preset the store does not have yet, and its body file.
 * Called once per console start; a no-op on every later start.
 */
export function ensureBuiltinPresets(agentDir: string): void {
	const stored = readStored(agentDir);
	const names = new Set(stored.map((preset) => preset.name));
	const ids = new Set(stored.map((preset) => preset.id));
	const missing = BUILTIN_PRESETS.filter((builtin) => !names.has(builtin.name) && !ids.has(builtin.id));
	if (missing.length === 0) return;
	const now = Date.now();
	writeStored(agentDir, [
		...stored,
		...missing.map((builtin) => ({
			id: builtin.id,
			name: builtin.name,
			description: builtin.description,
			tags: [...builtin.tags],
			placeholder: builtin.placeholder,
			enabled: true,
			createdAt: now,
			updatedAt: now,
		})),
	]);
	mkdirSync(presetsDir(agentDir), { recursive: true });
	for (const builtin of missing) {
		const path = presetTextPath(agentDir, builtin.id);
		if (existsSync(path)) continue;
		writeFileSync(path, `${builtin.text.trim()}\n`, { mode: 0o600 });
	}
}

/**
 * Preset ids end up in file names and in the commander's brief, so they are
 * restricted to a slug alphabet. A hand-edited `presets.json` carrying `../` in
 * an id must not be able to point the body path outside the presets directory.
 */
export function isPresetId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/** Body path for a preset; only valid ids reach it. */
export function presetTextPath(agentDir: string, id: string): string {
	return join(presetsDir(agentDir), `${id}.md`);
}

/**
 * Rough token estimate for the settings screen. CJK counts about one token per
 * character, everything else about one per four characters. It is deliberately
 * crude and labelled as an estimate in the UI — the point is to make a 40,000
 * character preset visible before it is loaded, not to predict a bill.
 */
export function estimateTokens(text: string): number {
	let wide = 0;
	let narrow = 0;
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (isWideCodePoint(code)) wide += 1;
		else narrow += 1;
	}
	return Math.ceil(wide + narrow / 4);
}

export function presetTokenLevel(tokens: number): SentinelPresetTokenLevel {
	if (tokens >= PRESET_TOKEN_DANGER) return "danger";
	if (tokens >= PRESET_TOKEN_WARN) return "warn";
	return "ok";
}

function isWideCodePoint(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x20000 && code <= 0x2fa1f)
	);
}

interface PresetsFile {
	presets: SentinelPreset[];
}

function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const tags: string[] = [];
	for (const raw of value) {
		if (typeof raw !== "string") continue;
		const tag = raw.trim();
		if (!tag) continue;
		if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) continue;
		tags.push(tag);
	}
	return tags;
}

/** Coerce one stored entry; null when it has no usable identity. */
function normalizeStored(value: unknown): SentinelPreset | null {
	if (typeof value !== "object" || value === null) return null;
	const entry = value as Record<string, unknown>;
	if (!isPresetId(entry.id)) return null;
	if (typeof entry.name !== "string" || !entry.name.trim()) return null;
	const createdAt = typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0;
	return {
		id: entry.id,
		name: entry.name.trim(),
		description: typeof entry.description === "string" ? entry.description.trim() : "",
		tags: normalizeTags(entry.tags),
		// A preset written before the hint existed has none, and none means "use the
		// console's default text" — never a blank input.
		placeholder: typeof entry.placeholder === "string" ? entry.placeholder.trim() : "",
		// A stored entry without the flag was written before presets could be
		// disabled; reading it as disabled would hide a preset the operator
		// never turned off.
		enabled: entry.enabled !== false,
		createdAt,
		updatedAt: typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : createdAt,
	};
}

function readStored(agentDir: string): SentinelPreset[] {
	const path = presetsPath(agentDir);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as PresetsFile;
		if (!Array.isArray(parsed.presets)) return [];
		return parsed.presets.map(normalizeStored).filter((entry): entry is SentinelPreset => entry !== null);
	} catch {
		return [];
	}
}

function writeStored(agentDir: string, presets: SentinelPreset[]): void {
	const path = presetsPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const file: PresetsFile = { presets };
	writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
}

/** Turn a display name into a slug id; empty for a name with no ASCII at all. */
function slugify(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
}

/**
 * Ids are generated, never typed. A name that yields no slug — Chinese names
 * mostly, which is the normal case here — falls back to a random suffix, and a
 * collision gets `-2`, `-3`, … so a name can be reused without clobbering.
 */
function uniqueId(presets: readonly SentinelPreset[], name: string): string {
	const base = slugify(name) || `preset-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const taken = new Set(presets.map((preset) => preset.id));
	if (!taken.has(base)) return base;
	for (let suffix = 2; suffix < 1000; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Metadata of every stored preset, in file order. Bodies are not read. */
export function listPresets(agentDir: string): SentinelPreset[] {
	return readStored(agentDir);
}

/** Enabled presets only: what a new session and the commander may choose from. */
export function listEnabledPresets(agentDir: string): SentinelPreset[] {
	return readStored(agentDir).filter((preset) => preset.enabled);
}

export function findPreset(agentDir: string, id: string): SentinelPreset | null {
	if (!isPresetId(id)) return null;
	return readStored(agentDir).find((preset) => preset.id === id) ?? null;
}

/** The preset body, or null when the file is missing or the id is unusable. */
export function readPresetText(agentDir: string, id: string): string | null {
	if (!isPresetId(id)) return null;
	const path = presetTextPath(agentDir, id);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

/** Every preset with its body loaded, for the settings screen. */
export function presetViews(agentDir: string): SentinelPresetView[] {
	return readStored(agentDir).map((preset) => viewOf(agentDir, preset));
}

/** One preset with its body loaded, or null when it does not exist. */
export function presetView(agentDir: string, id: string): SentinelPresetView | null {
	const preset = findPreset(agentDir, id);
	return preset ? viewOf(agentDir, preset) : null;
}

function viewOf(agentDir: string, preset: SentinelPreset): SentinelPresetView {
	const text = readPresetText(agentDir, preset.id);
	return {
		...preset,
		text: text ?? "",
		textMissing: text === null,
		tokens: text === null ? 0 : estimateTokens(text),
	};
}

export interface SavePresetInput {
	/** Present to update an existing preset; omitted to create one. */
	id?: string;
	name: string;
	description?: string;
	tags?: string[];
	/** The composer hint while this preset is active; omitted or empty keeps the default. */
	placeholder?: string;
	text: string;
	/** Defaults to true on create, and to the stored value on update. */
	enabled?: boolean;
}

export function savePreset(agentDir: string, input: SavePresetInput): { preset?: SentinelPreset; error?: string } {
	const name = input.name.trim();
	if (!name) return { error: "预设名称不能为空" };
	if (name.length > MAX_PRESET_NAME_CHARS) {
		return { error: `预设名称过长（最多 ${MAX_PRESET_NAME_CHARS} 字）` };
	}
	const description = (input.description ?? "").trim();
	if (description.length > MAX_PRESET_DESCRIPTION_CHARS) {
		return { error: `预设描述过长（最多 ${MAX_PRESET_DESCRIPTION_CHARS} 字）` };
	}
	const placeholder = (input.placeholder ?? "").trim();
	if (placeholder.length > MAX_PRESET_PLACEHOLDER_CHARS) {
		return { error: `输入框提示过长（最多 ${MAX_PRESET_PLACEHOLDER_CHARS} 字）` };
	}
	const tags = normalizeTags(input.tags ?? []);
	if (tags.length > MAX_PRESET_TAGS) return { error: `标签过多（最多 ${MAX_PRESET_TAGS} 个）` };
	const longTag = tags.find((tag) => tag.length > MAX_PRESET_TAG_CHARS);
	if (longTag) return { error: `标签过长（最多 ${MAX_PRESET_TAG_CHARS} 字）：${longTag}` };
	// The body may be any length — the settings screen shows its token cost
	// instead of refusing it — but an empty body is a preset that does nothing.
	const text = input.text.trim();
	if (!text) return { error: "预设内容不能为空" };

	const presets = readStored(agentDir);
	const existing = input.id ? presets.find((preset) => preset.id === input.id) : undefined;
	if (input.id && !existing) return { error: "该预设不存在" };

	const now = Date.now();
	const preset: SentinelPreset = existing
		? {
				...existing,
				name,
				description,
				tags,
				placeholder,
				enabled: input.enabled ?? existing.enabled,
				updatedAt: now,
			}
		: {
				id: uniqueId(presets, name),
				name,
				description,
				tags,
				placeholder,
				enabled: input.enabled ?? true,
				createdAt: now,
				updatedAt: now,
			};

	const next = existing ? presets.map((entry) => (entry.id === preset.id ? preset : entry)) : [...presets, preset];
	// Metadata first: an id with no body would be listed as broken, while a body
	// with no metadata is unreachable but harmless.
	writeStored(agentDir, next);
	mkdirSync(presetsDir(agentDir), { recursive: true });
	writeFileSync(presetTextPath(agentDir, preset.id), `${text}\n`, { mode: 0o600 });
	return { preset };
}

export function setPresetEnabled(
	agentDir: string,
	id: string,
	enabled: boolean,
): { preset?: SentinelPreset; error?: string } {
	const presets = readStored(agentDir);
	const existing = presets.find((preset) => preset.id === id);
	if (!existing) return { error: "该预设不存在" };
	const preset: SentinelPreset = { ...existing, enabled, updatedAt: Date.now() };
	writeStored(
		agentDir,
		presets.map((entry) => (entry.id === id ? preset : entry)),
	);
	return { preset };
}

/**
 * Remove a preset. Sessions and engines that already used it keep their own
 * record of the name and fall back to the default agent, which is why deletion
 * is not blocked by references: an unusable preset would otherwise sit in the
 * picker forever, and the operator can always re-create it from an export.
 */
export function deletePreset(agentDir: string, id: string): { ok: boolean; error?: string } {
	const presets = readStored(agentDir);
	if (!presets.some((preset) => preset.id === id)) return { ok: false, error: "该预设不存在" };
	writeStored(
		agentDir,
		presets.filter((preset) => preset.id !== id),
	);
	try {
		unlinkSync(presetTextPath(agentDir, id));
	} catch {
		// The body was already gone; the metadata entry is what mattered.
	}
	return { ok: true };
}

/** Export presets, bodies included, as one self-contained JSON file. */
export function exportPresets(agentDir: string, ids?: readonly string[]): SentinelPresetExport {
	const wanted = ids && ids.length > 0 ? new Set(ids) : null;
	const presets = readStored(agentDir)
		.filter((preset) => !wanted || wanted.has(preset.id))
		.map((preset) => ({ ...preset, text: readPresetText(agentDir, preset.id) ?? "" }));
	return {
		format: PRESETS_EXPORT_FORMAT,
		version: PRESETS_EXPORT_VERSION,
		exportedAt: Date.now(),
		presets,
	};
}

export function exportFileName(now: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `sentinel-presets-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

/**
 * Import presets from an export file.
 *
 * Every entry is saved as a new copy with a freshly generated id. Importing is
 * how a preset travels between machines or teammates, so it must never
 * overwrite what is already here: the operator's own edit to a same-named
 * preset is the more valuable of the two, and a silent overwrite is not
 * something they could notice afterwards.
 */
export function importPresets(agentDir: string, payload: unknown): SentinelPresetImportResult {
	const skipped: SentinelPresetImportResult["skipped"] = [];
	if (typeof payload !== "object" || payload === null) {
		return { imported: [], skipped, error: "文件内容不是合法的 JSON 对象" };
	}
	const file = payload as Partial<SentinelPresetExport>;
	if (file.format !== PRESETS_EXPORT_FORMAT) {
		return { imported: [], skipped, error: "不是 全链哨兵 预设导出文件" };
	}
	if (file.version !== PRESETS_EXPORT_VERSION) {
		return { imported: [], skipped, error: `不支持的导出版本：${String(file.version)}` };
	}
	if (!Array.isArray(file.presets)) return { imported: [], skipped, error: "文件里没有预设列表" };

	const imported: SentinelPreset[] = [];
	for (const raw of file.presets) {
		if (typeof raw !== "object" || raw === null) {
			skipped.push({ name: "（未命名）", reason: "条目不是对象" });
			continue;
		}
		const entry = raw as Partial<SentinelPresetExportEntry>;
		const label = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "（未命名）";
		const result = savePreset(agentDir, {
			name: typeof entry.name === "string" ? entry.name : "",
			description: typeof entry.description === "string" ? entry.description : "",
			tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [],
			placeholder: typeof entry.placeholder === "string" ? entry.placeholder : "",
			text: typeof entry.text === "string" ? entry.text : "",
			enabled: entry.enabled !== false,
		});
		if (result.preset) imported.push(result.preset);
		else skipped.push({ name: label, reason: result.error ?? "无法导入" });
	}
	return { imported, skipped };
}

/** Drop a description to the brief's width, on a character boundary. */
export function briefDescription(description: string): string {
	const trimmed = description.trim();
	if (trimmed.length <= PRESET_BRIEF_DESCRIPTION_CHARS) return trimmed;
	return `${trimmed.slice(0, PRESET_BRIEF_DESCRIPTION_CHARS - 1)}…`;
}

/**
 * The preset list as the commander's brief shows it: id, name, description and
 * the first few tags, one per line. Only enabled presets appear — a disabled
 * preset is not a choice, and offering it would produce a dispatch that gets
 * refused. The overflow line exists so an operator with a long list learns why
 * the commander cannot see all of it.
 */
export function presetBriefLines(presets: readonly SentinelPreset[]): string[] {
	const enabled = presets.filter((preset) => preset.enabled);
	const shown = enabled.slice(0, PRESET_BRIEF_MAX);
	const lines = shown.map((preset) => {
		const description = briefDescription(preset.description);
		const tags = preset.tags.slice(0, PRESET_BRIEF_MAX_TAGS).join("、");
		const suffix = [description, tags ? `[${tags}]` : ""].filter(Boolean).join(" · ");
		return `- ${preset.id} · ${preset.name}${suffix ? ` · ${suffix}` : ""}`;
	});
	if (enabled.length > PRESET_BRIEF_MAX) {
		lines.push(`（另有 ${enabled.length - PRESET_BRIEF_MAX} 条预设未列出，请让操作员精简预设库）`);
	}
	return lines;
}
