/**
 * The wire protocol between DroidBridge (the APK) and the console's device
 * gateway, over the reverse WebSocket the device dials out on.
 *
 * JSON frames only; binary payloads (screenshots, pulled files, pcaps) travel as
 * base64 `data` frames chunked under the request id, because one WS message is
 * not a place to hide a 300 MB pcap. Everything is request/response with an id
 * the device echoes, so many requests can be in flight and a slow command cannot
 * block the channel.
 *
 * The APK implements exactly this document — keep it the source of truth.
 */

/** Server → device: ask the device to run a shell command (root shell when asRoot). */
export interface DroidExecRequest {
	t: "exec";
	reqId: string;
	cmd: string;
	asRoot: boolean;
	timeoutMs: number;
}

/** Server → device: stream a file on the device back in `data` frames. */
export interface DroidPullRequest {
	t: "pull";
	reqId: string;
	path: string;
	/** Refusal guard: the device must not stream more than this many bytes. */
	maxBytes: number;
}

/** Server → device: write a file on the device. */
export interface DroidPushRequest {
	t: "push";
	reqId: string;
	path: string;
	b64: string;
	/** "0700" by default; executable when the agent pushes a tool binary. */
	mode?: string;
}

/** Server → device: full-screen screenshot as PNG (returns through `data` frames). */
export interface DroidScreencapRequest {
	t: "screencap";
	reqId: string;
}

/** Server → device: last N logcat lines, optional tag/level filter. */
export interface DroidLogcatRequest {
	t: "logcat";
	reqId: string;
	lines: number;
	filter?: string;
}

/** Server → device: installed packages. */
export interface DroidPackagesRequest {
	t: "packages";
	reqId: string;
	thirdPartyOnly: boolean;
}

/** Server → device: packet capture lifecycle. */
export interface DroidCaptureStartRequest {
	t: "capture_start";
	reqId: string;
	iface: string;
	seconds: number;
}
export interface DroidCaptureStopRequest {
	t: "capture_stop";
	reqId: string;
}
export interface DroidCaptureStatusRequest {
	t: "capture_status";
	reqId: string;
}

export type DroidRequest =
	| DroidExecRequest
	| DroidPullRequest
	| DroidPushRequest
	| DroidScreencapRequest
	| DroidLogcatRequest
	| DroidPackagesRequest
	| DroidCaptureStartRequest
	| DroidCaptureStopRequest
	| DroidCaptureStatusRequest;

/** Device → server: handshake. Everything else is refused before this. */
export interface DroidHelloFrame {
	t: "hello";
	token: string;
	deviceId: string;
	model: string;
	androidVersion: string;
	sdkInt: number;
	rooted: boolean;
}

/** Device → server: keepalive; the gateway refreshes the device's last-seen. */
export interface DroidHeartbeatFrame {
	t: "hb";
}

/** Device → server: streamed payload chunk for a request id. */
export interface DroidDataFrame {
	t: "data";
	reqId: string;
	seq: number;
	b64: string;
	done: boolean;
}

/** Device → server: the final answer for a request id. */
export interface DroidResultFrame {
	t: "result";
	reqId: string;
	ok: boolean;
	code?: number;
	stdout?: string;
	stderr?: string;
	error?: string;
}

export type DroidDeviceFrame = DroidHelloFrame | DroidHeartbeatFrame | DroidDataFrame | DroidResultFrame;

/** A request without its id: the gateway assigns one. */
type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
export type DroidRequestInput = DistributiveOmit<DroidRequest, "reqId">;

/** The aggregated answer the gateway hands a caller after a request completes. */
export interface DroidResult {
	ok: boolean;
	code?: number;
	stdout?: string;
	stderr?: string;
	error?: string;
	/** Assembled `data` chunks in sequence order (pull / screencap / pcap). */
	bytes?: Buffer;
}

/** Guard: a single streamed payload must stay under this size. */
export const DROID_MAX_STREAM_BYTES = 256 * 1024 * 1024;

/** Guard: one WS frame (one base64 chunk) must stay under this size. */
export const DROID_MAX_FRAME_BYTES = 8 * 1024 * 1024;
