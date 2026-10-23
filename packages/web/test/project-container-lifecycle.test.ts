/**
 * Stopping, starting and removing a project's container.
 *
 * A project outlives its container: the container can be stopped (and started
 * again with everything installed inside), or removed while the registry entry,
 * the work directory and the records stay. Only deleting the project data takes
 * those with it. What is pinned here: the deliberate stop is remembered so
 * readiness never silently starts it again, starting recreates a container that
 * is gone, the container-only removal keeps the entry on disk, and a work
 * directory outside the projects root is refused rather than deleted.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { deleteProjectWorkDir } from "../src/docker.ts";
import { engineHasWorkInFlight } from "../src/engine.ts";
import {
	addProject,
	ensureProjectReady,
	listProjects,
	removeProject,
	startProject,
	stopProject,
} from "../src/projects.ts";
import type { SentinelEngine, SentinelEngineTask, SentinelEngineTaskStatus } from "../src/protocol.ts";
import { installFakeDocker } from "./fake-docker.ts";

const roots: string[] = [];
const restores: Array<() => void> = [];

afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { agentDir: string; logPath: string } {
	const root = mkdtempSync(join(tmpdir(), "sentinel-stop-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const logPath = join(root, "docker.log");
	restores.push(installFakeDocker(root, join(root, "projects", "demo"), logPath).restore);
	return { agentDir, logPath };
}

function calls(logPath: string): string[] {
	return readFileSync(logPath, "utf-8").trim().split("\n");
}

test("a deliberate stop is remembered and never started again implicitly", async () => {
	const { agentDir, logPath } = setup();
	await addProject(agentDir, { name: "demo" });
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");

	const stopped = await stopProject(agentDir, project.id);
	expect(stopped.error).toBeUndefined();
	expect(stopped.project?.manualStop).toBe(true);
	expect(calls(logPath).at(-1)).toBe(`stop ${project.container}`);
	// The state survives a reload, which is what makes readiness refuse to start it.
	expect(listProjects(agentDir).projects[0]?.manualStop).toBe(true);

	const before = calls(logPath).length;
	// Read it back from disk: the flag has to survive a reload to gate readiness.
	const reloaded = listProjects(agentDir).projects[0];
	if (!reloaded) throw new Error("项目记录丢失");
	expect(await ensureProjectReady(reloaded, agentDir)).toBe(false);
	// No docker start was issued: the operator's stop holds.
	expect(calls(logPath).length).toBe(before);
});

test("starting clears the stop and recreates a container that is gone", async () => {
	const { agentDir, logPath } = setup();
	await addProject(agentDir, { name: "demo" });
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");
	await stopProject(agentDir, project.id);

	const started = await startProject(agentDir, project.id);
	expect(started.error).toBeUndefined();
	expect(started.created).toBe(false);
	expect(calls(logPath).at(-1)).toBe(`start ${project.container}`);
	expect(listProjects(agentDir).projects[0]?.manualStop).toBeUndefined();
	expect(await ensureProjectReady({ ...project, manualStop: undefined }, agentDir)).toBe(true);

	// Removing the container leaves nothing to start, so starting creates it again.
	await removeProject(agentDir, project.id, "container");
	const recreated = await startProject(agentDir, project.id);
	expect(recreated.error).toBeUndefined();
	expect(recreated.created).toBe(true);
	const run = calls(logPath).findLast((line) => line.startsWith("run "));
	expect(run).toContain(`--name ${project.container}`);
	expect(run).toContain(`-v ${project.workDir}:/work`);
});

test("removing only the container keeps the project, its files and its data", async () => {
	const { agentDir } = setup();
	await addProject(agentDir, { name: "demo" });
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");
	writeFileSync(join(project.workDir, "scan.txt"), "findings");

	const removed = await removeProject(agentDir, project.id, "container");
	expect(removed.error).toBeUndefined();
	// Still registered, still has its files, and now needs an explicit start.
	expect(listProjects(agentDir).projects.map((entry) => entry.id)).toEqual([project.id]);
	expect(listProjects(agentDir).projects[0]?.manualStop).toBe(true);
	expect(existsSync(join(project.workDir, "scan.txt"))).toBe(true);
	expect(await ensureProjectReady(listProjects(agentDir).projects[0]!, agentDir)).toBe(false);
});

test("removing the project unregisters it and hands the work directory back to the caller", async () => {
	const { agentDir } = setup();
	await addProject(agentDir, { name: "demo" });
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");
	writeFileSync(join(project.workDir, "scan.txt"), "findings");

	const removed = await removeProject(agentDir, project.id, "data");
	expect(removed.error).toBeUndefined();
	expect(listProjects(agentDir).projects).toEqual([]);
	// The registry no longer owns it, so its files are still there until deleted.
	expect(existsSync(join(project.workDir, "scan.txt"))).toBe(true);

	expect(deleteProjectWorkDir(project.workDir)).toEqual({ ok: true });
	expect(existsSync(project.workDir)).toBe(false);
});

test("only engines with work in flight block a container stop", () => {
	// Fabricated engine records: the rule is what matters, not how they were built.
	const base: Omit<SentinelEngine, "status" | "tasks"> = {
		id: "e1",
		projectId: "p1",
		projectName: "靶场",
		name: "内网打点",
		pauseNote: null,
		targets: [],
		doctrines: [],
		presetIds: [],
		presetOptional: true,
		limits: { concurrency: 2, roundLimit: 10, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
		gateMode: "auto",
		createdAt: 0,
		startedAt: null,
		endedAt: null,
		schedule: null,
		report: null,
	};
	const task = (status: SentinelEngineTaskStatus): SentinelEngineTask => ({
		id: "t1",
		engineId: "e1",
		title: "Web 面侦察",
		objective: "找入口",
		target: null,
		workspace: "/work/tasks/t1",
		status,
		attempt: 1,
		criteria: [],
		roundLimit: 10,
		pendingContinue: null,
		presetId: null,
		presetName: null,
		sessionId: null,
		startedAt: null,
		endedAt: null,
		summary: null,
		error: null,
		usage: null,
		vulns: 0,
		autoResume: false,
	});
	expect(engineHasWorkInFlight({ ...base, status: "running", tasks: [task("done")] })).toBe(true);
	expect(engineHasWorkInFlight({ ...base, status: "scheduled", tasks: [] })).toBe(true);
	expect(engineHasWorkInFlight({ ...base, status: "completed", tasks: [task("running")] })).toBe(true);
	expect(engineHasWorkInFlight({ ...base, status: "completed", tasks: [task("queued")] })).toBe(true);
	// Finished, paused or stopped engines hold no work: stopping is allowed.
	expect(engineHasWorkInFlight({ ...base, status: "paused", tasks: [task("done")] })).toBe(false);
	expect(engineHasWorkInFlight({ ...base, status: "stopped", tasks: [task("aborted")] })).toBe(false);
	expect(engineHasWorkInFlight({ ...base, status: "completed", tasks: [] })).toBe(false);
});

test("a work directory outside the projects root is refused", () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-guard-"));
	roots.push(root);
	const previous = process.env.SENTINEL_PROJECTS_DIR;
	process.env.SENTINEL_PROJECTS_DIR = join(root, "projects");
	restores.push(() => {
		if (previous === undefined) delete process.env.SENTINEL_PROJECTS_DIR;
		else process.env.SENTINEL_PROJECTS_DIR = previous;
	});
	const outside = join(root, "elsewhere");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "keep.txt"), "important");

	const refused = deleteProjectWorkDir(outside);
	expect(refused.ok).toBe(false);
	expect(existsSync(join(outside, "keep.txt"))).toBe(true);
	// The projects root itself is refused too: it holds every project.
	expect(deleteProjectWorkDir(join(root, "projects")).ok).toBe(false);
});
