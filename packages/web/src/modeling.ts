/**
 * Business modeling: the per-session state, the injected instruction, and the
 * two markers the transcript shows.
 *
 * The two run tools are declared to the model in every console session, because
 * modeling can also be asked for in the conversation ("帮我做业务建模") and a tool
 * that only a button can mount cannot be reached that way. What keeps modeling
 * out of ordinary work is therefore the instruction the tools carry rather than
 * their absence: both descriptions and both guideline lists open by saying they
 * may only be called when the operator asked for business modeling. The run
 * itself is opened by the first submission when the model is the one that
 * started it.
 *
 * The state lives on the branch as a `custom` entry, the way the mode, the
 * preset and the manual status do: it survives a restart, is inherited by a
 * fork, and never enters the model's context. Appending `null` clears it.
 */

import type { ZGApiModelStatus, ZGModelingState } from "./protocol.ts";

/**
 * The two run tools. They are declared in every console session — the operator
 * may start modeling by asking for it instead of pressing the button — and they
 * are the only modeling tools that are: the read tool below stays conditional on
 * the session actually carrying attached records.
 */
export const MODELING_TOOLS: readonly string[] = ["api_model_submit", "api_model_done"];

/**
 * The read-only tool mounted while a session carries attached modeling records
 * (the composer's 带建模数据). Registered everywhere, activated only when there
 * is something to read, like the run tools.
 */
export const MODELING_ATTACH_TOOLS: readonly string[] = ["api_model_read"];

/** Custom entry recording that a modeling run is in force for this session. */
export const MODELING_STATE_CUSTOM_TYPE = "zg-modeling-state";

/** Custom entry recording which modeling records were attached to this session. */
export const MODELING_ATTACH_CUSTOM_TYPE = "zg-modeling-attach-state";

/** The injected instruction, rendered as a foldable marker row. */
export const MODELING_MESSAGE_CUSTOM_TYPE = "zg-modeling";

/** The injected catalog of attached records, rendered as a foldable marker row. */
export const MODELING_ATTACH_MESSAGE_CUSTOM_TYPE = "zg-modeling-attach";

/** A run in force, as the branch records it. */
export interface ModelingRun {
	runId: string;
	target: string;
	startedAt: number;
}

/** The run one `zg-modeling-state` entry carries; `null` clears it. */
export function modelingRunFromEntry(data: unknown): ModelingRun | null | undefined {
	if (data === null) return null;
	if (typeof data !== "object") return undefined;
	const value = data as { runId?: unknown; target?: unknown; startedAt?: unknown };
	if (typeof value.runId !== "string" || !value.runId) return undefined;
	return {
		runId: value.runId,
		target: typeof value.target === "string" ? value.target : "",
		startedAt: typeof value.startedAt === "number" ? value.startedAt : Date.now(),
	};
}

/** Attached modeling records, as the `zg-modeling-attach-state` entry carries them. */
export interface ModelingAttach {
	ids: string[];
	at: number;
}

/** The attach state one entry carries; `null` clears it. */
export function modelingAttachFromEntry(data: unknown): ModelingAttach | null | undefined {
	if (data === null) return null;
	if (typeof data !== "object") return undefined;
	const value = data as { ids?: unknown; at?: unknown };
	if (!Array.isArray(value.ids)) return undefined;
	const ids = value.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (ids.length === 0) return undefined;
	return { ids, at: typeof value.at === "number" ? value.at : Date.now() };
}

/** The run set by the last state entry on a branch; null means modeling is off. */
export function readModelingRun(entries: readonly unknown[]): ModelingRun | null {
	let found: ModelingRun | null = null;
	for (const entry of entries) {
		const value = entry as { type?: string; customType?: string; data?: unknown };
		if (value.type !== "custom" || value.customType !== MODELING_STATE_CUSTOM_TYPE) continue;
		found = modelingRunFromEntry(value.data) ?? null;
	}
	return found;
}

/** The attach state set by the last state entry on a branch; null means none. */
export function readModelingAttach(entries: readonly unknown[]): ModelingAttach | null {
	let found: ModelingAttach | null = null;
	for (const entry of entries) {
		const value = entry as { type?: string; customType?: string; data?: unknown };
		if (value.type !== "custom" || value.customType !== MODELING_ATTACH_CUSTOM_TYPE) continue;
		found = modelingAttachFromEntry(value.data) ?? null;
	}
	return found;
}

/**
 * The tool set a session should have, given its current one and whether modeling
 * records are attached. The two run tools are always in it — a loadout restored
 * from an older transcript that left them out gets them back — so the model
 * always knows modeling exists; only the read tool is mounted and unmounted
 * here.
 *
 * The order of the untouched tools is preserved, so attaching and detaching
 * records leaves the rest of the loadout exactly as the SDK built it.
 */
export function modelingToolLoadout(active: readonly string[], attached: boolean): string[] {
	const managed = [...MODELING_TOOLS, ...MODELING_ATTACH_TOOLS];
	const mounted = [...MODELING_TOOLS, ...(attached ? MODELING_ATTACH_TOOLS : [])];
	const kept = active.filter((name) => !managed.includes(name));
	return [...kept, ...mounted.filter((name) => !kept.includes(name))];
}

/**
 * The catalog injected with the first prompt of a session that carries attached
 * records: one line per endpoint plus the entities, enough for the model to know
 * what exists without the full document in context. The details — parameters,
 * request bodies, response schemas — stay behind `api_model_read`, which is why
 * the catalog ends by naming it.
 *
 * Capped so a stack of large records cannot eat the context in one message.
 */
export function buildModelingCatalog(
	records: Array<{
		id: string;
		title: string;
		target: string;
		pathCount: number;
		operationCount: number;
		endpoints: Array<{ method: string; path: string; summary: string }>;
		entities: Array<{
			name: string;
			description?: string;
			fields?: Array<{ name: string; type?: string }>;
			relations?: Array<{ target: string; kind?: string }>;
		}>;
	}>,
): string {
	const MAX_CATALOG_CHARS = 16_000;
	const lines: string[] = ["以下是操作员带进本会话的业务建模记录（此前对目标接口的还原结果，可信但未必最新）：", ""];
	for (const record of records) {
		lines.push(`## ${record.title}${record.target ? `（${record.target}）` : ""} [id: ${record.id}]`);
		for (const endpoint of record.endpoints) {
			lines.push(
				`- ${endpoint.method.toUpperCase()} ${endpoint.path}${endpoint.summary ? ` — ${endpoint.summary}` : ""}`,
			);
		}
		if (record.entities.length > 0) {
			lines.push("业务实体：");
			for (const entity of record.entities) {
				const fields = (entity.fields ?? []).map((field) => field.name).join(", ");
				const relations = (entity.relations ?? [])
					.map((relation) => `${relation.kind ? `${relation.kind} ` : ""}${relation.target}`)
					.join("、");
				lines.push(
					`- ${entity.name}${entity.description ? `：${entity.description}` : ""}${fields ? `（字段：${fields}）` : ""}${relations ? `；关系：${relations}` : ""}`,
				);
			}
		}
		lines.push("");
	}
	let text = lines.join("\n");
	if (text.length > MAX_CATALOG_CHARS) {
		text = `${text.slice(0, MAX_CATALOG_CHARS)}\n\n[目录过长已截断：完整内容用 api_model_read 按 id 读取。]`;
	}
	text +=
		"以上只是目录，不含参数与响应结构。需要某个接口的参数、请求体或响应 schema 时，用 api_model_read 传对应 id 读取完整文档；不要凭目录猜字段。";
	return text;
}

/** The marker line the transcript folds the catalog into. */
export function buildModelingAttachMessage(titles: string[]): string {
	return `【业务建模 · 已带入 ${titles.length} 份】${titles.join("、")}。接口目录已作为本条消息的正文交给模型，完整文档可用 api_model_read 读取；在输入框「带建模数据」里移除后，工具随之摘除。`;
}

/**
 * What the button injects. It is the whole briefing: the model has never been
 * told that modeling exists, so this text has to say what to produce, which two
 * tools just appeared, how to work, and where the discipline is.
 */
export function buildModelingBrief(
	target: string,
	projectName: string | null,
	attached?: Array<{ title: string; pathCount: number }>,
): string {
	const scope = target.trim()
		? `操作员指定的目标：${target.trim()}`
		: projectName
			? `没有单独指定目标：以当前项目「${projectName}」和本次会话里已经确认的目标为准。`
			: "没有单独指定目标：以本次会话里已经确认的目标为准。";
	const prior =
		attached && attached.length > 0
			? `本次是增量建模：会话里已带有 ${attached.length} 份此前还原的建模记录（${attached
					.map((record) => `${record.title} ${record.pathCount} 路径`)
					.join(
						"、",
					)}）。不要从零重做：以它们为底，补充缺失或变化的部分；与实际响应冲突的，以实际响应为准并修正记录。`
			: "";
	return [
		"【业务建模】现在开始业务建模。这与前面的渗透工作分开：目标是把目标站点的业务接口还原成一份可用的 OpenAPI 3.0 文档，并整理出它背后的业务实体与关系。",
		scope,
		...(prior ? [prior] : []),
		"用这两个工具把结果交回来（它们平时也在工具表里，但只有操作员要求建模时才该调用；本次是操作员明确要求的）：",
		'- api_model_submit：提交文档，可以反复调用。两种形态——整份提交 { openapi: {...} }；分片提交 { paths: { "/a": {...} }, components: { schemas: {...} } }，按 key 合并进已有草稿（接口多的站点分片交，一次别塞太多）。同一个调用里可以用 entities 提交业务实体（name 必填，可带 fields / relations / description）。文档会被服务端校验（必须是 3.x、必须有 info.title / info.version 和 paths）；被拒绝时按返回的具体原因改，不要原样重试。',
		"- api_model_done：声明建模结束。确认文档已经提交、并且覆盖了已确认的接口之后再调用。",
		"怎么做：",
		"1. 先确定目标：以当前会话里已经确认的目标为准（前面的侦察结果、漏洞记录、你跑过的命令都在上下文里）。目标不明确时先问操作员一句，不要猜。",
		"2. 再取证：用 bash 在容器里抓取与枚举（curl 请求页面与接口、翻前端 JS 找接口调用、按已有路径规律试探），操作员放进工作目录的抓包、文档、源码也一并读。认证方式、参数、请求体、响应结构、错误码都从实际响应里读，不靠猜。",
		"3. 边确认边提交：先提交骨架（info + 空的 paths + 公共的 components / securitySchemes），再按模块分片补端点，中途被截断也不会丢掉已确认的部分。",
		"4. 实体与关系单独整理：站点业务里的对象（用户、订单、支付、文件……）写进 entities，关系写进 relations。实体是从接口证据归纳出来的，不是把 schemas 抄一遍。",
		"5. 收尾：在 api_model_done 里写清覆盖范围——抓了哪些模块、哪些没覆盖、哪些只是推测。",
		"纪律：",
		"- 只提交实际验证过的接口与字段；推测的内容要么不写，要么在 description 里注明「未验证」。",
		"- 不要编造端点、参数或响应字段来把文档填满，宁缺毋滥。",
		"- 不要把真实凭据（Cookie、Token、口令）写进文档，示例值用占位符。",
		"- 这一步是读与还原，不是利用：对目标不做破坏性操作。",
		"- 结束后这两个工具会被摘掉，会话回到普通状态；结束前不要去做与建模无关的工作。",
	].join("\n");
}

const END_LABELS: Record<Exclude<ZGApiModelStatus, "modeling">, string> = {
	done: "完成",
	manual: "操作员结束",
	failed: "失败",
};

/** The closing marker, injected so the transcript states how the run ended. */
export function buildModelingEndMessage(input: {
	status: Exclude<ZGApiModelStatus, "modeling">;
	pathCount: number;
	operationCount: number;
	entityCount: number;
	note?: string;
}): string {
	const lines = [
		`【业务建模 · 结束】业务建模已结束（${END_LABELS[input.status]}）：已记录 ${input.pathCount} 个路径 / ${input.operationCount} 个操作 / ${input.entityCount} 个业务实体。`,
	];
	if (input.note?.trim()) lines.push(input.note.trim());
	lines.push("会话回到普通状态：两个建模工具仍在工具表里，但没有操作员要求时不要再调用。");
	return lines.join("\n");
}

/** The live state the snapshot carries, from the run plus the record's counters. */
export function modelingState(
	run: ModelingRun,
	counters: {
		title: string;
		pathCount: number;
		operationCount: number;
		entityCount: number;
	},
): ZGModelingState {
	return {
		runId: run.runId,
		title: counters.title,
		target: run.target,
		startedAt: new Date(run.startedAt).toISOString(),
		pathCount: counters.pathCount,
		operationCount: counters.operationCount,
		entityCount: counters.entityCount,
	};
}
