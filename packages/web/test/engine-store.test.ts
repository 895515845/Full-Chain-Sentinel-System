/**
 * Unit tests for the engineering-mode persistence layer and the target-line
 * parser. These pin the resume contract: statuses round-trip through SQLite,
 * running tasks come back paused after a restart, and `target note` lines parse
 * the way the create form promises.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { containerWorkPath } from "../src/docker.ts";
import { EngineStore } from "../src/engine-store.ts";
import type { SentinelEngineLimits } from "../src/protocol.ts";
import { openSqliteDatabase } from "../src/sqlite.ts";
import { parseTargetLines } from "../src/worker.ts";

let dir: string;
let store: EngineStore;

const limits: SentinelEngineLimits = {
	concurrency: 3,
	roundLimit: 5,
	tokenLimit: null,
	timeLimitMin: null,
	maxRetries: 1,
};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-engine-store-"));
	store = new EngineStore(join(dir, "engines.db"));
});

afterAll(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("engine and tasks round-trip", () => {
	const engine = store.createEngine({
		projectId: "p1",
		projectName: "演示项目",
		name: "第一批",
		targets: [{ target: "10.0.0.1", note: "Web 服务器" }, { target: "10.0.0.2" }],
		doctrines: ["standard"],
		limits,
		gateMode: "auto",
	});
	const task = store.createTask({
		engineId: engine.id,
		title: "10.0.0.1 Web 侦察",
		objective: "对 10.0.0.1 做 Web 侦察……",
		target: "10.0.0.1",
		workspace: "web-a1-ab12",
		roundLimit: 5,
		attempt: 1,
		criteria: ["枚举出全部 HTTP 端口"],
	});
	store.updateTask(task.id, { status: "running", sessionId: "session-1" });

	const loaded = store.getEngine(engine.id);
	expect(loaded?.name).toBe("第一批");
	expect(loaded?.targets).toHaveLength(2);
	expect(loaded?.targets[0]?.note).toBe("Web 服务器");
	expect(loaded?.tasks).toHaveLength(1);
	expect(loaded?.tasks[0]?.status).toBe("running");
	expect(loaded?.tasks[0]?.sessionId).toBe("session-1");
	expect(loaded?.tasks[0]?.criteria).toEqual(["枚举出全部 HTTP 端口"]);
});

test("incrementTaskVulns counts findings and survives a later task update", () => {
	const engine = store.createEngine({
		projectId: "p1",
		projectName: "演示项目",
		name: "计数场景",
		targets: [{ target: "10.0.0.3" }],
		doctrines: ["standard"],
		limits,
		gateMode: "auto",
	});
	const task = store.createTask({
		engineId: engine.id,
		title: "提交漏洞",
		objective: "o",
		target: "10.0.0.3",
		workspace: "w",
		roundLimit: 3,
		attempt: 1,
	});
	store.incrementTaskVulns(task.id);
	store.incrementTaskVulns(task.id);
	// A board refresh updates the same row; the counter must not be overwritten.
	store.updateTask(task.id, { status: "running" });
	expect(store.getTask(task.id)?.vulns).toBe(2);
	expect(store.getEngine(engine.id)?.tasks[0]?.vulns).toBe(2);
	// A pruned task row makes the late counter a no-op, not a crash.
	expect(() => store.incrementTaskVulns("task-missing")).not.toThrow();
});

test("interruptRunning pauses queued and running tasks", () => {
	const engine = store.createEngine({
		projectId: "p1",
		projectName: "演示项目",
		name: "中断场景",
		targets: [{ target: "10.0.0.9" }],
		doctrines: ["standard"],
		limits,
		gateMode: "auto",
	});
	const queued = store.createTask({
		engineId: engine.id,
		title: "排队任务",
		objective: "o",
		target: "10.0.0.9",
		workspace: "w1",
		roundLimit: 3,
		attempt: 1,
	});
	const done = store.createTask({
		engineId: engine.id,
		title: "完成任务",
		objective: "o",
		target: "10.0.0.9",
		workspace: "w2",
		roundLimit: 3,
		attempt: 2,
	});
	store.updateTask(queued.id, { status: "queued" });
	store.updateTask(done.id, { status: "done", endedAt: Date.now() });

	const changed = store.interruptRunning();
	expect(changed).toBeGreaterThanOrEqual(1);
	const after = store.getEngine(engine.id);
	const statuses = new Map(after?.tasks.map((task) => [task.title, task.status]));
	expect(statuses.get("排队任务")).toBe("paused");
	expect(statuses.get("完成任务")).toBe("done");
});

test("commander and task events append in order and reload", () => {
	const engine = store.createEngine({
		projectId: "p2",
		projectName: "P2",
		name: "日志场景",
		targets: [{ target: "t" }],
		doctrines: ["standard"],
		limits,
		gateMode: "auto",
	});
	store.appendEvent(engine.id, { seq: 1, kind: "text", text: "第一条", at: 1 });
	store.appendEvent(engine.id, { seq: 2, kind: "tool_start", toolName: "dispatch_task", at: 2 });
	const events = store.listEvents(engine.id);
	expect(events).toHaveLength(2);
	expect(events[0]?.text).toBe("第一条");
	expect(events[1]?.toolName).toBe("dispatch_task");
});

test("deleteEngine removes tasks and events", () => {
	const engine = store.createEngine({
		projectId: "p3",
		projectName: "P3",
		name: "删除场景",
		targets: [{ target: "t" }],
		doctrines: ["standard"],
		limits,
		gateMode: "auto",
	});
	const task = store.createTask({
		engineId: engine.id,
		title: "任务",
		objective: "o",
		target: "t",
		workspace: "w",
		roundLimit: 3,
		attempt: 1,
	});
	store.appendEvent(engine.id, { seq: 1, kind: "status", note: "x", at: 1 });
	store.appendEvent(task.id, { seq: 1, kind: "status", note: "y", at: 2 });
	store.deleteEngine(engine.id);
	expect(store.getEngine(engine.id)).toBeUndefined();
	expect(store.getTask(task.id)).toBeUndefined();
	expect(store.listEvents(engine.id)).toHaveLength(0);
	expect(store.listEvents(task.id)).toHaveLength(0);
});

test("gate mode round-trips and can be changed", () => {
	const engine = store.createEngine({
		projectId: "p4",
		projectName: "P4",
		name: "守门场景",
		targets: [{ target: "t" }],
		doctrines: ["standard"],
		limits,
		gateMode: "ai",
	});
	expect(store.getEngine(engine.id)?.gateMode).toBe("ai");
	store.setEngineGateMode(engine.id, "auto");
	expect(store.getEngine(engine.id)?.gateMode).toBe("auto");
});

test("a database written before gate_mode existed is migrated to auto", () => {
	// The pre-change schema: same table, no gate_mode column.
	const legacyPath = join(dir, "legacy.db");
	const legacy = openSqliteDatabase(legacyPath);
	legacy.exec(`CREATE TABLE engines (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL,
		project_name TEXT NOT NULL,
		name TEXT NOT NULL,
		status TEXT NOT NULL,
		pause_note TEXT,
		targets TEXT NOT NULL,
		doctrines TEXT NOT NULL,
		limits TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		ended_at INTEGER,
		report TEXT
	)`);
	legacy
		.prepare(
			"INSERT INTO engines (id, project_id, project_name, name, status, targets, doctrines, limits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"engine-legacy",
			"p1",
			"旧项目",
			"旧工程",
			"paused",
			'[{"target":"t"}]',
			'["standard"]',
			JSON.stringify(limits),
			1,
		);
	legacy.close();

	const migrated = new EngineStore(legacyPath);
	// The old row keeps running ungated, which is how it ran before the column existed.
	expect(migrated.getEngine("engine-legacy")?.gateMode).toBe("auto");
	migrated.setEngineGateMode("engine-legacy", "ai");
	expect(migrated.getEngine("engine-legacy")?.gateMode).toBe("ai");
	migrated.close();
});

test("preset ids and a task's preset round-trip", () => {
	const engine = store.createEngine({
		projectId: "p5",
		projectName: "P5",
		name: "预设场景",
		targets: [{ target: "t" }],
		doctrines: ["standard"],
		presetIds: ["web-recon"],
		limits,
		gateMode: "auto",
	});
	expect(store.getEngine(engine.id)?.presetIds).toEqual(["web-recon"]);
	const task = store.createTask({
		engineId: engine.id,
		title: "带预设的任务",
		objective: "o",
		target: "t",
		workspace: "w",
		roundLimit: 3,
		attempt: 1,
		presetId: "web-recon",
		presetName: "Web 侦察",
	});
	const loaded = store.getTask(task.id);
	expect(loaded?.presetId).toBe("web-recon");
	// The name is copied in, not resolved: the board must still say what the task
	// ran as after the preset is renamed or deleted.
	expect(loaded?.presetName).toBe("Web 侦察");

	// An empty list clears the restriction rather than meaning "none available".
	store.setEnginePresets(engine.id, []);
	expect(store.getEngine(engine.id)?.presetIds).toEqual([]);

	// Presets are optional unless the operator says otherwise.
	expect(store.getEngine(engine.id)?.presetOptional).toBe(true);
	store.setEnginePresetOptional(engine.id, false);
	expect(store.getEngine(engine.id)?.presetOptional).toBe(false);
	store.setEnginePresetOptional(engine.id, true);
	expect(store.getEngine(engine.id)?.presetOptional).toBe(true);

	// A task without a preset is the default agent, and stays that way.
	const plain = store.createTask({
		engineId: engine.id,
		title: "默认任务",
		objective: "o",
		target: "t2",
		workspace: "w2",
		roundLimit: 3,
		attempt: 1,
	});
	expect(store.getTask(plain.id)?.presetId).toBeNull();
	expect(store.getTask(plain.id)?.presetName).toBeNull();
});

test("a database written before preset columns existed is migrated to no restriction", () => {
	const legacyPath = join(dir, "legacy-presets.db");
	const legacy = openSqliteDatabase(legacyPath);
	// The pre-change schema: no preset_ids on engines, no preset columns on tasks.
	legacy.exec(`CREATE TABLE engines (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL,
		project_name TEXT NOT NULL,
		name TEXT NOT NULL,
		status TEXT NOT NULL,
		pause_note TEXT,
		targets TEXT NOT NULL,
		doctrines TEXT NOT NULL,
		limits TEXT NOT NULL,
		gate_mode TEXT NOT NULL DEFAULT 'auto',
		created_at INTEGER NOT NULL,
		ended_at INTEGER,
		report TEXT
	)`);
	legacy.exec(`CREATE TABLE engine_tasks (
		id TEXT PRIMARY KEY,
		engine_id TEXT NOT NULL,
		title TEXT NOT NULL,
		objective TEXT NOT NULL,
		target TEXT,
		workspace TEXT NOT NULL,
		status TEXT NOT NULL,
		attempt INTEGER NOT NULL DEFAULT 1,
		criteria TEXT NOT NULL DEFAULT '[]',
		round_limit INTEGER NOT NULL,
		session_id TEXT,
		started_at INTEGER,
		ended_at INTEGER,
		summary TEXT,
		error TEXT,
		usage TEXT,
		vulns INTEGER NOT NULL DEFAULT 0,
		seq INTEGER NOT NULL DEFAULT 0
	)`);
	legacy
		.prepare(
			"INSERT INTO engines (id, project_id, project_name, name, status, targets, doctrines, limits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"engine-old",
			"p1",
			"旧项目",
			"旧工程",
			"paused",
			'[{"target":"t"}]',
			'["standard"]',
			JSON.stringify(limits),
			1,
		);
	legacy
		.prepare(
			"INSERT INTO engine_tasks (id, engine_id, title, objective, target, workspace, status, attempt, criteria, round_limit, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run("task-old", "engine-old", "旧任务", "o", "t", "w", "done", 1, "[]", 3, 0);
	legacy.close();

	const migrated = new EngineStore(legacyPath);
	// No restriction is how it ran, and no preset is the default agent it used.
	expect(migrated.getEngine("engine-old")?.presetIds).toEqual([]);
	expect(migrated.getTask("task-old")?.presetId).toBeNull();
	expect(migrated.getTask("task-old")?.presetName).toBeNull();
	// Presets stayed optional for it too, so its dispatches are unchanged.
	expect(migrated.getEngine("engine-old")?.presetOptional).toBe(true);
	migrated.setEnginePresets("engine-old", ["web-recon"]);
	expect(migrated.getEngine("engine-old")?.presetIds).toEqual(["web-recon"]);
	migrated.close();
});

test("parseTargetLines splits target and note, drops blanks", () => {
	const parsed = parseTargetLines(
		["10.0.0.1 这台是 Web 服务器", "", "http://x.example.com,只测登录", "10.0.0.2"].join("\n"),
	);
	expect(parsed).toEqual([
		{ target: "10.0.0.1", note: "这台是 Web 服务器" },
		{ target: "http://x.example.com", note: "只测登录" },
		{ target: "10.0.0.2" },
	]);
});

test("containerWorkPath maps host dirs under the work mount to /work", () => {
	const workDir = "/Users/x/.sentinel/projects/p";
	expect(containerWorkPath(workDir, workDir)).toBe("/work");
	expect(containerWorkPath(`${workDir}/tasks/task-a1`, workDir)).toBe("/work/tasks/task-a1");
	expect(containerWorkPath("/somewhere/else", workDir)).toBe("/work");
	expect(containerWorkPath(undefined, workDir)).toBe("/work");
});
