/**
 * Unit tests for the vulnerability reviewer: the arbitration rules (only a
 * still-pending, operator-untouched record gets calibrated), the timeline
 * trace, failure states, and the defensive verdict parsing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parseVerdict, VulnReviewer } from "../src/reviewer.ts";
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
	dir = mkdtempSync(join(tmpdir(), "zg-reviewer-"));
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
	// A deterministic stub: every call "reviews" down to medium/5.3.
	reviewer.call = async () => ({
		severity: "medium",
		cvss: 5.3,
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
	expect(after?.cvss).toBe(5.3);
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

test("dubious verdicts are filterable", async () => {
	const vuln = submit({ title: "证据不足的漏洞" });
	reviewer.call = async () => ({
		severity: "low",
		cvss: 2.1,
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

test("parseVerdict accepts fenced JSON and rejects bad severities", () => {
	const fenced = '```json\n{"severity":"high","cvss":7.5,"dubious":false,"reason":"ok"}\n```';
	expect(parseVerdict(fenced).severity).toBe("high");
	expect(() => parseVerdict("no json here")).toThrow();
	expect(() => parseVerdict('{"severity":"extreme","cvss":7.5,"dubious":false,"reason":"x"}')).toThrow(/severity/);
	expect(() => parseVerdict('{"severity":"high","cvss":11,"dubious":false,"reason":"x"}')).toThrow(/cvss/);
});

test("queued reviews left by a crashed process are recovered", async () => {
	const vuln = submit();
	// Simulate the crash: the record is queued but never enqueued in memory.
	const queue = new VulnReviewer(store, { onSettled: () => {} }, join(dir, "agent"));
	queue.call = async () => ({ severity: "info", cvss: 0, dubious: false, reason: "r" });
	queue.recover();
	await new Promise((resolve) => setImmediate(resolve));
	expect(store.get(vuln.id)?.review.state).toBe("done");
});
