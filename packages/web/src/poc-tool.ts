/**
 * The POC library's agent-facing tools: search and read, nothing else.
 *
 * The library is read-only by construction. Its rows live in the config
 * directory and never enter the project container, so there is no path the
 * agent could point nuclei at. What it gets back from `poc_read` is template
 * text; to fire it, the agent has to write its own yaml into the working
 * directory and run nuclei on that file through bash — the same gate as any
 * other command. Both tool descriptions say so, because a model that does not
 * know the bargain will try to execute the library instead.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PocStore } from "./pocs.ts";
import type { ZGPocSeverity } from "./protocol.ts";

/** Longest tool output handed back to the model. */
const MAX_TOOL_OUTPUT = 12000;

function clip(text: string): string {
	if (text.length <= MAX_TOOL_OUTPUT) return text;
	return `${text.slice(0, MAX_TOOL_OUTPUT)}\n…（输出已截断，共 ${text.length} 字符）`;
}

const SEVERITY_LABELS: Record<ZGPocSeverity, string> = {
	critical: "严重",
	high: "高危",
	medium: "中危",
	low: "低危",
	info: "信息",
};

/**
 * Appended to every `poc_read`, outside the clip so a truncated template still
 * carries it. A template's `path` is the author's guess at one common
 * deployment: the failure this prevents is the model firing that path as
 * written, getting a 404, and reporting the target as unaffected.
 */
const TEMPLATE_PATH_NOTE =
	"（提醒：模板里的 path / URL 前缀是作者按常见部署写的，未必等于目标上的真实路径。先按侦察结果确认真实前缀，再把匹配逻辑搬过去；照抄路径跑一次的命中或未命中，都不能单独作为结论。）";

const searchSchema = Type.Object({
	search: Type.Optional(
		Type.String({ description: "Case-insensitive substring matched against template id, name, tags and CVE ids" }),
	),
	severity: Type.Optional(
		Type.Union(
			[
				Type.Literal("critical"),
				Type.Literal("high"),
				Type.Literal("medium"),
				Type.Literal("low"),
				Type.Literal("info"),
			],
			{ description: "Only templates of this severity" },
		),
	),
	tag: Type.Optional(Type.String({ description: "Exact tag match, e.g. 'cve', 'rce', 'wordpress'" })),
});

const readSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Template id from poc_search, e.g. 'CVE-2021-44228-log4j-rce'" }),
});

export interface PocToolOptions {
	store: PocStore;
}

interface SearchDetails {
	ok: boolean;
	count: number;
	error?: string;
}

interface ReadDetails {
	ok: boolean;
	id?: string;
	error?: string;
}

export function createPocTools(options: PocToolOptions): ToolDefinition[] {
	const search = defineTool({
		name: "poc_search",
		label: "Search POC library",
		description:
			"Search the operator's read-only Nuclei POC library by keyword, tag or severity, and get back template ids with metadata. The library is generic fingerprint knowledge: templates name a product or CVE and carry one common deployment's paths, not the target's. They are reference material, not executable from here. To actually test a target, write your own yaml into the working directory and run nuclei on it via bash.",
		promptSnippet: "Search the read-only Nuclei POC library for templates matching a keyword, tag or severity",
		promptGuidelines: [
			"Search the POC library (poc_search) before writing a template from scratch; an imported one is a starting point",
			"Templates from the library are read-only reference: to use one, write the yaml yourself into the working directory and run nuclei on your own file via bash",
			"Use the library for generic fingerprinting of a product or CVE, not as a ready-made attack on the current target: a template's path and URL prefix are one common deployment, so confirm the real prefix from recon and adapt the request instead of firing the path as written",
			"A template that misses on its hardcoded path is not evidence that the target is unaffected: the match logic is what it is worth, the path is a guess",
		],
		parameters: searchSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<SearchDetails>> {
			const items = options.store.list({
				...(params.search?.trim() ? { search: params.search.trim() } : {}),
				...(params.severity ? { severity: params.severity as ZGPocSeverity } : {}),
				...(params.tag?.trim() ? { tag: params.tag.trim() } : {}),
			});
			if (items.length === 0) {
				return {
					content: [{ type: "text", text: "POC 库中没有匹配的模板。" }],
					details: { ok: true, count: 0 },
				};
			}
			const lines = items.map((item) => {
				const tags = item.tags.length > 0 ? ` | ${item.tags.join(",")}` : "";
				const refs = item.references.length > 0 ? ` | ${item.references.join(",")}` : "";
				return `${item.id} | ${SEVERITY_LABELS[item.severity]} | ${item.name}${tags}${refs}`;
			});
			return {
				content: [
					{
						type: "text",
						text: clip(
							`POC 库 ${items.length} 条匹配（id | 等级 | 名称 | 标签 | CVE）：\n${lines.join("\n")}\n用 poc_read 按 id 取模板全文。`,
						),
					},
				],
				details: { ok: true, count: items.length },
			};
		},
	});

	const read = defineTool({
		name: "poc_read",
		label: "Read POC template",
		description:
			"Read one Nuclei template from the POC library in full, by its id. The text is reference material only — it is not mounted in the container and cannot be executed from the library. To test with it, write the yaml yourself into the working directory and run nuclei on your own file via bash.",
		promptSnippet: "Read one template from the read-only Nuclei POC library in full",
		parameters: readSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<ReadDetails>> {
			const poc = options.store.get(params.id.trim());
			if (!poc) {
				return {
					content: [{ type: "text", text: `POC 库中没有 id 为 ${params.id} 的模板。` }],
					details: { ok: false, error: "not-found" },
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `${clip(`模板 ${poc.id}（${SEVERITY_LABELS[poc.severity]}）：\n\n${poc.content}`)}\n\n${TEMPLATE_PATH_NOTE}`,
					},
				],
				details: { ok: true, id: poc.id },
			};
		},
	});

	return [search, read];
}
