/**
 * The vulnerability reviewer: a dedicated LLM that calibrates every fresh
 * finding's CVSS metrics, and flags records whose evidence does not support the
 * claimed conclusion (hallucination suspects). The score and the five-level
 * label are derived from those metrics in `cvss.ts`, never written by the model.
 *
 * It lives entirely at the hub layer: submissions still land instantly with
 * the agent's own rating, the review happens asynchronously through a serial
 * queue, and the main agent never sees or waits for any of it. The verdict
 * overwrites severity/CVSS only while the record is still pending and no
 * operator has touched it — after that the machine defers to the human, except
 * when the operator asks for a re-review by hand.
 *
 * The endpoint is the commander's dedicated configuration when present,
 * otherwise the main endpoint: one more "dedicated model" slot without a
 * third settings page.
 */

import { type CvssMetrics, cvssBaseScore, cvssVector, parseCvssMetrics } from "./cvss.ts";
import { readModelLibrary, resolveLibraryRole } from "./model-library.ts";
import type { SentinelVulnerability } from "./protocol.ts";
import { severityForCvss, type VulnerabilityStore } from "./vulnerabilities.ts";

/**
 * What the reviewer is asked to produce. It judges the eight metrics and the
 * evidence, and never a number: `cvss.ts` turns the metrics into the score and
 * the five-level label.
 */
export interface ReviewVerdict {
	metrics: CvssMetrics;
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

1. 判定 CVSS v3.1 基准指标：攻击向量 av(N=网络/A=相邻/L=本地/P=物理)、攻击复杂度 ac(L=低/H=高)、所需权限 pr(N=无/L=低/H=高)、用户交互 ui(N=无/R=需要)、影响范围 s(U=不变/C=改变)、机密性 c、完整性 i、可用性 a(各取 H=高/L=低/N=无)。按目标实际暴露面判断：容器/内网、需要认证、需要用户点击都要如实反映，不要照抄提交者的乐观假设。

2. 证据审查：只依据给你的证据（原始数据包、命令与输出、复现步骤）判断结论是否被支撑。证据不足、输出与结论不符、或关键主张无佐证时，判 dubious=true 并在 reason 里指出具体缺口。宁可存疑，不要脑补。

分数和等级由程序按 CVSS v3.1 公式从你给的指标算出，你不要给分数。严格输出 JSON（不要 markdown 代码块、不要多余文字）：
{"av":"N","ac":"L","pr":"N","ui":"N","s":"U","c":"H","i":"H","a":"H","dubious":false,"reason":"<中文，一到三句：指标依据；若存疑，指出证据缺口>"}`;

function clip(value: string | undefined, limit: number): string {
	if (!value) return "（无）";
	const trimmed = value.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit)}…（截断）` : trimmed;
}

/** Exported for tests: the exact material the reviewer model is shown. */
export function buildUserPrompt(vuln: SentinelVulnerability): string {
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
	const metrics = parseCvssMetrics(parsed);
	if (typeof parsed.dubious !== "boolean") throw new Error(`dubious 无效：${String(parsed.dubious)}`);
	const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
	if (!reason) throw new Error("reason 为空");
	return { metrics, dubious: parsed.dubious, reason };
}

async function callReviewer(
	config: { baseUrl: string; apiKey: string; modelId: string },
	vuln: SentinelVulnerability,
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
	onSettled(vuln: SentinelVulnerability | undefined): void;
}

export class VulnReviewer {
	private readonly store: VulnerabilityStore;
	private readonly hooks: ReviewerHooks;
	private readonly agentDir: string;
	/** Pending work; `force` marks an operator-requested re-review of a settled record. */
	private readonly queue: Array<{ id: string; force: boolean }> = [];
	private draining = false;
	/** The model call; public and mutable so tests can stub it. */
	call: (
		config: { baseUrl: string; apiKey: string; modelId: string },
		vuln: SentinelVulnerability,
	) => Promise<ReviewVerdict>;

	constructor(store: VulnerabilityStore, hooks: ReviewerHooks, agentDir: string) {
		this.store = store;
		this.hooks = hooks;
		this.agentDir = agentDir;
		this.call = callReviewer;
	}

	/**
	 * Re-enqueue records that were queued when a previous process died. Skipped
	 * entirely while automatic review is off: nothing should be judged then.
	 */
	recover(): void {
		if (!readModelLibrary(this.agentDir).reviewerAuto) return;
		for (const id of this.store.queuedReviewIds()) this.enqueue(id);
	}

	enqueue(vulnId: string, force = false): void {
		const queued = this.queue.find((item) => item.id === vulnId);
		if (queued) {
			// A forced request must not be downgraded by one already waiting.
			if (force) queued.force = true;
			return;
		}
		this.queue.push({ id: vulnId, force });
		void this.drain();
	}

	/** Manual retry from the hub page: a failed review requeues. */
	retry(vulnId: string): { ok: boolean; error?: string } {
		if (!this.store.requeueReview(vulnId)) {
			return { ok: false, error: "该记录无法重试（未评审失败、正在评审中，或已被操作员处理）" };
		}
		this.enqueue(vulnId);
		return { ok: true };
	}

	/**
	 * Operator-requested re-review of a settled record. Unlike the automatic
	 * pass this overwrites whatever the record holds now, including a rating the
	 * operator edited by hand, so the timeline records it as a manual re-review.
	 */
	requeue(vulnId: string): { ok: boolean; error?: string } {
		if (!this.store.requeueReview(vulnId, true)) {
			return { ok: false, error: "该记录正在评审中" };
		}
		this.enqueue(vulnId, true);
		return { ok: true };
	}

	/** Bulk forced re-review, for every id the operator's console handed over. */
	requeueAll(vulnIds: string[]): number {
		let queued = 0;
		for (const id of vulnIds) {
			if (this.store.requeueReview(id, true)) {
				this.enqueue(id, true);
				queued += 1;
			}
		}
		return queued;
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift();
				if (!item) break;
				await this.reviewOne(item.id, item.force);
			}
		} finally {
			this.draining = false;
		}
	}

	private async reviewOne(id: string, force: boolean): Promise<void> {
		const config = resolveLibraryRole(this.agentDir, "reviewer")?.config ?? null;
		const vuln = this.store.get(id);
		// Re-check arbitration at execution time: the operator may have acted
		// while the record sat in the queue.
		if (!vuln || vuln.review.state !== "queued" || (vuln.status !== "pending" && !force)) return;
		if (!config) {
			this.store.markReviewFailed(id, "未配置模型端点，无法评审");
			this.hooks.onSettled(this.store.get(id));
			return;
		}
		try {
			const verdict = await this.call(config, vuln);
			// The model picks the metrics; the score and the five-level label are
			// derived here so they can never disagree with the vector.
			const cvss = cvssBaseScore(verdict.metrics);
			const updated = this.store.applyReview(
				id,
				{
					severity: severityForCvss(cvss),
					cvss,
					cvssVector: cvssVector(verdict.metrics),
					dubious: verdict.dubious,
					reason: verdict.reason,
					model: config.modelId,
				},
				force,
			);
			this.hooks.onSettled(updated ?? undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.store.markReviewFailed(id, message);
			this.hooks.onSettled(this.store.get(id));
		}
	}
}
