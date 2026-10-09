/**
 * Unit tests for the sub-agent run store: the record the panel reads back after a
 * run finished, including across a restart (orphan runs are closed, not lost).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ZGSubagentEvent } from "../src/protocol.ts";
import { SubagentStore, subagentDbPath } from "../src/subagent-store.ts";

const roots: string[] = [];
const stores: SubagentStore[] = [];

function openStore(): { store: SubagentStore; path: string } {
	const root = mkdtempSync(join(tmpdir(), "zgagent-subagent-store-"));
	roots.push(root);
	const path = subagentDbPath(root);
	const store = new SubagentStore(path);
	stores.push(store);
	return { store, path };
}

afterEach(() => {
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// Already closed by the test.
		}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function step(seq: number, kind: ZGSubagentEvent["kind"], extra: Partial<ZGSubagentEvent> = {}): ZGSubagentEvent {
	return { seq, kind, at: 1700000000000 + seq, ...extra };
}

test("a run keeps its task, mode, steps, and outcome", () => {
	const { store } = openStore();
	store.createRun({
		id: "run-1",
		sessionId: "session-a",
		projectId: "project-1",
		task: "recon 10.10.10.5",
		mode: "act",
		startedAt: "2024-01-01T00:00:00.000Z",
	});
	store.appendEvent("run-1", step(1, "status", { status: "running", note: "子代理启动" }));
	store.appendEvent(
		"run-1",
		step(2, "tool_start", { toolName: "bash", toolCallId: "call_1", args: { command: "id" } }),
	);
	store.appendEvent("run-1", step(3, "tool_end", { toolName: "bash", toolCallId: "call_1", output: "uid=0" }));
	store.appendEvent("run-1", step(4, "turn", { text: "第 1 轮" }));
	store.appendEvent("run-1", step(5, "status", { status: "done" }));
	store.finishRun("run-1", {
		status: "done",
		turns: 1,
		endedAt: "2024-01-01T00:00:05.000Z",
		result: "found an open port",
	});

	const run = store.getRun("run-1");
	expect(run).toEqual({
		id: "run-1",
		sessionId: "session-a",
		task: "recon 10.10.10.5",
		mode: "act",
		status: "done",
		turns: 1,
		startedAt: "2024-01-01T00:00:00.000Z",
		endedAt: "2024-01-01T00:00:05.000Z",
		result: "found an open port",
	});

	const events = store.listEvents("run-1");
	expect(events.map((event) => event.kind)).toEqual(["status", "tool_start", "tool_end", "turn", "status"]);
	expect(events[1]?.args).toEqual({ command: "id" });
	expect(events[2]?.output).toBe("uid=0");
});

test("runs are listed newest first and scoped to one session", () => {
	const { store } = openStore();
	for (const [id, sessionId, startedAt] of [
		["old", "session-a", "2024-01-01T00:00:00.000Z"],
		["new", "session-a", "2024-01-03T00:00:00.000Z"],
		["middle", "session-a", "2024-01-02T00:00:00.000Z"],
		["other", "session-b", "2024-01-04T00:00:00.000Z"],
	] as const) {
		store.createRun({ id, sessionId, task: `task ${id}`, mode: "explore", startedAt });
	}

	expect(store.listRuns("session-a").map((run) => run.id)).toEqual(["new", "middle", "old"]);
	expect(store.listRuns("session-a", 2).map((run) => run.id)).toEqual(["new", "middle"]);
	expect(store.listRuns("session-b").map((run) => run.id)).toEqual(["other"]);
	expect(store.listRuns("session-missing")).toEqual([]);
	// A fresh run is running with no steps yet; the list omits process steps.
	expect(store.listRuns("session-b")[0]?.status).toBe("running");
	expect(store.listRuns("session-b")[0]?.events).toBeUndefined();
});

test("a run left running by a previous process is closed on restart", () => {
	const { store, path } = openStore();
	store.createRun({
		id: "orphan",
		sessionId: "session-a",
		task: "long recon",
		mode: "act",
		startedAt: "2024-01-01T00:00:00.000Z",
	});
	store.appendEvent("orphan", step(1, "text", { text: "still working" }));
	store.finishRun("orphan-2-missing", { status: "done", turns: 1, endedAt: "2024-01-01T00:00:01.000Z" });
	store.close();
	stores.length = 0;

	// Reopen the same database, as a server restart would.
	const reopened = new SubagentStore(path);
	stores.push(reopened);
	expect(reopened.closeOrphanRuns()).toBe(1);
	const run = reopened.getRun("orphan");
	expect(run?.status).toBe("aborted");
	expect(run?.endedAt).toBeTruthy();
	// The steps recorded before the crash are still there.
	expect(reopened.listEvents("orphan").map((event) => event.kind)).toEqual(["text"]);
	expect(reopened.closeOrphanRuns()).toBe(0);
});

test("oversized steps and results are truncated instead of dropped", () => {
	const { store } = openStore();
	store.createRun({
		id: "run-big",
		sessionId: "session-a",
		task: "dump a lot",
		mode: "act",
		startedAt: "2024-01-01T00:00:00.000Z",
	});
	const huge = "A".repeat(200 * 1024);
	store.appendEvent("run-big", step(1, "tool_end", { toolName: "bash", toolCallId: "call_1", output: huge }));
	store.appendEvent("run-big", step(2, "text", { text: huge }));
	store.finishRun("run-big", {
		status: "error",
		turns: 1,
		endedAt: "2024-01-01T00:00:09.000Z",
		result: huge,
		error: huge,
	});

	const events = store.listEvents("run-big");
	expect(events).toHaveLength(2);
	expect(events[0]?.truncated).toBe(true);
	expect((events[0]?.output ?? "").length).toBeLessThan(huge.length);
	// The text step is replaced by the truncation marker, so the row stays bounded.
	expect(events[1]?.text).toBeUndefined();
	expect(events[1]?.truncated).toBe(true);

	const run = store.getRun("run-big");
	expect(run?.status).toBe("error");
	expect((run?.result ?? "").length).toBeLessThan(huge.length);
	expect(run?.result).toContain("已截断");
	expect(run?.error).toContain("已截断");
});
