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
	ensureContainer,
	hasImage,
	projectWorkDir,
	removeContainer,
	stopContainer,
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
	/**
	 * The operator stopped this project's container on purpose.
	 *
	 * Docker state is not enough to tell an intentional stop from a container
	 * that exited with the host: the first must wait for an explicit start, the
	 * second may be started again whenever the project is used.
	 */
	manualStop?: boolean;
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
	const removed = await removeContainer(project.container);
	if (!removed.ok) return { error: t("容器删除失败：{error}", { error: removed.error ?? "" }) };
	const created = await createContainer(project.container, project.workDir, readContainerNetwork(agentDir));
	if (!created.ok) return { error: t("容器重建失败：{error}", { error: created.error ?? "" }) };
	// A freshly created container is running: an earlier manual stop is spent.
	delete project.manualStop;
	writeProjects(agentDir, file);
	return { project };
}

/**
 * Remove a project's container, or the project itself.
 *
 * `container` keeps the registry entry and everything on the host: the container
 * is disposable, the work directory and the records are not. The project is left
 * needing an explicit start, which recreates the container from current settings.
 * `data` unregisters the project; its stored data is deleted by the caller, which
 * owns the databases and the session files.
 */
export async function removeProject(
	agentDir: string,
	id: string,
	scope: ProjectRemoveScope = "data",
): Promise<{ removed?: SentinelProject; error?: string }> {
	const file = readProjects(agentDir);
	const project = file.projects.find((entry) => entry.id === id);
	if (!project) return { error: t("项目不存在") };
	const removed = await removeContainer(project.container);
	if (!removed.ok) return { error: t("容器删除失败：{error}", { error: removed.error ?? "" }) };
	if (scope === "container") {
		project.manualStop = true;
		writeProjects(agentDir, file);
		return { removed: project };
	}
	const index = file.projects.findIndex((entry) => entry.id === id);
	file.projects.splice(index, 1);
	if (file.lastActiveProjectId === id) delete file.lastActiveProjectId;
	writeProjects(agentDir, file);
	return { removed: project };
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
	// Going through the readiness check keeps a deliberately stopped project
	// stopped: starting it is the operator's click, not a side effect of a restart.
	if (last && (await ensureProjectReady(last, agentDir))) return { project: last };
	return {};
}

/** The project's container state as the operator should see it. */
export type ProjectContainerState = "running" | "stopped" | "missing";

/** What a delete request covers: just the container, or everything the project owns. */
export type ProjectRemoveScope = "container" | "data";

/**
 * Verify a project's container is usable, starting it when it is merely stopped
 * and creating it when it is gone.
 *
 * A project the operator stopped by hand is never started here: it needs an
 * explicit 「启动容器」, or the stop would be undone by the next click.
 */
export async function ensureProjectReady(project: SentinelProject, agentDir: string): Promise<boolean> {
	if (project.manualStop) return false;
	const ready = await ensureContainer(project.container, project.workDir, readContainerNetwork(agentDir));
	return ready.ok;
}

/**
 * Stop a project's container and remember that it was intentional.
 *
 * The container is kept: it can be started again with its installed packages
 * intact, which is what separates this from removing or rebuilding it.
 */
export async function stopProject(
	agentDir: string,
	id: string,
): Promise<{ project?: SentinelProject; error?: string }> {
	const file = readProjects(agentDir);
	const project = file.projects.find((entry) => entry.id === id);
	if (!project) return { error: t("项目不存在") };
	const stopped = await stopContainer(project.container);
	if (!stopped.ok && stopped.error) return { error: t("容器停止失败：{error}", { error: stopped.error }) };
	project.manualStop = true;
	writeProjects(agentDir, file);
	return { project };
}

/** Start a project's container again, creating it when it no longer exists. */
export async function startProject(
	agentDir: string,
	id: string,
): Promise<{ project?: SentinelProject; created?: boolean; error?: string }> {
	const file = readProjects(agentDir);
	const project = file.projects.find((entry) => entry.id === id);
	if (!project) return { error: t("项目不存在") };
	const ready = await ensureContainer(project.container, project.workDir, readContainerNetwork(project.workDir));
	if (!ready.ok) return { error: t("容器启动失败：{error}", { error: ready.error ?? "" }) };
	delete project.manualStop;
	writeProjects(agentDir, file);
	return { project, created: ready.created };
}
