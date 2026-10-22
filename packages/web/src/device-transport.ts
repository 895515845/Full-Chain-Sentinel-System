/**
 * Transport primitives shared by the device gateways (Android today, iOS next).
 *
 * The two gateways speak the same wire shape: JSON request/result frames, a
 * chunked binary payload carried in `data` frames under one request id, and a
 * TCP-over-WebSocket tunnel. None of that is platform specific, and the parts
 * that are easy to get subtly wrong — sequence checking, the size ceilings, the
 * request/timeout registry — are exactly the parts that must not exist twice.
 *
 * DroidGateway still carries its own copy of this logic; iOS uses these helpers
 * from day one. The plan is to migrate Android onto them once the iOS side has
 * proven the shape, not to rewrite a working gateway in the same change.
 */

import { t } from "./i18n.ts";

/** A single streamed payload (pull, screenshot, pcap) may not exceed this. */
export const DEVICE_MAX_STREAM_BYTES = 256 * 1024 * 1024;

/** One WebSocket frame (one base64 chunk) may not exceed this. */
export const DEVICE_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Raw bytes per `push` chunk. 1 MB of file becomes ~1.37 MB of base64, far under
 * one frame, and bounds what the device holds while writing: it appends each
 * chunk to a file instead of assembling the payload in memory.
 */
export const DEVICE_PUSH_CHUNK_BYTES = 512 * 1024;

export interface FrameEncoding {
	ok: boolean;
	text?: string;
	error?: string;
}

/**
 * Serialize one outgoing frame and refuse it when the result would exceed the
 * frame ceiling. Every send goes through here: a single oversized message is
 * what takes a phone down (it materializes the JSON text, the base64 string and
 * the decoded bytes at once).
 */
export function encodeFrame(frame: Record<string, unknown>): FrameEncoding {
	const text = JSON.stringify(frame);
	const size = Buffer.byteLength(text);
	if (size > DEVICE_MAX_FRAME_BYTES) {
		return {
			ok: false,
			error: t("单帧 {size} 字节超过 {limit} 上限，请拆分请求或分片发送", {
				size,
				limit: DEVICE_MAX_FRAME_BYTES,
			}),
		};
	}
	return { ok: true, text };
}

interface StreamState {
	chunks: Buffer[];
	bytes: number;
	nextSeq: number;
}

export interface PushChunkResult {
	ok: boolean;
	/** The decoded bytes of this frame, when the sequence was valid. */
	chunk?: Buffer;
	error?: string;
}

/**
 * Reassembles one request's `data` frames.
 *
 * The sequence check is the point: a gateway that concatenates whatever arrives
 * turns a reordered or duplicated frame into a corrupt file that still reports
 * success, and the operator finds out when the evidence is unusable.
 *
 * `buffer: false` is the streaming path: the chunk goes to the caller and is not
 * kept here, so a 256 MB pull does not sit in the gateway heap as well.
 */
export class StreamAssembler {
	private readonly streams = new Map<string, StreamState>();

	push(
		reqId: string,
		seq: number,
		b64: string,
		options: { buffer?: boolean; limitBytes?: number } = {},
	): PushChunkResult {
		const limit = options.limitBytes ?? DEVICE_MAX_STREAM_BYTES;
		let stream = this.streams.get(reqId);
		if (!stream) {
			stream = { chunks: [], bytes: 0, nextSeq: 0 };
			this.streams.set(reqId, stream);
		}
		if (seq !== stream.nextSeq) {
			return {
				ok: false,
				error: t("流分片乱序：期望 {expected}，收到 {actual}", { expected: stream.nextSeq, actual: seq }),
			};
		}
		const chunk = Buffer.from(b64, "base64");
		stream.bytes += chunk.length;
		if (stream.bytes > limit) {
			return { ok: false, error: t("流超过大小上限 {limit} 字节", { limit }) };
		}
		stream.nextSeq += 1;
		if (options.buffer !== false) stream.chunks.push(chunk);
		return { ok: true, chunk };
	}

	/** The assembled payload and its request id entry, freed in one step. */
	take(reqId: string): Buffer | undefined {
		const stream = this.streams.get(reqId);
		if (!stream) return undefined;
		this.streams.delete(reqId);
		return stream.chunks.length > 0 ? Buffer.concat(stream.chunks) : Buffer.alloc(0);
	}

	discard(reqId: string): void {
		this.streams.delete(reqId);
	}

	bytesOf(reqId: string): number | undefined {
		return this.streams.get(reqId)?.bytes;
	}

	clear(): void {
		this.streams.clear();
	}
}

export interface PendingRequest<T> {
	deviceId: string;
	resolve: (value: T) => void;
	timer: ReturnType<typeof setTimeout>;
	/** Progressive consumer; when present the assembler does not also buffer. */
	onData?: (chunk: Buffer) => void;
}

/**
 * Request id → resolver, with the timeout owned in one place.
 *
 * The timeout value is supplied by the caller (it carries the localized error),
 * and `failDevice` is what lets a disconnect or a frozen app fail every call for
 * that device at once instead of letting each one wait out its own timer.
 */
export class PendingRequests<T> {
	private readonly entries = new Map<string, PendingRequest<T>>();

	add(
		reqId: string,
		deviceId: string,
		options: {
			timeoutMs: number;
			timeoutValue: T;
			resolve: (value: T) => void;
			onData?: (chunk: Buffer) => void;
			/** Cleanup for state the caller owns (stream assembly) on timeout. */
			onTimeout?: () => void;
		},
	): void {
		const timer = setTimeout(() => {
			if (!this.entries.delete(reqId)) return;
			options.onTimeout?.();
			options.resolve(options.timeoutValue);
		}, options.timeoutMs);
		const entry: PendingRequest<T> = { deviceId, resolve: options.resolve, timer, onData: options.onData };
		this.entries.set(reqId, entry);
	}

	get(reqId: string): PendingRequest<T> | undefined {
		return this.entries.get(reqId);
	}

	/** Remove and stop the timer; the caller decides what to resolve with. */
	settle(reqId: string): PendingRequest<T> | undefined {
		const entry = this.entries.get(reqId);
		if (!entry) return undefined;
		this.entries.delete(reqId);
		clearTimeout(entry.timer);
		return entry;
	}

	fail(reqId: string, value: T): boolean {
		const entry = this.settle(reqId);
		if (!entry) return false;
		entry.resolve(value);
		return true;
	}

	/** Fail every call still in flight for one device; returns how many. */
	failDevice(deviceId: string, value: T): number {
		let count = 0;
		for (const [reqId, entry] of [...this.entries.entries()]) {
			if (entry.deviceId !== deviceId) continue;
			this.entries.delete(reqId);
			clearTimeout(entry.timer);
			entry.resolve(value);
			count += 1;
		}
		return count;
	}

	has(reqId: string): boolean {
		return this.entries.has(reqId);
	}

	get size(): number {
		return this.entries.size;
	}

	clear(): void {
		for (const entry of this.entries.values()) clearTimeout(entry.timer);
		this.entries.clear();
	}
}
