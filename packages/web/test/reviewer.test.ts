/**
 * Unit tests for the vulnerability reviewer: the arbitration rules (only a
 * still-pending, operator-untouched record gets calibrated), the timeline
 * trace, failure states, and the defensive verdict parsing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildUserPrompt, parseVerdict, VulnReviewer } from "../src/reviewer.ts";
import { VulnerabilityStore } from "../src/vulnerabilities.ts";
import { writeTestModel } from "./model-fixtures.ts";

let dir: string;
let store: VulnerabilityStore;
let reviewer: VulnReviewer;
const settled: Array<string | undefined> = [];

const submit = (over: Record<string, unknown> = {}) =>
	store.create({
		projectId: "p1",
		projectName: "评审项目",
		source: "主代理",
		title: "测试漏洞",
		severity: "critical",
		cvss: 9.8,
		description: "描述",
		packet: "GET / HTTP/1.1",
		target: "10.0.0.1",
		...over,
	});

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-reviewer-"));
	store = new VulnerabilityStore(join(dir, "vulns.db"));
	// The reviewer resolves its endpoint from the agent dir; a stub config
	// keeps the real path exercised while the model call itself is stubbed.
	writeTestModel(
		join(dir, "agent"),
		{ baseUrl: "http://127.0.0.1:9/v1", apiKey: "stub", modelId: "reviewer-stub" },
		"reviewer",
	);
	reviewer = new VulnReviewer(
		store,
		{
			onSettled: (vuln) => settled.push(vuln?.review.state),
		},
		join(dir, "agent"),
	);
	// A deterministic stub: every call "reviews" down to medium/6.5. The model
	// returns metrics only, so the score below is the code's own arithmetic.
	reviewer.call = async () => ({
		metrics: { av: "N", ac: "L", pr: "N", ui: "N", s: "U", c: "L", i: "L", a: "N" },
		dubious: false,
		reason: "内网低权限前提，影响有限。",
	});
});

afterAll(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("a pending submission is calibrated and the change is traced", async () => {
	const vuln = submit();
	expect(vuln.review.state).toBe("queued");
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	const after = store.get(vuln.id);
	expect(after?.severity).toBe("medium");
	expect(after?.cvss).toBe(6.5);
	expect(after?.cvssVector).toBe("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N");
	// Derived from the score, so a record the reviewer rated can never carry the
	// "severity and score disagree" warning.
	expect(after?.severityMismatch).toBe(false);
	expect(after?.review.state).toBe("done");
	expect(after?.review.reason).toContain("内网");
	const lastNote = after?.notes[after.notes.length - 1];
	expect(lastNote?.author).toBe("system");
	expect(lastNote?.text).toContain("LLM 评审");
	expect(lastNote?.text).toContain("严重 → 中危");
});

test("an operator update before the review skips calibration for good", async () => {
	const vuln = submit();
	store.update(vuln.id, { status: "confirmed", note: "我先确认了" });
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	const after = store.get(vuln.id);
	expect(after?.review.state).toBe("skipped");
	expect(after?.severity).toBe("critical"); // agent's values untouched
});

test("a failed model call marks the review failed and keeps the agent's values", async () => {
	const original = reviewer.call;
	reviewer.call = async () => {
		throw new Error("端点返回 503");
	};
	const vuln = submit();
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	let after = store.get(vuln.id);
	expect(after?.review.state).toBe("failed");
	expect(after?.review.error).toContain("503");
	expect(after?.severity).toBe("critical");
	// Manual retry restores and re-runs with a working model.
	reviewer.call = original;
	expect(reviewer.retry(vuln.id).ok).toBe(true);
	await new Promise((resolve) => setImmediate(resolve));
	after = store.get(vuln.id);
	expect(after?.review.state).toBe("done");
	expect(after?.severity).toBe("medium");
});

test("retry is refused for records outside the failed/queued states", () => {
	const vuln = submit();
	store.update(vuln.id, { status: "false_positive", note: "误报" });
	expect(reviewer.retry(vuln.id).ok).toBe(false);
});

test("the operator can force a re-review of a record the machine had let go", async () => {
	// A record the operator already confirmed keeps its own rating: the
	// automatic pass refuses to touch it.
	const vuln = submit({ title: "操作员已确认" });
	store.update(vuln.id, { status: "confirmed", note: "我先确认了" });
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	expect(store.get(vuln.id)?.review.state).toBe("skipped");

	// The hub's 重新评审 button does overwrite it, and the timeline says so.
	expect(reviewer.requeue(vuln.id).ok).toBe(true);
	await new Promise((resolve) => setImmediate(resolve));
	const after = store.get(vuln.id);
	expect(after?.review.state).toBe("done");
	expect(after?.severity).toBe("medium");
	expect(after?.cvss).toBe(6.5);
	const last = after?.notes[after.notes.length - 1];
	expect(last?.text).toContain("人工重新评审");
	// The operator's status is untouched by a rating change.
	expect(after?.status).toBe("confirmed");
});

test("a failed re-review keeps the verdict it was re-reviewing", async () => {
	const vuln = submit({ title: "重评失败" });
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	expect(store.get(vuln.id)?.review.state).toBe("done");

	const original = reviewer.call;
	reviewer.call = async () => {
		throw new Error("端点超时");
	};
	expect(reviewer.requeue(vuln.id).ok).toBe(true);
	await new Promise((resolve) => setImmediate(resolve));
	const failed = store.get(vuln.id);
	expect(failed?.review.state).toBe("failed");
	expect(failed?.review.error).toContain("超时");
	// The old verdict is still readable behind the failure.
	expect(failed?.review.severity).toBe("medium");
	expect(failed?.review.reason).toContain("内网");
	reviewer.call = original;
});

test("the bulk re-review only takes the pending records it is handed", async () => {
	const pending = submit({ title: "待确认" });
	const confirmed = submit({ title: "已确认" });
	reviewer.enqueue(pending.id);
	store.update(confirmed.id, { status: "confirmed", note: "确认" });
	await new Promise((resolve) => setImmediate(resolve));
	expect(store.get(pending.id)?.review.state).toBe("done");

	// The session decides the scope (its pending ids); the reviewer takes exactly
	// that list and re-reviews it by force.
	const queued = reviewer.requeueAll([pending.id]);
	expect(queued).toBe(1);
	await new Promise((resolve) => setImmediate(resolve));
	const after = store.get(pending.id);
	expect(after?.review.state).toBe("done");
	const notes = after?.notes ?? [];
	expect(notes[notes.length - 1]?.text).toContain("人工重新评审");
	// The confirmed record was never in the list, so it stays as the operator left it.
	expect(store.get(confirmed.id)?.review.state).toBe("skipped");
	// A record already waiting for its first review is not queued twice.
	const fresh = submit({ title: "刚提交" });
	expect(reviewer.requeueAll([fresh.id])).toBe(0);
});

test("the reviewer never sees the submitter's own rating", () => {
	// Anchoring: the prompt used to hand the model the answer it was asked to
	// check, so calibrations came back as the agent's own numbers. The rating is
	// still on the record, it just does not reach the model.
	const prompt = buildUserPrompt(submit({ severity: "critical", cvss: 9.8 }));
	expect(prompt).toContain("原始数据包");
	expect(prompt).not.toContain("9.8");
	expect(prompt).not.toContain("提交者自评");
});

test("dubious verdicts are filterable", async () => {
	const vuln = submit({ title: "证据不足的漏洞" });
	reviewer.call = async () => ({
		metrics: { av: "N", ac: "H", pr: "N", ui: "N", s: "U", c: "L", i: "N", a: "N" },
		dubious: true,
		reason: "输出中没有回显，结论无佐证。",
	});
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	const after = store.get(vuln.id);
	expect(after?.review.verdict).toBe("dubious");
	const filtered = store.list("p1", { dubious: true });
	expect(filtered.some((item) => item.id === vuln.id)).toBe(true);
});

test("parseVerdict accepts fenced JSON and rejects unusable metrics", () => {
	const body = '"av":"N","ac":"L","pr":"N","ui":"N","s":"U","c":"H","i":"H","a":"H","dubious":false,"reason":"ok"';
	expect(parseVerdict(`\`\`\`json\n{${body}}\n\`\`\``).metrics.s).toBe("U");
	expect(() => parseVerdict("no json here")).toThrow();
	expect(() => parseVerdict(`{${body.replace('"av":"N"', '"av":"Network"')}}`)).toThrow(/AV/);
	expect(() => parseVerdict(`{${body.replace('"dubious":false', '"dubious":"no"')}}`)).toThrow(/dubious/);
	expect(() => parseVerdict('{"av":"N","ac":"L","pr":"N","ui":"N","s":"U","c":"H","i":"H","a":"H"}')).toThrow(
		/dubious/,
	);
});

test("queued reviews left by a crashed process are recovered", async () => {
	const vuln = submit();
	// Simulate the crash: the record is queued but never enqueued in memory.
	const queue = new VulnReviewer(store, { onSettled: () => {} }, join(dir, "agent"));
	queue.call = async () => ({
		metrics: { av: "N", ac: "L", pr: "N", ui: "N", s: "U", c: "N", i: "N", a: "N" },
		dubious: false,
		reason: "r",
	});
	queue.recover();
	await new Promise((resolve) => setImmediate(resolve));
	expect(store.get(vuln.id)?.review.state).toBe("done");
});
