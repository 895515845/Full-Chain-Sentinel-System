/**
 * The device gateway: the server side of DroidBridge's reverse connection.
 *
 * The device dials `ws(s)://console/ws/droid?token=…` — outbound from the
 * operator's network, so the server opens no port toward the phone and the
 * topology survives NAT. One gateway owns every connected device; agent tools
 * ask it to send a request frame and await the device's result, which keeps the
 * tools free of any WebSocket plumbing.
 *
 * A device must say `hello` with a valid, not-deleted token before anything
 * else; frames arriving before the handshake, or a second connection for the
 * same deviceId, are dropped (the newest connection wins for the hello case,
 * because a phone that lost its network half-closes the old socket first).
 */

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { type AddressInfo, createServer, type Socket as TcpSocket } from "node:net";
import type { Duplex } from "node:stream";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { DroidDevice, DroidHello, DroidStore } from "./droid.ts";
import {
	DROID_MAX_FRAME_BYTES,
	DROID_MAX_STREAM_BYTES,
	DROID_PUSH_CHUNK_BYTES,
	type DroidDeviceFrame,
	type DroidRequestInput,
	type DroidResult,
} from "./droid-protocol.ts";
import { t } from "./i18n.ts";

/**
 * A device that stops sending anything is almost never a closed socket: Android
 * (and emulators) can SIGSTOP the whole app process, which leaves the TCP
 * connection ESTABLISHED while no thread runs — heartbeats stop, requests are
 * never answered, and the gateway would keep reporting 在线 while every call
 * waits out its own timeout. Heartbeats are 15s, so three missed ones mean the
 * app stopped running: the sweep fails that device's calls immediately and marks
 * it unresponsive, and the first frame back clears the flag (an unfrozen process
 * resumes on the very same socket).
 */
const DROID_STALE_MS = 45_000;
const DROID_WATCHDOG_TICK_MS = 5_000;

function unresponsiveMessage(idleMs: number): string {
	const seconds = Math.round(idleMs / 1000);
	return t(
		"设备无响应：已 {seconds}s 未收到心跳（DroidBridge 进程可能被系统或模拟器冻结：socket 还在，但 app 不再执行任何代码）。请在设备上唤醒或重开 DroidBridge，等心跳恢复后重试",
		{ seconds },
	);
}

export interface DroidGatewayOptions {
	/** Silence longer than this marks a device unresponsive (default 45s). */
	staleMs?: number;
	/** Liveness sweep interval (default 5s). */
	watchdogTickMs?: number;
}

export interface DroidGatewayHooks {
	/** A device came online, went offline, or changed; consoles refresh the page. */
	onDeviceChange(): void;
	/** One audit line per device lifecycle event, into the server log. */
	log(line: string): void;
}

interface DeviceConnection {
	ws: WebSocket;
	device: DroidDevice;
	/** Payload chunks assembled so far, by request id. */
	streams: Map<string, { chunks: Buffer[]; bytes: number; nextSeq: number }>;
	/** tcp connId → the device-side socket is remote; the server side lives in `tunnels`. */
	tcp: Map<string, TcpSocket>;
	/** When the last frame of any kind arrived (heartbeats included). */
	lastFrameAt: number;
	/** Set by the liveness sweep; cleared by the first frame after a freeze. */
	stale: boolean;
}

/** One server-side TCP listener bridged into a device port. */
interface TcpTunnel {
	deviceId: string;
	server: import("node:net").Server;
	port: number;
	targetHost: string;
	targetPort: number;
	connections: Map<string, TcpSocket>;
	/** Bytes that arrived before the device finished dialing, flushed on tcp_opened. */
	buffers: Map<string, Buffer[]>;
}

interface PendingRequest {
	resolve: (result: DroidResult) => void;
	timer: ReturnType<typeof setTimeout>;
	onData?: (chunk: Buffer) => void;
}

export class DroidGateway {
	private readonly wss = new WebSocketServer({ noServer: true, maxPayload: DROID_MAX_FRAME_BYTES });
	/** deviceId → live connection. */
	private readonly connections = new Map<string, DeviceConnection>();
	/** reqId → pending promise, across all devices. */
	private readonly pending = new Map<string, PendingRequest>();
	/** reqId → deviceId, so a disconnect can fail exactly that device's calls. */
	private readonly pendingDevices = new Map<string, string>();
	private readonly tunnels = new Map<string, TcpTunnel>();
	/** The dedicated reverse-connection listener (independent of the console port). */
	private listener: { server: HttpServer; host: string; port: number } | undefined;
	/** Liveness sweep, alive only while at least one device is connected. */
	private watchdog: ReturnType<typeof setInterval> | undefined;
	private counter = 0;

	private readonly store: DroidStore;
	private readonly hooks: DroidGatewayHooks;
	private readonly staleMs: number;
	private readonly watchdogTickMs: number;

	constructor(store: DroidStore, hooks: DroidGatewayHooks, options: DroidGatewayOptions = {}) {
		this.store = store;
		this.hooks = hooks;
		this.staleMs = options.staleMs ?? DROID_STALE_MS;
		this.watchdogTickMs = options.watchdogTickMs ?? DROID_WATCHDOG_TICK_MS;
	}

	/** HTTP upgrade dispatch: only this path, only a valid token. */
	handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws/droid") return false;
		const token = url.searchParams.get("token") ?? "";
		const record = this.store.findToken(token);
		if (!record) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			this.hooks.log("设备反连被拒绝：token 无效或已删除");
			return true;
		}
		this.wss.handleUpgrade(request, socket, head, (ws) => this.onConnection(ws, record.id));
		return true;
	}

	private onConnection(ws: WebSocket, tokenId: string): void {
		let device: DroidDevice | undefined;
		let helloed = false;

		ws.on("message", (raw: RawData) => {
			let frame: DroidDeviceFrame;
			try {
				frame = JSON.parse(raw.toString()) as DroidDeviceFrame;
			} catch {
				return;
			}
			// Any frame — heartbeat, result, data chunk — proves the app is running.
			if (device) this.markAlive(device.id, ws);
			if (!helloed) {
				if (frame.t !== "hello") {
					ws.close(4001, "handshake required");
					return;
				}
				const hello = frame as unknown as DroidHello;
				if (!hello.deviceId || typeof hello.deviceId !== "string") {
					ws.close(4002, "deviceId required");
					return;
				}
				// The newest connection for a device wins: an old socket is half-dead.
				const previous = this.connections.get(hello.deviceId);
				if (previous) previous.ws.close(4003, "replaced by a new connection");
				device = this.store.upsertDevice(
					{
						deviceId: hello.deviceId,
						model: String(hello.model ?? "未知机型"),
						androidVersion: String(hello.androidVersion ?? "未知"),
						sdkInt: Number(hello.sdkInt ?? 0),
						rooted: hello.rooted === true,
					},
					tokenId,
				);
				this.connections.set(hello.deviceId, {
					ws,
					device,
					streams: new Map(),
					tcp: new Map(),
					lastFrameAt: Date.now(),
					stale: false,
				});
				this.ensureWatchdog();
				helloed = true;
				ws.send(JSON.stringify({ t: "welcome", deviceId: hello.deviceId }));
				this.hooks.log(
					`设备上线：${device.name}（Android ${device.androidVersion}${device.rooted ? "，已 root" : ""}）`,
				);
				this.hooks.onDeviceChange();
				return;
			}
			if (!device) return;
			if (frame.t === "hb") {
				this.store.setDeviceOnline(device.id, true);
				return;
			}
			if (frame.t === "data") {
				this.onData(device.id, frame.reqId, frame.seq, frame.b64, frame.done === true);
				return;
			}
			if (frame.t === "tcp_data") {
				const tunnel = this.tunnels.get(frame.tunnelId);
				const socket = tunnel?.connections.get(frame.connId);
				socket?.write(Buffer.from(frame.b64, "base64"));
				return;
			}
			if (frame.t === "tcp_closed") {
				const tunnel = this.tunnels.get(frame.tunnelId);
				tunnel?.connections.get(frame.connId)?.destroy();
				tunnel?.connections.delete(frame.connId);
				return;
			}
			if (frame.t === "tcp_opened") {
				console.error(
					"[DIAG gw tcp_opened]",
					frame.tunnelId,
					frame.connId,
					frame.ok,
					"pending=",
					this.pending.has(frame.reqId),
				);
				const pending = this.pending.get(frame.reqId);
				if (!pending) return;
				this.pending.delete(frame.reqId);
				clearTimeout(pending.timer);
				// Flush whatever the client wrote while the device was dialing.
				const tunnel = this.tunnels.get(frame.tunnelId);
				const buffered = tunnel?.buffers.get(frame.connId);
				console.error("[DIAG gw flush]", frame.tunnelId, "tunnel=", !!tunnel, "buffered=", buffered?.length);
				if (tunnel && buffered && frame.ok === true) {
					tunnel.buffers.delete(frame.connId);
					for (const chunk of buffered) {
						ws.send(
							JSON.stringify({
								t: "tcp_send",
								tunnelId: frame.tunnelId,
								connId: frame.connId,
								b64: chunk.toString("base64"),
							}),
						);
					}
				} else if (tunnel) {
					tunnel.buffers.delete(frame.connId);
				}
				pending.resolve({ ok: frame.ok === true, error: frame.error });
				return;
			}
			if (frame.t === "result") {
				const pending = this.pending.get(frame.reqId);
				if (!pending) return;
				this.pending.delete(frame.reqId);
				clearTimeout(pending.timer);
				pending.resolve({
					ok: frame.ok === true,
					code: frame.code,
					stdout: frame.stdout,
					stderr: frame.stderr,
					error: frame.error,
					// Streamed payloads are assembled for every caller; `onData` is the
					// progressive view of the same chunks, not a switch for assembly.
					bytes: this.takeStream(device.id, frame.reqId),
				});
			}
		});

		ws.on("close", () => {
			if (!device) return;
			// A replaced connection must not unregister its successor.
			const current = this.connections.get(device.id);
			if (current && current.ws !== ws) return;
			this.connections.delete(device.id);
			this.stopWatchdogIfIdle();
			this.store.setDeviceOnline(device.id, false);
			for (const [tunnelId, tunnel] of [...this.tunnels.entries()]) {
				if (tunnel.deviceId !== device.id) continue;
				for (const socket of tunnel.connections.values()) socket.destroy();
				tunnel.server.close();
				this.tunnels.delete(tunnelId);
			}
			this.failPendingOf(device.id, t("设备连接已断开"));
			this.hooks.log(`设备离线：${device.name}`);
			this.hooks.onDeviceChange();
		});
		ws.on("error", () => ws.close());
	}

	/** Start the liveness sweep once there is something to watch. */
	private ensureWatchdog(): void {
		if (this.watchdog) return;
		this.watchdog = setInterval(() => this.sweepLiveness(), this.watchdogTickMs);
		// A device may never come back: never hold the process open for it.
		this.watchdog.unref?.();
	}

	private stopWatchdogIfIdle(): void {
		if (!this.watchdog || this.connections.size > 0) return;
		clearInterval(this.watchdog);
		this.watchdog = undefined;
	}

	/**
	 * Fail a device's calls as soon as it stops answering, instead of letting each
	 * one wait out its own timeout: a frozen app never sends a result, so the
	 * caller otherwise learns nothing for a minute per attempt.
	 */
	private sweepLiveness(): void {
		const now = Date.now();
		for (const [deviceId, conn] of this.connections) {
			if (conn.stale || now - conn.lastFrameAt <= this.staleMs) continue;
			conn.stale = true;
			const idleMs = now - conn.lastFrameAt;
			this.hooks.log(
				`设备无响应：${conn.device.name}（已 ${Math.round(idleMs / 1000)}s 未收到心跳，进程可能被冻结或已停止响应）`,
			);
			this.failPendingOf(deviceId, unresponsiveMessage(idleMs));
			this.hooks.onDeviceChange();
		}
	}

	/** The first frame after a freeze means the app is executing again. */
	private markAlive(deviceId: string, ws: WebSocket): void {
		const conn = this.connections.get(deviceId);
		// A replaced socket must not refresh its successor's liveness.
		if (!conn || conn.ws !== ws) return;
		conn.lastFrameAt = Date.now();
		if (!conn.stale) return;
		conn.stale = false;
		this.hooks.log(`设备恢复响应：${conn.device.name}`);
		this.hooks.onDeviceChange();
	}

	/** Staleness at this instant: the sweep lags by up to one tick, callers must not. */
	private isStale(conn: DeviceConnection, now = Date.now()): boolean {
		return conn.stale || now - conn.lastFrameAt > this.staleMs;
	}

	/** What a call gets when the device is connected but has stopped answering. */
	private staleFailure(conn: DeviceConnection): { ok: false; error: string } {
		return { ok: false, error: unresponsiveMessage(Date.now() - conn.lastFrameAt) };
	}

	/** Runtime liveness of one device, for the console's device list. */
	livenessOf(deviceId: string): { stale: boolean; idleMs: number } | undefined {
		const conn = this.connections.get(deviceId);
		if (!conn) return undefined;
		return { stale: this.isStale(conn), idleMs: Date.now() - conn.lastFrameAt };
	}

	/** Assemble one streamed payload; a broken sequence or oversized stream fails the request. */
	private onData(deviceId: string, reqId: string, seq: number, b64: string, done: boolean): void {
		const pending = this.pending.get(reqId);
		const conn = this.connections.get(deviceId);
		if (!pending || !conn) return;
		let stream = conn.streams.get(reqId);
		if (!stream) {
			stream = { chunks: [], bytes: 0, nextSeq: 0 };
			conn.streams.set(reqId, stream);
		}
		if (seq !== stream.nextSeq) {
			this.fail(reqId, t("流分片乱序：期望 {expected}，收到 {actual}", { expected: stream.nextSeq, actual: seq }));
			conn.streams.delete(reqId);
			return;
		}
		stream.nextSeq += 1;
		const chunk = Buffer.from(b64, "base64");
		stream.bytes += chunk.length;
		if (stream.bytes > DROID_MAX_STREAM_BYTES) {
			this.fail(reqId, t("流超过大小上限"));
			conn.streams.delete(reqId);
			return;
		}
		// A consumer that writes as it goes must not also leave a copy here: that is
		// what makes a streamed pull actually stream (a 256MB file would otherwise
		// sit in the gateway heap until the result frame).
		if (pending.onData) pending.onData(chunk);
		else stream.chunks.push(chunk);
		// `done` stays with the frame so the device can mark its own end; the
		// assembled stream is consumed (and freed) by takeStream at the result.
		void done;
	}

	private takeStream(deviceId: string, reqId: string): Buffer | undefined {
		const conn = this.connections.get(deviceId);
		const stream = conn?.streams.get(reqId);
		if (!stream) return undefined;
		conn?.streams.delete(reqId);
		return Buffer.concat(stream.chunks);
	}

	private fail(reqId: string, error: string): void {
		const pending = this.pending.get(reqId);
		if (!pending) return;
		this.pending.delete(reqId);
		clearTimeout(pending.timer);
		pending.resolve({ ok: false, error });
	}

	private failPendingOf(deviceId: string, error: string): void {
		for (const [reqId, pending] of [...this.pending.entries()]) {
			if (this.pendingDevices.get(reqId) !== deviceId) continue;
			this.pending.delete(reqId);
			this.pendingDevices.delete(reqId);
			clearTimeout(pending.timer);
			pending.resolve({ ok: false, error });
		}
	}

	/** Connected devices, annotated with whether the app still answers. */
	onlineDevices(): DroidDevice[] {
		const now = Date.now();
		return [...this.connections.values()]
			.map((conn) => ({ conn, device: this.store.getDevice(conn.device.id) }))
			.filter((entry): entry is { conn: DeviceConnection; device: DroidDevice } => entry.device !== undefined)
			.map(({ conn, device }) => ({
				...device,
				stale: this.isStale(conn, now),
				idleMs: now - conn.lastFrameAt,
			}));
	}

	onlineDeviceIds(): string[] {
		return [...this.connections.keys()];
	}

	isOnline(deviceId: string): boolean {
		return this.connections.has(deviceId);
	}

	/** Drop a device's connection (token deleted, device removed). */
	disconnect(deviceId: string): void {
		this.connections.get(deviceId)?.ws.close(4004, "deleted");
	}

	/**
	 * The dedicated reverse-connection listener. Independent from the console's
	 * own HTTP server so the bind address can be changed at runtime: the operator
	 * picks the interface (0.0.0.0 / 127.0.0.1 / one NIC IP) on the device page
	 * and the socket rebinds immediately.
	 */
	listenInfo(): { host: string; port: number } | undefined {
		return this.listener ? { host: this.listener.host, port: this.listener.port } : undefined;
	}

	async listen(host: string, port: number): Promise<{ ok: boolean; port?: number; error?: string }> {
		this.stopListener();
		const server = createHttpServer();
		server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
			// Dedicated listener: every upgrade is a device, and the same token rule
			// applies (the path is not enforced here — the APK always uses /ws/droid).
			const url = new URL(request.url ?? "/", "http://localhost");
			const token = url.searchParams.get("token") ?? "";
			const record = this.store.findToken(token);
			if (!record) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				this.hooks.log("设备反连被拒绝：token 无效或已删除");
				return;
			}
			this.wss.handleUpgrade(request, socket, head, (ws) => this.onConnection(ws, record.id));
		});
		const result = new Promise<{ ok: boolean; port?: number; error?: string }>((resolve) => {
			server.once("error", (error: Error) => {
				if (this.listener?.server === server) this.listener = undefined;
				resolve({ ok: false, error: t("监听失败：{error}", { error: error.message }) });
			});
			server.listen(port, host === "0.0.0.0" || host === "::" ? undefined : host, () => {
				const boundPort = (server.address() as AddressInfo).port;
				this.listener = { server, host, port: boundPort };
				this.hooks.log(`设备反连监听：${host}:${boundPort}`);
				resolve({ ok: true, port: boundPort });
			});
		});
		const outcome = await result;
		if (outcome.ok) this.hooks.onDeviceChange();
		return outcome;
	}

	stopListener(): void {
		if (!this.listener) return;
		const server = this.listener.server;
		this.listener = undefined;
		server.close();
	}

	listenerHostOf(request: IncomingMessage): string | undefined {
		void request;
		return this.listener?.host;
	}

	listTunnels(): Array<{ tunnelId: string; deviceId: string; port: number; targetHost: string; targetPort: number }> {
		return [...this.tunnels.entries()].map(([tunnelId, tunnel]) => ({
			tunnelId,
			deviceId: tunnel.deviceId,
			port: tunnel.port,
			targetHost: tunnel.targetHost,
			targetPort: tunnel.targetPort,
		}));
	}

	/**
	 * Open a TCP tunnel: a loopback listener whose connections are bridged into
	 * `targetHost:targetPort` on the device. The container reaches it via
	 * host.docker.internal; the host via 127.0.0.1. Fails when the device already
	 * serves this exact target through a live tunnel (reuse instead).
	 */
	openTunnel(
		deviceId: string,
		targetHost: string,
		targetPort: number,
	): Promise<{ ok: boolean; port?: number; tunnelId?: string; error?: string }> {
		const conn = this.connections.get(deviceId);
		if (!conn) return Promise.resolve({ ok: false, error: t("设备不在线") });
		if (this.isStale(conn)) return Promise.resolve(this.staleFailure(conn));
		for (const [tunnelId, tunnel] of this.tunnels.entries()) {
			if (tunnel.deviceId === deviceId && tunnel.targetHost === targetHost && tunnel.targetPort === targetPort) {
				return Promise.resolve({ ok: true, port: tunnel.port, tunnelId });
			}
		}
		this.counter += 1;
		const tunnelId = `tn${Date.now().toString(36)}${this.counter.toString(36)}`;
		const tunnel: TcpTunnel = {
			deviceId,
			server: createServer(),
			port: 0,
			targetHost,
			targetPort,
			connections: new Map(),
			buffers: new Map(),
		};
		this.tunnels.set(tunnelId, tunnel);
		return new Promise((resolve) => {
			tunnel.server.on("connection", (socket: TcpSocket) => {
				const connId = randomUUID().slice(0, 8);
				const reqId = randomUUID().slice(0, 8);
				tunnel.connections.set(connId, socket);
				// Clients like frida write their handshake immediately, before the
				// device has finished dialing: buffer until tcp_opened, then flush.
				tunnel.buffers.set(connId, []);
				this.pendingDevices.set(reqId, deviceId);
				const timer = setTimeout(() => {
					this.pending.delete(reqId);
					tunnel.connections.delete(connId);
					socket.destroy();
				}, 10_000);
				this.pending.set(reqId, {
					resolve: (result) => {
						clearTimeout(timer);
						if (!result.ok) {
							tunnel.connections.delete(connId);
							socket.destroy();
						}
					},
					timer,
				});
				conn.ws.send(
					JSON.stringify({ t: "tcp_open", reqId, tunnelId, connId, host: targetHost, port: targetPort }),
				);
				socket.on("data", (chunk: Buffer) => {
					if (this.connections.get(deviceId) !== conn) return;
					const buffer = tunnel.buffers.get(connId);
					console.error("[DIAG gw sock data]", connId, chunk.length, "buffered=", !!buffer);
					if (buffer) {
						// The device-side dial is still in flight; hold the bytes in order.
						buffer.push(chunk);
						return;
					}
					conn.ws.send(JSON.stringify({ t: "tcp_send", tunnelId, connId, b64: chunk.toString("base64") }));
				});
				socket.on("close", () => {
					tunnel.connections.delete(connId);
					tunnel.buffers.delete(connId);
					if (this.connections.get(deviceId) === conn) {
						conn.ws.send(JSON.stringify({ t: "tcp_close", tunnelId, connId }));
					}
				});
				socket.on("error", () => socket.destroy());
			});
			tunnel.server.on("error", (error: Error) => {
				this.tunnels.delete(tunnelId);
				resolve({ ok: false, error: t("隧道监听失败：{error}", { error: error.message }) });
			});
			tunnel.server.listen(0, "127.0.0.1", () => {
				tunnel.port = (tunnel.server.address() as AddressInfo).port;
				resolve({ ok: true, port: tunnel.port, tunnelId });
			});
		});
	}

	closeTunnel(tunnelId: string): boolean {
		const tunnel = this.tunnels.get(tunnelId);
		if (!tunnel) return false;
		for (const socket of tunnel.connections.values()) socket.destroy();
		tunnel.server.close();
		this.tunnels.delete(tunnelId);
		return true;
	}

	/**
	 * Send a request to a device and await its final result. Streamed payloads are
	 * assembled into `bytes` when `onData` is absent; when it is present each chunk
	 * goes straight to the consumer and `bytes` stays empty (that is the streaming
	 * path — see `droid_file_pull`).
	 */
	request(
		deviceId: string,
		req: DroidRequestInput,
		options: { timeoutMs?: number; onData?: (chunk: Buffer) => void } = {},
	): Promise<DroidResult> {
		const conn = this.connections.get(deviceId);
		if (!conn) return Promise.resolve({ ok: false, error: t("设备不在线") });
		if (this.isStale(conn)) return Promise.resolve(this.staleFailure(conn));
		this.counter += 1;
		const reqId = `d${Date.now().toString(36)}${this.counter.toString(36)}${randomUUID().slice(0, 8)}`;
		// The wire frame is the request plus its assigned id.
		const frame: Record<string, unknown> = { ...req, reqId };
		this.pendingDevices.set(reqId, deviceId);
		return new Promise<DroidResult>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(reqId);
				this.pendingDevices.delete(reqId);
				conn.streams.delete(reqId);
				resolve({
					ok: false,
					error: t("设备响应超时（{seconds}s）", { seconds: Math.round((options.timeoutMs ?? 30000) / 1000) }),
				});
			}, options.timeoutMs ?? 30000);
			this.pending.set(reqId, { resolve, timer, onData: options.onData });
			this.sendFrame(conn, frame).catch((error: Error) => {
				if (!this.pending.has(reqId)) return;
				this.pending.delete(reqId);
				this.pendingDevices.delete(reqId);
				clearTimeout(timer);
				resolve({ ok: false, error: t("发送失败：{error}", { error: error.message }) });
			});
		});
	}

	/**
	 * Write a file onto a device in `push` chunks. One request id spans every
	 * chunk, so the device answers exactly once (the `done` chunk) and this
	 * resolves like any other request.
	 *
	 * Chunks are sent one at a time, each awaited: the socket drains as the device
	 * appends, instead of the whole file queueing in the gateway's send buffer.
	 */
	pushFile(
		deviceId: string,
		path: string,
		bytes: Buffer,
		options: { mode?: string; timeoutMs?: number } = {},
	): Promise<DroidResult> {
		const conn = this.connections.get(deviceId);
		if (!conn) return Promise.resolve({ ok: false, error: t("设备不在线") });
		if (this.isStale(conn)) return Promise.resolve(this.staleFailure(conn));
		if (bytes.length > DROID_MAX_STREAM_BYTES) {
			return Promise.resolve({
				ok: false,
				error: t("文件 {bytes} 字节超过上限 {limit}", { bytes: bytes.length, limit: DROID_MAX_STREAM_BYTES }),
			});
		}
		this.counter += 1;
		const reqId = `d${Date.now().toString(36)}${this.counter.toString(36)}${randomUUID().slice(0, 8)}`;
		this.pendingDevices.set(reqId, deviceId);
		// A slow link must not trip the timeout mid-transfer: the floor is a
		// generous 100 KB/s, so only a genuinely stuck push gives up.
		const timeoutMs = Math.max(options.timeoutMs ?? 30_000, 30_000 + Math.ceil(bytes.length / 100_000) * 1000);
		return new Promise<DroidResult>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(reqId);
				this.pendingDevices.delete(reqId);
				conn.streams.delete(reqId);
				resolve({ ok: false, error: t("设备响应超时（{seconds}s）", { seconds: Math.round(timeoutMs / 1000) }) });
			}, timeoutMs);
			this.pending.set(reqId, { resolve, timer });
			void this.sendPushChunks(conn, deviceId, reqId, path, bytes, options.mode);
		});
	}

	/** Stream one file as `push` frames; the last one carries `done`. */
	private async sendPushChunks(
		conn: DeviceConnection,
		deviceId: string,
		reqId: string,
		path: string,
		bytes: Buffer,
		mode: string | undefined,
	): Promise<void> {
		const total = Math.max(1, Math.ceil(bytes.length / DROID_PUSH_CHUNK_BYTES));
		try {
			for (let seq = 0; seq < total; seq += 1) {
				// The push may have already failed (timeout, disconnect): stop sending.
				if (!this.pending.has(reqId)) return;
				if (this.connections.get(deviceId) !== conn) {
					this.fail(reqId, t("设备连接已断开"));
					return;
				}
				const chunk = bytes.subarray(seq * DROID_PUSH_CHUNK_BYTES, (seq + 1) * DROID_PUSH_CHUNK_BYTES);
				await this.sendFrame(
					conn,
					{
						t: "push",
						reqId,
						path,
						seq,
						done: seq === total - 1,
						b64: chunk.toString("base64"),
						...(mode ? { mode } : {}),
					},
					reqId,
				);
			}
		} catch (error) {
			this.fail(reqId, t("发送失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
		}
	}

	/**
	 * The one place an outgoing frame leaves the gateway, so no caller can put a
	 * bulk payload in a single message and take the phone down with it.
	 *
	 * `reqId` is for streaming callers: the send callback only fires once the
	 * socket drains, so a request that already failed (timeout, disconnect) would
	 * otherwise keep the chunk loop — and the whole payload it references —
	 * waiting on a socket that stopped draining. The watcher lets go instead.
	 */
	private sendFrame(conn: DeviceConnection, frame: Record<string, unknown>, reqId?: string): Promise<void> {
		const text = JSON.stringify(frame);
		const size = Buffer.byteLength(text);
		if (size > DROID_MAX_FRAME_BYTES) {
			return Promise.reject(
				new Error(
					t("单帧 {size} 字节超过 {limit} 上限，请分片发送（DROID_PUSH_CHUNK_BYTES）", {
						size,
						limit: DROID_MAX_FRAME_BYTES,
					}),
				),
			);
		}
		return new Promise((resolve, reject) => {
			const watch = reqId
				? setInterval(() => {
						if (this.pending.has(reqId)) return;
						clearInterval(watch);
						resolve();
					}, 500)
				: undefined;
			conn.ws.send(text, (error) => {
				if (watch) clearInterval(watch);
				if (error) reject(error);
				else resolve();
			});
		});
	}
}
