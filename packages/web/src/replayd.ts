/**
 * replayd: the packet replay + headless render service that runs inside every
 * project container (source: MITM_Fuzz_Render/, a separate Go project).
 *
 * Why a per-container service instead of a console-side feature: sending a raw
 * packet byte-for-byte, and rendering the answer with a real browser that keeps
 * the target's cookies and sub-resources, only works from inside the container —
 * that is where the target is reachable, the cookies were captured, and the
 * captured traffic already lives.
 *
 * How the console talks to it: `docker exec` + `curl` inside the container. The
 * service stays bound to the container's loopback, so nothing is published and
 * neither network mode needs container flags:
 *
 *   - host mode shares the host netns, so a container loopback port is the host's;
 *     the console *could* dial it, but then it would have to know which of several
 *     containers owns the port.
 *   - bridge mode publishes nothing at all, so a direct dial is impossible without
 *     recreating containers with `-p`.
 *
 * The exec bridge costs a few tens of milliseconds per call and works in both
 * modes on an already existing container, which is the trade this file makes.
 *
 * The data directory lives under the project work dir (mounted at /work), so the
 * SQLite history, the rendered PNGs and the downloaded browser survive container
 * recreation and stay visible to the operator.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execInContainer } from "./docker.ts";
import { type ReplaydArch, readReplaydBinary, replaydArchFromUname, replaydBinaryHint } from "./replayd-binary.ts";

/** Binary path inside the container. Not under /work: it is tooling, not evidence. */
export const REPLAYD_BIN = "/opt/sentinel/replayd";

/** Data directory inside the container (host path: `<workDir>/.sentinel/replayd`). */
export const REPLAYD_DATA_DIR = "/work/.sentinel/replayd";

/** Log file inside the container, tailed into error messages when startup fails. */
const REPLAYD_LOG = `${REPLAYD_DATA_DIR}/replayd.log`;

/**
 * `pgrep -f` seen from the exec'd shell: the pattern text itself is part of that
 * shell's command line, so the first character is bracketed to keep pgrep from
 * matching its own invocation.
 */
const REPLAYD_PROC_PATTERN = `[r]eplayd -data-dir ${REPLAYD_DATA_DIR}`;

const MAX_PORT_CANDIDATES = 24;
const HEALTH_POLL_ATTEMPTS = 40;
const BINARY_PUSH_TIMEOUT_MS = 120_000;
const DEFAULT_FRESH_MS = 15_000;

export type ReplaydState = "running" | "stopped" | "binary_missing" | "unsupported" | "error";

export interface ReplaydStatus {
	state: ReplaydState;
	/** Console/API port inside the container. */
	port?: number;
	/** MITM proxy port inside the container. */
	proxyPort?: number;
	version?: string;
	arch?: ReplaydArch;
	/** Container path of the binary. */
	binary?: string;
	/** Host path the binary was pushed from, for diagnostics. */
	binarySource?: string;
	dataDir?: string;
	/** Set when the operator can open the UI directly (host network mode only). */
	uiUrl?: string;
	error?: string;
}

export interface EnsureReplaydOptions {
	signal?: AbortSignal;
	/** Skip the running-status cache and re-check the container. */
	force?: boolean;
	/** How long a cached "running" answer stays valid. */
	freshMs?: number;
	/** Do not start anything: only report what is there. */
	start?: boolean;
	/** Host network mode publishes the container loopback on the host, so a URL works. */
	hostNetwork?: boolean;
}

interface CacheEntry {
	status: ReplaydStatus;
	at: number;
}

interface Health {
	dataDir?: string;
	version?: string;
}

const statusCache = new Map<string, CacheEntry>();

/**
 * One ensure per container at a time. Flipping the switch and a status request can
 * arrive together, and without this both would push the 20 MB binary and start two
 * processes on two ports. A read-only probe never displaces a start that is already
 * running; a start does replace a probe, because the probe cannot produce what the
 * caller asked for.
 */
const inFlight = new Map<string, { promise: Promise<ReplaydStatus>; starts: boolean }>();

/** Drop cached status, e.g. after the container was stopped, removed or recreated. */
export function resetReplaydStatus(containerName?: string): void {
	if (containerName === undefined) statusCache.clear();
	else statusCache.delete(containerName);
}

/** Host-side data directory of a project's replayd (the same bytes as /work/.sentinel/replayd). */
export function replaydDataDirHost(workDir: string): string {
	return join(workDir, ".sentinel", "replayd");
}

/** The access token, read from the mounted data directory. Undefined before the first start. */
export function readReplaydToken(workDir: string): string | undefined {
	const path = join(replaydDataDirHost(workDir), "token");
	if (!existsSync(path)) return undefined;
	try {
		const token = readFileSync(path, "utf8").trim();
		return token === "" ? undefined : token;
	} catch {
		return undefined;
	}
}

/**
 * Ports for one container: derived from the container name so a status request
 * never has to discover anything, with retries for the case where the host or
 * another container in host network mode already owns the port.
 *
 * 7300-7899 keeps clear of the platform's own listeners and still sits inside the
 * 7000-8000 range replayd picks from when it is left to choose.
 */
export function replaydPorts(containerName: string, attempt = 0): { port: number; proxyPort: number } {
	let hash = 0x811c9dc5;
	for (let i = 0; i < containerName.length; i++) {
		hash ^= containerName.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const slot = (hash % 300) + attempt;
	return { port: 7300 + slot, proxyPort: 7600 + slot };
}

/** Trimmed value of a `KEY=value` line, or undefined when the line is absent. */
function markerValue(stdout: string, key: string): string | undefined {
	const prefix = `${key}=`;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
	}
	return undefined;
}

/** The first JSON object in the output, ignoring shell noise around it. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = source?.[key];
	return typeof value === "string" ? value : undefined;
}

/** A healthy replayd answer, if that is what the text holds. */
function healthOf(stdout: string): Health | undefined {
	const health = parseJsonObject(stdout);
	if (health === undefined || stringField(health, "status") !== "ok") return undefined;
	return { dataDir: stringField(health, "dataDir"), version: stringField(health, "version") };
}

interface InspectResult {
	arch?: ReplaydArch;
	machine: string;
	installedSha?: string;
	processAlive: boolean;
	/** Health of the container's derived port, so the first loop pass needs no second call. */
	health?: Health;
}

async function inspectContainer(containerName: string, port: number, signal?: AbortSignal): Promise<InspectResult> {
	const result = await execInContainer(
		containerName,
		`machine=$(uname -m); echo "MACHINE=$machine"; ` +
			`if [ -x ${REPLAYD_BIN} ]; then echo "SHA=$(sha256sum ${REPLAYD_BIN} | cut -d' ' -f1)"; else echo "SHA="; fi; ` +
			`if pgrep -f "${REPLAYD_PROC_PATTERN}" >/dev/null 2>&1; then echo "PROC=running"; else echo "PROC=stopped"; fi; ` +
			`curl -sS -m 2 http://127.0.0.1:${port}/api/health 2>/dev/null | head -c 4000`,
		[],
		{ signal, timeoutMs: 30_000 },
	);
	const machine = markerValue(result.stdout, "MACHINE") ?? "";
	const sha = markerValue(result.stdout, "SHA");
	return {
		machine,
		arch: replaydArchFromUname(machine),
		installedSha: sha === undefined || sha === "" ? undefined : sha,
		processAlive: markerValue(result.stdout, "PROC") === "running",
		health: healthOf(result.stdout),
	};
}

async function readHealth(containerName: string, port: number, signal?: AbortSignal): Promise<Health | undefined> {
	const result = await execInContainer(containerName, `curl -sS -m 3 http://127.0.0.1:${port}/api/health`, [], {
		signal,
		timeoutMs: 15_000,
	});
	if (result.code !== 0) return undefined;
	return healthOf(result.stdout);
}

/** Copy the binary in through stdin: `docker exec` needs no published path for this. */
async function pushBinary(
	containerName: string,
	bytes: Buffer,
	expectedSha: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
	const result = await execInContainer(
		containerName,
		`mkdir -p /opt/sentinel && cat > ${REPLAYD_BIN}.new && chmod 0755 ${REPLAYD_BIN}.new && ` +
			`mv -f ${REPLAYD_BIN}.new ${REPLAYD_BIN} && sha256sum ${REPLAYD_BIN} | cut -d' ' -f1`,
		[],
		{ stdin: bytes, signal, timeoutMs: BINARY_PUSH_TIMEOUT_MS },
	);
	if (result.code !== 0) return { ok: false, error: result.stderr.trim() || `docker exec 退出码 ${result.code}` };
	const actual = result.stdout.trim().split("\n").pop()?.trim();
	if (actual !== expectedSha) return { ok: false, error: `下发后校验不一致（容器内 ${actual ?? "空"}）` };
	return { ok: true };
}

async function stopStaleReplayd(containerName: string, signal?: AbortSignal): Promise<void> {
	// Only our own data directory: another project's container shares the host
	// loopback in host network mode and must keep running.
	await execInContainer(containerName, `pkill -f "${REPLAYD_PROC_PATTERN}" >/dev/null 2>&1 || true`, [], {
		signal,
		timeoutMs: 15_000,
	});
}

async function startReplayd(
	containerName: string,
	port: number,
	proxyPort: number,
	signal?: AbortSignal,
): Promise<{ ok: boolean; health?: Health; output: string }> {
	const script =
		`mkdir -p ${REPLAYD_DATA_DIR} && cd /work && ` +
		`nohup ${REPLAYD_BIN} -data-dir ${REPLAYD_DATA_DIR} -listen 127.0.0.1:${port} ` +
		`-proxy-listen 127.0.0.1:${proxyPort} -log-format json -quiet ` +
		`>> ${REPLAYD_LOG} 2>&1 </dev/null & ` +
		`i=0; while [ $i -lt ${HEALTH_POLL_ATTEMPTS} ]; do ` +
		`body=$(curl -sS -m 2 http://127.0.0.1:${port}/api/health 2>/dev/null) && { printf '%s' "$body"; exit 0; }; ` +
		`i=$((i+1)); sleep 0.25; done; ` +
		`echo "--- replayd 启动失败，日志末尾："; tail -n 20 ${REPLAYD_LOG} 2>/dev/null; exit 1`;
	const result = await execInContainer(containerName, script, [], { signal, timeoutMs: 60_000 });
	if (result.code !== 0) {
		return { ok: false, output: result.stdout.trim() || result.stderr.trim() || `docker exec 退出码 ${result.code}` };
	}
	return { ok: true, health: healthOf(result.stdout), output: result.stdout };
}

/**
 * Make sure the project's container runs replayd and return how to reach it.
 *
 * Idempotent and cheap enough to call before every tool call: a healthy service
 * short-circuits to a cached status, and only a missing or outdated binary, a dead
 * process, or a port that belongs to somebody else causes any writing.
 */
export function ensureReplayd(
	containerName: string,
	workDir: string,
	options: EnsureReplaydOptions = {},
): Promise<ReplaydStatus> {
	const starts = options.start !== false;
	const pending = inFlight.get(containerName);
	if (pending !== undefined && (!starts || pending.starts)) return pending.promise;
	const run = ensureReplaydOnce(containerName, workDir, options).finally(() => {
		// Only clear our own entry: a start may have replaced this probe already.
		if (inFlight.get(containerName)?.promise === run) inFlight.delete(containerName);
	});
	inFlight.set(containerName, { promise: run, starts });
	return run;
}

async function ensureReplaydOnce(
	containerName: string,
	workDir: string,
	options: EnsureReplaydOptions = {},
): Promise<ReplaydStatus> {
	const freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
	const cached = statusCache.get(containerName);
	if (!options.force && cached && cached.status.state === "running" && Date.now() - cached.at < freshMs) {
		return cached.status;
	}
	const remember = (status: ReplaydStatus): ReplaydStatus => {
		statusCache.set(containerName, { status, at: Date.now() });
		return status;
	};
	const decorate = (status: ReplaydStatus): ReplaydStatus => {
		if (!options.hostNetwork || status.port === undefined) return status;
		const token = readReplaydToken(workDir);
		const query = token === undefined ? "/" : `/?token=${encodeURIComponent(token)}`;
		return { ...status, uiUrl: `http://127.0.0.1:${status.port}${query}` };
	};
	const running = (
		port: number,
		proxyPort: number,
		health: Health,
		arch: ReplaydArch,
		source: string,
	): ReplaydStatus =>
		decorate({
			state: "running",
			port,
			proxyPort,
			version: health.version,
			arch,
			binary: REPLAYD_BIN,
			binarySource: source,
			dataDir: REPLAYD_DATA_DIR,
		});

	const probe = await inspectContainer(containerName, replaydPorts(containerName).port, options.signal);
	if (probe.arch === undefined) {
		return remember({
			state: "unsupported",
			error: `容器架构 ${probe.machine || "未知"} 没有对应的 replayd 二进制（只提供 linux/amd64 与 linux/arm64）`,
		});
	}
	const binary = readReplaydBinary(probe.arch);
	if (binary === undefined) {
		return remember({ state: "binary_missing", arch: probe.arch, error: replaydBinaryHint(probe.arch) });
	}
	const binaryMatches = probe.installedSha === binary.sha256;

	let lastError = "";
	let binaryReady = binaryMatches;
	// The derived port is tried first; the rest only matter when the host (or
	// another container in host network mode) already owns it.
	const attempts = options.start === false ? 1 : MAX_PORT_CANDIDATES;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const { port, proxyPort } = replaydPorts(containerName, attempt);
		const health = attempt === 0 ? probe.health : await readHealth(containerName, port, options.signal);
		if (health !== undefined && health.dataDir !== REPLAYD_DATA_DIR) {
			// Somebody else owns this port; leave that process alone.
			lastError = `端口 ${port} 已被其它 replayd 实例占用`;
			continue;
		}
		if (health !== undefined && (binaryReady || options.start === false)) {
			// Ours and current, or a read-only probe: reuse it rather than throwing
			// away its warm browser and its captured history.
			return remember(running(port, proxyPort, health, probe.arch, binary.path));
		}
		if (health === undefined && options.start === false) {
			return remember(
				decorate({
					state: "stopped",
					port,
					proxyPort,
					arch: probe.arch,
					binary: REPLAYD_BIN,
					binarySource: binary.path,
					dataDir: REPLAYD_DATA_DIR,
					error: probe.processAlive ? "replayd 进程存在但未响应健康检查" : undefined,
				}),
			);
		}
		// Either nothing is running, or the running instance predates the binary
		// this console ships (the two are built together, so that means a console
		// upgrade). Replace it: the version the operator sees is the version of the
		// console that pushed it.
		if (!binaryReady) {
			const pushed = await pushBinary(containerName, binary.bytes, binary.sha256, options.signal);
			if (!pushed.ok) {
				return remember({ state: "error", arch: probe.arch, error: `下发 replayd 二进制失败：${pushed.error}` });
			}
			binaryReady = true;
		}
		await stopStaleReplayd(containerName, options.signal);
		const started = await startReplayd(containerName, port, proxyPort, options.signal);
		if (!started.ok) {
			lastError = started.output;
			continue;
		}
		if (started.health === undefined) {
			lastError = "replayd 已启动但健康检查未通过";
			continue;
		}
		return remember(running(port, proxyPort, started.health, probe.arch, binary.path));
	}

	return remember({
		state: "error",
		arch: probe.arch,
		binary: REPLAYD_BIN,
		binarySource: binary.path,
		error: lastError || "replayd 未能启动",
	});
}

export type ReplaydApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ReplaydRequestOptions {
	container: string;
	port: number;
	method: "GET" | "POST" | "DELETE";
	path: string;
	body?: unknown;
	/** Client-side budget; the curl timeout is derived from it. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** Trailer curl writes after the body, so an API error still yields its envelope. */
const HTTP_STATUS_MARKER = "SENTINEL_HTTP=";

/**
 * One REST call against the container's replayd.
 *
 * The token is read inside the container from the mounted data directory, so it
 * never appears in `docker exec` argv and the console does not have to hold it.
 */
export async function replaydRequest<T>(options: ReplaydRequestOptions): Promise<ReplaydApiResult<T>> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const maxTimeSec = Math.max(5, Math.ceil(timeoutMs / 1000));
	const auth = `-H "Authorization: Bearer $(cat ${REPLAYD_DATA_DIR}/token)"`;
	const headers = options.body === undefined ? auth : `${auth} -H 'Content-Type: application/json'`;
	const payload = options.body === undefined ? "" : " --data-binary @-";
	const script =
		`curl -sS --max-time ${maxTimeSec} -X ${options.method} ${headers}${payload} ` +
		`-w '\\n${HTTP_STATUS_MARKER}%{http_code}' http://127.0.0.1:${options.port}${options.path}`;
	const stdin = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");
	const result = await execInContainer(options.container, script, [], {
		stdin,
		signal: options.signal,
		timeoutMs: timeoutMs + 10_000,
	});
	if (result.code !== 0) {
		return { ok: false, error: result.stderr.trim() || `docker exec 退出码 ${result.code}` };
	}
	const markerIndex = result.stdout.lastIndexOf(HTTP_STATUS_MARKER);
	const status =
		markerIndex < 0 ? 0 : Number.parseInt(result.stdout.slice(markerIndex + HTTP_STATUS_MARKER.length), 10);
	const payloadText = markerIndex < 0 ? result.stdout : result.stdout.slice(0, markerIndex);
	const parsed = parseJsonObject(payloadText);
	if (!Number.isFinite(status) || status < 200 || status >= 300) {
		const envelope = parsed?.error as Record<string, unknown> | undefined;
		const message = stringField(envelope, "message") ?? payloadText.trim().slice(0, 500);
		return { ok: false, error: `replayd ${status || "无响应"}${message === "" ? "" : `：${message}`}` };
	}
	if (parsed === undefined) {
		return { ok: false, error: `replayd 返回的不是 JSON：${payloadText.trim().slice(0, 300)}` };
	}
	return { ok: true, data: parsed as T };
}

/** PNG (or other artifact) bytes for an artifact id, for evidence and model images. */
export async function replaydArtifact(
	container: string,
	port: number,
	artifactId: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
	const script =
		`curl -sS -f --max-time 120 -H "Authorization: Bearer $(cat ${REPLAYD_DATA_DIR}/token)" ` +
		`http://127.0.0.1:${port}/api/artifacts/${artifactId}`;
	const result = await execInContainer(container, script, [], {
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? 130_000,
	});
	if (result.code !== 0) {
		return { ok: false, error: result.stderr.trim() || `docker exec 退出码 ${result.code}` };
	}
	if (result.stdoutBytes.length === 0) return { ok: false, error: "产物为空" };
	return { ok: true, bytes: result.stdoutBytes };
}
