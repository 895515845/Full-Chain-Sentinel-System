/**
 * Rebuilding a project's container.
 *
 * The network mode is read when a container is created and Docker cannot change it
 * afterwards, so switching modes means replacing the container. What must survive is
 * the project itself: same registry entry, same host work directory — only the
 * container is new. The docker invocations are asserted through the fake's log,
 * because the flags are the whole point of the operation.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { writeContainerNetwork } from "../src/container-network.ts";
import { addProject, listProjects, recreateProject } from "../src/projects.ts";
import { installFakeDocker } from "./fake-docker.ts";

const roots: string[] = [];
const restores: Array<() => void> = [];

afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { agentDir: string; logPath: string } {
	const root = mkdtempSync(join(tmpdir(), "sentinel-recreate-"));
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

test("rebuilding replaces the container with the stored network and keeps the project", async () => {
	const { agentDir, logPath } = setup();
	const added = await addProject(agentDir, { name: "demo" });
	expect(added.error).toBeUndefined();
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");
	// A fresh install defaults to host mode.
	expect(calls(logPath).find((line) => line.startsWith("run"))).toContain("--network host");

	writeContainerNetwork(agentDir, "bridge");
	const recreated = await recreateProject(agentDir, project.id);
	expect(recreated.error).toBeUndefined();
	// The registry entry is untouched: id, name and work directory survive.
	expect(recreated.project).toEqual(project);
	expect(listProjects(agentDir).projects).toEqual([project]);

	const last = calls(logPath).slice(-2);
	expect(last[0]).toContain(`rm -f ${project.container}`);
	expect(last[1]).toContain("--network bridge");
	expect(last[1]).toContain("NET_ADMIN");
	expect(last[1]).toContain(`-v ${project.workDir}:/work`);
});

test("an unknown project fails before docker is invoked", async () => {
	const { agentDir, logPath } = setup();
	const result = await recreateProject(agentDir, "not-a-project");
	expect(result.error).toBe("项目不存在");
	expect(existsSync(logPath)).toBe(false);
});
