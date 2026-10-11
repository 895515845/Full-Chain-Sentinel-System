/**
 * The vulnerability reviewer: a dedicated LLM that calibrates every fresh
 * finding's severity and CVSS, and flags records whose evidence does not
 * support the claimed conclusion (hallucination suspects).
 *
 * It lives entirely at the hub layer: submissions still land instantly with
 * the agent's own rating, the review happens asynchronously through a serial
 * queue, and the main agent never sees or waits for any of it. The verdict
 * overwrites severity/CVSS only while the record is still pending and no
 * operator has touched it — after that the machine defers to the human.
 *
 * The endpoint is the commander's dedicated configuration when present,
 * otherwise the main endpoint: one more "dedicated model" slot without a
 * third settings page.
 */

import { readCommanderModelConfig, readModelConfig } from "./model-config.ts";
import type { ZGVulnerability } from "./protocol.ts";
import type { VulnerabilityStore } from "./vulnerabilities.ts";

/** What the reviewer is asked to produce. */
export interface ReviewVerdict {
	severity: "critical" | "high" | "medium" | "low" | "info";
	cvss: number;
	cvssVector?: string;
	/** true when the evidence does not support the claimed finding. */
	dubious: boolean;
	reason: string;
}

/** How much of each field reaches the reviewer; packets can be huge. */
const PACKET_LIMIT = 6000;
const EVIDENCE_OUTPUT_LIMIT = 1500;
const TEXT_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 90_000;

const SYSTEM_PROMPT = `你是一名严谨的漏洞评审员。你评审渗透测试代理提交的漏洞记录，做两件事：

1. 校准等级与 CVSS：依据 CVSS v3.1 基准指标（攻击向量 AV、攻击复杂度 AC、所需权限 PR、用户交互 UI、影响范围 S、机密性/完整性/可用性 C/I/A）推导 0.0-10.0 的基础分和向量串，并给出对应五级（严重 ≥9.0、高危 ≥7.0、中危 ≥4.0、低危 >0、信息 =0）。内部环境（容器/内网）与低权限前提要如实反映在指标里，不要照抄提交者自评。

2. 证据审查：只依据给你的证据（原始数据包、命令与输出、复现步骤）判断结论是否被支撑。证据不足、输出与结论不符、或关键主张无佐证时，判 dubious=true 并在 reason 里指出具体缺口。宁可存疑，不要脑补。

严格输出 JSON（不要 markdown 代码块、不要多余文字）：
{"severity":"critical|high|medium|low|info","cvss":<0.0-10.0 一位小数>,"cvss_vector":"CVSS:3.1/AV:.../...","dubious":true|false,"reason":"<中文，一到三句：评级依据；若存疑，指出证据缺口>"}`;

function clip(value: string | undefined, limit: number): string {
	if (!value) return "（无）";
	const trimmed = value.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit)}…（截断）` : trimmed;
}

function buildUserPrompt(vuln: ZGVulnerability): string {
	const evidence = vuln.evidence
		.map(
			(item, index) =>
				`证据 ${index + 1}：${item.kind === "command" ? "命令" : "文件"}${item.command ? `\n  命令：${clip(item.command, TEXT_LIMIT)}` : ""}${item.output ? `\n  输出：${clip(item.output, EVIDENCE_OUTPUT_LIMIT)}` : ""}${item.path ? `\n  文件：${item.path}` : ""}`,
		)
		.join("\n");
	return [
		`标题：${clip(vuln.title, 300)}`,
		`目标：${vuln.target}`,
		`类型：${vuln.category ?? "未分类"}`,
		`提交者自评：${vuln.severity} / CVSS ${vuln.cvss.toFixed(1)}${vuln.cvssVector ? ` / ${vuln.cvssVector}` : ""}`,
		`来源：${vuln.source}`,
		"",
		`漏洞描述：${clip(vuln.description, TEXT_LIMIT)}`,
		"",
		`原始数据包：\n${clip(vuln.packet, PACKET_LIMIT)}`,
		"",
		`证据列表：\n${evidence || "（无）"}`,
		"",
		vuln.repro ? `复现步骤：\n${clip(vuln.repro, TEXT_LIMIT)}` : "复现步骤：（无）",
		"",
		"请给出评审 JSON。",
	].join("\n");
}

/** Pull the JSON object out of a model reply that may carry fences or prose. */
export function parseVerdict(raw: string): ReviewVerdict {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("回复中没有 JSON 对象");
	const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
	const severity = parsed.severity;
	if (
		severity !== "critical" &&
		severity !== "high" &&
		severity !== "medium" &&
		severity !== "low" &&
		severity !== "info"
	) {
		throw new Error(`severity 无效：${String(severity)}`);
	}
	const cvss = Number(parsed.cvss);
	if (!Number.isFinite(cvss) || cvss < 0 || cvss > 10) throw new Error(`cvss 无效：${String(parsed.cvss)}`);
	const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
	if (!reason) throw new Error("reason 为空");
	return {
		severity,
		cvss: Math.round(cvss * 10) / 10,
		...(typeof parsed.cvss_vector === "string" && parsed.cvss_vector.trim()
			? { cvssVector: parsed.cvss_vector.trim() }
			: {}),
		dubious: parsed.dubious === true,
		reason,
	};
}

async function callReviewer(
	config: { baseUrl: string; apiKey: string; modelId: string },
	vuln: ZGVulnerability,
): Promise<ReviewVerdict> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: config.modelId,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: buildUserPrompt(vuln) },
				],
				temperature: 0,
				response_format: { type: "json_object" },
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`端点返回 ${response.status}${body ? `：${body.slice(0, 200)}` : ""}`);
		}
		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
		};
		const content = data.choices?.[0]?.message?.content;
		const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : (content ?? "");
		if (!text.trim()) throw new Error("端点返回了空回复");
		return parseVerdict(text);
	} finally {
		clearTimeout(timer);
	}
}

/** Fires whenever a review settles, so consoles and notifications refresh. */
export interface ReviewerHooks {
	onSettled(vuln: ZGVulnerability | undefined): void;
}

export class VulnReviewer {
	private readonly store: VulnerabilityStore;
	private readonly hooks: ReviewerHooks;
	private readonly agentDir: string;
	private readonly queue: string[] = [];
	private draining = false;
	/** The model call; public and mutable so tests can stub it. */
	call: (
		config: { baseUrl: string; apiKey: string; modelId: string },
		vuln: ZGVulnerability,
	) => Promise<ReviewVerdict>;

	constructor(store: VulnerabilityStore, hooks: ReviewerHooks, agentDir: string) {
		this.store = store;
		this.hooks = hooks;
		this.agentDir = agentDir;
		this.call = callReviewer;
	}

	/** Re-enqueue records that were queued when a previous process died. */
	recover(): void {
		for (const id of this.store.queuedReviewIds()) this.enqueue(id);
	}

	enqueue(vulnId: string): void {
		if (this.queue.includes(vulnId)) return;
		this.queue.push(vulnId);
		void this.drain();
	}

	/** Manual retry from the hub page: failed (or stuck) reviews requeue. */
	retry(vulnId: string): { ok: boolean; error?: string } {
		if (!this.store.requeueReview(vulnId)) {
			return { ok: false, error: "该记录不在可重试状态（未评审失败，或已被操作员处理）" };
		}
		this.enqueue(vulnId);
		return { ok: true };
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const id = this.queue.shift();
				if (!id) break;
				await this.reviewOne(id);
			}
		} finally {
			this.draining = false;
		}
	}

	private async reviewOne(id: string): Promise<void> {
		const config = readCommanderModelConfig(this.agentDir) ?? readModelConfig(this.agentDir);
		const vuln = this.store.get(id);
		// Re-check arbitration at execution time: the operator may have acted
		// while the record sat in the queue.
		if (!vuln || vuln.status !== "pending" || vuln.review.state !== "queued") return;
		if (!config) {
			this.store.markReviewFailed(id, "未配置模型端点，无法评审");
			this.hooks.onSettled(this.store.get(id));
			return;
		}
		try {
			const verdict = await this.call(config, vuln);
			const updated = this.store.applyReview(id, {
				severity: verdict.severity,
				cvss: verdict.cvss,
				...(verdict.cvssVector ? { cvssVector: verdict.cvssVector } : {}),
				dubious: verdict.dubious,
				reason: verdict.reason,
				model: config.modelId,
			});
			this.hooks.onSettled(updated ?? undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.store.markReviewFailed(id, message);
			this.hooks.onSettled(this.store.get(id));
		}
	}
}
