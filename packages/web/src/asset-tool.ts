/**
 * The asset-mapping tools the agent sees: one search tool per platform.
 *
 * Three tools rather than one, because the three platforms do not share a query
 * language. FOFA writes `ip="1.1.1.1"`, Quake writes `ip:"1.1.1.1"`, Hunter
 * writes `ip="1.1.1.1"` but calls a page a different thing; a single tool with a
 * single `query` field would have to guess which dialect it was handed, and a
 * guess that lands wrong comes back as "no results" — the most expensive kind of
 * wrong answer in reconnaissance. Each description therefore names its own
 * dialect, and the tool list itself tells the model which platforms exist.
 *
 * Which tools exist is decided before the session is built: only platforms that
 * are switched on, keyed, and verified by a successful probe are mounted at all.
 * A platform that is missing or unusable is absent from the tool list, not
 * present-but-failing.
 *
 * The key never reaches the model. The console sends the request, so the key is
 * not in a bash command, not in the container, and not in the gatekeeper audit.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ASSET_PLATFORM_META,
	type AssetRecord,
	type AssetSearchOptions,
	type AssetSearchResult,
	assetSyntaxHint,
	DEFAULT_ASSET_PAGE_SIZE,
	MAX_ASSET_PAGE_SIZE,
} from "./asset-platforms.ts";
import type { SentinelAssetPlatform } from "./protocol.ts";

/** Longest tool output handed back to the model. */
const MAX_TOOL_OUTPUT = 12000;

/** Tool name per platform. Also the names `permissions.ts` denies when the switch is off. */
export const ASSET_TOOL_NAMES: Record<SentinelAssetPlatform, string> = {
	fofa: "fofa_search",
	quake: "quake_search",
	hunter: "hunter_search",
};

export const ASSET_TOOL_NAME_LIST: readonly string[] = Object.values(ASSET_TOOL_NAMES);

/** One finished query, as the runtime logs it and reports on the settings screen. */
export interface AssetQueryReport {
	platform: SentinelAssetPlatform;
	query: string;
	page: number;
	size: number;
	ok: boolean;
	total: number;
	count: number;
	latencyMs: number;
	error?: string;
	quota?: string;
	/** Normalized records, for the query log. */
	records: unknown[];
	/** Container-visible path of the raw response, when it was written. */
	evidencePath?: string;
}

/**
 * What the tools need from the runtime. The key is read through `keyOf` at call
 * time and never stored in the tool closure, so a key replaced by the operator
 * takes effect without rebuilding the tool.
 */
export interface AssetToolContext {
	/**
	 * Run one search. The console owns the network call, so the tool never holds
	 * a fetch implementation or an endpoint; a test can drive the whole tool with
	 * a stub here.
	 */
	search: (options: AssetSearchOptions) => Promise<AssetSearchResult>;
	/** The key for one platform. Only called for platforms that are mounted. */
	keyOf: (platform: SentinelAssetPlatform) => string;
	/** Queries left in this session across all platforms, or null when unlimited. */
	remaining: () => number | null;
	/** Account for one query. False means the session's budget is spent. */
	consume: () => boolean;
	/** Persist the raw response; returns the path to cite, or undefined on failure. */
	saveEvidence: (name: string, raw: unknown) => string | undefined;
	/** Log the query and refresh the platform's status line. */
	report: (report: AssetQueryReport) => void;
}

/** The structured half of a tool result; the text half is for the model. */
export interface AssetToolDetails {
	ok: boolean;
	platform: SentinelAssetPlatform;
	query: string;
	page: number;
	size: number;
	total: number;
	count: number;
	evidencePath?: string;
	remaining?: number | null;
	error?: string;
}

function clip(text: string): string {
	if (text.length <= MAX_TOOL_OUTPUT) return text;
	return `${text.slice(0, MAX_TOOL_OUTPUT)}\n…（输出已截断，共 ${text.length} 字符）`;
}

/** One record as a compact block: a location line, the fields that are set, the banner. */
function renderRecord(record: AssetRecord, index: number): string {
	const where = record.ip
		? `${record.ip}${record.port ? `:${record.port}` : ""}`
		: record.host || record.url || "(无地址)";
	const fields: Array<[string, string]> = [
		["host", record.host],
		["domain", record.domain],
		["url", record.url],
		["title", record.title],
		["server", record.server],
		["protocol", record.protocol],
		["os", record.os],
		["org", record.org],
		["country", record.country],
		["province", record.province],
		["city", record.city],
		["updated", record.updatedAt],
	];
	const set = fields.filter(([, value]) => value).map(([name, value]) => `${name}=${value}`);
	const lines = [`${index}. ${where}`];
	if (set.length > 0) lines.push(`   ${set.join(" ")}`);
	if (record.banner) lines.push(`   banner: ${record.banner.replace(/\n/g, "\n   ")}`);
	return lines.join("\n");
}

function renderResult(result: AssetSearchResult, evidencePath: string | undefined, remaining: number | null): string {
	const meta = ASSET_PLATFORM_META[result.platform];
	const head = `${meta.label} 查询 ${result.query} 第 ${result.page} 页（每页 ${result.size}）：命中 ${result.total} 条，本页 ${result.records.length} 条，耗时 ${result.latencyMs}ms`;
	const body =
		result.records.length > 0
			? result.records.map((record, index) => renderRecord(record, index + 1)).join("\n")
			: "（本页没有记录）";
	const notes: string[] = [];
	if (result.records.length === 0) {
		notes.push(
			`该平台没有返回记录，只说明它没测绘到匹配的资产，不能据此断定目标不存在；换个查询语法或换一个平台再试。${meta.label} 语法：${assetSyntaxHint(result.platform)}`,
		);
	} else if (result.total > result.page * result.size) {
		notes.push(`还有更多结果：用 page=${result.page + 1} 取下一页，或收窄查询。`);
	}
	if (result.quota) notes.push(`额度：${result.quota}`);
	if (result.syntaxHint) notes.push(`平台语法提示：${result.syntaxHint}`);
	if (evidencePath) notes.push(`原始响应已写入：${evidencePath}`);
	if (remaining !== null) notes.push(`本会话剩余查询次数：${remaining}`);
	return [clip(`${head}\n${body}`), ...notes].join("\n\n");
}

/** A file name that sorts by time and names the platform and page. */
function evidenceName(platform: SentinelAssetPlatform, page: number, now = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	return `${platform}-p${page}-${stamp}.json`;
}

/**
 * Write one raw response under `<workDir>/evidence/asset/` and return the path to
 * cite. The path is relative to the work directory on purpose: the session's read
 * tool resolves it against the host work dir and bash resolves it against
 * `/work`, which is the same directory, so one string works in both places.
 */
export function writeAssetEvidence(workDir: string, name: string, raw: unknown): string | undefined {
	const relative = join("evidence", "asset", name);
	try {
		const dir = join(workDir, "evidence", "asset");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), `${JSON.stringify(raw, null, "\t")}\n`, "utf8");
		return relative;
	} catch {
		// A full disk or a read-only work dir must not fail the query: the results
		// are already in hand, and the query log still records them.
		return undefined;
	}
}

function searchSchema(platform: SentinelAssetPlatform) {
	const meta = ASSET_PLATFORM_META[platform];
	return Type.Object({
		query: Type.String({
			description: `${meta.label} query in ${meta.label}'s own syntax. ${meta.syntax}`,
		}),
		page: Type.Optional(Type.Integer({ minimum: 1, description: "Page number, starting at 1. Defaults to 1." })),
		size: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_ASSET_PAGE_SIZE,
				description: `Records per page. Defaults to ${DEFAULT_ASSET_PAGE_SIZE}, maximum ${MAX_ASSET_PAGE_SIZE}.`,
			}),
		),
	});
}

function assetSearchTool(platform: SentinelAssetPlatform, context: AssetToolContext): ToolDefinition {
	const meta = ASSET_PLATFORM_META[platform];
	const name = ASSET_TOOL_NAMES[platform];
	return defineTool({
		name,
		label: `Search ${meta.label}`,
		description:
			`Search ${meta.label}, an internet-wide asset search engine, through the operator's own account. The console sends the request, so the API key stays on the host and out of the container. ` +
			`${meta.label} has its own query language: ${meta.syntax}. The three platforms do not share a syntax, so a query written for another one returns nothing here rather than an error. ` +
			`Results are assets ${meta.label} has already mapped on the public internet; an empty page means "not mapped by this platform", never "the target does not exist". ` +
			(meta.note ? `${meta.note} ` : "") +
			`Every query is metered against the operator's quota and logged, and the raw response is written into the project's evidence directory.`,
		promptSnippet: `Search ${meta.label} for exposed assets (${meta.label}'s own query syntax)`,
		promptGuidelines: [
			`Use ${name} to map a scope before probing it: subdomains, open ports, service banners and page titles come back in one call`,
			`Write the query in ${meta.label}'s syntax (${meta.syntax}); another platform's dialect silently returns nothing`,
			"A platform that returns no records has simply not mapped those assets: say so, and try another platform or a broader query instead of concluding the asset does not exist",
			"Each query spends the operator's metered quota, so narrow the query and page only as far as the scope needs",
		],
		parameters: searchSchema(platform),
		async execute(_toolCallId, params): Promise<AgentToolResult<AssetToolDetails>> {
			const query = params.query.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: `query 不能为空。${meta.label} 语法：${meta.syntax}` }],
					details: { ok: false, platform, query: "", page: 1, size: DEFAULT_ASSET_PAGE_SIZE, total: 0, count: 0 },
					isError: true,
				};
			}
			const key = context.keyOf(platform);
			if (!key) {
				// Unreachable while mounting follows `isPlatformUsable`, and stated
				// plainly if a config change ever races the session.
				return {
					content: [{ type: "text", text: `${meta.label} 未配置可用的 API Key，无法查询。` }],
					details: { ok: false, platform, query, page: 1, size: DEFAULT_ASSET_PAGE_SIZE, total: 0, count: 0 },
					isError: true,
				};
			}
			if (!context.consume()) {
				return {
					content: [
						{
							type: "text",
							text: `本会话的资产测绘查询预算已用完，${meta.label} 查询被拒绝。请让操作员在「设置 - 资产测绘」里调高上限或新开会话。`,
						},
					],
					details: {
						ok: false,
						platform,
						query,
						page: 1,
						size: DEFAULT_ASSET_PAGE_SIZE,
						total: 0,
						count: 0,
						remaining: 0,
					},
					isError: true,
				};
			}
			const page = params.page ?? 1;
			const size = params.size ?? DEFAULT_ASSET_PAGE_SIZE;
			try {
				const result = await context.search({ platform, key, query, page, size });
				const evidencePath = context.saveEvidence(evidenceName(platform, result.page), result.raw);
				context.report({
					platform,
					query,
					page: result.page,
					size: result.size,
					ok: true,
					total: result.total,
					count: result.records.length,
					latencyMs: result.latencyMs,
					...(result.quota ? { quota: result.quota } : {}),
					records: result.records,
					...(evidencePath ? { evidencePath } : {}),
				});
				const remaining = context.remaining();
				return {
					content: [{ type: "text", text: renderResult(result, evidencePath, remaining) }],
					details: {
						ok: true,
						platform,
						query,
						page: result.page,
						size: result.size,
						total: result.total,
						count: result.records.length,
						...(evidencePath ? { evidencePath } : {}),
						remaining,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				context.report({
					platform,
					query,
					page,
					size,
					ok: false,
					total: 0,
					count: 0,
					latencyMs: 0,
					error: message,
					records: [],
				});
				return {
					content: [
						{
							type: "text",
							text: `${meta.label} 查询失败：${message}\n\n查询语法（${meta.label}）：${meta.syntax}\n若提示令牌或额度问题，请让操作员在「设置 - 资产测绘」里检查该平台。`,
						},
					],
					details: {
						ok: false,
						platform,
						query,
						page,
						size,
						total: 0,
						count: 0,
						error: message,
						remaining: context.remaining(),
					},
					isError: true,
				};
			}
		},
	});
}

/** The tools for the platforms the caller decided are usable, in a fixed order. */
export function createAssetTools(
	platforms: readonly SentinelAssetPlatform[],
	context: AssetToolContext,
): ToolDefinition[] {
	return platforms.map((platform) => assetSearchTool(platform, context));
}
