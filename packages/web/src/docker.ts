/**
 * Docker execution layer for container projects.
 *
 * Each project owns one long-running container built from the zgagent image
 * (docker/zgagent.Dockerfile). Every bash tool call is a `docker exec` into
 * that container; file tools operate on the host-side mount so reports and
 * evidence persist outside the container lifecycle.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export const ZG_IMAGE = "zgagent:latest";
export const CONTAINER_PREFIX = "zgagent-";

function run(
	args: string[],
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
		const onAbort = () => child.kill("SIGKILL");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ code: code ?? 1, stdout, stderr });
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ code: 1, stdout, stderr: String(error) });
		});
	});
}

/** Whether the zgagent toolbox image exists locally. */
export async function hasImage(): Promise<boolean> {
	const result = await run(["image", "inspect", ZG_IMAGE], { timeoutMs: 15000 });
	return result.code === 0;
}

export interface BuildProgress {
	onLog(line: string): void;
	signal?: AbortSignal;
}

/** Build the toolbox image, streaming build output line by line. */
export async function buildImage(progress: BuildProgress): Promise<{ ok: boolean; error?: string }> {
	return await new Promise((resolve) => {
		const child = spawn("docker", ["build", "-t", ZG_IMAGE, "docker/"], {
			cwd: repoRoot(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		const onAbort = () => child.kill("SIGKILL");
		progress.signal?.addEventListener("abort", onAbort, { once: true });
		const feed = (stream: NodeJS.ReadableStream) => {
			let buffer = "";
			stream.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) if (line.trim()) progress.onLog(line);
			});
		};
		feed(child.stdout);
		feed(child.stderr);
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			progress.signal?.removeEventListener("abort", onAbort);
			resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.slice(-2000) || `exit ${code}` });
		});
		child.on("error", (error) => resolve({ ok: false, error: String(error) }));
	});
}

function repoRoot(): string {
	// dist/docker.js -> package root -> repo root
	return join(import.meta.dirname, "..", "..");
}

/** Host-side working directory for a project (mounted at /work in the container). */
export function projectWorkDir(name: string): string {
	const slug =
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
			.slice(0, 40) || "project";
	const dir = join(homedir(), ".zgagent", "projects", slug);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

/** Create the project container: detached, privileged for raw sockets, workdir mounted. */
export async function createContainer(
	containerName: string,
	workDir: string,
): Promise<{ ok: boolean; error?: string }> {
	const result = await run([
		"run",
		"-d",
		"--name",
		containerName,
		// masscan and friends need raw sockets
		"--cap-add",
		"NET_RAW",
		"--cap-add",
		"NET_ADMIN",
		"-v",
		`${workDir}:/work`,
		"-w",
		"/work",
		ZG_IMAGE,
	]);
	return result.code === 0 ? { ok: true } : { ok: false, error: result.stderr.trim() };
}

/** Start the container if it is not running (idempotent). */
export async function ensureRunning(containerName: string): Promise<boolean> {
	const state = await run(["inspect", "-f", "{{.State.Running}}", containerName], { timeoutMs: 15000 });
	if (state.code !== 0) return false;
	if (state.stdout.trim() === "true") return true;
	const start = await run(["start", containerName], { timeoutMs: 60000 });
	return start.code === 0;
}

/** Force-remove the project container. */
export async function removeContainer(containerName: string): Promise<void> {
	await run(["rm", "-f", containerName], { timeoutMs: 60000 });
}

export function containerNameFor(projectId: string): string {
	return `${CONTAINER_PREFIX}${projectId.slice(0, 12)}`;
}

/**
 * Bash execution inside a project container. Every command runs via
 * `docker exec`; output streams through onData like the local shell backend.
 */
export function dockerBashOperations(containerName: string): BashOperations {
	return {
		exec: (command, _cwd, options) => {
			return new Promise((resolve, reject) => {
				const child = spawn("docker", ["exec", "-i", containerName, "sh", "-c", command], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let killed = false;
				const onAbort = () => {
					killed = true;
					child.kill("SIGKILL");
				};
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				child.stdout.on("data", (chunk: Buffer) => options?.onData(chunk));
				child.stderr.on("data", (chunk: Buffer) => options?.onData(chunk));
				child.on("close", (code) => {
					options?.signal?.removeEventListener("abort", onAbort);
					if (options?.signal?.aborted || killed) {
						reject(new Error("aborted"));
						return;
					}
					resolve({ exitCode: code ?? 1 });
				});
				child.on("error", (error) => {
					options?.signal?.removeEventListener("abort", onAbort);
					reject(error);
				});
			});
		},
	};
}
