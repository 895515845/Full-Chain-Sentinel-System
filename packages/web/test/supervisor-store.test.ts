/** The global supervision audit: sessions, episodes, logs, advice, and cascade. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
	SentinelSupervisorAdvice,
	SentinelSupervisorAuditItem,
	SentinelSupervisorEpisode,
} from "../src/protocol.ts";
import { SupervisorStore } from "../src/supervisor-store.ts";

let root = "";
let store: SupervisorStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-supervisor-store-"));
	store = new SupervisorStore(join(root, "supervisor.db"));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

function session(overrides: Partial<SentinelSupervisorAuditItem> = {}): SentinelSupervisorAuditItem {
	return {
		sessionId: "s1",
		sessionPath: "/tmp/s1.jsonl",
		sessionName: "测试会话",
		projectId: "p1",
		projectName: "项目一",
		mode: "observe",
		delivery: "confirm",
		status: "running",
		armedAt: 1000,
		startedAt: 1100,
		endedAt: null,
		updatedAt: 2000,
		episodeCount: 1,
		callCount: 20,
		phase: "vuln_mapping",
		intent: "测 SQLi",
		progress: "stalled",
		adviceCount: 0,
		usage: { input: 10, output: 5, total: 15 },
		lastError: null,
		...overrides,
	};
}

function episode(overrides: Partial<SentinelSupervisorEpisode> = {}): SentinelSupervisorEpisode {
	return {
		id: "ep1",
		sessionId: "s1",
		seq: 1,
		at: 1500,
		trigger: "batch",
		phase: "vuln_mapping",
		intent: "测 SQLi",
		actions: [],
		outcomes: [],
		tested: [],
		deadEnds: [],
		newEvidence: [],
		openQuestions: [],
		nextCandidates: [],
		duplicateSignals: [],
		progress: "stalled",
		confidence: 0.7,
		advice: null,
		model: "stub",
		usage: { input: 10, output: 5, total: 15 },
		error: null,
		durationMs: 100,
		...overrides,
	};
}

function advice(overrides: Partial<SentinelSupervisorAdvice> = {}): SentinelSupervisorAdvice {
	return {
		id: "adv1",
		sessionId: "s1",
		episodeId: "ep1",
		at: 1600,
		delivery: "confirm",
		status: "pending",
		text: "建议",
		sentAt: null,
		...overrides,
	};
}

describe("SupervisorStore", () => {
	test("lists and paginates sessions with project/search filters", () => {
		store.upsertSession(session());
		store.upsertSession(
			session({
				sessionId: "s2",
				sessionName: "另一个",
				projectId: "p2",
				updatedAt: 3000,
				mode: "intervene",
				progress: "looping",
			}),
		);
		store.insertAdvice(advice());
		const all = store.listSessions({ page: 1, pageSize: 10 });
		expect(all.total).toBe(2);
		expect(all.stats).toEqual({
			total: 2,
			advancing: 0,
			stalled: 1,
			looping: 1,
			stopped: 0,
			pendingAdvice: 1,
		});
		expect(store.listSessions({ projectId: "p2" }).items.map((item) => item.sessionId)).toEqual(["s2"]);
		expect(store.listSessions({ search: "另一个" }).items.map((item) => item.sessionId)).toEqual(["s2"]);
		expect(store.listSessions({ mode: "intervene" }).items.map((item) => item.sessionId)).toEqual(["s2"]);
		expect(store.listSessions({ progress: "stalled" }).items.map((item) => item.sessionId)).toEqual(["s1"]);
	});

	test("stores episodes, logs and advice and returns a detail", () => {
		store.upsertSession(session());
		store.insertEpisode({ episode: episode(), calls: [] });
		store.appendLog("s1", { at: 1700, kind: "episode", text: "完成" });
		store.insertAdvice(advice());
		const detail = store.getDetail("s1");
		expect(detail?.episodes).toHaveLength(1);
		expect(detail?.logs[0]?.text).toBe("完成");
		expect(detail?.advice[0]?.status).toBe("pending");
		store.setAdviceStatus("adv1", "sent", 1800);
		expect(store.getAdvice("adv1")?.status).toBe("sent");
	});

	test("deleting a project deletes its supervision sessions", () => {
		store.upsertSession(session());
		store.upsertSession(session({ sessionId: "s2", projectId: "p2" }));
		store.deleteProject("p1");
		expect(store.getDetail("s1")).toBeNull();
		expect(store.getDetail("s2")).not.toBeNull();
	});
});
