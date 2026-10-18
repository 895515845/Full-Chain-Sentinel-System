/**
 * Docker operations of the plugin host.
 *
 * The host only ever uses the CLI. A socket client would need a dependency and a
 * second set of types, while the CLI is already the interface the console's
 * project containers use, and `docker inspect` JSON is stable.
 *
 * Three deliberate choices:
 *
 * - Published ports bind to 127.0.0.1 only. The console reaches the container
 *   through the host's reverse proxy; the container itself is never on a public
 *   interface, even when the host runs on a VPS.
 * - Host networking is applied only when the record says the operator approved
 *   it. The manifest asks; it never decides.
 * - Capabilities are filtered against a small allowlist. A manifest that asks
 *   for SYS_ADMIN is an install error, not a container.
 */

import { join } from "node:path";
import { runDocker } from "../docker.ts";
import type { SentinelPluginManifest } from "../plugin-manifest.ts";
import type { PluginRuntimeState, StoredPluginRecord } from "./store.ts";
import type { DockerRunner } from "./types.ts";

/** Capabilities a plugin may ask for. Everything else is refused at install. */
export const ALLOWED_CAPS: readonly string[] = ["NET_RAW", "NET_ADMIN", "NET_BIND_SERVICE", "SYS_PTRACE"];

/** Docker's restart policy never gives up; past this count the host calls the plugin failed. */
export const MAX_RESTARTS_BEFORE_FAILED = 5;

const TIMEOUT = {
	create: 60000,
	start: 60000,
	stop: 30000,
	remove: 30000,
	inspect: 15000,
	logs: 15000,
	build: 1800000,
	removeImage: 60000,
} as const;

const defaultRunner: DockerRunner = (args, options) => runDocker(args, options);

export interface DockerContext {
	runner?: DockerRunner;
}

function runnerOf(context: DockerContext): DockerRunner {
	return context.runner ?? defaultRunner;
}

export interface CreateContainerOptions {
	manifest: SentinelPluginManifest;
	record: StoredPluginRecord;
	/** Local tag produced by the build on this host. */
	imageTag: string;
	dataDir: string;
	artifactsDir: string;
	env: Record<string, string>;
}

export interface BuildImageOptions {
	/** Directory of the extracted package that contains plugin.json. */
	root: string;
	/** Dockerfile path relative to root. */
	dockerfile: string;
	/** Build context relative to root. */
	context: string;
	/** Local tag, e.g. sentinel-plugin/com.example.recon:0.1.0. */
	tag: string;
	/** Values for --build-arg, already validated by the manifest parser. */
	args: Record<string, string>;
	/** Receives Docker's output while the build runs, for the live install log. */
	onOutput?: (chunk: string) => void;
}

/**
 * Build the image from the uploaded package.
 *
 * The Dockerfile runs with the daemon's privileges, so the console only calls
 * this after the operator explicitly approved "run the build on this host".
 * The last 2 KB of output is returned on failure; the full log is written by
 * the caller, because a failed Go or JDK build is unreadable without it.
 */
export interface BuildResult {
	ok: boolean;
	/** Full build output, written to the plugin's build.log by the caller. */
	output: string;
	error?: string;
}

export async function buildPluginImage(context: DockerContext, options: BuildImageOptions): Promise<BuildResult> {
	const result = await runnerOf(context)(
		[
			"build",
			"-f",
			join(options.root, options.dockerfile),
			"-t",
			options.tag,
			...Object.entries(options.args).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
			join(options.root, options.context),
		],
		{ timeoutMs: TIMEOUT.build, onOutput: options.onOutput },
	);
	const output = `${result.stdout}\n${result.stderr}`.trim();
	if (result.code === 0) return { ok: true, output };
	return {
		ok: false,
		output,
		error: `镜像构建失败（退出码 ${result.code}）：\n${output.slice(-2000)}`,
	};
}

/** Whether a previous build already produced this exact tag. */
export async function imageExists(context: DockerContext, tag: string): Promise<boolean> {
	const result = await runnerOf(context)(["image", "inspect", tag], { timeoutMs: TIMEOUT.inspect });
	return result.code === 0;
}

/** Remove a locally built image; a missing image is not an error. */
export async function removeImage(context: DockerContext, tag: string): Promise<void> {
	await runnerOf(context)(["rmi", tag], { timeoutMs: TIMEOUT.removeImage });
}

/** Whether the daemon answers, for the host's own status line. */
export async function dockerVersion(
	context: DockerContext,
): Promise<{ ok: boolean; version?: string; error?: string }> {
	const result = await runnerOf(context)(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 5000 });
	if (result.code === 0) return { ok: true, version: result.stdout.trim() };
	return { ok: false, error: (result.stderr || result.stdout).trim().slice(-400) };
}

/** Port mapping flags. A host-network container binds its port on the host directly. */
function networkFlags(manifest: SentinelPluginManifest): string[] {
	if (manifest.permissions.network === "host") return ["--network", "host"];
	if (manifest.permissions.network === "none") return ["--network", "none"];
	// A random loopback port: the host proxies, so the number is never stable and never public.
	return ["--network", "bridge", "-p", `127.0.0.1::${manifest.mcp.port}`];
}

export function createArgs(options: CreateContainerOptions): string[] {
	const { manifest, record, dataDir, artifactsDir, env } = options;
	const args = [
		"create",
		"--name",
		record.containerName,
		"--label",
		`sentinel.plugin.id=${manifest.id}`,
		"--label",
		`sentinel.plugin.version=${manifest.version}`,
		"--restart",
		"unless-stopped",
		"--log-opt",
		"max-size=10m",
		"--log-opt",
		"max-file=3",
		"--cpus",
		String(manifest.resources.cpus),
		"--memory",
		manifest.resources.memory,
		"--pids-limit",
		String(manifest.resources.pidsLimit),
		...networkFlags(manifest),
	];
	for (const cap of manifest.permissions.capAdd) args.push("--cap-add", cap);
	if (manifest.permissions.privileged) args.push("--privileged");
	args.push("-v", `${dataDir}:/data`, "-v", `${artifactsDir}:/artifacts`);
	for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
	args.push(options.imageTag);
	return args;
}

/** Remove a leftover container with the same name; install must be idempotent. */
export async function removeContainer(context: DockerContext, name: string): Promise<void> {
	await runnerOf(context)(["rm", "-f", name], { timeoutMs: TIMEOUT.remove });
}

/**
 * Create the container. The published port is only assigned when it starts
 * (Docker leaves HostPort empty at create time), so callers resolve it after
 * startContainer rather than here.
 */
export async function createContainer(
	context: DockerContext,
	options: CreateContainerOptions,
): Promise<string | undefined> {
	const runner = runnerOf(context);
	await removeContainer(context, options.record.containerName);
	const created = await runner(createArgs(options), { timeoutMs: TIMEOUT.create });
	if (created.code !== 0) {
		return `创建容器失败：${(created.stderr || created.stdout).trim().slice(-600)}`;
	}
	return undefined;
}

/** The loopback port Docker assigned, or null when the port is not published. */
export async function containerHostPort(
	context: DockerContext,
	name: string,
	containerPort: number,
): Promise<number | null> {
	const result = await runnerOf(context)(["port", name, `${containerPort}/tcp`], { timeoutMs: TIMEOUT.inspect });
	if (result.code !== 0) return null;
	const line = result.stdout.trim().split("\n")[0] ?? "";
	const match = /:(\d+)$/.exec(line.trim());
	if (!match) return null;
	const port = Number(match[1]);
	return Number.isInteger(port) && port > 0 ? port : null;
}

export async function startContainer(context: DockerContext, name: string): Promise<string | undefined> {
	const result = await runnerOf(context)(["start", name], { timeoutMs: TIMEOUT.start });
	return result.code === 0 ? undefined : `启动失败：${(result.stderr || result.stdout).trim().slice(-600)}`;
}

/** Rename after the new container passed health, so the canonical name always points at a working one. */
export async function renameContainer(context: DockerContext, from: string, to: string): Promise<string | undefined> {
	const result = await runnerOf(context)(["rename", from, to], { timeoutMs: TIMEOUT.inspect });
	return result.code === 0 ? undefined : `重命名容器失败：${(result.stderr || result.stdout).trim().slice(-400)}`;
}

export async function stopContainer(context: DockerContext, name: string): Promise<string | undefined> {
	const result = await runnerOf(context)(["stop", name], { timeoutMs: TIMEOUT.stop });
	return result.code === 0 ? undefined : `停止失败：${(result.stderr || result.stdout).trim().slice(-600)}`;
}

export interface ContainerState {
	running: boolean;
	status: string;
	exitCode: number;
	restartCount: number;
}

export async function inspectContainer(context: DockerContext, name: string): Promise<ContainerState | null> {
	const result = await runnerOf(context)(["inspect", "--format", "{{json .}}", name], {
		timeoutMs: TIMEOUT.inspect,
	});
	if (result.code !== 0) return null;
	try {
		const raw = JSON.parse(result.stdout.trim()) as {
			State?: Partial<{ Running: boolean; Status: string; ExitCode: number }>;
			RestartCount?: number;
		};
		const state = raw.State ?? {};
		return {
			running: state.Running === true,
			status: typeof state.Status === "string" ? state.Status : "",
			exitCode: typeof state.ExitCode === "number" ? state.ExitCode : 0,
			restartCount: typeof raw.RestartCount === "number" ? raw.RestartCount : 0,
		};
	} catch {
		return null;
	}
}

export async function containerLogs(context: DockerContext, name: string, tail: number): Promise<string> {
	const result = await runnerOf(context)(["logs", "--tail", String(tail), name], { timeoutMs: TIMEOUT.logs });
	return `${result.stdout}${result.stderr}`.trim();
}

/** The runtime state a list response reports, derived from Docker rather than from a cached flag. */
export function runtimeState(state: ContainerState | null, healthy: boolean): PluginRuntimeState {
	if (!state) return "missing";
	// A container that keeps dying is not "starting": the page must say failed and show why.
	if (state.restartCount > MAX_RESTARTS_BEFORE_FAILED) return "failed";
	if (state.running) return healthy ? "running" : "starting";
	if (state.status === "created") return "stopped";
	if (state.exitCode !== 0) return "failed";
	return "stopped";
}

/** HTTP health probe against the loopback port the host published. */
export async function probeHealth(
	port: number | null,
	path: string,
	timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
	if (port === null) return { ok: false, error: "没有可用的端口映射" };
	try {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, {
			signal: AbortSignal.timeout(Math.max(timeoutMs, 500)),
		});
		if (response.ok) return { ok: true };
		return { ok: false, error: `健康检查返回 HTTP ${response.status}` };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Wait for the container's health endpoint, giving up after the manifest's startup budget. */
export async function waitHealthy(
	context: DockerContext,
	record: StoredPluginRecord,
	port: number | null,
): Promise<{ ok: boolean; error?: string }> {
	const { manifest } = record;
	const deadline = Date.now() + manifest.mcp.startupTimeoutMs;
	let last: { ok: boolean; error?: string } = { ok: false, error: "未开始检查" };
	while (Date.now() < deadline) {
		const state = await inspectContainer(context, record.containerName);
		if (state && !state.running && state.exitCode !== 0) {
			return { ok: false, error: `容器已退出（退出码 ${state.exitCode}）` };
		}
		last = await probeHealth(port, manifest.healthcheck.path, manifest.healthcheck.timeoutMs);
		if (last.ok) return last;
		await new Promise((resolve) => setTimeout(resolve, Math.max(500, manifest.healthcheck.intervalMs / 2)));
	}
	return { ok: false, error: `启动超时：${last.error ?? "健康检查未通过"}` };
}
