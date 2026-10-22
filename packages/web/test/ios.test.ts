/**
 * The iOS gateway: token auth, handshake, request/response, chunked payloads,
 * the TCP tunnel, and the liveness rules — all against a fake SentinelBridge.
 *
 * The fake device is a plain WebSocket client speaking the documented frames,
 * so these tests exercise the server side end to end: the upgrade, the
 * handshake, the routing, stream assembly (including a reordered stream), push
 * chunking, timeouts, replacement, and freeze detection. No phone required.
 */

import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { DEVICE_MAX_FRAME_BYTES, DEVICE_PUSH_CHUNK_BYTES } from "../src/device-transport.ts";
import { IosStore, iosDbPath } from "../src/ios.ts";
import { IosGateway } from "../src/ios-gateway.ts";
import { IOS_PROTOCOL_VERSION } from "../src/ios-protocol.ts";
import { FakeIos, type FakeIosOptions, wsUrlOf } from "./fake-ios.ts";

let dir: string;
let store: IosStore;
let gateway: IosGateway;
let server: Server;
let baseUrl = "";
let changes = 0;
const devices: FakeIos[] = [];

function tokenOf(label: string): string {
	return store.createToken(label).token;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function device(deviceId: string, token: string, options: FakeIosOptions = {}): Promise<FakeIos> {
	const fake = new FakeIos(deviceId, token, options);
	await fake.connect(baseUrl);
	devices.push(fake);
	return fake;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-ios-"));
	store = new IosStore(iosDbPath(dir));
	gateway = new IosGateway(store, {
		onDeviceChange: () => {
			changes += 1;
		},
		log: () => {},
	});
	server = createHttpServer();
	server.on("upgrade", (request, socket, head) => {
		gateway.handleUpgrade(request, socket, head);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = wsUrlOf(server);
});

afterEach(async () => {
	for (const fake of devices.splice(0)) fake.close();
	await new Promise((resolve) => setTimeout(resolve, 30));
});

afterAll(async () => {
	gateway.close();
	server.close();
	await new Promise((resolve) => setTimeout(resolve, 50));
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("tokens: create, find, last-used, delete", () => {
	const created = store.createToken("测试机-iPhone");
	expect(created.token.startsWith("ios_")).toBe(true);
	expect(store.findToken(created.token)?.label).toBe("测试机-iPhone");
	store.touchToken(created.id);
	expect(store.findToken(created.token)?.lastUsedAt).not.toBeNull();
	expect(store.deleteToken(created.id)).toBe(true);
	expect(store.findToken(created.token)).toBeUndefined();
	// Deleting twice is not an error, it just does nothing.
	expect(store.deleteToken(created.id)).toBe(false);
});

test("pairing codes are six digits, one-time, and map to a token", () => {
	const created = store.createPairing("配对机");
	expect(created.pairing.code).toMatch(/^\d{6}$/);
	expect(store.activePairing()?.code).toBe(created.pairing.code);
	const claimed = store.claimPairing(created.pairing.code);
	expect(claimed?.token).toBe(created.token.token);
	// A claimed code cannot be replayed, and the console stops showing it.
	expect(store.claimPairing(created.pairing.code)).toBeNull();
	expect(store.activePairing()).toBeNull();
});

test("an expired pairing code is refused", async () => {
	const created = store.createPairing("过期机", 5);
	await new Promise((resolve) => setTimeout(resolve, 15));
	expect(store.claimPairing(created.pairing.code)).toBeNull();
});

test("deleting a token also drops its pending pairing code", () => {
	const created = store.createPairing("删令牌机");
	expect(store.deleteToken(created.token.id)).toBe(true);
	expect(store.claimPairing(created.pairing.code)).toBeNull();
});

test("an unknown token is refused at the upgrade", async () => {
	const fake = new FakeIos("dvc-bad", "ios_not_a_real_token");
	await expect(fake.connect(baseUrl)).rejects.toThrow();
	expect(store.getDevice("dvc-bad")).toBeUndefined();
});

test("hello registers the device with its jailbreak form and arch", async () => {
	const token = tokenOf("越狱机");
	const fake = await device("dvc-hello", token, { jailbreakForm: "rootless", arch: "arm64e" });
	const registered = store.getDevice("dvc-hello");
	expect(registered?.model).toBe("iPhone15,2");
	expect(registered?.osVersion).toBe("16.6.1");
	expect(registered?.arch).toBe("arm64e");
	expect(registered?.jailbreakForm).toBe("rootless");
	expect(registered?.jailbreakName).toBe("Dopamine");
	expect(registered?.hasRoot).toBe(true);
	expect(registered?.online).toBe(true);

	const online = gateway.onlineDevices();
	expect(online).toHaveLength(1);
	expect(online[0]?.stale).toBe(false);
	expect(gateway.isOnline("dvc-hello")).toBe(true);
	expect(changes).toBeGreaterThan(0);

	fake.close();
	await waitFor(() => store.getDevice("dvc-hello")?.online === false);
	expect(gateway.isOnline("dvc-hello")).toBe(false);
});

test("exec round trip returns the device's result", async () => {
	const token = tokenOf("命令机");
	await device("dvc-exec", token);
	const result = await gateway.request("dvc-exec", { t: "exec", cmd: "id", asRoot: true, timeoutMs: 5000 });
	expect(result.ok).toBe(true);
	expect(result.code).toBe(0);
	expect(result.stdout).toBe("ran:id");
});

test("a request to an offline device fails immediately", async () => {
	const result = await gateway.request("dvc-absent", { t: "exec", cmd: "id", asRoot: false, timeoutMs: 5000 });
	expect(result.ok).toBe(false);
	expect(result.error).toContain("不在线");
});

test("a device that never answers times out", async () => {
	const token = tokenOf("静默机");
	await device("dvc-silent", token, { autoReply: false });
	// The request's own timeoutMs is the device-side budget; the gateway budget
	// is the third argument. They are separate on purpose.
	const result = await gateway.request(
		"dvc-silent",
		{ t: "exec", cmd: "id", asRoot: false, timeoutMs: 5000 },
		{ timeoutMs: 80 },
	);
	expect(result.ok).toBe(false);
	expect(result.error).toContain("超时");
});

test("chunked data is assembled in sequence order", async () => {
	const token = tokenOf("拉文件机");
	const fake = await device("dvc-pull", token, { autoReply: false });
	const pending = gateway.request("dvc-pull", { t: "pull", path: "/tmp/a", maxBytes: 1024 }, { timeoutMs: 5000 });
	await waitFor(() => fake.lastRequest("pull") !== undefined);
	const reqId = String(fake.lastRequest("pull")?.reqId);
	fake.send({ t: "data", reqId, seq: 0, b64: Buffer.from("he").toString("base64"), done: false });
	fake.send({ t: "data", reqId, seq: 1, b64: Buffer.from("llo").toString("base64"), done: true });
	fake.send({ t: "result", reqId, ok: true, code: 0 });
	const result = await pending;
	expect(result.ok).toBe(true);
	expect(result.bytes?.toString()).toBe("hello");
});

test("a reordered stream fails instead of producing a corrupt file", async () => {
	const token = tokenOf("乱序机");
	const fake = await device("dvc-order", token, { autoReply: false });
	const pending = gateway.request("dvc-order", { t: "pull", path: "/tmp/a", maxBytes: 1024 }, { timeoutMs: 5000 });
	await waitFor(() => fake.lastRequest("pull") !== undefined);
	const reqId = String(fake.lastRequest("pull")?.reqId);
	// seq 1 before seq 0: the gateway must refuse rather than concatenate.
	fake.send({ t: "data", reqId, seq: 1, b64: Buffer.from("ll").toString("base64"), done: false });
	const result = await pending;
	expect(result.ok).toBe(false);
	expect(result.error).toContain("乱序");
	// The late frames cannot resurrect the request.
	fake.send({ t: "data", reqId, seq: 0, b64: Buffer.from("he").toString("base64"), done: true });
	fake.send({ t: "result", reqId, ok: true });
});

test("onData streams chunks to the caller instead of buffering them", async () => {
	const token = tokenOf("流式机");
	const fake = await device("dvc-stream", token, { autoReply: false });
	const chunks: Buffer[] = [];
	const pending = gateway.request(
		"dvc-stream",
		{ t: "pull", path: "/tmp/big", maxBytes: 10 * 1024 * 1024 },
		{ timeoutMs: 5000, onData: (chunk) => chunks.push(chunk) },
	);
	await waitFor(() => fake.lastRequest("pull") !== undefined);
	const reqId = String(fake.lastRequest("pull")?.reqId);
	fake.send({ t: "data", reqId, seq: 0, b64: Buffer.from("aa").toString("base64"), done: false });
	fake.send({ t: "data", reqId, seq: 1, b64: Buffer.from("bb").toString("base64"), done: true });
	fake.send({ t: "result", reqId, ok: true });
	const result = await pending;
	expect(result.ok).toBe(true);
	expect(Buffer.concat(chunks).toString()).toBe("aabb");
});

test("pushFile sends 1 MB chunks and marks only the last one done", async () => {
	const token = tokenOf("推文件机");
	const fake = await device("dvc-push", token);
	const bytes = Buffer.alloc(DEVICE_PUSH_CHUNK_BYTES * 2 + 10, 7);
	const result = await gateway.pushFile("dvc-push", "/tmp/tool", bytes, { mode: "0755", timeoutMs: 5000 });
	expect(result.ok).toBe(true);
	expect(result.stdout).toBe(`写入 ${bytes.length} 字节`);

	const pushes = fake.received.filter((frame) => frame.t === "push");
	expect(pushes).toHaveLength(3);
	expect(pushes.map((frame) => frame.seq)).toEqual([0, 1, 2]);
	expect(pushes.map((frame) => frame.done)).toEqual([false, false, true]);
	expect(pushes[0]?.mode).toBe("0755");
});

test("an oversized request is refused before it reaches the socket", async () => {
	const token = tokenOf("大帧机");
	await device("dvc-large", token);
	const result = await gateway.request("dvc-large", {
		t: "exec",
		cmd: "x".repeat(DEVICE_MAX_FRAME_BYTES),
		asRoot: false,
		timeoutMs: 5000,
	});
	expect(result.ok).toBe(false);
	expect(result.error).toContain("发送失败");
});

test("disconnecting fails every pending request for that device", async () => {
	const token = tokenOf("断线机");
	const fake = await device("dvc-drop", token, { autoReply: false });
	const pending = gateway.request("dvc-drop", { t: "exec", cmd: "sleep 10", asRoot: false, timeoutMs: 10_000 });
	fake.close();
	const result = await pending;
	expect(result.ok).toBe(false);
	expect(result.error).toContain("断开");
});

test("a second connection for the same device replaces the first", async () => {
	const token = tokenOf("重连机");
	const first = await device("dvc-replace", token);
	const second = await device("dvc-replace", token);
	await waitFor(() => first.closeCode !== undefined);
	expect(first.closeCode).toBe(4003);
	expect(gateway.onlineDevices()).toHaveLength(1);
	expect(second.ws?.readyState).toBe(1);
});

test("roothide is refused with a reason instead of half-working", async () => {
	const token = tokenOf("roothide机");
	const fake = new FakeIos("dvc-roothide", token, { jailbreakForm: "roothide" });
	await expect(fake.connect(baseUrl)).rejects.toThrow();
	await waitFor(() => fake.closeCode !== undefined);
	expect(fake.closeCode).toBe(4005);
	expect(store.getDevice("dvc-roothide")).toBeUndefined();
});

test("a non-iOS handshake is refused", async () => {
	const token = tokenOf("假安卓");
	const fake = new FakeIos("dvc-platform", token, { platform: "android" });
	await expect(fake.connect(baseUrl)).rejects.toThrow();
	await waitFor(() => fake.closeCode !== undefined);
	expect(fake.closeCode).toBe(4002);
});

test("a protocol version the console cannot read is refused", async () => {
	const token = tokenOf("旧协议");
	const fake = new FakeIos("dvc-protocol", token, { protocol: IOS_PROTOCOL_VERSION + 1 });
	await expect(fake.connect(baseUrl)).rejects.toThrow();
	await waitFor(() => fake.closeCode !== undefined);
	expect(fake.closeCode).toBe(4002);
});

test("a frozen device fails calls at the sweep and recovers on the next frame", async () => {
	const frozenStore = new IosStore(join(dir, "frozen-ios.db"));
	const frozenGateway = new IosGateway(
		frozenStore,
		{ onDeviceChange: () => {}, log: () => {} },
		{ staleMs: 100, watchdogTickMs: 20 },
	);
	const frozenServer = createHttpServer();
	frozenServer.on("upgrade", (request, socket, head) => {
		frozenGateway.handleUpgrade(request, socket, head);
	});
	await new Promise<void>((resolve) => frozenServer.listen(0, "127.0.0.1", resolve));
	const frozenUrl = wsUrlOf(frozenServer);
	const token = frozenStore.createToken("冻结机").token;
	const fake = new FakeIos("dvc-frozen", token, { autoReply: false });
	await fake.connect(frozenUrl);

	await waitFor(() => frozenGateway.livenessOf("dvc-frozen")?.stale === true);
	const rejected = await frozenGateway.request("dvc-frozen", {
		t: "exec",
		cmd: "id",
		asRoot: false,
		timeoutMs: 5000,
	});
	expect(rejected.ok).toBe(false);
	expect(rejected.error).toContain("无响应");

	// A heartbeat proves the process is executing again; the same socket is usable.
	fake.autoReply = true;
	fake.send({ t: "hb" });
	await waitFor(() => frozenGateway.livenessOf("dvc-frozen")?.stale === false);
	const recovered = await frozenGateway.request("dvc-frozen", {
		t: "exec",
		cmd: "id",
		asRoot: false,
		timeoutMs: 5000,
	});
	expect(recovered.ok).toBe(true);
	expect(recovered.stdout).toBe("ran:id");

	fake.close();
	frozenGateway.close();
	frozenServer.close();
	await new Promise((resolve) => setTimeout(resolve, 50));
	frozenStore.close();
});

test("the TCP tunnel bridges bytes to the device-side port", async () => {
	const token = tokenOf("隧道机");
	const fake = await device("dvc-tunnel", token);
	const echo = createTcpServer((socket) => socket.pipe(socket));
	await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
	const echoPort = (echo.address() as { port: number }).port;

	const sockets = new Map<string, ReturnType<typeof createConnection>>();
	fake.onFrame = (frame) => {
		if (frame.t === "tcp_open") {
			const tunnelId = String(frame.tunnelId);
			const connId = String(frame.connId);
			const socket = createConnection({ host: String(frame.host), port: Number(frame.port) }, () => {
				fake.send({ t: "tcp_opened", reqId: frame.reqId, tunnelId, connId, ok: true });
			});
			sockets.set(connId, socket);
			socket.on("data", (chunk) => {
				fake.send({ t: "tcp_data", tunnelId, connId, b64: chunk.toString("base64") });
			});
			socket.on("close", () => fake.send({ t: "tcp_closed", tunnelId, connId }));
			return;
		}
		if (frame.t === "tcp_send") {
			sockets.get(String(frame.connId))?.write(Buffer.from(String(frame.b64), "base64"));
			return;
		}
		if (frame.t === "tcp_close") {
			sockets.get(String(frame.connId))?.destroy();
			sockets.delete(String(frame.connId));
		}
	};

	const tunnel = await gateway.openTunnel("dvc-tunnel", "127.0.0.1", echoPort);
	expect(tunnel.ok).toBe(true);
	const client = createConnection({ host: "127.0.0.1", port: tunnel.port as number });
	await once(client, "connect");
	const response = once(client, "data");
	client.write("ping");
	const [data] = await response;
	expect(String(data)).toBe("ping");
	client.destroy();
	gateway.closeTunnel(tunnel.tunnelId as string);
	echo.close();
});

test("dedicated listener binds, reports its port and stops", async () => {
	const result = await gateway.listen("127.0.0.1", 0);
	try {
		expect(result.ok).toBe(true);
		expect(result.port).toBeGreaterThan(0);
		expect(gateway.listenInfo()).toEqual({ host: "127.0.0.1", port: result.port });
	} finally {
		gateway.stopListener();
	}
	expect(gateway.listenInfo()).toBeUndefined();
});
