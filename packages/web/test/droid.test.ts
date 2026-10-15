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

	readonly deviceId: string;
	private readonly token: string;
	private readonly autoReply: boolean;

	constructor(deviceId: string, token: string, autoReply = true) {
		this.deviceId = deviceId;
		this.token = token;
		this.autoReply = autoReply;
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`${baseUrl}/ws/droid?token=${this.token}`);
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
	dir = mkdtempSync(join(tmpdir(), "zg-droid-"));
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

test("tokens: create, find, last-used, revoke", () => {
	const created = store.createToken("测试机-一加");
	expect(created.token.startsWith("droid_")).toBe(true);
	expect(store.findToken(created.token)?.label).toBe("测试机-一加");
	store.touchToken(created.id);
	expect(store.findToken(created.token)?.lastUsedAt).not.toBeNull();
	expect(store.revokeToken(created.id)).toBe(true);
	expect(store.findToken(created.token)).toBeUndefined();
	// Revoking twice is not an error, it just does nothing.
	expect(store.revokeToken(created.id)).toBe(false);
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
	const result = await gateway.request("dvc-3", { t: "exec", cmd: "slow", asRoot: false, timeoutMs: 200 });
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
	const { startZGServer } = await import("../src/server.ts");
	const tempRoot = mkdtempSync(join(tmpdir(), "zg-droid-server-"));
	let close: (() => void) | undefined;
	try {
		const started = await startZGServer({
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
