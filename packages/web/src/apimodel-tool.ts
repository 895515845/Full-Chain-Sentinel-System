/**
 * The two tools business modeling works through.
 *
 * They are declared to the model in every console session: the operator may ask
 * for modeling in the conversation instead of pressing 业务建模, and a tool that
 * only a button can mount cannot be reached that way. The discipline therefore
 * lives in the tools themselves — both descriptions and both guideline lists
 * open by saying they may only be called when the operator asked for business
 * modeling — and the first submission opens the run when the model is the one
 * that started it. `api_model_done` still refuses without a live run, so a stale
 * activation cannot close a record that is already finished.
 *
 * `api_model_submit` is deliberately usable many times. A real site has hundreds
 * of endpoints, and a single document that big does not fit in one model answer;
 * the tool takes a whole document or a slice of one, merges slices into the
 * draft, and reports the validation problems of the merged result so the model
 * fixes the document rather than guessing why it was refused.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ApiModelSubmitInput } from "./apimodels.ts";

/** Outcome of one submission, as the runtime reports it back to the tool. */
export type ModelingSubmitOutcome =
	| { ok: true; pathCount: number; operationCount: number; entityCount: number; warnings: string[] }
	| { ok: false; errors: string[] };

/** What the runtime has to provide for the tools to work on a live run. */
export interface ModelingPort {
	/** The run in force for the calling session, if any. */
	current(): { runId: string; target: string } | undefined;
	/**
	 * The run in force, opening one when there is none: the model may start
	 * modeling from the conversation, and the first submission is what opens it.
	 */
	ensureRun(): { runId: string; target: string };
	submit(input: ApiModelSubmitInput): ModelingSubmitOutcome;
	/** The agent's own declaration that the document is complete. */
	done(summary: string): void;
}

/** What the runtime provides for the read-only tool over attached records. */
export interface ModelingAttachPort {
	/** The records currently attached to the session, or an empty list. */
	attached(): Array<{ id: string; title: string }>;
	/** One attached record in full, or undefined when the id is not attached. */
	read(id: string): { title: string; document: Record<string, unknown>; entities: unknown } | undefined;
}

const fieldSchema = Type.Object({
	name: Type.String({ description: "字段名，例如 id / status / created_at" }),
	type: Type.Optional(Type.String({ description: "字段类型，例如 string / integer / array<Order>" })),
	description: Type.Optional(Type.String({ description: "这个字段在业务上是什么" })),
});

const relationSchema = Type.Object({
	target: Type.String({ description: "关联到的实体名，必须与另一个实体的 name 一致" }),
	kind: Type.Optional(Type.String({ description: "关系类型，例如 1:N / 属于 / 包含" })),
	description: Type.Optional(Type.String()),
});

const entitySchema = Type.Object({
	name: Type.String({ description: "业务实体名，例如 用户 / 订单 / 支付单" }),
	description: Type.Optional(Type.String({ description: "这个实体在业务里代表什么" })),
	fields: Type.Optional(Type.Array(fieldSchema, { description: "实体的字段，从接口证据归纳" })),
	relations: Type.Optional(Type.Array(relationSchema, { description: "与其他实体的关系" })),
});

const documentSchema = Type.Record(Type.String(), Type.Unknown(), {
	description: 'OpenAPI 3.x 文档对象，例如 { openapi: "3.0.3", info: {...}, paths: {...} }',
});

const submitSchema = Type.Object({
	openapi: Type.Optional(documentSchema),
	paths: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: '按路径分片提交，例如 { "/api/users": { get: {...}, post: {...} } }；与已有草稿按路径合并',
		}),
	),
	components: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "按段分片提交，例如 { schemas: { User: {...} } }；与已有草稿按段内名称合并",
		}),
	),
	entities: Type.Optional(Type.Array(entitySchema, { description: "业务实体与关系；给了就整份替换已存的实体列表" })),
	target: Type.Optional(Type.String({ description: "建模目标：站点根地址或主机，例如 https://example.com" })),
	title: Type.Optional(Type.String({ description: "这次建模的名字，例如「商城前台 API」；不填则沿用记录里的名字" })),
	note: Type.Optional(Type.String({ description: "本次提交补了什么，写进审计时间线" })),
});

const doneSchema = Type.Object({
	summary: Type.String({
		description: "建模结论：覆盖了哪些模块、哪些没覆盖、哪些内容只是推测",
	}),
});

/** Result details shared by both tools, so the transcript can show them uniformly. */
interface ModelingToolDetails {
	ok: boolean;
	runId?: string;
	pathCount?: number;
	operationCount?: number;
	entityCount?: number;
	error?: string;
}

function failure(text: string, error: string): AgentToolResult<ModelingToolDetails> {
	return { content: [{ type: "text", text }], details: { ok: false, error }, isError: true };
}

export function createApiModelTools(port: ModelingPort): ToolDefinition[] {
	/** `api_model_done` starts here: without a live run there is nothing to close. */
	const requireActive = (): { runId: string } | { error: string } => {
		const run = port.current();
		if (!run) {
			return {
				error: "当前会话没有进行中的业务建模。先调用 api_model_submit 开始一次，或由操作员在输入框上方点「业务建模」。",
			};
		}
		return { runId: run.runId };
	};

	const submit = defineTool({
		name: "api_model_submit",
		label: "Submit API model",
		// Declared everywhere: the operator can start modeling by asking for it in
		// the conversation, and the guard against doing it unasked is the wording of
		// the description and the guidelines below, not the tool's absence.
		defaultActive: true,
		description:
			"Only call this when the operator asked for business modeling — if the user does not need business modeling, do not call this tool. Stores the OpenAPI 3.x document describing this target's business API, or one slice of it. Call it repeatedly: send a whole document with `openapi`, or send `paths` / `components` slices that merge into the draft by key — that is how a site with hundreds of endpoints is delivered without one oversized answer. `entities` records the business entities and their relations. The merged document is validated server-side (3.x, info.title, info.version, paths); when the call is refused nothing is stored and the answer lists exactly what to fix. Calling it with no run in force starts one.",
		promptSnippet: "Submit (or extend) the OpenAPI document and business entities of a modeling run",
		promptGuidelines: [
			"Call this only when the operator asked for business modeling (in the conversation or by pressing 业务建模); if the user does not need business modeling, do not call this tool",
			"Submit the skeleton first (info plus an empty paths and the shared components/securitySchemes), then add endpoints in batches with the paths slice",
			"Only submit endpoints and fields you actually verified against the target; mark anything inferred in its description instead of dropping the caveat",
			"Do not invent endpoints, parameters or response fields to fill the document out — a smaller verified document is the deliverable",
			"Do not copy real credentials (Cookie, Token, passwords) into the document; use placeholder example values",
			"Re-submitting is the normal way to fix a refusal: read the listed reasons and send the corrected slice",
		],
		parameters: submitSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<ModelingToolDetails>> {
			// No run in force means the operator asked for modeling in the
			// conversation rather than pressing the button: this call opens the run.
			const active = port.ensureRun();
			const outcome = port.submit(params);
			if (!outcome.ok) {
				return failure(
					`提交被拒绝，文档未入库：\n- ${outcome.errors.join("\n- ")}\n请按上述原因修改后重新提交。`,
					"invalid-document",
				);
			}
			const notes: string[] = [];
			if (outcome.warnings.length > 0) notes.push(`提醒：${outcome.warnings.join("；")}`);
			if (outcome.operationCount === 0) {
				notes.push("文档里还没有任何接口：继续抓取，然后用 paths 分片提交已确认的端点。");
			}
			const tail = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
			return {
				content: [
					{
						type: "text",
						text: `已入库：路径 ${outcome.pathCount} 个，操作 ${outcome.operationCount} 个，业务实体 ${outcome.entityCount} 个。${tail}`,
					},
				],
				details: {
					ok: true,
					runId: active.runId,
					pathCount: outcome.pathCount,
					operationCount: outcome.operationCount,
					entityCount: outcome.entityCount,
				},
			};
		},
	});

	const done = defineTool({
		name: "api_model_done",
		label: "Finish API modeling",
		defaultActive: true,
		description:
			"Only call this when the operator asked for business modeling — if the user does not need business modeling, do not call this tool. Declares the business model complete and ends the run. The document must already be submitted. State the coverage: which modules were mapped, which were not, and what is only inferred.",
		promptSnippet: "Declare the business-modeling run complete, with its coverage",
		promptGuidelines: [
			"Call this only when the operator asked for business modeling, and only to close a run you actually started or continued; if the user does not need business modeling, do not call this tool",
			"Call api_model_submit with the final document before api_model_done; a run that ends without a submission has produced nothing",
			"State the coverage honestly in the summary: modules mapped, modules left out, and what remains inferred",
		],
		parameters: doneSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<ModelingToolDetails>> {
			const active = requireActive();
			if ("error" in active) return failure(active.error, "no-modeling-run");
			const summary = params.summary.trim();
			if (!summary) return failure("建模结论不能为空：写清覆盖范围。", "no-summary");
			port.done(summary);
			return {
				content: [
					{
						type: "text",
						text: `业务建模已结束，记录已归档，可以继续原来的工作。\n结论：${summary}`,
					},
				],
				details: { ok: true, runId: active.runId },
			};
		},
	});

	return [submit, done];
}

/**
 * The read-only companion for sessions that carry attached records (the
 * composer's 带建模数据). Registered with `defaultActive: false` like the run
 * tools; the runtime activates it only while the session actually has records
 * attached, and deactivates it the moment the operator removes them.
 */
export function createApiModelAttachTools(port: ModelingAttachPort): ToolDefinition[] {
	const read = defineTool({
		name: "api_model_read",
		label: "Read attached API model",
		defaultActive: false,
		description:
			"Read the OpenAPI documents previously attached to this session by the operator (带建模数据). Call without `id` to list which records are attached and their ids; pass an `id` to get that record's full document — paths with all parameters, request bodies and response schemas — plus its business entities. The catalog in the conversation context is only an index; read the full record before relying on any parameter or response field.",
		promptSnippet: "Read the modeling records attached to this session",
		promptGuidelines: [
			"List first (no id), then read only the records you actually need — a full document is large",
			"The catalog in context is an index without parameters or schemas; read a record before relying on any field",
		],
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "要读取的记录 id；不传则列出已带入的全部记录" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean; id?: string }>> {
			const attached = port.attached();
			if (attached.length === 0) {
				return failure("当前会话没有带入业务建模记录。", "nothing-attached");
			}
			if (!params.id) {
				const list = attached.map((record) => `- ${record.title} [id: ${record.id}]`).join("\n");
				return {
					content: [
						{ type: "text", text: `已带入 ${attached.length} 份建模记录：\n${list}\n用 id 读取完整文档。` },
					],
					details: { ok: true },
				};
			}
			const record = port.read(params.id);
			if (!record) {
				return failure(
					`id ${params.id} 不在本会话带入的记录里。可用 id：${attached.map((item) => item.id).join("、")}。`,
					"unknown-id",
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `${record.title} 的完整文档：\n${JSON.stringify({ openapi: record.document, entities: record.entities }).replace(/</g, "\\u003c")}`,
					},
				],
				details: { ok: true, id: params.id },
			};
		},
	});
	return [read];
}
