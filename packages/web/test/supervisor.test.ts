/**
 * The supervisor's runtime contract: arming is per conversation and only
 * before the first user message, a batch produces one episode, observation
 * mode never injects advice, and intervene/auto does.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test } from "vitest";
import { addLibraryEntry, setLibraryRole } from "../src/model-library.ts";
import type {
	SentinelSupervisorCall,
	SentinelSupervisorEpisode,
	SentinelSupervisorLog,
	SentinelSupervisorView,
} from "../src/protocol.ts";
import { Supervisor } from "../src/supervisor.ts";
import { SupervisorStore } from "../src/supervisor-store.ts";

interface FakeEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; toolCallId?: string; content?: unknown };
}

function fakeManager(entries: FakeEntry[], sessionId = "s1"): SessionManager {
	return {
		getBranch: () => entries,
		getEntries: () => entries,
		getSessionId: () => sessionId,
		getSessionFile: () => `/tmp/${sessionId}.jsonl`,
		getSessionName: () => "测试会话",
		appendCustomEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
			return "entry";
		},
	} as unknown as SessionManager;
}

let root = "";
let agentDir = "";
let store: SupervisorStore;
let supervisor: Supervisor;
let entries: FakeEntry[];
let states: SentinelSupervisorView[];
let episodes: SentinelSupervisorEpisode[];
let advice: string[];

function call(index: number): SentinelSupervisorCall {
	return {
		callId: `call-${index}`,
		at: 1_700_000_000_000 + index,
		tool: "bash",
		args: `curl http://target/api/item?id=${index}`,
		status: "ok",
		durationMs: 10,
		outputBytes: 100,
		outputHash: `hash-${index}`,
		outputHead: `HTTP/1.1 200 OK ${index}`,
		outputTail: "",
		httpStatus: 200,
		newEndpoints: [`http://target/api/item${index}`],
		newParams: [],
		newEvidence: true,
		signals: ["http:200"],
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-supervisor-"));
	agentDir = join(root, "agent");
	addLibraryEntry(agentDir, {
		name: "主模型",
		baseUrl: "http://main/v1",
		apiKey: "",
		modelId: "main-model",
	});
	const supervisorEntry = addLibraryEntry(agentDir, {
		name: "监督模型",
		baseUrl: "http://supervisor/v1",
		apiKey: "",
		modelId: "supervisor-model",
	});
	setLibraryRole(agentDir, "supervisor", supervisorEntry.id);
	store = new SupervisorStore(join(root, "supervisor.db"));
	entries = [{ type: "custom", customType: "other", data: { ignored: true } }];
	states = [];
	episodes = [];
	advice = [];
	supervisor = new Supervisor({
		agentDir,
		store,
		hooks: {
			onState: (view) => {
				if (view) states.push(view);
			},
			onEpisode: (episode) => episodes.push(episode),
			onLog: (_sessionId, _log: SentinelSupervisorLog) => {},
			onAdvice: () => {},
			onSendAdvice: (record) => advice.push(record.text),
		},
	});
	supervisor.call = async () => ({
		raw: JSON.stringify({
			phase: "vuln_mapping",
			intent: "枚举接口",
			actions: ["请求接口"],
			outcomes: ["返回 200"],
			tested: [{ target: "/api/item", test: "enum", result: "200" }],
			deadEnds: [],
			newEvidence: ["/api/item"],
			openQuestions: [],
			nextCandidates: ["继续枚举"],
			duplicateSignals: [],
			progress: "advancing",
			confidence: 0.8,
			advice: { needed: false, reason: "", doNotRepeat: [], nextActions: [] },
		}),
		usage: { input: 10, output: 10, total: 20 },
		model: "supervisor-model",
	});
	supervisor.attach({
		sessionId: "s1",
		manager: fakeManager(entries),
		projectId: "p1",
		projectName: "项目一",
	});
});

afterEach(() => {
	supervisor.close();
	rmSync(root, { recursive: true, force: true });
});

test("arming is per conversation and refused after a user message", () => {
	expect(supervisor.view("s1")).toBeNull();
	supervisor.arm("s1", "observe", "confirm");
	expect(supervisor.view("s1")?.status).toBe("waiting");
	entries.push({ type: "message", message: { role: "user", content: "开始" } });
	expect(() => supervisor.arm("s1", "observe", "confirm")).toThrow(/开始对话前/);
});

test("a batch of calls produces one episode and keeps the rolling state", async () => {
	supervisor.arm("s1", "observe", "confirm");
	supervisor.start("s1");
	for (let index = 0; index < 20; index += 1) {
		supervisor.observe("s1", {
			record: call(index),
			fingerprint: `fingerprint-${index}`,
		});
	}
	await new Promise((resolve) => setTimeout(resolve, 20));
	const view = supervisor.view("s1");
	expect(episodes).toHaveLength(1);
	expect(view?.episodeCount).toBe(1);
	expect(view?.callCount).toBe(20);
	expect(view?.state.phase).toBe("vuln_mapping");
	expect(view?.state.intent).toBe("枚举接口");
	expect(states.length).toBeGreaterThan(0);
});

function stubLoopingAdvice(): void {
	supervisor.call = async () => ({
		raw: JSON.stringify({
			phase: "vuln_mapping",
			intent: "重复测试同一个接口",
			actions: ["重复请求"],
			outcomes: [],
			tested: [],
			deadEnds: ["/api/item"],
			newEvidence: [],
			openQuestions: [],
			nextCandidates: ["切换参数"],
			duplicateSignals: ["重复 3 次"],
			progress: "looping",
			confidence: 0.9,
			advice: {
				needed: true,
				reason: "重复测试",
				doNotRepeat: ["/api/item"],
				nextActions: ["切换参数"],
			},
		}),
		usage: { input: 10, output: 10, total: 20 },
		model: "supervisor-model",
	});
}

test("observe mode never sends advice", async () => {
	stubLoopingAdvice();
	supervisor.arm("s1", "observe", "confirm");
	supervisor.start("s1");
	for (let index = 0; index < 3; index += 1) {
		supervisor.observe("s1", { record: call(index), fingerprint: "same" });
	}
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(advice).toHaveLength(0);
});

test("intervene/auto sends exactly one labelled advice", async () => {
	const otherEntries: FakeEntry[] = [];
	supervisor.attach({
		sessionId: "s2",
		manager: fakeManager(otherEntries, "s2"),
		projectId: "p1",
		projectName: "项目一",
	});
	stubLoopingAdvice();
	supervisor.arm("s2", "intervene", "auto");
	supervisor.start("s2");
	for (let index = 0; index < 3; index += 1) {
		supervisor.observe("s2", { record: call(index), fingerprint: "same" });
	}
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(advice).toHaveLength(1);
	expect(advice[0]).toContain("【监督建议 · 非操作员指令】");
});
