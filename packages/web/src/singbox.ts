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
import {
	buildOpenVpnProfile,
	OPENVPN_AUTH_FILE,
	OPENVPN_CLIENT_DIR,
	OPENVPN_CONFIG_FILE,
	OPENVPN_HOOK_FILE,
	OPENVPN_PUSHED_DNS_FILE,
	openVpnEntrypoint,
	openVpnHookScript,
} from "./openvpn.ts";
import type { SentinelOpenVpn, SentinelProxySettings, SentinelWireGuard } from "./protocol.ts";
import {
	buildSingboxConfig,
	parseNameservers,
	projectOpenVpnAuthPath,
	projectOpenVpnConfigPath,
	projectOpenVpnHookPath,
	projectOpenVpnPushedDnsPath,
	projectProxyConfigPath,
	projectResolvConfPath,
	projectWireGuardConfigPath,
} from "./proxy.ts";
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
 * Write a generated file, unless it already holds exactly this.
 *
 * The modification time is what says whether a running sidecar still serves what the
 * console generated, so a write on every use would make every sidecar look out of
 * date. Every generated file follows this rule: writing one returns the path to
 * mount, or the reason the settings cannot become a configuration at all.
 */
function writeIfChanged(path: string, body: string, mode: number): void {
	try {
		if (readFileSync(path, "utf-8") === body) return;
	} catch {
		// Missing or unreadable: written below.
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body, { mode });
}

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
	// 0600: the file holds the private key.
	writeIfChanged(path, built.config, 0o600);
	return { ok: true, path, dns: built.dns ?? "" };
}

/**
 * Write the `/etc/resolv.conf` a tunneled project container mounts.
 *
 * It exists because neither of the two obvious answers works: Docker's embedded
 * resolver sits outside the tunnel's routes, and `--dns` is rejected together with
 * the container network mode the tunnel requires. Same rule as the other generated
 * files: an identical rewrite is skipped, so the file's modification time keeps
 * meaning "this changed"; the mount itself is live, so a changed resolver reaches
 * a running container on its next lookup.
 */
export function writeProjectResolvConf(
	agentDir: string,
	projectId: string,
	dns: string,
): { ok: true; path: string } | { ok: false; error: string } {
	const nameservers = parseNameservers(dns);
	if (nameservers.length === 0) return { ok: false, error: t("DNS 要填 IP 地址，多个用逗号分隔") };
	const body = `${nameservers.map((server) => `nameserver ${server}`).join("\n")}\n`;
	const path = projectResolvConfPath(agentDir, projectId);
	// 0644: the container reads it as any user, and it holds no credential — only the
	// address of the tunnel's resolver.
	writeIfChanged(path, body, 0o644);
	return { ok: true, path };
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
	writeIfChanged(path, built.config, 0o600);
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

/** The four files one project's OpenVPN sidecar mounts. */
export interface OpenVpnFiles {
	configPath: string;
	/** Present only when the profile carries a username. */
	authPath?: string;
	hookPath: string;
	pushedDnsPath: string;
}

/**
 * Write an OpenVPN profile's files, and clear the resolver file the hook writes.
 *
 * The pushed-resolver file is truncated on every call: what it holds has to describe
 * the connection being established now, and a value left over from the previous one
 * would be mounted as the project container's resolver.
 */
export function writeProjectOpenVpnFiles(
	agentDir: string,
	projectId: string,
	openvpn: SentinelOpenVpn,
): { ok: true; files: OpenVpnFiles; dns: string[] } | { ok: false; error: string } {
	const built = buildOpenVpnProfile(openvpn);
	if (built.error || !built.config) return { ok: false, error: built.error ?? t("配置生成失败") };
	const configPath = projectOpenVpnConfigPath(agentDir, projectId);
	const authPath = projectOpenVpnAuthPath(agentDir, projectId);
	const hookPath = projectOpenVpnHookPath(agentDir, projectId);
	const pushedDnsPath = projectOpenVpnPushedDnsPath(agentDir, projectId);
	// 0600: the configuration carries the private key, and the credentials file the
	// password. The hook and the pushed resolvers hold nothing secret.
	writeIfChanged(configPath, built.config, 0o600);
	if (built.credentials === undefined) rmSync(authPath, { force: true });
	else writeIfChanged(authPath, built.credentials, 0o600);
	writeIfChanged(hookPath, openVpnHookScript(openvpn.killSwitch), 0o600);
	mkdirSync(dirname(pushedDnsPath), { recursive: true });
	writeFileSync(pushedDnsPath, "", { mode: 0o600 });
	return {
		ok: true,
		dns: built.dns ?? [],
		files: {
			configPath,
			authPath: built.credentials === undefined ? undefined : authPath,
			hookPath,
			pushedDnsPath,
		},
	};
}

/**
 * The resolvers the sidecar's hook last saw the server push.
 *
 * Read after the tunnel is up, and only when the profile names none of its own: it is
 * what makes "paste the .ovpn and go" work for the common server that pushes its own
 * resolver, which the console cannot know before connecting.
 */
export function readPushedDns(path: string): string[] {
	try {
		const lines = readFileSync(path, "utf-8").split("\n");
		return parseNameservers(lines.map((line) => line.replace(/^nameserver\s+/i, "")).join(" "));
	} catch {
		return [];
	}
}

/**
 * The pushed resolvers, giving the hook a moment to write them.
 *
 * The interface exists a moment before `--route-up` runs, so a probe that says "the
 * tunnel is up" can still be a moment too early for the file. This is only paid when
 * the profile names no resolver of its own.
 */
export async function readPushedDnsWhenReady(path: string, timeoutMs = 2000): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = readPushedDns(path);
		if (found.length > 0 || Date.now() >= deadline) return found;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

/**
 * Start the OpenVPN sidecar.
 *
 * It runs the toolbox image, which carries `openvpn` and `iproute2`; the tunnel is a
 * real interface with real routes, which is the whole point of not making it a
 * sing-box outbound. `--cap-add NET_ADMIN` and the tun device node are what the
 * client needs to create it.
 */
export async function createOpenVpnContainer(
	containerName: string,
	files: OpenVpnFiles,
	image: string,
): Promise<{ ok: boolean; error?: string }> {
	const network = await ensureProxyNetwork();
	if (!network.ok) return { ok: false, error: network.error };
	const mount = (source: string, target: string, mode: string): string[] => ["-v", `${source}:${target}${mode}`];
	const result = await runDocker([
		"run",
		"-d",
		"--name",
		containerName,
		"--network",
		proxyNetworkName(),
		"--cap-add",
		"NET_ADMIN",
		...hostTunDevice(),
		...mount(files.configPath, `${OPENVPN_CLIENT_DIR}/${OPENVPN_CONFIG_FILE}`, ":ro"),
		...(files.authPath ? mount(files.authPath, `${OPENVPN_CLIENT_DIR}/${OPENVPN_AUTH_FILE}`, ":ro") : []),
		...mount(files.hookPath, `${OPENVPN_CLIENT_DIR}/${OPENVPN_HOOK_FILE}`, ":ro"),
		// Writable: the hook writes the pushed resolvers there and the console reads
		// them to build the project container's resolver file. Nothing else can reach
		// it — the job container shares the network namespace, not the file system.
		...mount(files.pushedDnsPath, `${OPENVPN_CLIENT_DIR}/${OPENVPN_PUSHED_DNS_FILE}`, ""),
		"--entrypoint",
		"sh",
		image,
		"-c",
		openVpnEntrypoint({ credentials: files.authPath !== undefined }),
	]);
	return result.code === 0 ? { ok: true } : { ok: false, error: result.stderr.trim() };
}

/** How long a tunnel that was just created or started gets to come up. */
const OPENVPN_TIMEOUT_MS = 60000;

/**
 * Lines that mean the client will never connect without a change.
 *
 * A configuration that cannot be used fails at startup and the process exits; a
 * remote that is unreachable or a handshake that is refused does not — the client
 * retries forever with the container still `running`, which is why readiness cannot
 * be decided from the log alone.
 */
const OPENVPN_FATAL_LINES = [
	"please correct this error",
	"exiting due to fatal error",
	"auth_failed",
	"cannot ioctl tunsetiff",
	"cannot open tun/tap dev",
	"openvpn: not found",
];

function openVpnFatalLine(lines: string[]): string | undefined {
	return lines.find((line) => OPENVPN_FATAL_LINES.some((fatal) => line.toLowerCase().includes(fatal)));
}

/**
 * The reason a tunnel did not come up, in the order an operator can act on it.
 *
 * A retrying client logs several kinds of line, and the last one is not the most
 * useful: `SIGUSR1[...] received, process restarting` follows the line that says why.
 * Each pattern is tried in turn, and the last line matching the first one that occurs
 * anywhere is the answer.
 */
const OPENVPN_REASONS = [
	/resolve:/i,
	/tls error/i,
	/auth_failed/i,
	/cannot (ioctl|open)/i,
	/options error/i,
	/warning/i,
	/error/i,
	/sigusr1/i,
];

function openVpnReason(lines: string[]): string | undefined {
	for (const pattern of OPENVPN_REASONS) {
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index] ?? "";
			if (pattern.test(line)) return line;
		}
	}
	return lines[lines.length - 1];
}

async function openVpnLogTail(containerName: string): Promise<string[]> {
	const logs = await runDocker(["logs", "--tail", "80", containerName], { timeoutMs: 20000 });
	return `${logs.stdout}\n${logs.stderr}`
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Whether the tunnel is up right now, asked of the interface rather than the log: the
 * ready line is printed again after every reconnect, so it says nothing about the
 * current state.
 *
 * A sidecar whose image has no `iproute2` cannot answer at all, and that deserves its
 * own answer: the tunnel may well be up while the kill switch silently did nothing.
 */
async function openVpnTunnelProbe(containerName: string): Promise<{ up: boolean; missingTools?: boolean }> {
	const probe = await runDocker(["exec", containerName, "ip", "-o", "addr", "show"], { timeoutMs: 15000 });
	if (probe.code !== 0) return { up: false, missingTools: /not found|executable file/i.test(probe.stderr) };
	return { up: /\btun\d*\b/.test(probe.stdout) };
}

/** The answer a sidecar missing `iproute2` gets, in both call paths. */
function missingTunnelTools(): string {
	return t("代理容器里没有 ip 命令（工具镜像缺少 iproute2），kill-switch 无法生效；请重建工具镜像");
}

/**
 * Wait for a fresh tunnel to come up, or report why it did not.
 *
 * The two failure shapes are checked separately: a process that exited is asked for
 * its log, and a process that keeps retrying is given the whole timeout before its
 * last line is reported.
 */
async function waitForOpenVpnTunnel(containerName: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const seconds = Math.round(OPENVPN_TIMEOUT_MS / 1000);
	const deadline = Date.now() + OPENVPN_TIMEOUT_MS;
	let detail = t("隧道没有在 {seconds} 秒内建立", { seconds });
	while (Date.now() < deadline) {
		const state = await runDocker(["inspect", "-f", "{{.State.Status}}", containerName], { timeoutMs: 15000 });
		const status = state.stdout.trim();
		const lines = await openVpnLogTail(containerName);
		const fatal = openVpnFatalLine(lines);
		if (fatal) return { ok: false, error: fatal };
		if (status === "exited" || status === "dead") {
			return { ok: false, error: openVpnReason(lines) ?? t("代理容器已退出") };
		}
		const probe = await openVpnTunnelProbe(containerName);
		if (probe.missingTools) return { ok: false, error: missingTunnelTools() };
		if (probe.up) return { ok: true };
		detail = openVpnReason(lines) ?? detail;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return { ok: false, error: detail };
}

/**
 * Start the OpenVPN sidecar if it is not running, creating it when it is gone, and
 * wait for the tunnel.
 *
 * Waiting is why this is not the WireGuard shape: an OpenVPN client that cannot
 * connect keeps retrying with the container up, and a project container created onto
 * that namespace looks healthy while nothing is proxied. A tunnel that was already up
 * when the call arrived is only probed, not waited for.
 */
export async function ensureOpenVpnRunning(
	containerName: string,
	files: OpenVpnFiles,
	image: string,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
	const state = await runDocker(["inspect", "-f", "{{.State.Running}}", containerName], { timeoutMs: 15000 });
	if (state.code !== 0) {
		if (!(await hasSingboxImage(image))) {
			return { ok: false, created: false, error: t("镜像 {image} 不存在", { image }) };
		}
		const created = await createOpenVpnContainer(containerName, files, image);
		if (!created.ok) return { ok: false, created: true, error: created.error };
		const up = await waitForOpenVpnTunnel(containerName);
		return up.ok ? { ok: true, created: true } : { ok: false, created: true, error: up.error };
	}
	if (state.stdout.trim() !== "true") {
		const start = await runDocker(["start", containerName], { timeoutMs: 60000 });
		if (start.code !== 0) return { ok: false, created: false, error: start.stderr.trim() };
		const up = await waitForOpenVpnTunnel(containerName);
		return up.ok ? { ok: true, created: false } : { ok: false, created: false, error: up.error };
	}
	// Already running: the tunnel either is up or is reconnecting. One probe keeps a
	// project from starting onto a namespace nothing is routing, without paying the
	// full timeout for a healthy tunnel.
	const probe = await openVpnTunnelProbe(containerName);
	if (probe.up) return { ok: true, created: false };
	if (probe.missingTools) return { ok: false, created: false, error: missingTunnelTools() };
	const lines = await openVpnLogTail(containerName);
	return {
		ok: false,
		created: false,
		error: t("代理容器里的隧道没有建立（可能正在重连）：{reason}", {
			reason: openVpnReason(lines) ?? t("没有可用日志"),
		}),
	};
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
