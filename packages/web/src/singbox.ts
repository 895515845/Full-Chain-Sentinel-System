/**
 * The sing-box sidecar: one per proxied project.
 *
 * A proxied project container does not get the host or the bridge network. It
 * shares the network namespace of a small sing-box container created for it, so
 * every packet a tool sends enters the tunnel, and the node credentials live in
 * the sidecar's mounted configuration rather than inside the container the Agent
 * runs commands in.
 *
 * That sharing is what makes the order of every lifecycle call matter:
 *
 * - The sidecar must be *running* before the project container can be created or
 *   started, or Docker refuses with "cannot join network namespace of a non
 *   running container".
 * - Restarting the sidecar container creates a new namespace. The project
 *   container keeps running and keeps reporting `Up`, but its interfaces are
 *   gone and every command fails in ways that look like anything but a network
 *   problem. So the sidecar is never restarted on its own, and
 *   `netnsIsStale` is the check that catches it when something else did.
 *
 * The sidecar joins a user-defined network rather than Docker's default bridge:
 * on a user-defined network the embedded DNS resolver (127.0.0.11) lives inside
 * the shared namespace, so name resolution never has to survive the tunnel, and
 * Docker Desktop resolves `host.docker.internal` for the container for free —
 * which matters because `--add-host` cannot be combined with
 * `--network container:`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { containerPrefix, runDocker } from "./docker.ts";
import { t } from "./i18n.ts";
import { freePort } from "./node-test.ts";
import type { SentinelProxySettings, SentinelWireGuard } from "./protocol.ts";
import { buildSingboxConfig, projectProxyConfigPath, projectWireGuardConfigPath } from "./proxy.ts";
import { buildWireGuardConfig, wireGuardEntrypoint } from "./wireguard.ts";

/** Container name of one project's sidecar. */
export function singboxContainerNameFor(projectId: string): string {
	return `${containerPrefix()}sb-${projectId.slice(0, 12)}`;
}

/** User-defined network the sidecars join; created on first use. */
export function proxyNetworkName(): string {
	return `${containerPrefix()}proxy`;
}

/** Whether the host has the tun device node; without it the container makes one. */
function hostTunDevice(): string[] {
	return existsSync("/dev/net/tun") ? ["--device", "/dev/net/tun"] : [];
}

export async function hasSingboxImage(image: string): Promise<boolean> {
	const result = await runDocker(["image", "inspect", image], { timeoutMs: 15000 });
	return result.code === 0;
}

/** Pull the image, streaming Docker's output. A slow first pull is normal. */
export function pullSingboxImage(
	image: string,
	options: { signal?: AbortSignal; onOutput?: (chunk: string) => void } = {},
): Promise<{ ok: boolean; error?: string }> {
	return runDocker(["pull", image], { signal: options.signal, onOutput: options.onOutput, timeoutMs: 1800000 }).then(
		(result) =>
			result.code === 0
				? { ok: true }
				: { ok: false, error: result.stderr.trim().slice(-2000) || `exit ${result.code}` },
	);
}

/** Create the sidecar network when it is missing. Idempotent. */
export async function ensureProxyNetwork(): Promise<{ ok: boolean; error?: string }> {
	const name = proxyNetworkName();
	const inspect = await runDocker(["network", "inspect", name], { timeoutMs: 15000 });
	if (inspect.code === 0) return { ok: true };
	const created = await runDocker(["network", "create", name], { timeoutMs: 30000 });
	if (created.code === 0) return { ok: true };
	// Losing a race with another project's first use is not a failure.
	const recheck = await runDocker(["network", "inspect", name], { timeoutMs: 15000 });
	return recheck.code === 0 ? { ok: true } : { ok: false, error: created.stderr.trim() || `exit ${created.code}` };
}

/**
 * Write one project's generated configuration. Returns the path to mount, or the
 * reason the settings cannot become a configuration — the caller reports that
 * instead of creating a sidecar that would fail at startup.
 *
 * An unchanged configuration is not rewritten: the file's timestamp is what says
 * whether a running sidecar still serves what the console generated, and a write
 * on every use would make every sidecar look out of date.
 */
/**
 * Write a tunnel's `wg0.conf`.
 *
 * Same rule as the sing-box configuration: an identical rewrite is skipped so the
 * file's modification time keeps meaning "this changed", which is what the
 * environment check uses to decide whether a running sidecar is stale.
 */
export function writeProjectWireGuardConfig(
	agentDir: string,
	projectId: string,
	wireguard: SentinelWireGuard,
): { ok: true; path: string; dns: string } | { ok: false; error: string } {
	const built = buildWireGuardConfig(wireguard);
	if (built.error || !built.config) return { ok: false, error: built.error ?? t("配置生成失败") };
	const path = projectWireGuardConfigPath(agentDir, projectId);
	const dns = built.dns ?? "";
	try {
		if (readFileSync(path, "utf-8") === built.config) return { ok: true, path, dns };
	} catch {
		// Missing or unreadable: written below.
	}
	mkdirSync(dirname(path), { recursive: true });
	// 0600: the file holds the private key.
	writeFileSync(path, built.config, { mode: 0o600 });
	return { ok: true, path, dns };
}

export async function writeProjectProxyConfig(
	agentDir: string,
	projectId: string,
	settings: SentinelProxySettings,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const path = projectProxyConfigPath(agentDir, projectId);
	// The control port and its secret have to survive a rewrite: the running
	// sidecar was published on that port, and the console switches nodes through
	// it. They are regenerated only when the configuration is created.
	const existing = readClashApi(path) ?? (await allocateClashApi());
	const built = buildSingboxConfig(settings, existing);
	if (built.error || !built.config) return { ok: false, error: built.error ?? t("配置生成失败") };
	try {
		if (readFileSync(path, "utf-8") === built.config) return { ok: true, path };
	} catch {
		// Missing or unreadable: written below.
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, built.config, { mode: 0o600 });
	return { ok: true, path };
}

/** The Clash API settings of an existing configuration, if it has any. */
export function readClashApi(configPath: string): { port: number; secret: string } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch {
		return undefined;
	}
	const api = (parsed as { experimental?: { clash_api?: { external_controller?: unknown; secret?: unknown } } })
		?.experimental?.clash_api;
	const controller = typeof api?.external_controller === "string" ? api.external_controller : "";
	const secret = typeof api?.secret === "string" ? api.secret : "";
	const port = Number(controller.split(":").pop());
	if (!Number.isFinite(port) || port <= 0 || !secret) return undefined;
	return { port, secret };
}

/**
 * Where the console can reach a sidecar's control API: the host port Docker
 * assigned, plus the secret the configuration carries.
 *
 * The host side is ephemeral, so this is asked for at switch time rather than
 * remembered; a sidecar that is not running has no answer, which is exactly the
 * "nothing to switch right now" case.
 */
export async function proxyApiEndpoint(
	containerName: string,
	configPath: string,
): Promise<{ port: number; secret: string } | undefined> {
	const api = readClashApi(configPath);
	if (!api) return undefined;
	const published = await runDocker(["port", containerName, `${api.port}/tcp`], { timeoutMs: 10000 });
	if (published.code !== 0) return undefined;
	// `127.0.0.1:54321` (one line per binding; the first is enough).
	const line = published.stdout.trim().split("\n")[0] ?? "";
	const port = Number(line.slice(line.lastIndexOf(":") + 1));
	if (!Number.isFinite(port) || port <= 0) return undefined;
	return { port, secret: api.secret };
}

/** Fresh API settings for a configuration that does not have any yet. */
async function allocateClashApi(): Promise<{ port: number; secret: string }> {
	return { port: await freePort(), secret: randomBytes(16).toString("hex") };
}

/**
 * `sing-box check` on a configuration, in a throwaway container.
 *
 * Worth the second it costs: a rejected configuration would otherwise surface as
 * a sidecar that starts and immediately exits, which reads as "the proxy is
 * broken" rather than "this node needs a different field".
 */
export async function checkSingboxConfig(image: string, configPath: string): Promise<{ ok: boolean; error?: string }> {
	const result = await runDocker(
		[
			"run",
			"--rm",
			"--network",
			"none",
			"--pull=never",
			"-v",
			`${configPath}:/etc/sing-box/config.json:ro`,
			"--entrypoint",
			"sing-box",
			image,
			"check",
			"-C",
			"/etc/sing-box",
		],
		{ timeoutMs: 60000 },
	);
	if (result.code === 0) return { ok: true };
	const output = `${result.stdout}\n${result.stderr}`.trim();
	return { ok: false, error: output.split("\n").slice(-4).join("\n").slice(-800) || `exit ${result.code}` };
}

/**
 * `sing-box check` on a configuration that is not a project's yet.
 *
 * The 代理 page saves a profile before any container uses it, so the check needs a
 * file to mount. It goes in the proxy directory — the one directory the console
 * already knows is visible to the Docker daemon, which a system temp directory is
 * not on every platform — and is removed again either way.
 */
export async function checkProxyProfile(
	image: string,
	config: string,
	agentDir: string,
): Promise<{ ok: boolean; error?: string }> {
	const path = join(agentDir, "proxy", ".check.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, config, { mode: 0o600 });
	try {
		return await checkSingboxConfig(image, path);
	} finally {
		rmSync(path, { force: true });
	}
}

/**
 * Start the sidecar for a project.
 *
 * The tun device is created inside the container when the host has no node for
 * it: Docker's default device cgroup already allows character device 10:200, so
 * `mknod` works without `--privileged` and the sidecar does not depend on the
 * host's udev having made the node.
 */
export async function createSingboxContainer(
	containerName: string,
	configPath: string,
	image: string,
): Promise<{ ok: boolean; error?: string }> {
	const network = await ensureProxyNetwork();
	if (!network.ok) return { ok: false, error: network.error };
	// The console switches nodes through this port, so it has to be reachable from
	// the host — loopback only, never on a network the container shares. The host
	// side is left to Docker: a fixed one could collide with a sidecar that was
	// stopped when this one was created, and a sidecar that cannot publish cannot
	// start at all.
	const api = readClashApi(configPath);
	const result = await runDocker([
		"run",
		"-d",
		"--name",
		containerName,
		"--network",
		proxyNetworkName(),
		...(api ? ["-p", `127.0.0.1::${api.port}`] : []),
		"--cap-add",
		"NET_ADMIN",
		"--cap-add",
		"NET_RAW",
		...hostTunDevice(),
		"-v",
		`${configPath}:/etc/sing-box/config.json:ro`,
		"--entrypoint",
		"sh",
		image,
		"-c",
		"mkdir -p /dev/net; [ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200; exec sing-box run -C /etc/sing-box",
	]);
	return result.code === 0 ? { ok: true } : { ok: false, error: result.stderr.trim() };
}

/** Start the sidecar if it is not running, creating it when it is gone. */
export async function ensureSingboxRunning(
	containerName: string,
	configPath: string,
	image: string,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
	const state = await runDocker(["inspect", "-f", "{{.State.Running}}", containerName], { timeoutMs: 15000 });
	if (state.code !== 0) {
		if (!(await hasSingboxImage(image))) {
			return { ok: false, created: false, error: t("代理镜像 {image} 不存在", { image }) };
		}
		const created = await createSingboxContainer(containerName, configPath, image);
		return { ok: created.ok, created: true, error: created.error };
	}
	if (state.stdout.trim() === "true") return { ok: true, created: false };
	const start = await runDocker(["start", containerName], { timeoutMs: 60000 });
	return { ok: start.code === 0, created: false, error: start.code === 0 ? undefined : start.stderr.trim() };
}

/**
 * The sidecar of a WireGuard profile.
 *
 * It is not a sing-box container at all: `wg-quick` creates a real interface and
 * installs a real default route, which is what makes ICMP and UDP work — a proxy
 * engine's outbound can only carry TCP and UDP. It runs the toolbox image, which
 * already has `wireguard-tools` and `iproute2`, so a tunnel needs no second image
 * to pull.
 *
 * It still joins the console's proxy network: that is what gives the sidecar a
 * working resolver for the peer's hostname, and the same `/etc/hosts` treatment
 * for `host.docker.internal`.
 */
export async function createWireGuardContainer(
	containerName: string,
	configPath: string,
	image: string,
	killSwitch: boolean,
): Promise<{ ok: boolean; error?: string }> {
	const network = await ensureProxyNetwork();
	if (!network.ok) return { ok: false, error: network.error };
	const result = await runDocker([
		"run",
		"-d",
		"--name",
		containerName,
		"--network",
		proxyNetworkName(),
		"--cap-add",
		"NET_ADMIN",
		// wg-quick sets this for its kill switch, and /proc/sys is read-only in a
		// container unless the key is granted here.
		"--sysctl",
		"net.ipv4.conf.all.src_valid_mark=1",
		"-v",
		`${configPath}:/etc/wireguard/wg0.conf:ro`,
		"--entrypoint",
		"sh",
		image,
		"-c",
		wireGuardEntrypoint(killSwitch),
	]);
	return result.code === 0 ? { ok: true } : { ok: false, error: result.stderr.trim() };
}

/** Start the tunnel sidecar if it is not running, creating it when it is gone. */
export async function ensureWireGuardRunning(
	containerName: string,
	configPath: string,
	image: string,
	killSwitch: boolean,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
	const state = await runDocker(["inspect", "-f", "{{.State.Running}}", containerName], { timeoutMs: 15000 });
	if (state.code !== 0) {
		if (!(await hasSingboxImage(image))) {
			return { ok: false, created: false, error: t("镜像 {image} 不存在", { image }) };
		}
		const created = await createWireGuardContainer(containerName, configPath, image, killSwitch);
		return { ok: created.ok, created: true, error: created.error };
	}
	if (state.stdout.trim() === "true") return { ok: true, created: false };
	const start = await runDocker(["start", containerName], { timeoutMs: 60000 });
	return { ok: start.code === 0, created: false, error: start.code === 0 ? undefined : start.stderr.trim() };
}

export async function stopSingboxContainer(containerName: string): Promise<{ ok: boolean; error?: string }> {
	const result = await runDocker(["stop", containerName], { timeoutMs: 120000 });
	return result.code === 0 ? { ok: true } : { ok: false, error: result.stderr.trim() };
}

export async function removeSingboxContainer(containerName: string): Promise<{ ok: boolean; error?: string }> {
	const result = await runDocker(["rm", "-f", containerName], { timeoutMs: 60000 });
	if (result.code === 0) return { ok: true };
	const inspect = await runDocker(["inspect", "-f", "{{.Id}}", containerName], { timeoutMs: 15000 });
	return inspect.code === 0 ? { ok: false, error: result.stderr.trim() } : { ok: true };
}

/** Container state per name, for the project list and the environment page. */
export async function singboxState(containerName: string): Promise<"running" | "stopped" | "missing"> {
	const result = await runDocker(["inspect", "-f", "{{.State.Running}}", containerName], { timeoutMs: 15000 });
	if (result.code !== 0) return "missing";
	return result.stdout.trim() === "true" ? "running" : "stopped";
}

/** The full id of a container, or undefined when it does not exist. */
async function containerId(containerName: string): Promise<string | undefined> {
	const result = await runDocker(["inspect", "-f", "{{.Id}}", containerName], { timeoutMs: 15000 });
	const id = result.stdout.trim();
	return result.code === 0 && id ? id : undefined;
}

/** `docker inspect` timestamps carry nanoseconds; Date.parse truncates them. */
function startedAt(value: string): number {
	const parsed = Date.parse(value.trim());
	return Number.isFinite(parsed) ? parsed : 0;
}

async function containerStartedAt(containerName: string): Promise<number> {
	const result = await runDocker(["inspect", "-f", "{{.State.StartedAt}}", containerName], { timeoutMs: 15000 });
	return result.code === 0 ? startedAt(result.stdout) : 0;
}

/**
 * What a project container's relationship to its sidecar looks like right now.
 *
 * Every field describes a state the operator cannot see from inside the container:
 * a container still reports `Up` after the namespace it was attached to is gone,
 * and nothing about a running sidecar says which configuration it loaded.
 */
export interface SidecarHealth {
	/** The project container exists at all. */
	exists: boolean;
	/** Its network mode points at this sidecar. */
	joined: boolean;
	/**
	 * The namespace it joined is gone: the sidecar was removed and recreated (a
	 * different container id in the network mode) or restarted (same id, a newer
	 * start time — the old namespace went with the old process). The container
	 * keeps running with no interfaces at all until it is rebuilt.
	 */
	netnsStale: boolean;
	/**
	 * The generated configuration was replaced after the sidecar loaded it, so the
	 * sidecar is serving a node the operator has already moved on from. Reloading
	 * it means restarting the container, which cannot happen under a container
	 * that is attached to it — the two are rebuilt together or not at all.
	 */
	configStale: boolean;
}

/**
 * Inspect one project container against its sidecar.
 *
 * A container that is not on a sidecar network at all is not stale: it is on the
 * host or bridge network, which is a different state the caller reports
 * separately (`joined` says which it is).
 */
export async function checkSidecar(
	containerName: string,
	sidecarName: string,
	configPath: string,
): Promise<SidecarHealth> {
	const mode = await runDocker(["inspect", "-f", "{{.HostConfig.NetworkMode}}", containerName], { timeoutMs: 15000 });
	const exists = mode.code === 0;
	const value = exists ? mode.stdout.trim() : "";
	const onSidecar = value.startsWith("container:");
	const [sidecarId, sidecarStarted, containerStarted] = await Promise.all([
		containerId(sidecarName),
		containerStartedAt(sidecarName),
		exists ? containerStartedAt(containerName) : Promise.resolve(0),
	]);
	const joined = onSidecar && Boolean(sidecarId) && sidecarId === value.slice("container:".length);
	return {
		exists,
		joined,
		// A mode that names a container other than this sidecar is stale by
		// definition; joining one and starting after it is the other way round. An
		// unreadable start time (0) must not read as "the sidecar started later".
		netnsStale: onSidecar && (!joined || (containerStarted > 0 && sidecarStarted > containerStarted)),
		// Independent of the container: whether the sidecar's process is still the
		// one that read this file is a property of the sidecar alone.
		configStale: configIsNewerThan(configPath, sidecarStarted),
	};
}

/** Whether the configuration file was written after the sidecar loaded it. */
function configIsNewerThan(configPath: string, sidecarStarted: number): boolean {
	if (sidecarStarted <= 0) return false;
	try {
		return statSync(configPath).mtimeMs > sidecarStarted;
	} catch {
		return false;
	}
}

/** The network mode Docker reports for a container, empty when it is gone. */
export async function containerNetworkMode(containerName: string): Promise<string> {
	const result = await runDocker(["inspect", "-f", "{{.HostConfig.NetworkMode}}", containerName], {
		timeoutMs: 15000,
	});
	return result.code === 0 ? result.stdout.trim() : "";
}
