/**
 * The Droid plugin: device registry, token auth, and the reverse gateway.
 *
 * The gateway is tested with a fake device — a plain WebSocket client that speaks
 * the same frames DroidBridge will — against a real HTTP server whose upgrade
 * path is the gateway's. That exercises the whole server side: token auth at the
 * upgrade, handshake, command routing, streaming assembly, timeouts, and the
 * offline bookkeeping — everything except the phone itself.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createConnection, createServer as netCreateServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { DroidStore, droidDbPath } from "../src/droid.ts";
import { DroidGateway } from "../src/droid-gateway.ts";
import { DROID_MAX_FRAME_BYTES, DROID_PUSH_CHUNK_BYTES } from "../src/droid-protocol.ts";
import { openSqliteDatabase } from "../src/sqlite.ts";

let dir: string;
let store: DroidStore;
let gateway: DroidGateway;
let server: Server;
let baseUrl = "";
let changes = 0;

/** A fake DroidBridge: connects, says hello, answers commands. */
class FakeDevice {
	ws?: WebSocket;
	received: Array<Record<string, unknown>> = [];
	/** Payload chunks of an in-flight push, by request id. */
	private readonly pushes = new Map<string, Buffer[]>();

	readonly deviceId: string;
	private readonly token: string;
	/** Set false to model a frozen app: the socket stays open, nothing is answered. */
	autoReply: boolean;

	constructor(deviceId: string, token: string, autoReply = true) {
		this.deviceId = deviceId;
		this.token = token;
		this.autoReply = autoReply;
	}

	connect(url = baseUrl): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`${url}/ws/droid?token=${this.token}`);
			ws.on("open", () => {
				ws.send(
					JSON.stringify({
						t: "hello",
						token: this.token,
						deviceId: this.deviceId,
						model: "Pixel 7",
						androidVersion: "14",
						sdkInt: 34,
						rooted: true,
					}),
				);
			});
			ws.on("message", (raw) => {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				if (frame.t === "welcome") {
					resolve();
					return;
				}
				this.received.push(frame);
				if (this.autoReply && frame.t === "exec") {
					ws.send(
						JSON.stringify({ t: "result", reqId: frame.reqId, ok: true, code: 0, stdout: `ran:${frame.cmd}` }),
					);
				}
				// Chunked push, like DroidBridge: append per request, answer only on `done`.
				if (this.autoReply && frame.t === "push") {
					const reqId = String(frame.reqId);
					const chunks = this.pushes.get(reqId) ?? [];
					chunks.push(Buffer.from(String(frame.b64), "base64"));
					this.pushes.set(reqId, chunks);
					if (frame.done === true) {
						this.pushes.delete(reqId);
						const bytes = Buffer.concat(chunks);
						ws.send(
							JSON.stringify({
								t: "result",
								reqId,
								ok: true,
								code: 0,
								stdout: `写入 ${bytes.length} 字节`,
							}),
						);
					}
				}
			});
			ws.on("error", reject);
			this.ws = ws;
		});
	}

	send(frame: Record<string, unknown>): void {
		this.ws?.send(JSON.stringify(frame));
	}

	/** Tunnel plumbing: remember the device-side socket and close it with the WS. */
	private readonly tcp = new Map<string, import("node:net").Socket>();
	onTcp?: (socket: import("node:net").Socket, tunnelId: string, connId: string) => void;

	/** Called by the tunnel test to register its device-side socket for close tracking. */
	trackTcp(socket: import("node:net").Socket, tunnelId: string, connId: string): void {
		this.tcp.set(`${tunnelId}:${connId}`, socket);
	}

	close(): void {
		this.ws?.close();
	}
}

function tokenOf(label: string): string {
	return store.createToken(label).token;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-droid-"));
	store = new DroidStore(droidDbPath(dir));
	gateway = new DroidGateway(store, {
		onDeviceChange: () => {
			changes += 1;
		},
		log: () => {},
	});
	server = createServer();
	server.on("upgrade", (request, socket, head) => {
		gateway.handleUpgrade(request, socket, head);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	// Close the listeners and every device connection first: their close handlers
	// write "offline" back to the store, which must still be open.
	gateway.stopListener();
	for (const device of store.listDevices()) gateway.disconnect(device.id);
	server.close();
	await new Promise((resolve) => setTimeout(resolve, 50));
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("tokens: create, find, last-used, delete", () => {
	const created = store.createToken("测试机-一加");
	expect(created.token.startsWith("droid_")).toBe(true);
	expect(store.findToken(created.token)?.label).toBe("测试机-一加");
	store.touchToken(created.id);
	expect(store.findToken(created.token)?.lastUsedAt).not.toBeNull();
	// 删除 is the only way out: the row is gone, so the secret cannot authenticate.
	expect(store.deleteToken(created.id)).toBe(true);
	expect(store.findToken(created.token)).toBeUndefined();
	expect(store.listTokens().some((token) => token.id === created.id)).toBe(false);
	// Deleting twice is not an error, it just does nothing.
	expect(store.deleteToken(created.id)).toBe(false);
});

test("a token an older console only marked revoked is dropped when the registry opens", () => {
	// The previous semantic stamped `revoked_at`, and the page had no action for a
	// row in that state, so it stayed in the list forever. Opening the store must
	// clean it up, otherwise the operator keeps seeing a token that is already dead.
	const legacyPath = join(dir, "legacy-droids.db");
	const legacy = openSqliteDatabase(legacyPath);
	legacy.exec(`
		CREATE TABLE droid_tokens (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			token TEXT NOT NULL,
			created_at TEXT NOT NULL,
			revoked_at TEXT,
			last_used_at TEXT
		);
	`);
	legacy
		.prepare(
			"INSERT INTO droid_tokens (id, label, token, created_at, revoked_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)",
		)
		.run("legacy-1", "旧机", "droid_legacy", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
	legacy.close();

	const reopened = new DroidStore(legacyPath);
	expect(reopened.listTokens()).toEqual([]);
	expect(reopened.findToken("droid_legacy")).toBeUndefined();
	reopened.close();
});

test("a wrong or missing token is refused at the upgrade", async () => {
	const refused = await new Promise<string>((resolve) => {
		const ws = new WebSocket(`${baseUrl}/ws/droid?token=droid-wrong`);
		ws.on("error", (error: Error) => resolve(error.message));
	});
	expect(refused).toContain("401");
	// No device was registered by the refused attempt.
	expect(store.listDevices()).toEqual([]);
});

test("hello registers the device online; disconnect marks it offline", async () => {
	const token = tokenOf("联调机");
	const device = new FakeDevice("dvc-1", token);
	await device.connect();
	const stored = store.getDevice("dvc-1");
	expect(stored?.online).toBe(true);
	expect(stored?.model).toBe("Pixel 7");
	expect(stored?.rooted).toBe(true);
	expect(stored?.name).toBe("Pixel 7"); // defaults to the model
	expect(changes).toBeGreaterThan(0);

	// The operator's label survives a re-connect that refreshes the facts.
	store.renameDevice("dvc-1", "测试机");
	device.close();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(store.getDevice("dvc-1")?.online).toBe(false);
	expect(store.getDevice("dvc-1")?.name).toBe("测试机");
});

test("exec round-trips a command to the device and back", async () => {
	const token = tokenOf("exec机");
	const device = new FakeDevice("dvc-2", token);
	await device.connect();
	const result = await gateway.request("dvc-2", { t: "exec", cmd: "id", asRoot: false, timeoutMs: 5000 });
	expect(result.ok).toBe(true);
	expect(result.stdout).toBe("ran:id");
	expect(device.received.some((frame) => frame.t === "exec")).toBe(true);
	device.close();
});

test("a request to an offline device fails immediately, without touching the wire", async () => {
	const result = await gateway.request("dvc-missing", { t: "exec", cmd: "id", asRoot: false, timeoutMs: 1000 });
	expect(result.ok).toBe(false);
	expect(result.error).toBe("设备不在线");
});

test("a device that never answers times out and reports it", async () => {
	const token = tokenOf("沉默机");
	const device = new FakeDevice("dvc-3", token, false);
	await device.connect();
	// The frame's timeoutMs is the device-side budget; the gateway's own timer is
	// the third argument, and this test is about the gateway giving up.
	const result = await gateway.request(
		"dvc-3",
		{ t: "exec", cmd: "slow", asRoot: false, timeoutMs: 200 },
		{ timeoutMs: 200 },
	);
	expect(result.ok).toBe(false);
	expect(result.error).toContain("超时");
	device.close();
});

test("streamed payloads are assembled in order", async () => {
	const token = tokenOf("流机");
	const device = new FakeDevice("dvc-4", token, false);
	await device.connect();
	const pending = gateway.request(
		"dvc-4",
		{ t: "pull", path: "/data/local/tmp/x.pcap", maxBytes: 1 << 20 },
		{
			timeoutMs: 5000,
		},
	);
	// Chunks arrive in sequence (one WS guarantees order) and reassemble into bytes.
	const reqId = await findReqId(device);
	device.send({ t: "data", reqId, seq: 0, b64: Buffer.from("hello ").toString("base64"), done: false });
	device.send({ t: "data", reqId, seq: 1, b64: Buffer.from("world").toString("base64"), done: false });
	device.send({ t: "data", reqId, seq: 2, b64: "", done: true });
	device.send({ t: "result", reqId, ok: true });
	const result = await pending;
	expect(result.ok).toBe(true);
	expect(result.bytes?.toString()).toBe("hello world");
	device.close();
});

test("a device that breaks the chunk sequence fails the request instead of scrambling bytes", async () => {
	const token = tokenOf("乱序机");
	const device = new FakeDevice("dvc-5", token, false);
	await device.connect();
	const pending = gateway.request("dvc-5", { t: "pull", path: "/x", maxBytes: 1 << 20 }, { timeoutMs: 5000 });
	const reqId = await findReqId(device);
	device.send({ t: "data", reqId, seq: 7, b64: Buffer.from("x").toString("base64"), done: false });
	const result = await pending;
	expect(result.ok).toBe(false);
	expect(result.error).toContain("乱序");
	device.close();
});

test("onData streams a payload straight through instead of buffering a second copy", async () => {
	const token = tokenOf("流式机");
	const device = new FakeDevice("dvc-stream", token, false);
	await device.connect();
	const chunks: Buffer[] = [];
	const pending = gateway.request(
		"dvc-stream",
		{ t: "pull", path: "/data/local/tmp/big.apk", maxBytes: 1 << 20 },
		{ timeoutMs: 5000, onData: (chunk) => chunks.push(chunk) },
	);
	const reqId = await findReqId(device);
	device.send({ t: "data", reqId, seq: 0, b64: Buffer.from("part-1").toString("base64"), done: false });
	// The consumer sees the first chunk before the request is answered at all.
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(Buffer.concat(chunks).toString()).toBe("part-1");
	device.send({ t: "data", reqId, seq: 1, b64: Buffer.from("-part-2").toString("base64"), done: true });
	device.send({ t: "result", reqId, ok: true });
	const result = await pending;
	expect(result.ok).toBe(true);
	expect(Buffer.concat(chunks).toString()).toBe("part-1-part-2");
	// Nothing was kept in the gateway as well.
	expect(result.bytes?.length ?? 0).toBe(0);
	device.close();
});

test("a push streams in ordered chunks, and only the last frame is answered", async () => {
	const token = tokenOf("推送机");
	const device = new FakeDevice("dvc-push", token);
	await device.connect();
	// 5.5 MB crosses several 1 MB chunks; as one frame it would be ~7.3 MB of base64,
	// which is what used to make the phone materialize the whole file and die.
	const payload = Buffer.alloc(5_500_000);
	for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;

	const result = await gateway.pushFile("dvc-push", "/data/local/tmp/frida-server", payload, { mode: "0755" });
	expect(result.ok).toBe(true);
	expect(result.stdout).toBe(`写入 ${payload.length} 字节`);

	const frames = device.received.filter((frame) => frame.t === "push");
	expect(frames).toHaveLength(Math.ceil(payload.length / DROID_PUSH_CHUNK_BYTES));
	expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_frame, index) => index));
	// One request, one answer: only the last chunk is `done`.
	expect(frames.filter((frame) => frame.done === true)).toHaveLength(1);
	expect(frames.at(-1)?.done).toBe(true);
	expect(frames.every((frame) => frame.mode === "0755")).toBe(true);
	// Every frame stays inside the gateway's own limit, with room to spare.
	for (const frame of frames) {
		expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(DROID_MAX_FRAME_BYTES);
	}
	const reassembled = Buffer.concat(frames.map((frame) => Buffer.from(String(frame.b64), "base64")));
	expect(reassembled.equals(payload)).toBe(true);
	device.close();
});

test("an oversized single frame is refused instead of taking the device down", async () => {
	const token = tokenOf("巨帧机");
	const device = new FakeDevice("dvc-big", token);
	await device.connect();
	const result = await gateway.request("dvc-big", {
		t: "exec",
		cmd: "x".repeat(DROID_MAX_FRAME_BYTES + 1),
		asRoot: false,
		timeoutMs: 1000,
	});
	expect(result.ok).toBe(false);
	expect(result.error).toContain("超过");
	expect(device.received.some((frame) => frame.t === "exec")).toBe(false);
	device.close();
});

test("a disconnect fails every request still in flight for that device", async () => {
	const token = tokenOf("断线机");
	const device = new FakeDevice("dvc-6", token, false);
	await device.connect();
	const pending = gateway.request("dvc-6", { t: "exec", cmd: "sleep", asRoot: false, timeoutMs: 30_000 });
	device.close();
	const result = await pending;
	expect(result.ok).toBe(false);
	expect(result.error).toContain("断开");
});

test("a replaced connection takes over the same deviceId", async () => {
	const token = tokenOf("重连机");
	const first = new FakeDevice("dvc-7", token, false);
	await first.connect();
	const second = new FakeDevice("dvc-7", token, false);
	await second.connect();
	// The old socket was closed by the gateway; only the new one is online.
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(gateway.onlineDevices().filter((device) => device.id === "dvc-7")).toHaveLength(1);
	first.close();
	second.close();
});

/** The exec request id the fake device was asked about, once the frame arrives. */
async function findReqId(device: FakeDevice): Promise<string> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const frame = device.received.find((candidate) => typeof candidate.reqId === "string");
		if (frame) return frame.reqId as string;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("device received no request");
}

/** A gateway stub with one device always online: the tool layer needs no real socket. */
const stubRequests: Array<Record<string, unknown>> = [];
const stubGateway = {
	onlineDevices: () => [
		{
			id: "dvc-x",
			name: "测试机",
			model: "Pixel 7",
			androidVersion: "14",
			sdkInt: 34,
			rooted: true,
			online: true,
			tokenId: "t",
			firstSeen: "",
			lastSeen: "",
		},
	],
	isOnline: () => true,
	disconnect: () => {},
	request: async (_deviceId: string, req: Record<string, unknown>) => {
		stubRequests.push(req);
		return { ok: true, code: 0, stdout: "ran:id" };
	},
} as unknown as DroidGateway;

test("the droid tools refuse to run a device command the gate refuses", async () => {
	const { createDroidTools } = await import("../src/droid-tool.ts");
	const requested: string[] = [];
	const refused = createDroidTools({
		gateway: () => stubGateway,
		enabled: () => true,
		container: () => "unused",
		workDir: () => dir,
		guard: (deviceName, command) => {
			requested.push(`${deviceName}:${command}`);
			return Promise.reject(new Error("守门员拒绝：危险命令"));
		},
	});
	const shell = refused.find((tool) => tool.name === "droid_shell");
	if (!shell) throw new Error("droid_shell is not registered");
	const result = await (
		shell as unknown as { execute: (id: string, params: never) => Promise<{ isError?: boolean }> }
	).execute("call-1", { command: "rm -rf /data", asRoot: true } as never);
	expect(result.isError).toBe(true);
	expect(requested).toEqual(["测试机:rm -rf /data"]);
	// The refused command never reached the (stubbed) gateway as an exec request.
	expect(stubRequests).toEqual([]);
});

test("an approved device command runs through the gateway and carries the result", async () => {
	const { createDroidTools } = await import("../src/droid-tool.ts");
	const tools = createDroidTools({
		gateway: () => stubGateway,
		enabled: () => true,
		container: () => "unused",
		workDir: () => dir,
		guard: (deviceName, command) => {
			void deviceName;
			return Promise.resolve(command);
		},
	});
	const shell = tools.find((tool) => tool.name === "droid_shell");
	if (!shell) throw new Error("droid_shell is not registered");
	const result = await (
		shell as unknown as {
			execute: (id: string, params: never) => Promise<{ isError?: boolean; content?: { text?: string }[] }>;
		}
	).execute("call-2", { command: "id", asRoot: false } as never);
	expect(result.isError).toBeFalsy();
	expect(result.content?.[0]?.text).toContain("退出码 0");
	expect(stubRequests.some((frame) => frame.t === "exec")).toBe(true);
});

test("the running console refuses a device upgrade without a valid token", async () => {
	const { startSentinelServer } = await import("../src/server.ts");
	const tempRoot = mkdtempSync(join(tmpdir(), "sentinel-droid-server-"));
	let close: (() => void) | undefined;
	try {
		const started = await startSentinelServer({
			cwd: join(tempRoot, "workspace"),
			agentDir: join(tempRoot, "agent"),
			host: "127.0.0.1",
			port: 0,
			auth: false,
		});
		close = started.close;
		const message = await new Promise<string>((resolve) => {
			const ws = new WebSocket(started.url.replace("http", "ws").concat("/ws/droid?token=droid-nope"));
			ws.on("error", (error: Error) => resolve(error.message));
		});
		expect(message).toContain("401");
	} finally {
		close?.();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("the TCP tunnel bridges a loopback connection into the device port", async () => {
	// A stand-in for frida-server: an echo server on the "device" side of the test.
	const echo = netCreateServer((socket) => {
		socket.on("data", (chunk) => socket.write(chunk));
	});
	await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
	const devicePort = (echo.address() as AddressInfo).port;

	const token = tokenOf("隧道机");
	const device = new FakeDevice("dvc-8", token, false);
	await device.connect();

	// The fake device implements the tunnel the way DroidBridge does: dial on
	// tcp_open, pipe data both ways, close on tcp_close.
	const dialed = new Set<string>();
	const sockets = new Map<string, import("node:net").Socket>();
	device.ws?.on("message", (raw: WebSocket.RawData) => {
		const frame = JSON.parse(String(raw)) as Record<string, unknown>;
		if (frame.t === "tcp_open" && !dialed.has(frame.connId as string)) {
			dialed.add(frame.connId as string);
			const tunnelId = frame.tunnelId as string;
			const connId = frame.connId as string;
			const socket = createConnection({ host: "127.0.0.1", port: devicePort }, () => {
				device.send({ t: "tcp_opened", reqId: frame.reqId, tunnelId, connId, ok: true });
			});
			sockets.set(connId, socket);
			socket.on("data", (chunk: Buffer) => {
				device.send({ t: "tcp_data", tunnelId, connId, b64: chunk.toString("base64") });
			});
			socket.on("close", () => device.send({ t: "tcp_closed", tunnelId, connId }));
		}
		if (frame.t === "tcp_send") {
			sockets.get(frame.connId as string)?.write(Buffer.from(frame.b64 as string, "base64"));
		}
	});

	const tunnel = await gateway.openTunnel("dvc-8", "127.0.0.1", devicePort);
	expect(tunnel.ok).toBe(true);
	if (!tunnel.ok || !tunnel.port) return;

	// A client on the host (the container would use host.docker.internal) echoes
	// through the whole chain: TCP → WS → device socket → WS → TCP. The first
	// bytes are written before the device finishes dialing, which is exactly how
	// frida behaves — the gateway must buffer and flush them.
	const client = createConnection({ host: "127.0.0.1", port: tunnel.port });
	const echoed = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("echo timed out")), 5000);
		client.on("data", (chunk: Buffer) => {
			clearTimeout(timer);
			resolve(chunk.toString());
			client.destroy();
		});
		client.on("error", (error: Error) => {
			clearTimeout(timer);
			reject(error);
		});
		client.write("ping-frida");
	});
	expect(echoed).toBe("ping-frida");
	expect(gateway.listTunnels().some((entry) => entry.port === tunnel.port)).toBe(true);

	client.destroy();
	gateway.closeTunnel(tunnel.tunnelId as string);
	expect(gateway.listTunnels()).toHaveLength(0);
	echo.close();
	device.close();
});

test("the dedicated listener accepts a device handshake and rebinds on demand", async () => {
	// Bind on an ephemeral loopback port, exactly what the device page's 应用 does.
	const bound = await gateway.listen("127.0.0.1", 0);
	expect(bound.ok).toBe(true);
	if (!bound.ok || !bound.port) return;
	expect(gateway.listenInfo()?.host).toBe("127.0.0.1");

	// A device dialing the dedicated listener registers like on the shared path.
	const token = tokenOf("独立监听机");
	const handshake = await new Promise<void>((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${bound.port}/ws/droid?token=${token}`);
		ws.on("open", () => {
			ws.send(
				JSON.stringify({
					t: "hello",
					token,
					deviceId: "dvc-9",
					model: "OnePlus 12",
					androidVersion: "14",
					sdkInt: 34,
					rooted: true,
				}),
			);
		});
		ws.on("message", (raw) => {
			if (JSON.parse(String(raw)).t === "welcome") {
				resolve();
				ws.close();
			}
		});
		ws.on("error", reject);
	});
	expect(handshake).toBeUndefined();
	expect(store.getDevice("dvc-9")?.online).toBe(true);

	// Rebinding stops the old listener: new dials there are refused.
	const rebound = await gateway.listen("127.0.0.1", 0);
	expect(rebound.ok).toBe(true);
	const refused = await new Promise<string>((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${bound.port}/ws/droid?token=${token}`);
		ws.on("error", (error: Error) => resolve(error.message));
	});
	expect(refused).toContain("ECONNREFUSED");
	gateway.stopListener();
});

test("a device that stops answering fails its calls fast, and recovers on the next heartbeat", async () => {
	// Android and emulators can SIGSTOP the whole app process: the TCP connection
	// stays ESTABLISHED while no thread runs, so without a liveness check the
	// gateway reports 在线 and every call waits out its own timeout — one silent
	// black hole per attempt. A frozen device is modelled here by a socket that
	// simply stops replying.
	const strict = new DroidGateway(
		store,
		{ onDeviceChange: () => {}, log: () => {} },
		{ staleMs: 120, watchdogTickMs: 20 },
	);
	const strictServer = createServer();
	strictServer.on("upgrade", (request, socket, head) => {
		strict.handleUpgrade(request, socket, head);
	});
	await new Promise<void>((resolve) => strictServer.listen(0, "127.0.0.1", resolve));
	const strictUrl = `ws://127.0.0.1:${(strictServer.address() as AddressInfo).port}`;

	const token = tokenOf("冻结机");
	const device = new FakeDevice("dvc-frozen", token);
	await device.connect(strictUrl);
	expect(strict.onlineDevices()[0]?.stale).toBe(false);

	// A request already in flight when the freeze starts must come back with the
	// liveness error, long before its own 5s timeout.
	device.autoReply = false;
	const started = Date.now();
	const inflight = await strict.request("dvc-frozen", { t: "exec", cmd: "id", asRoot: false, timeoutMs: 5000 });
	expect(inflight.ok).toBe(false);
	expect(inflight.error).toContain("设备无响应");
	expect(Date.now() - started).toBeLessThan(1000);

	// The device stays listed — its socket is open — but marked unresponsive.
	const listed = strict.onlineDevices();
	expect(listed.length).toBe(1);
	expect(listed[0]?.stale).toBe(true);
	expect(listed[0]?.online).toBe(true);

	// A new call fails immediately and never reaches the wire.
	const received = device.received.length;
	const rejected = await strict.request("dvc-frozen", { t: "exec", cmd: "id", asRoot: false, timeoutMs: 5000 });
	expect(rejected.ok).toBe(false);
	expect(rejected.error).toContain("设备无响应");
	expect(device.received.length).toBe(received);

	// A heartbeat means the app is executing again (unfreezing resumes it on the
	// very same socket), so the device is usable without a reconnect.
	device.autoReply = true;
	device.send({ t: "hb" });
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(strict.onlineDevices()[0]?.stale).toBe(false);
	const recovered = await strict.request("dvc-frozen", { t: "exec", cmd: "id", asRoot: false, timeoutMs: 5000 });
	expect(recovered.ok).toBe(true);
	expect(recovered.stdout).toBe("ran:id");

	device.close();
	strict.stopListener();
	strictServer.close();
	await new Promise((resolve) => setTimeout(resolve, 50));
});
