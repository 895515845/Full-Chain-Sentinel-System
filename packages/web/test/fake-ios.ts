/**
 * A fake SentinelBridge for the gateway tests.
 *
 * It is a plain WebSocket client that speaks the same frames the real daemon
 * will: hello, heartbeats, exec results, chunked data and pull/push. Tests drive
 * the parts they care about (a frozen device, a reordered stream, a dropped
 * socket) by turning `autoReply` off and sending frames by hand.
 */

import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import type { IosHelloFrame, IosJailbreakForm } from "../src/ios-protocol.ts";

export interface FakeIosOptions {
	model?: string;
	osVersion?: string;
	build?: string;
	arch?: string;
	jailbreakForm?: IosJailbreakForm;
	jailbreakName?: string;
	hasRoot?: boolean;
	/** Answer exec automatically with `ran:<cmd>`; default true. */
	autoReply?: boolean;
	protocol?: number;
	platform?: string;
}

export class FakeIos {
	ws?: WebSocket;
	received: Array<Record<string, unknown>> = [];
	/** Payload chunks of an in-flight push, by request id. */
	readonly pushes = new Map<string, Buffer[]>();
	autoReply: boolean;
	closeCode?: number;
	closeReason?: string;
	/** Called for every frame before the built-in auto-replies run. */
	onFrame?: (frame: Record<string, unknown>) => void;

	readonly deviceId: string;
	private readonly token: string;
	private readonly options: FakeIosOptions;

	constructor(deviceId: string, token: string, options: FakeIosOptions = {}) {
		this.deviceId = deviceId;
		this.token = token;
		this.options = options;
		this.autoReply = options.autoReply ?? true;
	}

	helloFrame(): IosHelloFrame {
		const form = this.options.jailbreakForm ?? "rootless";
		return {
			t: "hello",
			protocol: this.options.protocol ?? 1,
			platform: (this.options.platform ?? "ios") as "ios",
			token: this.token,
			deviceId: this.deviceId,
			model: this.options.model ?? "iPhone15,2",
			osVersion: this.options.osVersion ?? "16.6.1",
			build: this.options.build ?? "20G75",
			arch: this.options.arch ?? "arm64e",
			jailbreak: {
				form,
				name: this.options.jailbreakName ?? (form === "rootful" ? "palera1n" : "Dopamine"),
				version: "2.0",
			},
			hasRoot: this.options.hasRoot ?? true,
			appVersion: "0.1.0",
			capabilities: ["exec", "pull", "push", "screencap", "tcp"],
		};
	}

	connect(url = ""): Promise<void> {
		return new Promise((resolve, reject) => {
			let welcomed = false;
			const ws = new WebSocket(`${url}/ws/ios?token=${this.token}`);
			ws.on("open", () => ws.send(JSON.stringify(this.helloFrame())));
			ws.on("message", (raw) => {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				if (frame.t === "welcome") {
					welcomed = true;
					resolve();
					return;
				}
				this.received.push(frame);
				this.onFrame?.(frame);
				if (this.autoReply && frame.t === "exec") {
					ws.send(
						JSON.stringify({
							t: "result",
							reqId: frame.reqId,
							ok: true,
							code: 0,
							stdout: `ran:${frame.cmd}`,
						}),
					);
				}
				// Chunked push, like the daemon: append per request, answer only on `done`.
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
			ws.on("close", (code, reason) => {
				this.closeCode = code;
				this.closeReason = reason.toString();
				// A refused handshake closes without a welcome; do not hang the test.
				if (!welcomed) reject(new Error(`closed before welcome: ${code} ${reason.toString()}`));
			});
			ws.on("error", reject);
			this.ws = ws;
		});
	}

	send(frame: Record<string, unknown>): void {
		this.ws?.send(JSON.stringify(frame));
	}

	/** The last request frame of a type, so a test can answer it by id. */
	lastRequest(t: string): Record<string, unknown> | undefined {
		for (let i = this.received.length - 1; i >= 0; i -= 1) {
			if (this.received[i]?.t === t) return this.received[i];
		}
		return undefined;
	}

	close(): void {
		this.ws?.close();
	}
}

export function wsUrlOf(server: { address(): AddressInfo | string | null }): string {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server has no TCP address");
	return `ws://127.0.0.1:${address.port}`;
}
