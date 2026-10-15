/**
 * Command doctrines (指挥思路): named text templates the operator picks when
 * creating an engine. The selected texts are merged into the commander's system
 * prompt.
 *
 * Built-in doctrines ship with the console and cannot be removed; custom ones
 * live in `<agentDir>/doctrines.json` and are managed from the engine page. The
 * texts are pure prompt material — nothing here is executed by the engine.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SentinelDoctrine {
	id: string;
	name: string;
	/** Prompt text merged into the commander's system prompt. */
	text: string;
	builtin: boolean;
}

/**
 * Built-in doctrines. Intentionally minimal placeholders until the operator
 * supplies their own; custom doctrines added from the engine page carry the
 * real engagement playbooks.
 */
const BUILTIN_DOCTRINES: SentinelDoctrine[] = [
	{
		id: "standard",
		name: "标准编排",
		text: [
			"按标准渗透流程编排：先为每个目标派发侦察与枚举任务，拿到结果后再决定是否派发漏洞验证与利用任务。",
			"一次只给一个任务一个明确目标；任务指令必须自包含（目标、范围、注意事项、验收口径）。",
			"同类目标优先合并思路：把已验证有效的做法写入后续任务的指令，但不要把未经验证的猜测当事实传递。",
			"任务失败时先分析摘要里的原因，换一种思路重派，而不是原样重发；同一目标重派前先确认重试次数还有余量。",
		].join("\n"),
		builtin: true,
	},
	{
		id: "easy-first",
		name: "先易后难",
		text: [
			"先把所有目标都派发一轮快速侦察，按「表面暴露面大小 + 服务版本新旧」判断难易。",
			"容易的目标先派深度任务拿结果，难的目标放在后面集中资源。",
			"目标是尽快拿到可提交的发现，而不是在最难的机器上消耗轮次。",
		].join("\n"),
		builtin: true,
	},
	{
		id: "web-first",
		name: "优先 Web",
		text: [
			"优先打 Web 面：对开放了 HTTP/HTTPS 服务的目标先派 Web 侦察（目录、指纹、参数）任务。",
			"Web 无果或服务明确不是 Web 时再转向端口与服务漏洞方向。",
			"Web 任务指令里写清目标 URL、范围（不要越出目标）与提交口径。",
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
	if (!name) return { error: "思路名称不能为空" };
	if (!text) return { error: "思路内容不能为空" };
	const custom = readCustom(agentDir);
	const existing = input.id ? custom.find((item) => item.id === input.id) : undefined;
	if (input.id && !existing) return { error: "该思路不存在（内置思路不能修改）" };
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
	if (!custom.some((item) => item.id === id)) return { ok: false, error: "该思路不存在（内置思路不能删除）" };
	writeCustom(
		agentDir,
		custom.filter((item) => item.id !== id),
	);
	return { ok: true };
}
