/**
 * DingTalk custom-robot notifications.
 *
 * A finished run posts a markdown message to the configured group robot. Sends
 * are best-effort: they never block or fail the agent run, and the outcome of
 * the most recent attempt is kept for the settings screen.
 *
 * Two robot security modes are supported:
 * - "加签" (signed): the secret signs `${timestamp}\n${secret}` with HMAC-SHA256,
 *   and the signature plus timestamp ride along as query parameters.
 * - "自定义关键词" (keyword): the message body must contain the keyword, so it is
 *   prepended to the text.
 */

import { createHmac } from "node:crypto";
import type { ZGNotifyConfig, ZGNotifyStatus, ZGTestResult, ZGVulnerability } from "./protocol.ts";
import { SESSION_STATUS_LABELS, type ZGSessionStatus } from "./session-status.ts";
import { ZG_VULN_SEVERITY_LABELS, ZG_VULN_STATUS_LABELS } from "./vulnerabilities.ts";

const SEND_TIMEOUT_MS = 10000;
/** Two retries after the first attempt, per the operator's choice. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

/** DingTalk answers 200 with a JSON body; only errcode 0 means delivered. */
interface DingTalkReply {
	errcode?: number;
	errmsg?: string;
}

/**
 * Signed webhook URL: DingTalk requires `timestamp` (ms) and `sign`, where the
 * signature is the base64 HMAC-SHA256 of `${timestamp}\n${secret}`.
 */
export function signedWebhookUrl(webhook: string, secret: string, timestampMs: number): string {
	if (!secret) return webhook;
	const stringToSign = `${timestampMs}\n${secret}`;
	const sign = createHmac("sha256", secret).update(stringToSign, "utf-8").digest("base64");
	const separator = webhook.includes("?") ? "&" : "?";
	return `${webhook}${separator}timestamp=${timestampMs}&sign=${encodeURIComponent(sign)}`;
}

/** A DingTalk markdown body, with the keyword prepended when one is configured. */
export function buildPayload(config: ZGNotifyConfig, title: string, markdown: string): string {
	const prefix = config.keyword ? `${config.keyword}\n` : "";
	return JSON.stringify({
		msgtype: "markdown",
		markdown: { title, text: `${prefix}${markdown}` },
		at: { isAtAll: false },
	});
}

/** DingTalk rejects a request body over this many bytes with errcode 460101. */
const MAX_BODY_BYTES = 20000;
/** Room for the JSON envelope, the keyword, and the trailing note. */
const BODY_BYTE_MARGIN = 300;

/** Keep the first `limit` characters; 0 keeps all of it. */
export function clipText(text: string, limit: number): string {
	if (limit <= 0 || text.length <= limit) return text;
	return `${text.slice(0, limit)}…（已截断，全文 ${text.length} 字）`;
}

/** The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes. */
function clipToBytes(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf-8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}

/**
 * The request body, clipped until it fits DingTalk's own limit.
 *
 * The character limit each section applies is the operator's choice; this is the
 * platform's, and it applies to the whole body including the envelope. A summary
 * the operator asked to keep in full still has to fit, so it is cut here and the
 * note says which limit did it.
 */
export function fitPayload(config: ZGNotifyConfig, title: string, markdown: string): string {
	const overhead = Buffer.byteLength(buildPayload(config, title, ""), "utf-8");
	if (overhead + Buffer.byteLength(markdown, "utf-8") <= MAX_BODY_BYTES) {
		return buildPayload(config, title, markdown);
	}
	const note = `…（超出钉钉单条上限，已截断，全文 ${markdown.length} 字）`;
	const budget = MAX_BODY_BYTES - BODY_BYTE_MARGIN - overhead - Buffer.byteLength(note, "utf-8");
	const kept = budget > 0 ? clipToBytes(markdown, budget) : "";
	return buildPayload(config, title, `${kept}${note}`);
}

/** One delivery attempt. Returns the failure reason, or undefined on success. */
async function attempt(config: ZGNotifyConfig, title: string, markdown: string): Promise<string | undefined> {
	const url = signedWebhookUrl(config.webhook, config.secret, Date.now());
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: fitPayload(config, title, markdown),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			return `请求超时（${SEND_TIMEOUT_MS / 1000}s）`;
		}
		const cause = error instanceof Error && error.cause instanceof Error ? `：${error.cause.message}` : "";
		return `${error instanceof Error ? error.message : String(error)}${cause}`;
	}
	if (!response.ok) return `HTTP ${response.status}`;
	let reply: DingTalkReply;
	try {
		reply = (await response.json()) as DingTalkReply;
	} catch {
		return "响应不是合法 JSON";
	}
	if (reply.errcode === 0) return undefined;
	const hint = reply.errcode === 310000 ? "（通常是加签校验失败或缺少自定义关键词）" : "";
	return `钉钉返回 errcode ${reply.errcode}: ${reply.errmsg ?? ""}${hint}`;
}

/**
 * DingTalk is https-only. http is tolerated for a loopback address so a local
 * relay (or the test suite) can stand in for the robot.
 */
export function webhookUrlError(webhook: string): string | undefined {
	let url: URL;
	try {
		url = new URL(webhook);
	} catch {
		return "webhook 不是合法的 URL";
	}
	if (url.protocol === "https:") return undefined;
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
	if (url.protocol === "http:" && loopback) return undefined;
	return "webhook 必须是 https 地址";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Post a markdown notification, retrying a transient failure. Never throws: the
 * caller records the result and moves on.
 */
export async function sendDingTalk(config: ZGNotifyConfig, title: string, markdown: string): Promise<ZGNotifyStatus> {
	const webhook = config.webhook.trim();
	if (!webhook) {
		return { at: Date.now(), ok: false, error: "未配置 webhook 地址" };
	}
	const urlError = webhookUrlError(webhook);
	if (urlError) return { at: Date.now(), ok: false, error: urlError };
	let lastError: string | undefined;
	for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
		lastError = await attempt(config, title, markdown);
		if (!lastError) return { at: Date.now(), ok: true };
		if (attemptNumber < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
	}
	return { at: Date.now(), ok: false, error: lastError };
}

/** Settings-screen "send a test message" action. */
export async function testDingTalk(config: ZGNotifyConfig): Promise<ZGTestResult> {
	if (!config.webhook.trim()) return { ok: false, message: "请先填写 webhook 地址" };
	const urlError = webhookUrlError(config.webhook.trim());
	if (urlError) return { ok: false, message: urlError, detail: "钉钉自定义机器人只接受 https。" };
	const status = await sendDingTalk(
		config,
		"ZGAgent 测试通知",
		"### ZGAgent 测试通知\n\n如果你在群里看到这条消息，通知配置可用。",
	);
	return status.ok
		? { ok: true, message: "测试消息已发送，请查看钉钉群" }
		: { ok: false, message: "发送失败", detail: status.error };
}

/**
 * Whether a settled run reports. The composer's per-message choice wins when it
 * sent one: the pill starts out mirroring the global switch, so an explicit
 * false is an opt-out even while the switch is on, and an explicit true forces a
 * send while it is off. Without a choice, the switch decides.
 */
export function shouldNotifyRun(runNotify: boolean | undefined, enabled: boolean): boolean {
	return runNotify ?? enabled;
}

/** Everything the notification reports about one finished run. */
export interface ZGRunReport {
	status: "done" | "failed" | "aborted";
	projectName: string;
	/** Session name if the operator set one, else the first instruction. */
	sessionTitle: string;
	/** The operator's manual label for that session, when it has one. */
	sessionStatus?: ZGSessionStatus | null;
	durationMs: number;
	/** The run's closing assistant text. */
	summary: string;
	/** Provider or tool error, when the run failed. */
	error?: string;
	tokens?: { input: number; output: number; total: number };
	cost?: number;
}

const STATUS_LABEL: Record<ZGRunReport["status"], string> = {
	done: "完成",
	failed: "失败",
	aborted: "已中止",
};

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.round(seconds % 60)}s`;
}

/**
 * The markdown body and robot title for a finished run. `limit` is the operator's
 * character budget for the closing summary; 0 keeps it whole.
 */
export function buildRunNotification(report: ZGRunReport, limit: number): { title: string; markdown: string } {
	const label = STATUS_LABEL[report.status];
	const title = `ZGAgent 任务${label}`;
	const lines = [
		`### ${title}`,
		"",
		`- **状态**：${label}`,
		`- **项目**：${report.projectName || "未命名项目"}`,
		`- **会话**：${report.sessionTitle || "未命名会话"}`,
	];
	// The operator labels sessions by hand to remember which one still needs them;
	// the notification is read away from the console, so it carries the label too.
	if (report.sessionStatus) lines.push(`- **会话状态**：${SESSION_STATUS_LABELS[report.sessionStatus]}`);
	lines.push(`- **耗时**：${formatDuration(report.durationMs)}`);
	if (report.tokens) {
		const cost = typeof report.cost === "number" ? ` / 花费 $${report.cost.toFixed(4)}` : "";
		lines.push(
			`- **Token**：输入 ${report.tokens.input} / 输出 ${report.tokens.output} / 合计 ${report.tokens.total}${cost}`,
		);
	}
	if (report.error) lines.push(`- **错误**：${report.error}`);
	const summary = report.summary.trim();
	if (summary) lines.push("", "**最后回复**", "", clipText(summary, limit));
	return { title, markdown: lines.join("\n") };
}

/** Everything the notification reports about one persistent goal. */
export interface ZGGoalReport {
	/** Human label of the state, e.g. "已完成" or "已暂停（轮数上限）". */
	label: string;
	projectName: string;
	sessionTitle: string;
	/** The operator's manual label for that session, when it has one. */
	sessionStatus?: ZGSessionStatus | null;
	objective: string;
	rounds: { used: number; limit: number };
	durationMs: number;
	/** The completion conclusion, the blocker reason, or the round's last prose. */
	summary: string;
	evidence?: string[];
	/** Findings the hub holds for this goal, as the runtime counted them. */
	findings?: { submitted: number; note: string };
	criteria?: { criterion: string; met: boolean; evidence: string }[];
}

/**
 * One notification per goal state change. A goal runs unattended, so this is the
 * only way the operator learns that it stopped, ran out of rounds, or finished;
 * the per-round run report is switched off for goal-driven runs to avoid noise.
 *
 * `limit` is the operator's character budget for the conclusion; 0 keeps it whole.
 */
export function buildGoalNotification(report: ZGGoalReport, limit: number): { title: string; markdown: string } {
	const title = `ZGAgent 持续目标${report.label}`;
	const lines = [
		`### ${title}`,
		"",
		`- **状态**：${report.label}`,
		`- **项目**：${report.projectName || "未命名项目"}`,
		`- **会话**：${report.sessionTitle || "未命名会话"}`,
	];
	if (report.sessionStatus) lines.push(`- **会话状态**：${SESSION_STATUS_LABELS[report.sessionStatus]}`);
	lines.push(
		`- **目标**：${report.objective}`,
		`- **轮次**：自动续跑 ${report.rounds.used}/${report.rounds.limit} 轮`,
		`- **耗时**：${formatDuration(report.durationMs)}`,
	);
	if (report.findings) {
		lines.push(
			`- **漏洞中枢**：${report.findings.submitted} 条${report.findings.note ? `（${report.findings.note}）` : ""}`,
		);
	}
	const summary = report.summary.trim();
	if (summary) lines.push("", "**结论**", "", clipText(summary, limit));
	if (report.criteria && report.criteria.length > 0) {
		lines.push("", "**验收标准**");
		for (const item of report.criteria) {
			lines.push(
				`- ${item.met ? "满足" : "未满足"}：${item.criterion}${item.evidence ? ` —— ${item.evidence}` : ""}`,
			);
		}
	}
	if (report.evidence && report.evidence.length > 0) {
		lines.push("", "**证据**");
		for (const item of report.evidence.slice(0, 8)) lines.push(`- ${item}`);
	}
	return { title, markdown: lines.join("\n") };
}

/**
 * Immediate notification for one critical/high finding, sent the moment it is
 * submitted instead of waiting for the run to end. It carries the headline, the
 * score, the target, and as much of the packet as `limit` allows; the hub page
 * holds the rest.
 */
export function buildVulnNotification(
	vuln: ZGVulnerability,
	projectName: string,
	limit: number,
): { title: string; markdown: string } {
	const severity = ZG_VULN_SEVERITY_LABELS[vuln.severity];
	const title = `ZGAgent 发现${severity}漏洞`;
	const lines = [
		`### ${title}`,
		"",
		`- **编号**：${vuln.label}`,
		`- **标题**：${vuln.title}`,
		`- **等级**：${severity}（${vuln.severity}）· CVSS ${vuln.cvss.toFixed(1)}`,
		`- **状态**：${ZG_VULN_STATUS_LABELS[vuln.status]}`,
		`- **目标**：${vuln.target}`,
		`- **项目**：${projectName || vuln.projectName}`,
		`- **来源**：${vuln.source}`,
	];
	if (vuln.category) lines.push(`- **类型**：${vuln.category}`);
	lines.push(`- **时间**：${new Date(vuln.createdAt).toLocaleString("zh-CN", { hour12: false })}`);
	const packet = vuln.packet.trim();
	if (packet) {
		// No code fence: DingTalk's markdown renderer is narrow, and the raw text
		// survives better as a paragraph.
		lines.push("", "**原始数据包**", "", clipText(packet, limit));
	}
	return { title, markdown: lines.join("\n") };
}
