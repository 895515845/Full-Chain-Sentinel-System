/**
 * Calibration tests for the vulnerability reviewer.
 *
 * Two things are pinned here. The first is the rubric: the metrics are only
 * as good as the criteria the model is given, and the drift that made the
 * ratings high (PR read as "no admin rights needed", the three impact axes
 * pulled up together) came from criteria that were never written down. The
 * second is the cap: a finding whose evidence did not hold up must not climb
 * into the high or critical bucket, and its vector must agree with its score.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { capMetricsToScore, cvssBaseScore, cvssVector, DUBIOUS_MAX_SCORE, parseCvssMetrics } from "../src/cvss.ts";
import { REVIEWER_SYSTEM_PROMPT, VulnReviewer } from "../src/reviewer.ts";
import { VulnerabilityStore } from "../src/vulnerabilities.ts";
import { buildVulnReport } from "../src/vulnerability-markdown.ts";
import { writeTestModel } from "./model-fixtures.ts";
import { benchmarkVuln, REVIEWER_BENCHMARKS, scoreDelta } from "./reviewer-benchmarks.ts";

let dir: string;
let store: VulnerabilityStore;
let reviewer: VulnReviewer;

/** A CVSS vector back into the metric record the parser reads. */
function metricsFromVector(vector: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of vector.split("/").slice(1)) {
		const [key, value] = part.split(":");
		if (key && value) out[key.toLowerCase()] = value;
	}
	return out;
}

const submit = (over: Record<string, unknown> = {}) =>
	store.create({
		projectId: "p1",
		projectName: "校准项目",
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
	dir = mkdtempSync(join(tmpdir(), "sentinel-calibration-"));
	store = new VulnerabilityStore(join(dir, "vulns.db"));
	writeTestModel(
		join(dir, "agent"),
		{ baseUrl: "http://127.0.0.1:9/v1", apiKey: "stub", modelId: "reviewer-stub" },
		"reviewer",
	);
	reviewer = new VulnReviewer(store, { onSettled: () => {} }, join(dir, "agent"));
});

afterAll(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("the rubric names the metric traps the ratings used to fall into", () => {
	// PR: the trap was reading "普通用户即可触发" as "no privileges needed".
	expect(REVIEWER_SYSTEM_PROMPT).toContain("PR 所需权限");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("不需要任何凭据");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("把 L 或 H 误判成 N");
	// The impact axes: the trap was pulling all of them up together, so they
	// are no longer a free judgement — they follow the four capability answers.
	expect(REVIEWER_SYSTEM_PROMPT).toContain("先回答四个能力问题");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("read（机密性影响有多大");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("write（能不能改动数据或让状态发生变化）");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("down（能不能让服务不可用或数据被破坏）");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("cross（影响会不会跳到别的安全域）");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("read=none → N");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("write=false → N");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("down=false → N");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("cross=false → U");
	// A broken protection is not the same as no protection: weak crypto, missing
	// headers and a bypassable captcha are a partial confidentiality impact.
	// Without this the model answered "no data leaked" and dropped a dozen
	// findings to zero.
	expect(REVIEWER_SYSTEM_PROMPT).toContain("破坏了一部分保护措施");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("弱加密模式");
	// "The evidence does not show it" and "it has no impact" are different
	// answers, and the first one is a doubt, not a rating.
	expect(REVIEWER_SYSTEM_PROMPT).toContain('"证据不足以证明影响"和"这个漏洞没有影响"是两回事');
	expect(REVIEWER_SYSTEM_PROMPT).toContain("不要用 read=none 来代替");
	// The capability of the flaw, not the step the proof happened to show.
	expect(REVIEWER_SYSTEM_PROMPT).toContain("按漏洞本身的能力判");
	// Fingerprint information is not a confidentiality impact, and XSS is not
	// "no impact": both were over-corrected once and had to be written down.
	expect(REVIEWER_SYSTEM_PROMPT).toContain("指纹信息");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("XSS");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("C 至少 L");
	// UI:R has to drag the impact down with it.
	expect(REVIEWER_SYSTEM_PROMPT).toContain("UI=R 时必须联动降影响");
	// The evidence has to be read before it is called missing.
	expect(REVIEWER_SYSTEM_PROMPT).toContain("先把给的证据读完再判断");
});

test("the output section carries no metric tuple for the model to copy", () => {
	// The single most expensive line in the whole prompt. With a worst-case
	// example in the output format, the reviewer copied it: 14 of 25 real
	// findings came back on the example's exact vector, and a production pass
	// put 209 of 270 findings there — every uncertain finding turned into a
	// 9.8. The example has to stay out.
	expect(REVIEWER_SYSTEM_PROMPT).not.toContain('"av":"N","ac":"L","pr":"N","ui":"N","s":"U","c":"H","i":"H","a":"H"');
	expect(REVIEWER_SYSTEM_PROMPT).not.toContain('"av":"N","ac":"L","pr":"L"');
	expect(REVIEWER_SYSTEM_PROMPT).not.toMatch(/"av":"[NALP]","ac":"[LH]"/);
	// The shape is still described, in words.
	expect(REVIEWER_SYSTEM_PROMPT).toContain("字段为 av、ac、pr、ui、s、c、i、a");
});

test("the rubric no longer tells the model to push past the submitter's caution", () => {
	// This line used to read "不要照抄提交者的乐观假设", which told the model to
	// discard the submitter's *conservative* framing and escalate: one reviewer
	// quoted it back while raising a reflected XSS to 9.3.
	expect(REVIEWER_SYSTEM_PROMPT).not.toContain("乐观假设");
	expect(REVIEWER_SYSTEM_PROMPT).toContain("只是一条待核对的声明");
	expect(REVIEWER_SYSTEM_PROMPT).toContain('说"影响有限"也不构成调低的理由');
});

test("the cap lowers a suspicious finding to the medium bucket and keeps the vector honest", () => {
	// The reviewer's typical worst case: network, no conditions, everything high.
	const inflated = { av: "N", ac: "L", pr: "N", ui: "N", s: "U", c: "H", i: "H", a: "H" } as const;
	expect(cvssBaseScore(inflated)).toBe(9.8);
	const capped = capMetricsToScore(inflated, DUBIOUS_MAX_SCORE);
	expect(cvssBaseScore(capped)).toBeLessThanOrEqual(DUBIOUS_MAX_SCORE);
	// The vector and the score must still describe the same finding: decoding
	// the capped vector has to give the capped score back.
	const decoded = parseCvssMetrics(metricsFromVector(cvssVector(capped)));
	expect(cvssBaseScore(decoded)).toBe(cvssBaseScore(capped));
	expect(cvssVector(capped)).toContain(`C:${capped.c}`);
	expect(cvssVector(capped)).toContain(`I:${capped.i}`);
	expect(cvssVector(capped)).toContain(`A:${capped.a}`);
});

test("the cap leaves a finding that is already below the cap untouched", () => {
	const medium = { av: "N", ac: "L", pr: "L", ui: "N", s: "U", c: "H", i: "N", a: "N" } as const;
	expect(cvssBaseScore(medium)).toBe(6.5);
	expect(capMetricsToScore(medium, DUBIOUS_MAX_SCORE)).toEqual(medium);
});

test("a dubious finding never lands in the high or critical bucket", async () => {
	reviewer.call = async () => ({
		metrics: { av: "N", ac: "L", pr: "N", ui: "N", s: "U", c: "H", i: "H", a: "H" },
		dubious: true,
		reason: "证据只有构造，没有实际执行结果。",
	});
	const vuln = submit({ title: "存疑的漏洞" });
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	const after = store.get(vuln.id);
	expect(after?.severity).toBe("medium");
	expect(after?.cvss).toBeLessThanOrEqual(DUBIOUS_MAX_SCORE);
	expect(after?.review.verdict).toBe("dubious");
	// The operator has to be told the number was lowered, not shown a silent edit.
	expect(after?.review.reason).toContain("影响指标已按中危上限下调");
	// The level and the score still agree with each other.
	expect(after?.severityMismatch).toBe(false);
});

test("a solid finding keeps the reviewer's own rating", async () => {
	reviewer.call = async () => ({
		metrics: { av: "N", ac: "L", pr: "L", ui: "N", s: "U", c: "H", i: "N", a: "N" },
		dubious: false,
		reason: "越权成立，影响限于机密性。",
	});
	const vuln = submit({ title: "证据充分的漏洞" });
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	const after = store.get(vuln.id);
	expect(after?.severity).toBe("medium");
	expect(after?.cvss).toBe(6.5);
	expect(after?.review.reason).not.toContain("上限下调");
});

test("the capability answers clip an impact the evidence does not support", async () => {
	// The production shape of the complaint: the reviewer answered "this sounds
	// serious" and gave all three impact axes H on a read-only finding. The
	// capability answers say the attacker can only look, so the impact axes
	// give way — in code, where the rule cannot be talked past.
	reviewer.call = async () => ({
		metrics: { av: "N", ac: "L", pr: "N", ui: "N", s: "U", c: "H", i: "H", a: "H" },
		capabilities: { read: "partial", write: false, down: false, cross: false },
		dubious: false,
		reason: "只读接口泄露了部分数据。",
	});
	const vuln = submit({ title: "只读泄露" });
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	const after = store.get(vuln.id);
	expect(after?.cvss).toBe(5.3);
	expect(after?.severity).toBe("medium");
	// The operator has to be told the number was lowered, not shown a silent edit.
	expect(after?.review.reason).toContain("影响指标已按实际能力下调");
	// The vector still describes the number beside it.
	expect(after?.cvssVector).toContain("I:N");
	expect(after?.cvssVector).toContain("A:N");
	expect(after?.severityMismatch).toBe(false);
});

test("a verdict without capability answers is used as it stands", async () => {
	// A model that does not answer the four questions still gets a rating; the
	// clip is skipped rather than guessed.
	reviewer.call = async () => ({
		metrics: { av: "N", ac: "L", pr: "N", ui: "N", s: "U", c: "H", i: "H", a: "H" },
		dubious: false,
		reason: "未授权命令执行。",
	});
	const vuln = submit({ title: "没有能力回答的评审" });
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	const after = store.get(vuln.id);
	expect(after?.cvss).toBe(9.8);
	expect(after?.review.reason).not.toContain("下调");
});

test("a failed review keeps the agent's rating but marks it as the agent's", async () => {
	const original = reviewer.call;
	reviewer.call = async () => {
		throw new Error("端点返回 503");
	};
	const vuln = submit({ title: "评审失败" });
	reviewer.enqueue(vuln.id);
	await new Promise((resolve) => setImmediate(resolve));
	const after = store.get(vuln.id);
	expect(after?.review.state).toBe("failed");
	// The number is still there, but it is now known to be the agent's guess:
	// the console labels it 「自评」 and the report says so.
	expect(after?.severity).toBe("critical");
	expect(after?.review.agentSeverity).toBe("critical");
	expect(after?.review.agentCvss).toBe(9.8);
	reviewer.call = original;
});

test("the report says which levels the machine could not stand behind", () => {
	const reviewed = store.create({
		projectId: "p1",
		projectName: "报告项目",
		source: "主代理",
		title: "评审存疑的漏洞",
		severity: "high",
		cvss: 7.5,
		description: "描述",
		packet: "GET / HTTP/1.1",
		target: "10.0.0.1",
	});
	store.applyReview(reviewed.id, {
		severity: "medium",
		cvss: 6.5,
		cvssVector: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N",
		dubious: true,
		reason: "证据不足以支撑结论。",
		model: "reviewer-stub",
	});
	const report = buildVulnReport({ projectName: "报告项目", projectId: "p1", vulns: [store.get(reviewed.id)!] });
	// The level line carries the doubt, not just the timeline far below it.
	expect(report.markdown).toContain("评审存疑");
	expect(report.markdown).toContain("中危");
	expect(report.markdown).toContain("其中：评审存疑 1 条");
});

test("the benchmarks keep their expected ratings", () => {
	// The yardstick itself: if these move, the benchmark no longer measures
	// what it claims to measure.
	for (const benchmark of REVIEWER_BENCHMARKS) {
		expect(benchmark.expectedCvss).toBeGreaterThanOrEqual(0);
		expect(benchmark.expectedCvss).toBeLessThanOrEqual(10);
	}
	expect(REVIEWER_BENCHMARKS).toHaveLength(8);
	// A read-only IDOR is the case the ratings used to inflate, so its
	// expected score is the one worth guarding.
	const idor = REVIEWER_BENCHMARKS.find((entry) => entry.name.startsWith("C"));
	expect(idor?.expectedCvss).toBe(6.5);
	expect(idor?.expectedSeverity).toBe("medium");
	// The cases the per-axis abuse used to inflate: a takeover, a read-only
	// injection, and a leaked key. Each one has exactly one impact axis high.
	const takeover = REVIEWER_BENCHMARKS.find((entry) => entry.name.startsWith("F"));
	expect(takeover?.expectedCvss).toBe(9.1);
	const blind = REVIEWER_BENCHMARKS.find((entry) => entry.name.startsWith("G"));
	expect(blind?.expectedCvss).toBe(7.5);
	const key = REVIEWER_BENCHMARKS.find((entry) => entry.name.startsWith("H"));
	expect(key?.expectedCvss).toBe(7.5);
});

test("the benchmark findings reach the reviewer as the reviewer expects", () => {
	// The prompt builder takes a full record; the benchmark supplies a
	// partial one, so the shape is checked here rather than by a crash later.
	const vuln = benchmarkVuln(REVIEWER_BENCHMARKS[0]);
	expect(vuln.title).toBe("首页返回服务端版本号");
	expect(vuln.packet).toContain("X-Powered-By");
	expect(scoreDelta(9.8, 6.5)).toBe(3.3);
});
