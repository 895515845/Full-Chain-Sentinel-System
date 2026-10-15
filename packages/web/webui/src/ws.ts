/** WebSocket client with auto-reconnect. */

import type { SentinelClientMessage, SentinelServerMessage } from "./types.ts";

export class SentinelConnection {
	private socket: WebSocket | null = null;
	private closed = false;
	private reconnectDelay = 500;
	private queue: SentinelClientMessage[] = [];

	constructor(
		private readonly onMessage: (message: SentinelServerMessage) => void,
		/** Reports every open and close, so the UI can show the real connection state. */
		private readonly onStatus: (connected: boolean) => void = () => {},
	) {}

	connect(): void {
		this.closed = false;
		this.open();
	}

	private open(): void {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
		this.socket = socket;
		socket.onopen = () => {
			this.reconnectDelay = 500;
			this.onStatus(true);
			for (const message of this.queue.splice(0)) socket.send(JSON.stringify(message));
		};
		socket.onmessage = (event) => {
			try {
				this.onMessage(JSON.parse(String(event.data)) as SentinelServerMessage);
			} catch {
				// Ignore malformed frames.
			}
		};
		socket.onclose = () => {
			this.socket = null;
			this.onStatus(false);
			if (this.closed) return;
			window.setTimeout(() => this.open(), this.reconnectDelay);
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
		};
		socket.onerror = () => socket.close();
	}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	send(message: SentinelClientMessage): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(message));
		} else {
			this.queue.push(message);
		}
	}

	close(): void {
		this.closed = true;
		this.socket?.close();
	}
}
