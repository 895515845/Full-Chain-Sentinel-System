/**
 * Project registry: each project owns a Docker container running the zgagent
 * toolbox image plus a host-side working directory mounted at /work.
 * Sessions, approvals, and reports stay on the host; only tool execution
 * happens inside the container.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	containerNameFor,
	createContainer,
	ensureRunning,
	hasImage,
	projectWorkDir,
	removeContainer,
} from "./docker.ts";

export interface ZGProject {
	id: string;
	name: string;
	/** Docker container running the toolbox image. */
	container: string;
	/** Host directory mounted at /work in the container. */
	workDir: string;
	createdAt: string;
}

interface ProjectsFile {
	projects: ZGProject[];
	lastActiveProjectId?: string;
}

function projectsPath(agentDir: string): string {
	return `${agentDir}/projects.json`;
}

function readProjects(agentDir: string): ProjectsFile {
	const path = projectsPath(agentDir);
	if (!existsSync(path)) return { projects: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ProjectsFile;
		if (!Array.isArray(parsed.projects)) return { projects: [] };
		return parsed;
	} catch {
		return { projects: [] };
	}
}

function writeProjects(agentDir: string, file: ProjectsFile): void {
	const path = projectsPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
}

export function listProjects(agentDir: string): ProjectsFile {
	return readProjects(agentDir);
}

/** Register a project: creates the container and its host work directory. */
export async function addProject(
	agentDir: string,
	input: { name: string },
): Promise<{ project?: ZGProject; error?: string }> {
	const name = input.name.trim();
	if (!name) return { error: "项目名称不能为空" };
	const file = readProjects(agentDir);
	if (file.projects.some((project) => project.name === name)) {
		return { error: "已存在同名项目" };
	}
	if (!(await hasImage())) {
		return { error: "工具镜像尚未构建，请先构建镜像后再创建项目" };
	}
	const id = randomUUID();
	const container = containerNameFor(id);
	const workDir = projectWorkDir(name);
	const created = await createContainer(container, workDir);
	if (!created.ok) {
		return { error: `容器创建失败：${created.error}` };
	}
	const project: ZGProject = { id, name, container, workDir, createdAt: new Date().toISOString() };
	file.projects.push(project);
	writeProjects(agentDir, file);
	return { project };
}

export async function removeProject(agentDir: string, id: string): Promise<{ removed?: ZGProject; error?: string }> {
	const file = readProjects(agentDir);
	const index = file.projects.findIndex((project) => project.id === id);
	if (index === -1) return { error: "项目不存在" };
	const [removed] = file.projects.splice(index, 1);
	if (file.lastActiveProjectId === id) delete file.lastActiveProjectId;
	writeProjects(agentDir, file);
	await removeContainer(removed.container);
	return { removed };
}

export function setLastActiveProject(agentDir: string, id: string | undefined): void {
	const file = readProjects(agentDir);
	file.lastActiveProjectId = id;
	writeProjects(agentDir, file);
}

/** Resolve the startup project; returns nothing when it is gone or none was set. */
export async function resolveStartupProject(agentDir: string): Promise<{ project?: ZGProject }> {
	const file = readProjects(agentDir);
	const last = file.projects.find((project) => project.id === file.lastActiveProjectId);
	if (last && (await ensureRunning(last.container))) return { project: last };
	return {};
}

/** Verify a project's container is usable, starting it when stopped. */
export async function ensureProjectReady(project: ZGProject): Promise<boolean> {
	return await ensureRunning(project.container);
}
