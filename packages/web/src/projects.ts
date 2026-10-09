/**
 * Project registry: named working directories persisted in projects.json.
 *
 * A project is just a name bound to a cwd; sessions, context files, and bash
 * tool paths all follow the directory automatically because pi scopes sessions
 * per-cwd on disk. Switching projects rebuilds the agent session for the new
 * directory.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolveFsPath } from "node:path";

export interface ZGProject {
	id: string;
	name: string;
	cwd: string;
	createdAt: string;
}

export interface ProjectsFile {
	projects: ZGProject[];
	lastActiveProjectId?: string;
}

export function projectsJsonPath(agentDir: string): string {
	return `${agentDir}/projects.json`;
}

function readProjects(agentDir: string): ProjectsFile {
	const path = projectsJsonPath(agentDir);
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
	const path = projectsJsonPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
}

export function listProjects(agentDir: string): { projects: ZGProject[]; lastActiveProjectId?: string } {
	return readProjects(agentDir);
}

/** Register a project. The directory must exist; duplicate cwds are rejected. */
export function addProject(
	agentDir: string,
	input: { name: string; cwd: string },
): { project?: ZGProject; error?: string } {
	const name = input.name.trim();
	const cwd = resolveFsPath(input.cwd.trim());
	if (!name) return { error: "项目名称不能为空" };
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
		return { error: `目录不存在：${cwd}` };
	}
	const file = readProjects(agentDir);
	if (file.projects.some((project) => project.cwd === cwd)) {
		return { error: "该目录已被其他项目使用" };
	}
	if (file.projects.some((project) => project.name === name)) {
		return { error: "已存在同名项目" };
	}
	const project: ZGProject = { id: randomUUID(), name, cwd, createdAt: new Date().toISOString() };
	file.projects.push(project);
	writeProjects(agentDir, file);
	return { project };
}

export function removeProject(agentDir: string, id: string): { removed?: ZGProject; error?: string } {
	const file = readProjects(agentDir);
	const index = file.projects.findIndex((project) => project.id === id);
	if (index === -1) return { error: "项目不存在" };
	const [removed] = file.projects.splice(index, 1);
	if (file.lastActiveProjectId === id) delete file.lastActiveProjectId;
	writeProjects(agentDir, file);
	return { removed };
}

export function setLastActiveProject(agentDir: string, id: string | undefined): void {
	const file = readProjects(agentDir);
	file.lastActiveProjectId = id;
	writeProjects(agentDir, file);
}

/** Resolve the project the server should start in, if it still exists. */
export function resolveStartupProject(agentDir: string, fallbackCwd: string): { project?: ZGProject; cwd: string } {
	const file = readProjects(agentDir);
	const last = file.projects.find((project) => project.id === file.lastActiveProjectId);
	if (last && existsSync(last.cwd)) return { project: last, cwd: last.cwd };
	return { cwd: fallbackCwd };
}
