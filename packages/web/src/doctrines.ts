/**
 * Command doctrines (指挥思路): named text templates the operator picks when
 * creating an engine. The selected texts are merged into the commander's system
 * prompt.
 *
 * The built-in doctrine ships as the console's default and cannot be
 * removed; further doctrines are the operator's own, living in
 * `<agentDir>/doctrines.json` and managed from the engine page. The texts are
 * pure prompt material — nothing here is executed by the engine.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { t } from "./i18n.ts";

export interface SentinelDoctrine {
	id: string;
	name: string;
	/** Prompt text merged into the commander's system prompt. */
	text: string;
	builtin: boolean;
}

/** The one built-in doctrine: the operator's default engagement playbook. */
const BUILTIN_DOCTRINES: SentinelDoctrine[] = [
	{
		id: "attack-defense-web",
		name: "攻防Web渗透打点",
		text: [
			"对 Web 目标进行深度渗透测试，以权限和数据为目标，最终尝试 RCE，注意不允许影响业务正常运行，在 RCE 后，只允许执行 whoami 进行测试。",
			"",
			"任务分配优先级：",
			"需要先探查任务优先级：",
			"自研 IIS .NEW 系统 > 自研其他系统的优先级 > 通用系统 > 通用 OA>WordPress > 各种门户网站",
			"在下发任务前，请优先测试一下用户提交的目标有无重复，有可能不同域名/IP但是内容是重复的，这点请你熟知。",
			"",
			"用户输入类型判断：",
			"1.如果是 http(s):// 类型，那么直接当做任务目标即可",
			"2.如果是 ip 或者域名，请优先进行信息收集后再进行任务提交",
		].join("\n"),
		builtin: true,
	},
];

interface DoctrinesFile {
	doctrines: SentinelDoctrine[];
}

function doctrinesPath(agentDir: string): string {
	return `${agentDir}/doctrines.json`;
}

function readCustom(agentDir: string): SentinelDoctrine[] {
	const path = doctrinesPath(agentDir);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as DoctrinesFile;
		if (!Array.isArray(parsed.doctrines)) return [];
		return parsed.doctrines.filter(
			(item): item is SentinelDoctrine =>
				typeof item === "object" &&
				item !== null &&
				typeof item.id === "string" &&
				typeof item.name === "string" &&
				typeof item.text === "string",
		);
	} catch {
		return [];
	}
}

function writeCustom(agentDir: string, doctrines: SentinelDoctrine[]): void {
	const path = doctrinesPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const file: DoctrinesFile = { doctrines };
	writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
}

export function listDoctrines(agentDir: string): SentinelDoctrine[] {
	return [...BUILTIN_DOCTRINES, ...readCustom(agentDir)];
}

/** Resolve doctrine ids to their texts, ignoring unknown ids. */
export function resolveDoctrines(agentDir: string, ids: readonly string[]): SentinelDoctrine[] {
	const byId = new Map(listDoctrines(agentDir).map((doctrine) => [doctrine.id, doctrine]));
	const resolved: SentinelDoctrine[] = [];
	for (const id of ids) {
		const doctrine = byId.get(id);
		if (doctrine && !resolved.some((item) => item.id === doctrine.id)) resolved.push(doctrine);
	}
	return resolved;
}

export function saveDoctrine(
	agentDir: string,
	input: { id?: string; name: string; text: string },
): { doctrine?: SentinelDoctrine; error?: string } {
	const name = input.name.trim();
	const text = input.text.trim();
	if (!name) return { error: t("思路名称不能为空") };
	if (!text) return { error: t("思路内容不能为空") };
	const custom = readCustom(agentDir);
	const existing = input.id ? custom.find((item) => item.id === input.id) : undefined;
	if (input.id && !existing) return { error: t("该思路不存在（内置思路不能修改）") };
	const doctrine: SentinelDoctrine = existing
		? { ...existing, name, text }
		: {
				id: `doctrine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				name,
				text,
				builtin: false,
			};
	writeCustom(
		agentDir,
		existing ? custom.map((item) => (item.id === doctrine.id ? doctrine : item)) : [...custom, doctrine],
	);
	return { doctrine };
}

export function deleteDoctrine(agentDir: string, id: string): { ok: boolean; error?: string } {
	const custom = readCustom(agentDir);
	if (!custom.some((item) => item.id === id)) return { ok: false, error: t("该思路不存在（内置思路不能删除）") };
	writeCustom(
		agentDir,
		custom.filter((item) => item.id !== id),
	);
	return { ok: true };
}
