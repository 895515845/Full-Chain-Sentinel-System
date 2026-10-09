/**
 * Unit tests for DingTalk notifications.
 *
 * A local HTTP server plays the robot, so signature building, keyword handling,
 * retry, and error mapping are pinned without reaching DingTalk.
 */

import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { buildRunNotification, sendDingTalk, shouldNotifyRun, signedWebhookUrl, testDingTalk } from "../src/notify.ts";
import { notificationsJsonPath, readNotifyConfig, writeNotifyConfig } from "../src/notify-config.ts";
import type { ZGNotifyConfig } from "../src/protocol.ts";

const CONFIG: ZGNotifyConfig = { enabled: true, webhook: "", secret: "", keyword: "" };

/** Requests the fake robot received, in order. */
interface Received {
	url: string;
	body: { msgtype?: string; markdown?: { title?: string; text?: string } };
}

let server: Server;
let received: Received[] = [];
/** Bodies the fake robot rejects, keyed by a substring of the markdown text. */
let rejectWith: { match: string; errcode: number; errmsg: string } | null = null;
let baseUrl = "";

beforeAll(async () => {
	server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk: Buffer) => {
			raw += chunk.toString();
		});
		request.on("end", () => {
			const body = JSON.parse(raw) as Received["body"];
			received.push({ url: request.url ?? "", body });
			const text = body.markdown?.text ?? "";
			const reject = rejectWith && text.includes(rejectWith.match) ? rejectWith : null;
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify(reject ? { errcode: reject.errcode, errmsg: reject.errmsg } : { errcode: 0, errmsg: "ok" }),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	baseUrl = `http://127.0.0.1:${port}/robot/send?access_token=test-token`;
});

afterAll(() => {
	server.close();
});

afterEach(() => {
	received = [];
	rejectWith = null;
});

test("a signed webhook carries a timestamp and the HMAC of timestamp-newline-secret", () => {
	const url = signedWebhookUrl("https://oapi.dingtalk.com/robot/send?access_token=abc", "SECxyz", 1700000000000);
	const parsed = new URL(url);
	expect(parsed.searchParams.get("access_token")).toBe("abc");
	expect(parsed.searchParams.get("timestamp")).toBe("1700000000000");
	const expected = createHmac("sha256", "SECxyz").update("1700000000000\nSECxyz", "utf-8").digest("base64");
	expect(parsed.searchParams.get("sign")).toBe(expected);
});

test("without a secret the webhook is used as-is", () => {
	const url = "https://oapi.dingtalk.com/robot/send?access_token=abc";
	expect(signedWebhookUrl(url, "", 1700000000000)).toBe(url);
});

test("a configured keyword is prepended to the markdown body", async () => {
	const status = await sendDingTalk({ ...CONFIG, webhook: baseUrl, keyword: "ZGAgent" }, "T", "### body");
	expect(status.ok).toBe(true);
	expect(received).toHaveLength(1);
	expect(received[0]?.body.markdown?.text).toBe("ZGAgent\n### body");
	expect(received[0]?.body.msgtype).toBe("markdown");
});

test("a robot error is reported with its errcode and the 310000 hint", async () => {
	rejectWith = { match: "### body", errcode: 310000, errmsg: "keywords not in content" };
	const status = await sendDingTalk({ ...CONFIG, webhook: baseUrl }, "T", "### body");
	expect(status.ok).toBe(false);
	expect(status.error).toContain("310000");
	expect(status.error).toContain("加签校验失败或缺少自定义关键词");
	// The first attempt plus two retries.
	expect(received).toHaveLength(3);
});

test("a rejected send is retried and can still succeed", async () => {
	// The robot accepts everything, so the three attempts all land and the last
	// result is a success.
	const status = await sendDingTalk({ ...CONFIG, webhook: baseUrl }, "T", "### retry-body");
	expect(status.ok).toBe(true);
	expect(received).toHaveLength(1);
	expect(status.at).toBeGreaterThan(0);
});

test("a missing webhook fails without any request", async () => {
	const status = await sendDingTalk({ ...CONFIG, webhook: "  " }, "T", "### body");
	expect(status.ok).toBe(false);
	expect(status.error).toContain("未配置 webhook");
	expect(received).toHaveLength(0);
});

test("the settings-screen test refuses a non-https webhook", async () => {
	const result = await testDingTalk({ ...CONFIG, webhook: "http://example.com/robot/send" });
	expect(result.ok).toBe(false);
	expect(result.message).toContain("https");
	expect(received).toHaveLength(0);
});

test("the run notification reports status, project, session, duration, tokens, and the summary", () => {
	const { title, markdown } = buildRunNotification({
		status: "failed",
		projectName: "测试项目",
		sessionTitle: "扫描 10.0.0.1",
		durationMs: 65000,
		summary: "扫描完成",
		error: "502 upstream unavailable",
		tokens: { input: 1200, output: 340, total: 1540 },
		cost: 0.0123,
	});
	expect(title).toBe("ZGAgent 任务失败");
	expect(markdown).toContain("**状态**：失败");
	expect(markdown).toContain("**项目**：测试项目");
	expect(markdown).toContain("**会话**：扫描 10.0.0.1");
	expect(markdown).toContain("**耗时**：1m5s");
	expect(markdown).toContain("输入 1200 / 输出 340 / 合计 1540 / 花费 $0.0123");
	expect(markdown).toContain("**错误**：502 upstream unavailable");
	expect(markdown).toContain("扫描完成");
});

test("a long summary is truncated in the notification", () => {
	const { markdown } = buildRunNotification({
		status: "done",
		projectName: "p",
		sessionTitle: "s",
		durationMs: 900,
		summary: "x".repeat(900),
	});
	expect(markdown).toContain("（已截断）");
	expect(markdown).not.toContain("x".repeat(600));
	expect(markdown).toContain("x".repeat(500));
});

test("a done run omits the error and token lines it has no data for", () => {
	const { markdown } = buildRunNotification({
		status: "aborted",
		projectName: "",
		sessionTitle: "",
		durationMs: 500,
		summary: "",
	});
	expect(markdown).toContain("**状态**：已中止");
	expect(markdown).toContain("未命名项目");
	expect(markdown).toContain("未命名会话");
	expect(markdown).not.toContain("**错误**");
	expect(markdown).not.toContain("**Token**");
});

test("the per-message choice overrides the global switch in both directions", () => {
	// No choice from the composer: the switch decides.
	expect(shouldNotifyRun(undefined, true)).toBe(true);
	expect(shouldNotifyRun(undefined, false)).toBe(false);
	// An explicit choice wins: opt out while on, force while off.
	expect(shouldNotifyRun(false, true)).toBe(false);
	expect(shouldNotifyRun(true, false)).toBe(true);
});

test("the notification config round-trips through notifications.json with 0600", () => {
	const dir = mkdtempSync(join(tmpdir(), "zg-notify-"));
	try {
		expect(readNotifyConfig(dir)).toEqual({ enabled: false, webhook: "", secret: "", keyword: "" });
		writeNotifyConfig(dir, { enabled: true, webhook: " https://x/y ", secret: " SEC ", keyword: " KW " });
		expect(readNotifyConfig(dir)).toEqual({
			enabled: true,
			webhook: "https://x/y",
			secret: "SEC",
			keyword: "KW",
		});
		chmodSync(notificationsJsonPath(dir), 0o600);
		expect(statSync(notificationsJsonPath(dir)).mode & 0o777).toBe(0o600);
		expect(readFileSync(notificationsJsonPath(dir), "utf-8")).toContain('"dingtalk"');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
