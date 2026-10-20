/**
 * Manager-level schedule behavior: the timer reaches the start hook, a restart
 * never auto-resumes work, and canceling a waiting plan is a stored state change
 * rather than a process-memory side effect.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { EngineManager } from "../src/engine.ts";
import { normalizeSchedule } from "../src/engine-schedule.ts";
import { EngineStore } from "../src/engine-store.ts";
import type { SentinelEngineCreateInput, SentinelProjectInfo } from "../src/protocol.ts";

const START = Date.UTC(2026, 9, 21, 0, 0, 0);
const HOUR = 60 * 60_000;
const limits: SentinelEngineCreateInput["limits"] = {
	concurrency: 1,
	roundLimit: 2,
	tokenLimit: null,
	timeLimitMin: null,
	maxRetries: 1,
};

function project(dir: string): SentinelProjectInfo {
	return { id: "p-schedule", name: "计划项目", cwd: dir };
}

function input(startAt: number): SentinelEngineCreateInput {
	return {
		name: "定时工程",
		targets: "10.0.0.1",
		doctrines: ["attack-defense-web"],
		presetIds: [],
		presetOptional: true,
		limits,
		gateMode: "auto",
		schedule: { timezone: "Asia/Shanghai", startAt },
	};
}

afterEach(() => {
	vi.useRealTimers();
});

test("a scheduled start checks the environment and pauses when it is not ready", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(START));
	const dir = mkdtempSync(join(tmpdir(), "sentinel-schedule-manager-"));
	let checks = 0;
	const manager = new EngineManager(
		dir,
		{
			onChange: () => {},
			onCommanderEvent: () => {},
			onTaskEvent: () => {},
			beforeStart: async () => {
				checks += 1;
				return { ok: false, error: "Docker 未就绪" };
			},
		},
		async () => {
			throw new Error("no session expected");
		},
	);
	try {
		const engine = await manager.createEngine(project(dir), input(START + 1000));
		expect(engine.status).toBe("scheduled");
		expect(engine.startedAt).toBeNull();
		expect(engine.schedule?.phase).toBe("waiting_start");
		expect(engine.tasks).toEqual([]);

		await vi.advanceTimersByTimeAsync(1000);
		await Promise.resolve();
		const paused = manager.getEngine(engine.id);
		expect(checks).toBe(1);
		expect(paused?.status).toBe("paused");
		expect(paused?.startedAt).toBeNull();
		expect(paused?.schedule?.phase).toBe("finished");
		expect(paused?.schedule?.finishedReason).toBe("start_failed");
		expect(paused?.pauseNote).toContain("定时启动失败");
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a commander start failure is stored as a paused scheduled-start failure", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(START));
	const dir = mkdtempSync(join(tmpdir(), "sentinel-schedule-start-fail-"));
	const manager = new EngineManager(
		dir,
		{
			onChange: () => {},
			onCommanderEvent: () => {},
			onTaskEvent: () => {},
			beforeStart: async () => ({ ok: true }),
		},
		async () => {
			throw new Error("no session expected");
		},
	);
	try {
		const engine = await manager.createEngine(project(dir), input(START + 1000));
		await vi.advanceTimersByTimeAsync(1000);
		await Promise.resolve();
		const paused = manager.getEngine(engine.id);
		expect(paused?.status).toBe("paused");
		expect(paused?.startedAt).toBeNull();
		expect(paused?.schedule?.finishedReason).toBe("start_failed");
		expect(paused?.pauseNote).toContain("定时启动失败");
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rejected environment check pauses the engine instead of stranding it as scheduled", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(START));
	const dir = mkdtempSync(join(tmpdir(), "sentinel-schedule-hook-error-"));
	const manager = new EngineManager(
		dir,
		{
			onChange: () => {},
			onCommanderEvent: () => {},
			onTaskEvent: () => {},
			beforeStart: async () => {
				throw new Error("docker probe crashed");
			},
		},
		async () => {
			throw new Error("no session expected");
		},
	);
	try {
		const engine = await manager.createEngine(project(dir), input(START + 1000));
		await vi.advanceTimersByTimeAsync(1000);
		await Promise.resolve();
		const paused = manager.getEngine(engine.id);
		expect(paused?.status).toBe("paused");
		expect(paused?.schedule?.finishedReason).toBe("start_failed");
		expect(paused?.pauseNote).toContain("定时动作失败");
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a start missed beyond the grace window pauses instead of auto-running", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(START));
	const dir = mkdtempSync(join(tmpdir(), "sentinel-schedule-missed-"));
	// Seed the row the way a process that was down across the start time would
	// leave it: still scheduled, with the planned instant already past.
	const store = new EngineStore(join(dir, "engines.db"));
	const engine = store.createEngine({
		projectId: "p1",
		projectName: "项目",
		name: "错过的计划",
		targets: [{ target: "10.0.0.1" }],
		doctrines: ["attack-defense-web"],
		limits,
		gateMode: "auto",
		status: "scheduled",
		startedAt: null,
		schedule: normalizeSchedule({ timezone: "UTC", startAt: START - 11 * 60_000 }, START - 20 * 60_000),
	});
	store.close();
	let checks = 0;
	const manager = new EngineManager(
		dir,
		{
			onChange: () => {},
			onCommanderEvent: () => {},
			onTaskEvent: () => {},
			beforeStart: async () => {
				checks += 1;
				return { ok: true };
			},
		},
		async () => {
			throw new Error("no session expected");
		},
	);
	try {
		await vi.runOnlyPendingTimersAsync();
		await Promise.resolve();
		const paused = manager.getEngine(engine.id);
		expect(checks).toBe(0);
		expect(paused?.status).toBe("paused");
		expect(paused?.schedule?.finishedReason).toBe("missed");
		expect(paused?.pauseNote).toContain("错过定时开始");
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a restart keeps a future plan armed but pauses a run that was already active", () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(START));
	const dir = mkdtempSync(join(tmpdir(), "sentinel-schedule-restart-"));
	const db = join(dir, "engines.db");
	const store = new EngineStore(db);
	const schedule = normalizeSchedule({ timezone: "UTC", startAt: START + HOUR, deadlineAt: START + 3 * HOUR }, START);
	const active = store.createEngine({
		projectId: "p1",
		projectName: "项目",
		name: "运行中的计划",
		targets: [{ target: "10.0.0.1" }],
		doctrines: ["attack-defense-web"],
		limits,
		gateMode: "auto",
		status: "running",
		startedAt: START,
		schedule,
	});
	const task = store.createTask({
		engineId: active.id,
		title: "中断任务",
		objective: "继续原目标",
		target: "10.0.0.1",
		workspace: "w",
		roundLimit: 2,
		attempt: 1,
	});
	store.updateTask(task.id, { status: "running", autoResume: true });
	const future = store.createEngine({
		projectId: "p1",
		projectName: "项目",
		name: "未来的计划",
		targets: [{ target: "10.0.0.2" }],
		doctrines: ["attack-defense-web"],
		limits,
		gateMode: "auto",
		status: "scheduled",
		startedAt: null,
		schedule: normalizeSchedule({ timezone: "UTC", startAt: START + 2 * HOUR }, START),
	});
	store.close();

	const manager = new EngineManager(
		dir,
		{ onChange: () => {}, onCommanderEvent: () => {}, onTaskEvent: () => {} },
		async () => {
			throw new Error("no session expected");
		},
	);
	try {
		const paused = manager.getEngine(active.id);
		expect(paused?.status).toBe("paused");
		expect(paused?.schedule?.phase).toBe("finished");
		expect(paused?.schedule?.finishedReason).toBe("restart");
		expect(paused?.tasks[0]?.status).toBe("paused");
		expect(paused?.tasks[0]?.autoResume).toBe(false);
		expect(manager.getEngine(future.id)?.status).toBe("scheduled");
		expect(manager.getEngine(future.id)?.schedule?.phase).toBe("waiting_start");
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a waiting plan can be edited and canceled before it starts", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(START));
	const dir = mkdtempSync(join(tmpdir(), "sentinel-schedule-edit-"));
	const manager = new EngineManager(
		dir,
		{ onChange: () => {}, onCommanderEvent: () => {}, onTaskEvent: () => {} },
		async () => {
			throw new Error("no session expected");
		},
	);
	try {
		const engine = await manager.createEngine(project(dir), input(START + HOUR));
		manager.setSchedule(engine.id, {
			timezone: "Asia/Shanghai",
			startAt: START + 2 * HOUR,
			pauseAt: START + 3 * HOUR,
			resumeAt: START + 4 * HOUR,
			deadlineAt: START + 5 * HOUR,
		});
		const edited = manager.getEngine(engine.id);
		expect(edited?.status).toBe("scheduled");
		expect(edited?.schedule?.startAt).toBe(START + 2 * HOUR);
		expect(edited?.schedule?.pauseAt).toBe(START + 3 * HOUR);
		manager.cancelSchedule(engine.id);
		const canceled = manager.getEngine(engine.id);
		expect(canceled?.status).toBe("stopped");
		expect(canceled?.schedule?.phase).toBe("finished");
		expect(canceled?.schedule?.finishedReason).toBe("canceled");
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
