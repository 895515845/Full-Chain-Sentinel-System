/**
 * The iOS gateway: the server side of SentinelBridge's reverse connection.
 *
 * The device dials `wss://console/ws/ios?token=…` — outbound from the operator's
 * network, so the server opens no port toward the phone and the topology
 * survives NAT and CGNAT. One gateway owns every connected device; the tool
 * layer only sees request/response promises.
 *
 * Deliberately separate from DroidGateway (see the M0 decision): the Android
 * gateway works and must not be rewritten for symmetry. What the two share is
 * the transport shape, imported from `device-transport.ts`; what differs is the
 * handshake (jailbreak form, arch, capability set) and, later, the tool set.
 *
 * A device must say `hello` with a valid, not-deleted token before anything
 * else. Frames before the handshake are refused; a second connection for the
 * same deviceId replaces the first (a phone that lost its network half-closes
 * the old socket before dialing again).
 */

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import {
	type AddressInfo,
	createServer as createTcpServer,
	type Server as TcpServer,
	type Socket as TcpSocket,
} from "node:net";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
	DEVICE_MAX_FRAME_BYTES,
	DEVICE_PUSH_CHUNK_BYTES,
	encodeFrame,
	PendingRequests,
	StreamAssembler,
} from "./device-transport.ts";
import { t } from "./i18n.ts";
import { type IosDevice, type IosStore, normalizeJailbreakForm } from "./ios.ts";
import {
	IOS_PROTOCOL_VERSION,
	type IosDeviceFrame,
	type IosHelloFrame,
	type IosRequestInput,
	type IosResult,
} from "./ios-protocol.ts";

/**
 * A device that stops sending anything is almost never a closed socket: iOS can
 * suspend the App process, and the kernel keeps the connection ESTABLISHED
 * while no thread runs. Heartbeats are 15s, so three missed ones mean the
 * process stopped executing.
 *
 * The daemon is not suspended by iOS, so this mostly matters in the App-only
 * fallback mode — but the daemon can also wedge (a stuck tcpdump, a deadlock),
 * and the operator deserves the same answer either way.
 */
const IOS_STALE_MS = 45_000;
const IOS_WATCHDOG_TICK_MS = 5_000;

function unresponsiveMessage(idleMs: number): string {
	const seconds = Math.round(idleMs / 1000);
	return t(
		"设备无响应：已 {seconds}s 未收到心跳（SentinelBridge 可能被挂起或卡死：socket 还在，但设备不再执行任何代码）。请在设备上重开 SentinelBridge 或重启 daemon 后重试",
		{ seconds },
	);
}

export interface IosGatewayOptions {
	/** Silence longer than this marks a device unresponsive (default 45s). */
	staleMs?: number;
	/** Liveness sweep interval (default 5s). */
	watchdogTickMs?: number;
	/** TLS material for the dedicated listener; iOS only accepts wss. */
	tls?: { cert: string | Buffer; key: string | Buffer };
}

export interface IosGatewayHooks {
	/** A device came online, went offline, or changed; consoles refresh the page. */
	onDeviceChange(): void;
	/** One audit line per device lifecycle event, into the server log. */
	log(line: string): void;
}

interface DeviceConnection {
	ws: WebSocket;
	device: IosDevice;
	/** Payload chunks assembled so far, by request id. */
	streams: StreamAssembler;
	/** connId → the device-side socket is remote; the server side lives in `tunnels`. */
	tcp: Map<string, TcpSocket>;
	/** When the last frame of any kind arrived (heartbeats included). */
	lastFrameAt: number;
	/** Set by the liveness sweep; cleared by the first frame after a freeze. */
	stale: boolean;
}

/** One server-side TCP listener bridged into a device port. */
interface TcpTunnel {
	deviceId: string;
	server: TcpServer;
	port: number;
	targetHost: string;
	targetPort: number;
	connections: Map<string, TcpSocket>;
	/** Bytes that arrived before the device finished dialing, flushed on tcp_opened. */
	buffers: Map<string, Buffer[]>;
}

export class IosGateway {
	private readonly wss = new WebSocketServer({ noServer: true, maxPayload: DEVICE_MAX_FRAME_BYTES });
	/** deviceId → live connection. */
	private readonly connections = new Map<string, DeviceConnection>();
	private readonly pending = new PendingRequests<IosResult>();
	private readonly tunnels = new Map<string, TcpTunnel>();
	/** The dedicated reverse listener, independent from the console's HTTP server. */
	private listener: { server: HttpServer | HttpsServer; host: string; port: number } | undefined;
	private watchdog: ReturnType<typeof setInterval> | undefined;
	private counter = 0;
	/** Set once the gateway is shutting down: close handlers must not touch the store. */
	private closing = false;

	private readonly store: IosStore;
	private readonly hooks: IosGatewayHooks;
	private readonly staleMs: number;
	private readonly watchdogTickMs: number;
	private readonly tls: { cert: string | Buffer; key: string | Buffer } | undefined;

	constructor(store: IosStore, hooks: IosGatewayHooks, options: IosGatewayOptions = {}) {
		this.store = store;
		this.hooks = hooks;
		this.staleMs = options.staleMs ?? IOS_STALE_MS;
		this.watchdogTickMs = options.watchdogTickMs ?? IOS_WATCHDOG_TICK_MS;
		this.tls = options.tls;
	}

	/** HTTP upgrade dispatch: only this path, only a valid token. */
	handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws/ios") return false;
		const token = url.searchParams.get("token") ?? "";
		const record = this.store.findToken(token);
		if (!record) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			this.hooks.log("iOS 设备反连被拒绝：token 无效或已删除");
			return true;
		}
		this.wss.handleUpgrade(request, socket, head, (ws) => this.onConnection(ws, record.id));
		return true;
	}

	private onConnection(ws: WebSocket, tokenId: string): void {
		let device: IosDevice | undefined;
		let helloed = false;

		ws.on("message", (raw: RawData) => {
			let frame: IosDeviceFrame;
			try {
				frame = JSON.parse(raw.toString()) as IosDeviceFrame;
			} catch {
				return;
			}
			// Any frame — heartbeat, result, data chunk — proves the process is running.
			if (device) this.markAlive(device.id, ws);
			if (!helloed) {
				const outcome = this.acceptHello(frame);
				if (!outcome.ok) {
					ws.close(outcome.code, outcome.reason);
					return;
				}
				const hello = outcome.hello;
				// The newest connection for a device wins: an old socket is half-dead.
				const previous = this.connections.get(hello.deviceId);
				if (previous) {
					// Tunnels and in-flight calls belong to the old socket; tear them down
					// instead of leaving them pointed at a closed transport.
					this.pending.failDevice(hello.deviceId, { ok: false, error: t("设备连接已被新连接替换") });
					this.closeDeviceTunnels(hello.deviceId);
					previous.ws.close(4003, "replaced by a new connection");
				}
				device = this.store.upsertDevice(hello, tokenId);
				this.connections.set(hello.deviceId, {
					ws,
					device,
					streams: new StreamAssembler(),
					tcp: new Map(),
					lastFrameAt: Date.now(),
					stale: false,
				});
				this.ensureWatchdog();
				helloed = true;
				this.sendFrame(ws, {
					t: "welcome",
					deviceId: hello.deviceId,
					protocol: IOS_PROTOCOL_VERSION,
				}).catch(() => ws.close());
				this.hooks.log(
					`iOS 设备上线：${device.name}（iOS ${device.osVersion} · ${device.arch} · ${device.jailbreakName || "未知越狱"} ${device.jailbreakForm}${device.hasRoot ? " · root" : ""}）`,
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
				this.onData(device.id, frame.reqId, frame.seq, frame.b64);
				return;
			}
			if (frame.t === "tcp_data") {
				const tunnel = this.tunnels.get(frame.tunnelId);
				// A device may only touch its own tunnel: ids are short, and a
				// compromised device must not write into another device's stream.
				if (!tunnel || tunnel.deviceId !== device.id) return;
				tunnel.connections.get(frame.connId)?.write(Buffer.from(frame.b64, "base64"));
				return;
			}
			if (frame.t === "tcp_closed") {
				const tunnel = this.tunnels.get(frame.tunnelId);
				if (!tunnel || tunnel.deviceId !== device.id) return;
				tunnel.connections.get(frame.connId)?.destroy();
				tunnel.connections.delete(frame.connId);
				return;
			}
			if (frame.t === "tcp_opened") {
				const pending = this.pending.settle(frame.reqId);
				if (!pending) return;
				const tunnel = this.tunnels.get(frame.tunnelId);
				if (tunnel && tunnel.deviceId !== device.id) {
					pending.resolve({ ok: false, error: "tunnel belongs to another device" });
					return;
				}
				const buffered = tunnel?.buffers.get(frame.connId);
				if (tunnel && buffered && frame.ok === true) {
					tunnel.buffers.delete(frame.connId);
					for (const chunk of buffered) {
						void this.sendFrame(ws, {
							t: "tcp_send",
							tunnelId: frame.tunnelId,
							connId: frame.connId,
							b64: chunk.toString("base64"),
						}).catch(() => {});
					}
				} else if (tunnel) {
					tunnel.buffers.delete(frame.connId);
				}
				pending.resolve({ ok: frame.ok === true, error: frame.error });
				return;
			}
			if (frame.t === "result") {
				const pending = this.pending.settle(frame.reqId);
				if (!pending) return;
				const conn = this.connections.get(device.id);
				pending.resolve({
					ok: frame.ok === true,
					code: frame.code,
					stdout: frame.stdout,
					stderr: frame.stderr,
					error: frame.error,
					// Streamed payloads are assembled for every caller; `onData` is the
					// progressive view of the same chunks, not a switch for assembly.
					bytes: conn?.streams.take(frame.reqId),
				});
				return;
			}
			// Protocol guidance: say "unsupported" instead of dropping the frame
			// silently, so a newer device build fails visibly and diagnosably.
			const unknown = frame as { reqId?: unknown };
			if (typeof unknown.reqId === "string") {
				void this.sendFrame(ws, {
					t: "result",
					reqId: unknown.reqId,
					ok: false,
					error: "unsupported",
				}).catch(() => {});
			}
		});

		ws.on("close", () => {
			if (!device) return;
			// A replaced connection must not unregister its successor.
			const current = this.connections.get(device.id);
			if (current && current.ws !== ws) return;
			this.connections.delete(device.id);
			this.stopWatchdogIfIdle();
			if (!this.closing) this.store.setDeviceOnline(device.id, false);
			this.closeDeviceTunnels(device.id);
			this.pending.failDevice(device.id, { ok: false, error: t("设备连接已断开") });
			if (this.closing) return;
			this.hooks.log(`iOS 设备离线：${device.name}`);
			this.hooks.onDeviceChange();
		});
		ws.on("error", () => ws.close());
		ws.on("close", (code: number, reason: Buffer) => {
			const name = device?.name ?? "未握手设备";
			this.hooks.log(`iOS 设备断开：${name}（code ${code}${reason.length > 0 ? `，${reason.toString()}` : ""}）`);
		});
	}

	/**
	 * Validate the handshake. Everything here is a refusal the device can act on,
	 * so each reason names the fix instead of a generic "bad handshake".
	 */
	private acceptHello(
		frame: IosDeviceFrame,
	): { ok: true; hello: IosHelloFrame } | { ok: false; code: number; reason: string } {
		if (frame.t !== "hello") return { ok: false, code: 4001, reason: "handshake required" };
		const hello = frame as IosHelloFrame;
		if (hello.platform !== "ios") return { ok: false, code: 4002, reason: "platform mismatch" };
		if (Number(hello.protocol) !== IOS_PROTOCOL_VERSION) {
			return { ok: false, code: 4002, reason: `protocol ${IOS_PROTOCOL_VERSION} required` };
		}
		if (!hello.deviceId || typeof hello.deviceId !== "string") {
			return { ok: false, code: 4002, reason: "deviceId required" };
		}
		// roothide hides the jailbreak root behind a per-app random path, so every
		// launchd and dpkg step in this design is wrong there. Refusing is honest;
		// pretending to support it would produce a device that connects and then
		// fails every privileged action.
		if (normalizeJailbreakForm(hello.jailbreak?.form) === "roothide") {
			return { ok: false, code: 4005, reason: "roothide is not supported" };
		}
		return { ok: true, hello };
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
	 * one wait out its own timeout.
	 */
	private sweepLiveness(): void {
		const now = Date.now();
		for (const [deviceId, conn] of this.connections) {
			if (conn.stale || now - conn.lastFrameAt <= this.staleMs) continue;
			conn.stale = true;
			const idleMs = now - conn.lastFrameAt;
			this.hooks.log(
				`iOS 设备无响应：${conn.device.name}（已 ${Math.round(idleMs / 1000)}s 未收到心跳，进程可能被挂起或卡死）`,
			);
			this.pending.failDevice(deviceId, { ok: false, error: unresponsiveMessage(idleMs) });
			conn.streams.clear();
			this.hooks.onDeviceChange();
		}
	}

	/** The first frame after a freeze means the process is executing again. */
	private markAlive(deviceId: string, ws: WebSocket): void {
		const conn = this.connections.get(deviceId);
		// A replaced socket must not refresh its successor's liveness.
		if (!conn || conn.ws !== ws) return;
		conn.lastFrameAt = Date.now();
		if (!conn.stale) return;
		conn.stale = false;
		this.hooks.log(`iOS 设备恢复响应：${conn.device.name}`);
		this.hooks.onDeviceChange();
	}

	/** Staleness at this instant: the sweep lags by up to one tick, callers must not. */
	private isStale(conn: DeviceConnection, now = Date.now()): boolean {
		return conn.stale || now - conn.lastFrameAt > this.staleMs;
	}

	private staleFailure(conn: DeviceConnection): IosResult {
		return { ok: false, error: unresponsiveMessage(Date.now() - conn.lastFrameAt) };
	}

	/** Runtime liveness of one device, for the console's device list. */
	livenessOf(deviceId: string): { stale: boolean; idleMs: number } | undefined {
		const conn = this.connections.get(deviceId);
		if (!conn) return undefined;
		return { stale: this.isStale(conn), idleMs: Date.now() - conn.lastFrameAt };
	}

	/** Assemble one streamed payload; a broken sequence fails the request. */
	private onData(deviceId: string, reqId: string, seq: number, b64: string): void {
		const conn = this.connections.get(deviceId);
		const pending = this.pending.get(reqId);
		if (!conn || !pending) return;
		const outcome = conn.streams.push(reqId, seq, b64, { buffer: !pending.onData });
		if (!outcome.ok) {
			conn.streams.discard(reqId);
			this.pending.fail(reqId, { ok: false, error: outcome.error ?? t("流解析失败") });
			return;
		}
		if (pending.onData && outcome.chunk) pending.onData(outcome.chunk);
		// The stream is consumed (and freed) by the `result` frame; `done` only tells
		// the device it can close its file handle.
	}

	/** Connected devices, annotated with whether the process still answers. */
	onlineDevices(): IosDevice[] {
		const at = Date.now();
		return [...this.connections.values()]
			.map((conn) => ({ conn, device: this.store.getDevice(conn.device.id) }))
			.filter((entry): entry is { conn: DeviceConnection; device: IosDevice } => entry.device !== undefined)
			.map(({ conn, device }) => ({
				...device,
				stale: this.isStale(conn, at),
				idleMs: at - conn.lastFrameAt,
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

	/** The dedicated listener the device page bound, if any. */
	listenInfo(): { host: string; port: number } | undefined {
		return this.listener ? { host: this.listener.host, port: this.listener.port } : undefined;
	}

	/**
	 * Bind a reverse-connection listener that is independent from the console's
	 * own HTTP server, so the operator can choose 0.0.0.0 / one NIC / loopback
	 * and rebind without touching the console port. Auth and path rules are the
	 * same as the console-hosted upgrade: the device token is the credential.
	 */
	async listen(host: string, port: number): Promise<{ ok: boolean; port?: number; error?: string }> {
		this.stopListener();
		const server = this.tls ? createHttpsServer(this.tls) : createHttpServer();
		// A plain GET here is an operator probing the port from a phone browser:
		// answer immediately instead of leaving the request hanging.
		server.on("request", (_request, response) => {
			response.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("SentinelBridge iOS listener: WebSocket upgrade required (path /ws/ios?token=...)\n");
		});
		server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
			this.handleUpgrade(request, socket, head);
		});
		return new Promise((resolve) => {
			server.once("error", (error: Error) => {
				if (this.listener?.server === server) this.listener = undefined;
				resolve({ ok: false, error: t("监听失败：{error}", { error: error.message }) });
			});
			server.listen(port, host === "0.0.0.0" || host === "::" ? undefined : host, () => {
				const boundPort = (server.address() as AddressInfo).port;
				this.listener = { server, host, port: boundPort };
				resolve({ ok: true, port: boundPort });
			});
		});
	}

	stopListener(): void {
		if (!this.listener) return;
		this.listener.server.close();
		this.listener = undefined;
	}

	/**
	 * Open a TCP tunnel: a loopback listener whose connections are bridged into
	 * `targetHost:targetPort` on the device. The container reaches it via
	 * host.docker.internal; the host via 127.0.0.1. A live tunnel for the same
	 * target is reused rather than duplicated.
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
		const tunnelId = `it${Date.now().toString(36)}${this.counter.toString(36)}`;
		const tunnel: TcpTunnel = {
			deviceId,
			server: createTcpServer(),
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
				const reqId = `it${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
				tunnel.connections.set(connId, socket);
				// Clients like frida write their handshake immediately, before the
				// device has finished dialing: buffer until tcp_opened, then flush.
				tunnel.buffers.set(connId, []);
				this.pending.add(reqId, deviceId, {
					timeoutMs: 10_000,
					timeoutValue: { ok: false, error: t("隧道建立超时") },
					resolve: (result) => {
						if (result.ok) return;
						tunnel.connections.delete(connId);
						socket.destroy();
					},
				});
				void this.sendFrame(conn.ws, {
					t: "tcp_open",
					reqId,
					tunnelId,
					connId,
					host: targetHost,
					port: targetPort,
				}).catch(() => socket.destroy());
				socket.on("data", (chunk: Buffer) => {
					if (this.connections.get(deviceId) !== conn) return;
					const buffer = tunnel.buffers.get(connId);
					if (buffer) {
						// The device-side dial is still in flight; hold the bytes in order.
						buffer.push(chunk);
						return;
					}
					void this.sendFrame(conn.ws, {
						t: "tcp_send",
						tunnelId,
						connId,
						b64: chunk.toString("base64"),
					}).catch(() => socket.destroy());
				});
				socket.on("close", () => {
					tunnel.connections.delete(connId);
					tunnel.buffers.delete(connId);
					if (this.connections.get(deviceId) === conn) {
						void this.sendFrame(conn.ws, { t: "tcp_close", tunnelId, connId }).catch(() => {});
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

	/** Drop every tunnel belonging to one device (disconnect or replacement). */
	private closeDeviceTunnels(deviceId: string): void {
		for (const [tunnelId, tunnel] of [...this.tunnels.entries()]) {
			if (tunnel.deviceId !== deviceId) continue;
			for (const socket of tunnel.connections.values()) socket.destroy();
			tunnel.server.close();
			this.tunnels.delete(tunnelId);
		}
	}

	closeTunnel(tunnelId: string): boolean {
		const tunnel = this.tunnels.get(tunnelId);
		if (!tunnel) return false;
		for (const socket of tunnel.connections.values()) socket.destroy();
		tunnel.server.close();
		this.tunnels.delete(tunnelId);
		return true;
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
	 * Send a request to a device and await its final result. Streamed payloads are
	 * assembled into `bytes` when `onData` is absent; when it is present each chunk
	 * goes straight to the consumer (the streaming path used for large pulls).
	 */
	request(
		deviceId: string,
		req: IosRequestInput,
		options: { timeoutMs?: number; onData?: (chunk: Buffer) => void } = {},
	): Promise<IosResult> {
		const conn = this.connections.get(deviceId);
		if (!conn) return Promise.resolve({ ok: false, error: t("设备不在线") });
		if (this.isStale(conn)) return Promise.resolve(this.staleFailure(conn));
		this.counter += 1;
		const reqId = `i${Date.now().toString(36)}${this.counter.toString(36)}${randomUUID().slice(0, 8)}`;
		const timeoutMs = options.timeoutMs ?? 30_000;
		const frame: Record<string, unknown> = { ...req, reqId };
		return new Promise<IosResult>((resolve) => {
			this.pending.add(reqId, deviceId, {
				timeoutMs,
				timeoutValue: {
					ok: false,
					error: t("设备响应超时（{seconds}s）", { seconds: Math.max(1, Math.round(timeoutMs / 1000)) }),
				},
				resolve,
				onData: options.onData,
				onTimeout: () => conn.streams.discard(reqId),
			});
			this.sendFrame(conn.ws, frame, reqId).catch((error: Error) => {
				conn.streams.discard(reqId);
				this.pending.fail(reqId, { ok: false, error: t("发送失败：{error}", { error: error.message }) });
			});
		});
	}

	/**
	 * Write a file onto a device in `push` chunks. One request id spans every
	 * chunk, so the device answers exactly once (the `done` chunk).
	 *
	 * Chunks are sent one at a time, each awaited: the socket drains as the device
	 * appends, instead of the whole file queueing in the gateway's send buffer.
	 */
	pushFile(
		deviceId: string,
		path: string,
		bytes: Buffer,
		options: { mode?: string; timeoutMs?: number } = {},
	): Promise<IosResult> {
		const conn = this.connections.get(deviceId);
		if (!conn) return Promise.resolve({ ok: false, error: t("设备不在线") });
		if (this.isStale(conn)) return Promise.resolve(this.staleFailure(conn));
		this.counter += 1;
		const reqId = `i${Date.now().toString(36)}${this.counter.toString(36)}${randomUUID().slice(0, 8)}`;
		// A slow link must not trip the timeout mid-transfer: the floor is a
		// generous 100 KB/s, so only a genuinely stuck push gives up.
		const timeoutMs = Math.max(options.timeoutMs ?? 30_000, 30_000 + Math.ceil(bytes.length / 100_000) * 1000);
		return new Promise<IosResult>((resolve) => {
			this.pending.add(reqId, deviceId, {
				timeoutMs,
				timeoutValue: {
					ok: false,
					error: t("设备响应超时（{seconds}s）", { seconds: Math.max(1, Math.round(timeoutMs / 1000)) }),
				},
				resolve,
				onTimeout: () => conn.streams.discard(reqId),
			});
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
		const total = Math.max(1, Math.ceil(bytes.length / DEVICE_PUSH_CHUNK_BYTES));
		try {
			for (let seq = 0; seq < total; seq += 1) {
				// The push may have already failed (timeout, disconnect): stop sending.
				if (!this.pending.has(reqId)) return;
				if (this.connections.get(deviceId) !== conn) {
					this.pending.fail(reqId, { ok: false, error: t("设备连接已断开") });
					return;
				}
				const chunk = bytes.subarray(seq * DEVICE_PUSH_CHUNK_BYTES, (seq + 1) * DEVICE_PUSH_CHUNK_BYTES);
				await this.sendFrame(
					conn.ws,
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
			this.pending.fail(reqId, {
				ok: false,
				error: t("发送失败：{error}", { error: error instanceof Error ? error.message : String(error) }),
			});
		}
	}

	/**
	 * The one place an outgoing frame leaves the gateway, so no caller can put a
	 * bulk payload in a single message. `reqId` is for streaming callers: the send
	 * callback only fires once the socket drains, so a request that already failed
	 * would otherwise keep the chunk loop waiting on a socket that stopped draining.
	 */
	private sendFrame(ws: WebSocket, frame: Record<string, unknown>, reqId?: string): Promise<void> {
		const encoded = encodeFrame(frame);
		if (!encoded.ok) return Promise.reject(new Error(encoded.error ?? t("帧过大")));
		const text = encoded.text as string;
		return new Promise((resolve, reject) => {
			const watch = reqId
				? setInterval(() => {
						if (this.pending.has(reqId)) return;
						clearInterval(watch);
						resolve();
					}, 500)
				: undefined;
			ws.send(text, (error) => {
				if (watch) clearInterval(watch);
				if (error) reject(error);
				else resolve();
			});
		});
	}

	/** Close every device connection, tunnel and pending request. */
	close(): void {
		this.closing = true;
		this.stopListener();
		for (const conn of this.connections.values()) conn.ws.close(1001, "server shutdown");
		this.connections.clear();
		for (const tunnelId of [...this.tunnels.keys()]) this.closeTunnel(tunnelId);
		this.pending.clear();
		if (this.watchdog) {
			clearInterval(this.watchdog);
			this.watchdog = undefined;
		}
		this.wss.close();
	}
}
