/**
 * The curl bridge, exercised for real.
 *
 * These tests install the fake `docker` (which runs the exec'd script on the host
 * with `/work` rewritten to the project work directory) and point the container's
 * derived port at a real local HTTP server. That is what pins the parts a mocked
 * exec cannot: the quoting of `Authorization: Bearer $(cat ...)`, the stdin body
 * upload, the HTTP status trailer, and that PNG bytes survive the round trip
 * through `docker exec` stdout.
 *
 * Only the reuse path of `ensureReplayd` is covered here: on a development host
 * the container steps (sha256sum, starting a Linux binary) do not exist, and the
 * state machine itself is pinned in replayd.test.ts.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	ensureReplayd,
	replaydArtifact,
	replaydDataDirHost,
	replaydPorts,
	replaydRequest,
	resetReplaydStatus,
} from "../src/replayd.ts";
import { type FakeDocker, installFakeDocker } from "./fake-docker.ts";

let root = "";
let workDir = "";
let fake: FakeDocker | undefined;
let server: Server | undefined;
let previousReplaydDir: string | undefined;

const FAKE_BINARY = Buffer.from("fake-replayd-binary-for-live-tests");

interface SeenRequest {
	url: string;
	method: string;
	authorization?: string;
	body: string;
}

let seen: SeenRequest[] = [];

/** Start a server on a fixed port; undefined when that port is unavailable. */
async function listen(
	port: number,
	handler: (url: string, method: string) => { status: number; body: Buffer; type: string },
): Promise<Server | undefined> {
	const created = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const answer = handler(request.url ?? "/", request.method ?? "GET");
			seen.push({
				url: request.url ?? "/",
				method: request.method ?? "GET",
				authorization: request.headers.authorization,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			response.writeHead(answer.status, { "Content-Type": answer.type });
			response.end(answer.body);
		});
	});
	return new Promise((resolve) => {
		created.once("error", () => resolve(undefined));
		created.listen(port, "127.0.0.1", () => resolve(created));
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "replayd-live-"));
	workDir = join(root, "work");
	mkdirSync(workDir, { recursive: true });
	fake = installFakeDocker(root, workDir, join(root, "docker.log"));
	const dataDir = replaydDataDirHost(workDir);
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, "token"), "tok-live\n");
	// The container-side tooling the console relies on, faked so this test means the
	// same thing on every host: `sha256sum` reporting the hash of the binary we ship
	// (macOS has none), and that binary in SENTINEL_REPLAYD_DIR. Without both, a
	// healthy service looks like a console upgrade and gets replaced instead of
	// reused — that path is pinned in replayd.test.ts with a mocked exec.
	const arch = process.arch === "x64" ? "amd64" : "arm64";
	const binaryDir = join(root, "replayd-bin");
	mkdirSync(binaryDir, { recursive: true });
	writeFileSync(join(binaryDir, `replayd_linux_${arch}`), FAKE_BINARY);
	const sha = createHash("sha256").update(FAKE_BINARY).digest("hex");
	// The container already has our binary (the exec'd scripts see /opt/sentinel
	// redirected into the temp root), so a healthy service is "current".
	const installed = join(process.env.SENTINEL_FAKE_SENTINEL_DIR ?? join(root, "fake-opt-sentinel"), "replayd");
	mkdirSync(join(installed, ".."), { recursive: true });
	writeFileSync(installed, FAKE_BINARY);
	chmodSync(installed, 0o755);
	const sha256sum = join(fake.dir, "sha256sum");
	writeFileSync(sha256sum, `#!/bin/sh\nprintf '%s\\n' ${sha}\n`);
	chmodSync(sha256sum, 0o755);
	previousReplaydDir = process.env.SENTINEL_REPLAYD_DIR;
	process.env.SENTINEL_REPLAYD_DIR = binaryDir;
	seen = [];
	resetReplaydStatus();
});

afterEach(async () => {
	resetReplaydStatus();
	if (previousReplaydDir === undefined) delete process.env.SENTINEL_REPLAYD_DIR;
	else process.env.SENTINEL_REPLAYD_DIR = previousReplaydDir;
	fake?.restore();
	fake = undefined;
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
	}
	rmSync(root, { recursive: true, force: true });
});

test("a replay call reaches the container service with the token and the raw packet", async () => {
	const port = 7399;
	server = await listen(port, () => ({
		status: 200,
		body: Buffer.from('{"status":"done","flowId":"flw_live"}'),
		type: "application/json",
	}));
	if (!server) throw new Error(`测试端口 ${port} 被占用`);
	const raw = "POST /login HTTP/1.1\r\nHost: target.test\r\nContent-Length: 5\r\n\r\nadmin";
	const result = await replaydRequest<{ flowId: string }>({
		container: "sentinel-live",
		port,
		method: "POST",
		path: "/api/replay",
		body: { raw, save: true },
	});
	expect(result).toEqual({ ok: true, data: { status: "done", flowId: "flw_live" } });
	expect(seen).toHaveLength(1);
	expect(seen[0].method).toBe("POST");
	expect(seen[0].url).toBe("/api/replay");
	// The token came from the mounted data directory, read inside the container.
	expect(seen[0].authorization).toBe("Bearer tok-live");
	expect(JSON.parse(seen[0].body)).toEqual({ raw, save: true });
});

test("an API error envelope survives the status trailer", async () => {
	const port = 7398;
	server = await listen(port, () => ({
		status: 400,
		body: Buffer.from('{"error":{"code":"bad_request","message":"raw 不能为空（需要要发送的原始请求报文）"}}'),
		type: "application/json",
	}));
	if (!server) throw new Error(`测试端口 ${port} 被占用`);
	const result = await replaydRequest({
		container: "sentinel-live",
		port,
		method: "POST",
		path: "/api/capture",
		body: {},
	});
	expect(result.ok).toBe(false);
	expect(result.ok === false ? result.error : "").toContain("raw 不能为空");
});

test("PNG bytes are not mangled by the exec bridge", async () => {
	const port = 7397;
	// A PNG header plus bytes that would break a text-mode pipe (CRLF, 0x1a, 0xff).
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
		Buffer.from([0x1a, 0x0d, 0x0a, 0xff, 0xfe, 0x00, 0x7f]),
	]);
	server = await listen(port, () => ({ status: 200, body: png, type: "image/png" }));
	if (!server) throw new Error(`测试端口 ${port} 被占用`);
	const result = await replaydArtifact("sentinel-live", port, "art_live");
	expect(result.ok).toBe(true);
	expect(result.ok === true ? result.bytes.equals(png) : false).toBe(true);
	expect(seen[0].url).toBe("/api/artifacts/art_live");
});

test("a healthy service is reused, so no binary is pushed and nothing is started", async () => {
	const container = "sentinel-live-reuse";
	const port = replaydPorts(container).port;
	server = await listen(port, (url) =>
		url.startsWith("/api/health")
			? {
					status: 200,
					body: Buffer.from(
						JSON.stringify({ status: "ok", version: "0.1.0", dataDir: "/work/.sentinel/replayd" }),
					),
					type: "application/json",
				}
			: { status: 404, body: Buffer.from("{}"), type: "application/json" },
	);
	if (!server) throw new Error(`测试端口 ${port} 被占用`);
	const status = await ensureReplayd(container, workDir);
	expect(status.state).toBe("running");
	expect(status.port).toBe(port);
	expect(status.version).toBe("0.1.0");
});
