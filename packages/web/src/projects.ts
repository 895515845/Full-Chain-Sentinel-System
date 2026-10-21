/**
 * Project registry: each project owns a Docker container running the sentinel
 * toolbox image plus a host-side working directory mounted at /work.
 * Sessions, approvals, and reports stay on the host; only tool execution
 * happens inside the container.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readContainerNetwork } from "./container-network.ts";
import {
	containerNameFor,
	createContainer,
	ensureRunning,
	hasImage,
	projectWorkDir,
	removeContainer,
} from "./docker.ts";
import { t } from "./i18n.ts";

export interface SentinelProject {
	id: string;
	name: string;
	/** Docker container running the toolbox image. */
	container: string;
	/** Host directory mounted at /work in the container. */
	workDir: string;
	createdAt: string;
}

interface ProjectsFile {
	projects: SentinelProject[];
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
): Promise<{ project?: SentinelProject; error?: string }> {
	const name = input.name.trim();
	if (!name) return { error: t("项目名称不能为空") };
	const file = readProjects(agentDir);
	if (file.projects.some((project) => project.name === name)) {
		return { error: t("已存在同名项目") };
	}
	if (!(await hasImage())) {
		return { error: t("工具镜像尚未构建，请先构建镜像后再创建项目") };
	}
	const id = randomUUID();
	const container = containerNameFor(id);
	const workDir = projectWorkDir(name);
	const created = await createContainer(container, workDir, readContainerNetwork(agentDir));
	if (!created.ok) {
		return { error: t("容器创建失败：{error}", { error: created.error ?? "" }) };
	}
	const project: SentinelProject = { id, name, container, workDir, createdAt: new Date().toISOString() };
	file.projects.push(project);
	writeProjects(agentDir, file);
	return { project };
}

/**
 * Replace a project's container, keeping its id, name and host work directory.
 *
 * Docker cannot change a container's network after creation, so applying a new
 * network mode (or new capabilities) means replacing the container. The work
 * directory is a bind mount and survives; the container's own layer does not, so
 * anything installed with apt or written outside /work is lost.
 */
export async function recreateProject(
	agentDir: string,
	id: string,
): Promise<{ project?: SentinelProject; error?: string }> {
	const file = readProjects(agentDir);
	const project = file.projects.find((entry) => entry.id === id);
	if (!project) return { error: t("项目不存在") };
	if (!(await hasImage())) {
		return { error: t("工具镜像尚未构建，请先构建镜像后再重建容器") };
	}
	await removeContainer(project.container);
	const created = await createContainer(project.container, project.workDir, readContainerNetwork(agentDir));
	if (!created.ok) return { error: t("容器重建失败：{error}", { error: created.error ?? "" }) };
	return { project };
}

export async function removeProject(
	agentDir: string,
	id: string,
): Promise<{ removed?: SentinelProject; error?: string }> {
	const file = readProjects(agentDir);
	const index = file.projects.findIndex((project) => project.id === id);
	if (index === -1) return { error: t("项目不存在") };
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
export async function resolveStartupProject(agentDir: string): Promise<{ project?: SentinelProject }> {
	const file = readProjects(agentDir);
	const last = file.projects.find((project) => project.id === file.lastActiveProjectId);
	if (last && (await ensureRunning(last.container))) return { project: last };
	return {};
}

/** Verify a project's container is usable, starting it when stopped. */
export async function ensureProjectReady(project: SentinelProject): Promise<boolean> {
	return await ensureRunning(project.container);
}
