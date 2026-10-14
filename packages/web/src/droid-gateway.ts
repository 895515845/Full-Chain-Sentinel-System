/**
 * The device gateway: the server side of DroidBridge's reverse connection.
 *
 * The device dials `ws(s)://console/ws/droid?token=…` — outbound from the
 * operator's network, so the server opens no port toward the phone and the
 * topology survives NAT. One gateway owns every connected device; agent tools
 * ask it to send a request frame and await the device's result, which keeps the
 * tools free of any WebSocket plumbing.
 *
 * A device must say `hello` with a valid, non-revoked token before anything
 * else; frames arriving before the handshake, or a second connection for the
 * same deviceId, are dropped (the newest connection wins for the hello case,
 * because a phone that lost its network half-closes the old socket first).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { DroidDevice, DroidHello, DroidStore } from "./droid.ts";
import {
	DROID_MAX_FRAME_BYTES,
	DROID_MAX_STREAM_BYTES,
	type DroidDeviceFrame,
	type DroidRequestInput,
	type DroidResult,
} from "./droid-protocol.ts";

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
	private counter = 0;

	private readonly store: DroidStore;
	private readonly hooks: DroidGatewayHooks;

	constructor(store: DroidStore, hooks: DroidGatewayHooks) {
		this.store = store;
		this.hooks = hooks;
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
			this.hooks.log("设备反连被拒绝：token 无效或已吊销");
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
				this.connections.set(hello.deviceId, { ws, device, streams: new Map() });
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
			this.store.setDeviceOnline(device.id, false);
			this.failPendingOf(device.id, "设备连接已断开");
			this.hooks.log(`设备离线：${device.name}`);
			this.hooks.onDeviceChange();
		});
		ws.on("error", () => ws.close());
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
			this.fail(reqId, `流分片乱序：期望 ${stream.nextSeq}，收到 ${seq}`);
			conn.streams.delete(reqId);
			return;
		}
		stream.nextSeq += 1;
		const chunk = Buffer.from(b64, "base64");
		stream.bytes += chunk.length;
		if (stream.bytes > DROID_MAX_STREAM_BYTES) {
			this.fail(reqId, "流超过大小上限");
			conn.streams.delete(reqId);
			return;
		}
		stream.chunks.push(chunk);
		pending.onData?.(chunk);
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

	onlineDevices(): DroidDevice[] {
		return [...this.connections.values()]
			.map((conn) => conn.device)
			.map((device) => this.store.getDevice(device.id))
			.filter((device): device is DroidDevice => device !== undefined);
	}

	onlineDeviceIds(): string[] {
		return [...this.connections.keys()];
	}

	isOnline(deviceId: string): boolean {
		return this.connections.has(deviceId);
	}

	/** Drop a device's connection (token revoked, device removed). */
	disconnect(deviceId: string): void {
		this.connections.get(deviceId)?.ws.close(4004, "revoked");
	}

	/**
	 * Send a request to a device and await its final result. Streamed payloads are
	 * assembled into `bytes` when `onData` is absent, forwarded when present.
	 */
	request(
		deviceId: string,
		req: DroidRequestInput,
		options: { timeoutMs?: number; onData?: (chunk: Buffer) => void } = {},
	): Promise<DroidResult> {
		const conn = this.connections.get(deviceId);
		if (!conn) return Promise.resolve({ ok: false, error: "设备不在线" });
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
				resolve({ ok: false, error: `设备响应超时（${Math.round((options.timeoutMs ?? 30000) / 1000)}s）` });
			}, options.timeoutMs ?? 30000);
			this.pending.set(reqId, { resolve, timer, onData: options.onData });
			conn.ws.send(JSON.stringify(frame), (error) => {
				if (error) {
					this.pending.delete(reqId);
					this.pendingDevices.delete(reqId);
					clearTimeout(timer);
					resolve({ ok: false, error: `发送失败：${error.message}` });
				}
			});
		});
	}
}
