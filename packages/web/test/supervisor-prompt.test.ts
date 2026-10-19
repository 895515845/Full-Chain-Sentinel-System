/** The supervisor's strict JSON contract: fences, defaults, and advice text. */

import { describe, expect, test } from "vitest";
import type { SentinelSupervisorEpisode } from "../src/protocol.ts";
import { buildAdviceText, buildSupervisorInput, parseSupervisorEpisode } from "../src/supervisor-prompt.ts";

const EPISODE: SentinelSupervisorEpisode = {
	id: "ep-1",
	sessionId: "s1",
	seq: 1,
	at: 1_700_000_000_000,
	trigger: "duplicate",
	phase: "vuln_mapping",
	intent: "重复测试 /api/user 的 SQLi",
	actions: ["SQLi 测试 4 次"],
	outcomes: ["响应无差异"],
	tested: [{ target: "/api/user?id", test: "sqli", result: "no-difference" }],
	deadEnds: ["/api/user?id 的 SQLi"],
	newEvidence: [],
	openQuestions: ["是否存在 IDOR"],
	nextCandidates: ["切换 id 做越权对比"],
	duplicateSignals: ["同类 payload 重复 4 次"],
	progress: "looping",
	confidence: 0.8,
	advice: {
		needed: true,
		reason: "同一接口重复测试且无新证据",
		doNotRepeat: ["/api/user?id 的 SQLi"],
		nextActions: ["切换 id 做越权对比"],
	},
	model: "supervisor-stub",
	usage: { input: 10, output: 20, total: 30 },
	error: null,
	durationMs: 500,
};

describe("parseSupervisorEpisode", () => {
	test("accepts a fenced JSON object and fills missing arrays", () => {
		const parsed = parseSupervisorEpisode(`\`\`\`json
		{
			"phase": "enum",
			"intent": "枚举目录",
			"progress": "stalled",
			"confidence": 0.6,
			"deadEnds": ["/admin 无响应"]
		}
		\`\`\``);
		expect(parsed.phase).toBe("enum");
		expect(parsed.intent).toBe("枚举目录");
		expect(parsed.progress).toBe("stalled");
		expect(parsed.deadEnds).toEqual(["/admin 无响应"]);
		expect(parsed.actions).toEqual([]);
		expect(parsed.advice).toBeNull();
	});

	test("rejects a response that is not a JSON object", () => {
		expect(() => parseSupervisorEpisode("not json")).toThrow(/不完整|无法解析/);
	});

	test("extracts the balanced object and repairs a trailing comma", () => {
		const parsed = parseSupervisorEpisode(
			'说明\n{"phase":"enum","intent":"枚举","actions":["a",],"deadEnds":["x"],}\n结束',
		);
		expect(parsed.phase).toBe("enum");
		expect(parsed.intent).toBe("枚举");
		expect(parsed.actions).toEqual(["a"]);
		expect(parsed.deadEnds).toEqual(["x"]);
	});

	test("clamps confidence and unknown progress", () => {
		const parsed = parseSupervisorEpisode(JSON.stringify({ phase: "bogus", progress: "bogus", confidence: 4 }));
		expect(parsed.phase).toBe("unknown");
		expect(parsed.progress).toBe("unknown");
		expect(parsed.confidence).toBe(1);
	});
});

describe("buildSupervisorInput", () => {
	test("includes state, call args and trigger", () => {
		const input = buildSupervisorInput({
			trigger: "manual",
			sessionName: "测试会话",
			projectName: "项目一",
			state: {
				phase: "vuln_mapping",
				intent: "测 SQLi",
				progress: "advancing",
				tested: [],
				deadEnds: ["/admin"],
				newEvidence: [],
				openQuestions: [],
				nextCandidates: [],
				duplicateSignals: [],
			},
			calls: [
				{
					callId: "c1",
					at: 1,
					tool: "bash",
					args: "curl /api/user?id=1",
					status: "ok",
					durationMs: 10,
					outputBytes: 100,
					outputHash: "h",
					outputHead: "HTTP/1.1 200 OK",
					outputTail: "",
					httpStatus: 200,
					newEndpoints: [],
					newParams: [],
					newEvidence: false,
					signals: ["http:200"],
				},
			],
		});
		expect(input).toContain("触发：manual");
		expect(input).toContain("已排除：/admin");
		expect(input).toContain("curl /api/user?id=1");
		expect(input).toContain("HTTP/1.1 200 OK");
	});
});

test("buildAdviceText labels the advice as non-operator text", () => {
	const text = buildAdviceText(EPISODE);
	expect(text.startsWith("【监督建议 · 非操作员指令】")).toBe(true);
	expect(text).toContain("不要重复");
	expect(text).toContain("切换 id 做越权对比");
});
