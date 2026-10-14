/**
 * The vulnerability hub's agent-facing tools.
 *
 * `vuln_submit` is how a finding reaches the hub: the agent states the target,
 * the severity, a CVSS score, and the raw packet that proves it, and the record
 * lands as "待确认" for the operator to reproduce. `vuln_list` and `vuln_get`
 * let it read back what the project already holds, so a second pass reports a
 * new finding instead of re-submitting an old one.
 *
 * There is no tool that edits or deletes a record: the hub is a record of what
 * was claimed and what the operator decided, not a scratchpad.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ZGVulnerability, ZGVulnFilters, ZGVulnSeverity, ZGVulnStatus } from "./protocol.ts";
import {
	isSeverityMismatch,
	severityForCvss,
	type VulnerabilityStore,
	ZG_VULN_SEVERITY_LABELS,
	ZG_VULN_STATUS_LABELS,
} from "./vulnerabilities.ts";

/** Longest tool output handed back to the model, so one record cannot flood the context. */
const MAX_TOOL_OUTPUT = 8000;

/** Longest title accepted. A finding title is a label, not a paragraph. */
export const MAX_VULN_TITLE_CHARS = 40;

/**
 * Leading decoration an agent attaches when it echoes its own plan: the plan
 * number in brackets, a task id, a list marker. Only *leading* groups are
 * stripped, so a trailing "(CWE-307)" stays part of the title.
 */
const TITLE_LEAD = /^(?:[【[（(][^】\]）)]{0,60}[】\]）)]|\d+\s*[.、)）]|[-*#])\s*/;

/** Closing punctuation a one-line title does not need. */
const TITLE_TAIL = /[。．.；;，,、：:\s]+$/;

/**
 * Turn a submitted title into a one-line label.
 *
 * Agents that carry a plan number through a run tend to prefix it to every
 * output, so the hub ended up with titles like
 * "【计划编号 PLAN-0109】结论更正：api/report/export 非 SSRF（建议撤销）".
 * The plan number, the round, and the verdict are process notes: they belong in
 * the description, and the title is only the flaw.
 */
export function normalizeVulnTitle(raw: string): string {
	let title = raw.replace(/\s+/g, " ").trim();
	for (;;) {
		const next = title.replace(TITLE_LEAD, "").trim();
		// A title that is nothing but decoration keeps its original text, so the
		// operator still sees what the agent tried to submit.
		if (next === title || next === "") return title.replace(TITLE_TAIL, "").trim();
		title = next;
	}
}

function clip(text: string, limit = MAX_TOOL_OUTPUT): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n…（输出已截断，共 ${text.length} 字符）`;
}

function severityTag(severity: ZGVulnSeverity, cvss: number): string {
	const mismatch = isSeverityMismatch(severity, cvss) ? `，与 CVSS 档位（${severityForCvss(cvss)}）不一致` : "";
	return `${severity}/${ZG_VULN_SEVERITY_LABELS[severity]} CVSS ${cvss.toFixed(1)}${mismatch}`;
}

function renderFull(vuln: ZGVulnerability): string {
	const lines = [
		`${vuln.label} ${vuln.title}`,
		`等级：${severityTag(vuln.severity, vuln.cvss)}${vuln.cvssVector ? ` · 向量 ${vuln.cvssVector}` : ""}`,
		`状态：${ZG_VULN_STATUS_LABELS[vuln.status]}`,
		`目标：${vuln.target}`,
	];
	if (vuln.category) lines.push(`类型：${vuln.category}`);
	lines.push(`来源：${vuln.source}`, `提交时间：${vuln.createdAt}`, "", "漏洞详情：", vuln.description);
	if (vuln.packet.trim()) lines.push("", "原始数据包：", vuln.packet);
	if (vuln.repro) lines.push("", "复现步骤：", vuln.repro);
	if (vuln.evidence.length > 0) {
		lines.push("", "证据：");
		for (const [index, item] of vuln.evidence.entries()) {
			lines.push(`  ${index + 1}. ${item.note ?? ""}`.trimEnd());
			if (item.path) lines.push(`     容器文件：${item.path}`);
			if (item.command) lines.push(`     命令：${item.command}`);
			if (item.output) lines.push(`     输出：${item.output}`);
		}
	}
	if (vuln.remediation) lines.push("", "修复建议：", vuln.remediation);
	if (vuln.references?.length) lines.push("", `参考：${vuln.references.join("、")}`);
	if (vuln.notes.length > 0) {
		lines.push("", "处理时间线：");
		for (const note of vuln.notes) lines.push(`  - ${note.at} ${note.author}：${note.text}`);
	}
	return clip(lines.join("\n"));
}

/** Result details of the three hub tools; the same shape on the success and failure paths. */
interface SubmitDetails {
	ok: boolean;
	id?: string;
	label?: string;
	severity?: ZGVulnSeverity;
	status?: ZGVulnStatus;
	error?: string;
}

interface ListDetails {
	ok: boolean;
	count: number;
	error?: string;
}

interface GetDetails {
	ok: boolean;
	id?: string;
	label?: string;
	status?: ZGVulnStatus;
	error?: string;
}

export interface VulnerabilityToolOptions {
	store: VulnerabilityStore;
	/** Active project; undefined means no project is selected and nothing may be submitted. */
	getProject: () => { id: string; name: string } | undefined;
	/** Main session of the submission, for the record. */
	getSessionId: () => string | undefined;
	/** Who is calling, e.g. "主代理" or "子代理 <runId>". */
	getSource: () => string;
	/** Called for critical/high findings so the runtime can push a notification. */
	onHighSeverity?: (vuln: ZGVulnerability) => void;
	/** Called after a record is created, so connected consoles refresh the hub page. */
	onChange?: () => void;
	/** Called once per created record, so a running goal can count it as its own finding. */
	onSubmit?: (vuln: ZGVulnerability) => void;
}

const evidenceSchema = Type.Object({
	kind: Type.Union([Type.Literal("command"), Type.Literal("file")], {
		description: "command: a shell command with its output. file: a file inside the project container.",
	}),
	command: Type.Optional(Type.String({ description: "Command that produced the evidence (kind=command)" })),
	output: Type.Optional(Type.String({ description: "Key output of that command (kind=command)" })),
	path: Type.Optional(
		Type.String({ description: "Absolute container path, e.g. /work/evidence/nmap.txt (kind=file)" }),
	),
	note: Type.Optional(Type.String({ description: "What this piece of evidence shows" })),
});

const submitSchema = Type.Object({
	title: Type.String({
		minLength: 1,
		description:
			"One-line finding title: vulnerability class plus affected object, at most 40 characters (e.g. '后台登录处 SQL 注入'). No 【】 prefix, plan number, round, verdict or fix advice; those go in description.",
	}),
	severity: Type.Union(
		[
			Type.Literal("critical"),
			Type.Literal("high"),
			Type.Literal("medium"),
			Type.Literal("low"),
			Type.Literal("info"),
		],
		{ description: "Severity bucket; it must agree with the CVSS score" },
	),
	cvss: Type.Number({ minimum: 0, maximum: 10, description: "CVSS base score, 0.0-10.0" }),
	cvssVector: Type.Optional(Type.String({ description: "Optional CVSS vector string" })),
	target: Type.String({ minLength: 1, description: "Affected target: host, URL, IP:port or service" }),
	category: Type.Optional(Type.String({ description: "Vulnerability class, e.g. 'SQL 注入' / '未授权访问'" })),
	description: Type.String({ minLength: 1, description: "What the flaw is and what it lets an attacker do" }),
	packet: Type.String({
		minLength: 1,
		description: "The raw request or packet that proves it, verbatim (HTTP request/response, or the packet bytes)",
	}),
	repro: Type.Optional(Type.String({ description: "Steps to reproduce, in order" })),
	remediation: Type.Optional(Type.String({ description: "How to fix it" })),
	references: Type.Optional(Type.Array(Type.String(), { description: "CVE/CWE ids or reference links" })),
	evidence: Type.Optional(
		Type.Array(evidenceSchema, { description: "Supporting commands, outputs, and container files" }),
	),
});

const listSchema = Type.Object({
	status: Type.Optional(
		Type.Union(
			[Type.Literal("pending"), Type.Literal("confirmed"), Type.Literal("false_positive"), Type.Literal("fixed")],
			{
				description: "Only findings in this state",
			},
		),
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
			{ description: "Only findings of this severity" },
		),
	),
	target: Type.Optional(Type.String({ description: "Substring match on the affected target" })),
	search: Type.Optional(Type.String({ description: "Substring match on id, title, type or description" })),
});

const getSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Finding id, e.g. 'E2E-PROJECT-0003', or its internal id" }),
});

export function createVulnerabilityTools(options: VulnerabilityToolOptions): ToolDefinition[] {
	const requireProject = (): { id: string; name: string } => {
		const project = options.getProject();
		if (!project) throw new Error("尚未选择项目，无法使用漏洞中枢。请先在控制台创建或选择一个项目。");
		return project;
	};

	const submit = defineTool({
		name: "vuln_submit",
		label: "Submit finding",
		description:
			"Submit one confirmed finding to the project's vulnerability hub. Call it once per finding, as soon as the finding is validated, instead of waiting for the final summary. The record lands as 待确认 for the operator to reproduce, so state the evidence you actually have.",
		promptSnippet:
			"Submit a validated finding (severity, CVSS, target, raw packet) to the project's vulnerability hub",
		promptGuidelines: [
			"Submit every validated finding with vuln_submit as soon as it is confirmed, not only in the final report",
			"Give vuln_submit the raw request or packet that proves the finding, plus a CVSS score that matches the severity bucket",
			"Your severity and CVSS are a first estimate: the hub recalibrates a fresh finding from CVSS v3.1 metrics, so rate the flaw honestly for the evidence you have instead of reaching for the highest bucket",
			"Check vuln_list before submitting so an already-recorded finding is updated in your notes instead of submitted twice",
			"Keep the vuln_submit title to one line of at most 40 characters: the flaw plus what it affects. Plan numbers, rounds, corrected verdicts and fix advice go into description, never into the title",
		],
		parameters: submitSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<SubmitDetails>> {
			const project = requireProject();
			if (!Number.isFinite(params.cvss) || params.cvss < 0 || params.cvss > 10) {
				return {
					content: [{ type: "text", text: `CVSS 分数必须在 0.0-10.0 之间，收到 ${params.cvss}。` }],
					details: { ok: false, error: "invalid-cvss" },
					isError: true,
				};
			}
			const submittedTitle = params.title.trim();
			const title = normalizeVulnTitle(submittedTitle);
			if (!title) {
				return {
					content: [{ type: "text", text: "标题不能为空。" }],
					details: { ok: false, error: "empty-title" },
					isError: true,
				};
			}
			if (title.length > MAX_VULN_TITLE_CHARS) {
				return {
					content: [
						{
							type: "text",
							text: `标题太长（${title.length} 字，上限 ${MAX_VULN_TITLE_CHARS} 字），没有入库。请改成一句话漏洞标题：「漏洞类型 + 受影响对象」，例如「后台登录处 SQL 注入」「/api/report/export 免验证码登录」。计划编号、轮次、结论更正、建议撤销、括号里的判定说明都属于流程信息，写进 description；改好后重新调用 vuln_submit。`,
						},
					],
					details: { ok: false, error: "title-too-long" },
					isError: true,
				};
			}
			const vuln = options.store.create({
				projectId: project.id,
				projectName: project.name,
				...(options.getSessionId() ? { sessionId: options.getSessionId() as string } : {}),
				source: options.getSource(),
				title,
				severity: params.severity,
				cvss: params.cvss,
				...(params.cvssVector?.trim() ? { cvssVector: params.cvssVector.trim() } : {}),
				target: params.target.trim(),
				...(params.category?.trim() ? { category: params.category.trim() } : {}),
				description: params.description,
				packet: params.packet,
				...(params.repro?.trim() ? { repro: params.repro } : {}),
				...(params.remediation?.trim() ? { remediation: params.remediation } : {}),
				...(params.references?.length ? { references: params.references } : {}),
				...(params.evidence?.length ? { evidence: params.evidence } : {}),
			});
			if (vuln.severity === "critical" || vuln.severity === "high") {
				options.onHighSeverity?.(vuln);
			}
			options.onSubmit?.(vuln);
			options.onChange?.();
			const warning = vuln.severityMismatch
				? `\n注意：等级与 CVSS 分数不一致（${vuln.cvss.toFixed(1)} 对应 ${severityForCvss(vuln.cvss)}），已照你给的等级记录，操作员会复核。`
				: "";
			const titleNote = title === submittedTitle ? "" : `（标题已规范化为「${title}」：去掉了前缀与末尾标点）`;
			return {
				content: [
					{
						type: "text",
						text: `已提交到漏洞中枢：${vuln.label} ${vuln.title}（${severityTag(vuln.severity, vuln.cvss)}），状态：待确认。${titleNote}${warning}`,
					},
				],
				details: { ok: true, id: vuln.id, label: vuln.label, severity: vuln.severity, status: vuln.status },
			};
		},
	});

	const list = defineTool({
		name: "vuln_list",
		label: "List findings",
		description:
			"List the findings already recorded for this project, newest first. Use it before reporting to avoid submitting a duplicate, and to reference existing ids in your summary.",
		promptSnippet: "List the findings already recorded in this project's vulnerability hub",
		parameters: listSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<ListDetails>> {
			const project = requireProject();
			const filters: ZGVulnFilters = {
				...(params.status ? { status: params.status as ZGVulnStatus } : {}),
				...(params.severity ? { severity: params.severity as ZGVulnSeverity } : {}),
				...(params.target?.trim() ? { target: params.target.trim() } : {}),
				...(params.search?.trim() ? { search: params.search.trim() } : {}),
			};
			const items = options.store.list(project.id, filters);
			if (items.length === 0) {
				return {
					content: [{ type: "text", text: "当前项目没有符合条件的漏洞记录。" }],
					details: { ok: true, count: 0 },
				};
			}
			const lines = items.map(
				(item) =>
					`${item.label} | ${item.severity} | CVSS ${item.cvss.toFixed(1)} | ${ZG_VULN_STATUS_LABELS[item.status]} | ${item.target} | ${item.title}`,
			);
			return {
				content: [
					{
						type: "text",
						text: clip(
							`当前项目 ${items.length} 条漏洞记录（编号 | 等级 | CVSS | 状态 | 目标 | 标题）：\n${lines.join("\n")}`,
						),
					},
				],
				details: { ok: true, count: items.length },
			};
		},
	});

	const get = defineTool({
		name: "vuln_get",
		label: "Get finding",
		description:
			"Read one finding of this project in full, including its raw packet, evidence and the operator's timeline.",
		promptSnippet: "Read one finding from this project's vulnerability hub in full",
		parameters: getSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<GetDetails>> {
			const project = requireProject();
			const vuln = options.store.find(project.id, params.id);
			if (!vuln) {
				return {
					content: [{ type: "text", text: `当前项目没有编号为 ${params.id} 的漏洞记录。` }],
					details: { ok: false, error: "not-found" },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: renderFull(vuln) }],
				details: { ok: true, id: vuln.id, label: vuln.label, status: vuln.status },
			};
		},
	});

	return [submit, list, get];
}
