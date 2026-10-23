/**
 * Unit tests for the per-container replayd service (packet replay + headless render).
 *
 * `execInContainer` is mocked: what matters here is the contract — which script is
 * sent into the container, that the token is read inside it rather than passed
 * through argv, that a stale binary is replaced, that ports never get stolen from
 * another project, and how API errors surface. The real curl round trip is covered
 * in replayd-live.test.ts through the fake docker.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { execInContainer } = vi.hoisted(() => ({ execInContainer: vi.fn() }));
vi.mock("../src/docker.ts", () => ({ execInContainer, repoRoot: () => "/nonexistent-repo-root" }));

import {
	ensureReplayd,
	REPLAYD_BIN,
	REPLAYD_DATA_DIR,
	readReplaydToken,
	replaydArtifact,
	replaydDataDirHost,
	replaydPorts,
	replaydRequest,
	resetReplaydStatus,
} from "../src/replayd.ts";
import {
	readReplaydBinary,
	replaydArchFromUname,
	replaydArtifactName,
	replaydBinarySearchPaths,
} from "../src/replayd-binary.ts";

const FAKE_BINARY = Buffer.from("fake-replayd-binary-for-tests");
const FAKE_SHA = createHash("sha256").update(FAKE_BINARY).digest("hex");

let root = "";
let workDir = "";
let binaryDir = "";

function execResult(
	code: number,
	stdout = "",
	stderr = "",
): {
	code: number;
	stdout: string;
	stdoutBytes: Buffer;
	stderr: string;
} {
	return { code, stdout, stdoutBytes: Buffer.from(stdout, "binary"), stderr };
}

/** Health envelope as replayd answers it. */
function healthJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		status: "ok",
		version: "0.1.0",
		dataDir: REPLAYD_DATA_DIR,
		listen: "127.0.0.1:7300",
		...overrides,
	});
}

/** Stdout of the inspection script. */
function inspectOutput(options: {
	machine?: string;
	sha?: string;
	process?: "running" | "stopped";
	health?: string;
}): string {
	const lines = [
		`MACHINE=${options.machine ?? "x86_64"}`,
		`SHA=${options.sha ?? ""}`,
		`PROC=${options.process ?? "stopped"}`,
	];
	if (options.health !== undefined) lines.push(options.health);
	return `${lines.join("\n")}\n`;
}

/** Route the mocked exec by the script it was handed, recording every call. */
interface Route {
	script: string;
	stdin?: Buffer;
}

function execCalls(): Route[] {
	return execInContainer.mock.calls.map((call: unknown[]) => ({
		script: String(call[1]),
		stdin: (call[3] as { stdin?: Buffer } | undefined)?.stdin,
	}));
}

function findCall(fragment: string): Route | undefined {
	return execCalls().find((call) => call.script.includes(fragment));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "replayd-test-"));
	workDir = join(root, "work");
	binaryDir = join(root, "bin");
	mkdirSync(workDir, { recursive: true });
	mkdirSync(binaryDir, { recursive: true });
	writeFileSync(join(binaryDir, replaydArtifactName("amd64")), FAKE_BINARY);
	process.env.SENTINEL_REPLAYD_DIR = binaryDir;
	execInContainer.mockReset();
	resetReplaydStatus();
});

afterEach(() => {
	delete process.env.SENTINEL_REPLAYD_DIR;
	resetReplaydStatus();
	rmSync(root, { recursive: true, force: true });
});

test("replaydPorts is deterministic, in range, and spreads across containers", () => {
	const a = replaydPorts("sentinel-aaaaaaaaaaaa");
	expect(a).toEqual(replaydPorts("sentinel-aaaaaaaaaaaa"));
	expect(a.port).toBeGreaterThanOrEqual(7300);
	expect(a.port).toBeLessThan(7600);
	expect(a.proxyPort).toBe(a.port + 300);
	// A retry moves to the next candidate instead of reusing a taken port.
	expect(replaydPorts("sentinel-aaaaaaaaaaaa", 1).port).toBe(a.port + 1);
	const ports = new Set(
		["sentinel-1", "sentinel-2", "sentinel-3", "sentinel-4", "sentinel-5"].map((name) => replaydPorts(name).port),
	);
	expect(ports.size).toBeGreaterThan(1);
});

test("architecture mapping follows uname", () => {
	expect(replaydArchFromUname("x86_64")).toBe("amd64");
	expect(replaydArchFromUname("AMD64\n")).toBe("amd64");
	expect(replaydArchFromUname("aarch64")).toBe("arm64");
	expect(replaydArchFromUname("arm64")).toBe("arm64");
	expect(replaydArchFromUname("i686")).toBeUndefined();
	expect(replaydArchFromUname("")).toBeUndefined();
});

test("binary lookup prefers the operator override, then the checkout, then the release layout", () => {
	const paths = replaydBinarySearchPaths("amd64", {
		root: "/repo",
		execPath: "/opt/sentinel/sentinel-web",
		envDir: "/custom",
	});
	expect(paths.map((entry) => entry.path)).toEqual([
		"/custom/replayd_linux_amd64",
		"/repo/MITM_Fuzz_Render/dist/replayd_linux_amd64",
		"/opt/sentinel/replayd/replayd_linux_amd64",
	]);
	expect(paths.map((entry) => entry.source)).toEqual(["env", "checkout", "release"]);
});

test("binary lookup skips missing paths and reports the hash of what it found", () => {
	expect(
		readReplaydBinary("amd64", { envDir: binaryDir, root: "/nonexistent", execPath: "/nonexistent" }),
	).toMatchObject({
		source: "env",
		sha256: FAKE_SHA,
	});
	expect(
		readReplaydBinary("arm64", { envDir: binaryDir, root: "/nonexistent", execPath: "/nonexistent" }),
	).toBeUndefined();
	// An empty file is not a usable binary.
	writeFileSync(join(binaryDir, replaydArtifactName("arm64")), "");
	expect(
		readReplaydBinary("arm64", { envDir: binaryDir, root: "/nonexistent", execPath: "/nonexistent" }),
	).toBeUndefined();
});

test("the token is read from the mounted data directory of the project", () => {
	expect(readReplaydToken(workDir)).toBeUndefined();
	const dataDir = replaydDataDirHost(workDir);
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, "token"), "  abc123  \n");
	expect(readReplaydToken(workDir)).toBe("abc123");
});

test("a healthy instance is reused without touching the binary or the process", async () => {
	execInContainer.mockResolvedValueOnce(
		execResult(0, inspectOutput({ machine: "x86_64", sha: FAKE_SHA, process: "running", health: healthJson() })),
	);
	const status = await ensureReplayd("sentinel-abc", workDir);
	expect(status.state).toBe("running");
	expect(status.version).toBe("0.1.0");
	expect(status.port).toBe(replaydPorts("sentinel-abc").port);
	expect(status.proxyPort).toBe(replaydPorts("sentinel-abc").proxyPort);
	expect(status.binarySource).toBe(join(binaryDir, replaydArtifactName("amd64")));
	// One inspection call: no push, no kill, no start.
	expect(execInContainer).toHaveBeenCalledTimes(1);
});

test("a running status is cached, and force re-checks the container", async () => {
	execInContainer.mockResolvedValue(
		execResult(0, inspectOutput({ sha: FAKE_SHA, process: "running", health: healthJson() })),
	);
	await ensureReplayd("sentinel-cache", workDir);
	await ensureReplayd("sentinel-cache", workDir);
	expect(execInContainer).toHaveBeenCalledTimes(1);
	await ensureReplayd("sentinel-cache", workDir, { force: true });
	expect(execInContainer).toHaveBeenCalledTimes(2);
});

test("an unsupported container architecture is reported, not guessed", async () => {
	execInContainer.mockResolvedValueOnce(execResult(0, inspectOutput({ machine: "i686" })));
	const status = await ensureReplayd("sentinel-32bit", workDir);
	expect(status.state).toBe("unsupported");
	expect(status.error).toContain("i686");
	expect(execInContainer).toHaveBeenCalledTimes(1);
});

test("a missing binary stops before touching the container", async () => {
	// The checkout fallback is stubbed to a path that cannot exist, so the only
	// candidate left is the operator override, which is empty for arm64 here.
	execInContainer.mockResolvedValueOnce(execResult(0, inspectOutput({ machine: "aarch64" })));
	const status = await ensureReplayd("sentinel-nobinary", workDir);
	expect(status.state).toBe("binary_missing");
	expect(status.arch).toBe("arm64");
	expect(status.error).toContain("make dist");
	expect(execInContainer).toHaveBeenCalledTimes(1);
});

test("a stale binary is pushed through stdin, then the service starts", async () => {
	const port = replaydPorts("sentinel-stale").port;
	execInContainer
		.mockResolvedValueOnce(execResult(0, inspectOutput({ sha: "deadbeef", process: "stopped" })))
		.mockResolvedValueOnce(execResult(0, `${FAKE_SHA}\n`))
		.mockResolvedValueOnce(execResult(0, ""))
		.mockResolvedValueOnce(execResult(0, healthJson()));

	const status = await ensureReplayd("sentinel-stale", workDir);
	expect(status.state).toBe("running");

	const push = findCall(`cat > ${REPLAYD_BIN}.new`);
	expect(push?.stdin?.equals(FAKE_BINARY)).toBe(true);
	expect(push?.script).toContain(`chmod 0755 ${REPLAYD_BIN}.new`);
	// The stale process is killed by data directory, never by name alone.
	const kill = findCall("pkill -f");
	expect(kill?.script).toContain(`[r]eplayd -data-dir ${REPLAYD_DATA_DIR}`);
	const start = findCall("nohup");
	expect(start?.script).toContain(`-listen 127.0.0.1:${port}`);
	expect(start?.script).toContain(`-proxy-listen 127.0.0.1:${port + 300}`);
	expect(start?.script).toContain(`-data-dir ${REPLAYD_DATA_DIR}`);
	expect(start?.script).toContain("</dev/null &");
});

test("concurrent ensures share one attempt instead of pushing the binary twice", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	execInContainer.mockImplementationOnce(async () => {
		await gate;
		return execResult(0, inspectOutput({ sha: FAKE_SHA, health: healthJson() }));
	});
	const first = ensureReplayd("sentinel-race", workDir);
	const second = ensureReplayd("sentinel-race", workDir);
	release?.();
	const [a, b] = await Promise.all([first, second]);
	expect(a.state).toBe("running");
	expect(b).toEqual(a);
	expect(execInContainer).toHaveBeenCalledTimes(1);
});

test("a start is not swallowed by a read-only probe already in flight", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	execInContainer
		.mockImplementationOnce(async () => {
			await gate;
			return execResult(0, inspectOutput({ sha: FAKE_SHA }));
		})
		.mockResolvedValueOnce(execResult(0, inspectOutput({ sha: FAKE_SHA, health: healthJson() })));
	const probe = ensureReplayd("sentinel-probe", workDir, { start: false });
	const start = ensureReplayd("sentinel-probe", workDir);
	release?.();
	const [probeResult, startResult] = await Promise.all([probe, start]);
	expect(probeResult.state).toBe("stopped");
	expect(startResult.state).toBe("running");
	expect(execInContainer).toHaveBeenCalledTimes(2);
});

test("a healthy service running an older binary is replaced, not reused", async () => {
	// The console and the service are built together, so a hash mismatch means the
	// console was upgraded: reusing the running process would keep the old one alive
	// until the container is recreated.
	execInContainer
		.mockResolvedValueOnce(
			execResult(0, inspectOutput({ sha: "older-build", process: "running", health: healthJson() })),
		)
		.mockResolvedValueOnce(execResult(0, `${FAKE_SHA}\n`))
		.mockResolvedValueOnce(execResult(0, ""))
		.mockResolvedValueOnce(execResult(0, healthJson({ version: "1.1.0" })));
	const status = await ensureReplayd("sentinel-upgrade", workDir);
	expect(status.state).toBe("running");
	expect(status.version).toBe("1.1.0");
	expect(findCall(`cat > ${REPLAYD_BIN}.new`)?.stdin?.equals(FAKE_BINARY)).toBe(true);
	expect(findCall("pkill -f")).toBeDefined();
	expect(findCall("nohup")).toBeDefined();
});

test("a read-only probe never replaces a healthy older binary", async () => {
	execInContainer.mockResolvedValueOnce(
		execResult(0, inspectOutput({ sha: "older-build", process: "running", health: healthJson() })),
	);
	const status = await ensureReplayd("sentinel-upgrade-probe", workDir, { start: false });
	expect(status.state).toBe("running");
	expect(findCall(`cat > ${REPLAYD_BIN}.new`)).toBeUndefined();
	expect(findCall("nohup")).toBeUndefined();
});

test("an up-to-date binary is not re-sent when the process is simply down", async () => {
	execInContainer
		.mockResolvedValueOnce(execResult(0, inspectOutput({ sha: FAKE_SHA, process: "stopped" })))
		.mockResolvedValueOnce(execResult(0, ""))
		.mockResolvedValueOnce(execResult(0, healthJson()));
	const status = await ensureReplayd("sentinel-restart", workDir);
	expect(status.state).toBe("running");
	expect(findCall(`cat > ${REPLAYD_BIN}.new`)).toBeUndefined();
	expect(findCall("nohup")).toBeDefined();
});

test("a port owned by another replayd is skipped, not stolen", async () => {
	const first = replaydPorts("sentinel-conflict").port;
	execInContainer
		// The derived port answers, but for a different data directory.
		.mockResolvedValueOnce(
			execResult(0, inspectOutput({ sha: FAKE_SHA, health: healthJson({ dataDir: "/work/other" }) })),
		)
		// The next candidate is free, so it becomes ours.
		.mockResolvedValueOnce(execResult(1, ""))
		.mockResolvedValueOnce(execResult(0, ""))
		.mockResolvedValueOnce(execResult(0, healthJson({ dataDir: "/work/other" })))
		.mockResolvedValueOnce(execResult(0, healthJson()));
	const status = await ensureReplayd("sentinel-conflict", workDir);
	expect(status.state).toBe("running");
	expect(status.port).toBe(first + 1);
	expect(findCall(`-listen 127.0.0.1:${first + 1}`)).toBeDefined();
});

test("start:false reports the state without starting anything", async () => {
	execInContainer.mockResolvedValueOnce(execResult(0, inspectOutput({ sha: FAKE_SHA, process: "stopped" })));
	const status = await ensureReplayd("sentinel-statusonly", workDir, { start: false });
	expect(status.state).toBe("stopped");
	expect(status.port).toBe(replaydPorts("sentinel-statusonly").port);
	expect(findCall("nohup")).toBeUndefined();
});

test("a failed start surfaces the log tail", async () => {
	execInContainer
		.mockResolvedValueOnce(execResult(0, inspectOutput({ sha: FAKE_SHA })))
		.mockResolvedValueOnce(execResult(0, ""))
		.mockResolvedValue(execResult(1, "--- replayd 启动失败，日志末尾：\nlevel=ERROR msg=端口被占用"));
	const status = await ensureReplayd("sentinel-fail", workDir);
	expect(status.state).toBe("error");
	expect(status.error).toContain("端口被占用");
});

test("a failed binary push is reported with its reason", async () => {
	execInContainer
		.mockResolvedValueOnce(execResult(0, inspectOutput({ sha: "stale" })))
		.mockResolvedValueOnce(execResult(1, "", "no space left on device"));
	const status = await ensureReplayd("sentinel-pushfail", workDir);
	expect(status.state).toBe("error");
	expect(status.error).toContain("no space left on device");
});

test("the UI address is offered only for host network mode and carries the token", async () => {
	const dataDir = replaydDataDirHost(workDir);
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, "token"), "tok-123\n");
	execInContainer.mockResolvedValueOnce(execResult(0, inspectOutput({ sha: FAKE_SHA, health: healthJson() })));
	const bridged = await ensureReplayd("sentinel-url", workDir, { force: true });
	expect(bridged.uiUrl).toBeUndefined();
	resetReplaydStatus();
	execInContainer.mockResolvedValueOnce(execResult(0, inspectOutput({ sha: FAKE_SHA, health: healthJson() })));
	const hosted = await ensureReplayd("sentinel-url", workDir, { force: true, hostNetwork: true });
	expect(hosted.uiUrl).toBe(`http://127.0.0.1:${hosted.port}/?token=tok-123`);
});

test("replaydRequest posts JSON and reads the token inside the container", async () => {
	execInContainer.mockResolvedValueOnce(execResult(0, '{"status":"done","flowId":"flw_1"}\nSENTINEL_HTTP=200'));
	const result = await replaydRequest<{ status: string; flowId: string }>({
		container: "sentinel-api",
		port: 7311,
		method: "POST",
		path: "/api/replay",
		body: { raw: "GET / HTTP/1.1\r\nHost: x\r\n\r\n" },
	});
	expect(result).toEqual({ ok: true, data: { status: "done", flowId: "flw_1" } });
	const call = execCalls()[0];
	expect(call.script).toContain(`Authorization: Bearer $(cat ${REPLAYD_DATA_DIR}/token)`);
	expect(call.script).toContain("http://127.0.0.1:7311/api/replay");
	expect(call.script).not.toContain("raw"); // the packet travels on stdin, not in argv
	expect(JSON.parse(call.stdin?.toString("utf8") ?? "")).toEqual({ raw: "GET / HTTP/1.1\r\nHost: x\r\n\r\n" });
});

test("replaydRequest reports API errors with their message", async () => {
	execInContainer.mockResolvedValueOnce(
		execResult(0, '{"error":{"code":"bad_request","message":"raw 不能为空"}}\nSENTINEL_HTTP=400'),
	);
	const result = await replaydRequest({ container: "c", port: 7311, method: "POST", path: "/api/capture", body: {} });
	expect(result.ok).toBe(false);
	expect(result.ok === false ? result.error : "").toContain("raw 不能为空");
});

test("replaydRequest rejects a docker failure and a non-JSON answer", async () => {
	execInContainer.mockResolvedValueOnce(execResult(1, "", "Error: No such container: sentinel-gone"));
	const failed = await replaydRequest({ container: "sentinel-gone", port: 7311, method: "GET", path: "/api/health" });
	expect(failed.ok).toBe(false);
	expect(failed.ok === false ? failed.error : "").toContain("No such container");

	execInContainer.mockReset();
	execInContainer.mockResolvedValueOnce(execResult(0, "boom\nSENTINEL_HTTP=200"));
	const garbage = await replaydRequest({ container: "c", port: 7311, method: "GET", path: "/api/render/status" });
	expect(garbage.ok).toBe(false);
	expect(garbage.ok === false ? garbage.error : "").toContain("不是 JSON");
});

test("artifact bytes come back unmodified", async () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
	execInContainer.mockResolvedValueOnce({
		code: 0,
		stdout: png.toString("binary"),
		stdoutBytes: png,
		stderr: "",
	});
	const result = await replaydArtifact("sentinel-art", 7311, "art_01J");
	expect(result.ok).toBe(true);
	expect(result.ok === true ? result.bytes.equals(png) : false).toBe(true);
	expect(execCalls()[0].script).toContain("/api/artifacts/art_01J");
});

test("artifact fetch reports an empty body instead of a zero-byte image", async () => {
	execInContainer.mockResolvedValueOnce(execResult(0, ""));
	const result = await replaydArtifact("sentinel-art", 7311, "art_empty");
	expect(result.ok).toBe(false);
});
