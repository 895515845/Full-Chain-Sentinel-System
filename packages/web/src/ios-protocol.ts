/**
 * Wire protocol between SentinelBridge iOS and the console's iOS gateway.
 *
 * It is deliberately the same shape as the Android protocol: JSON control
 * frames, binary payloads chunked under one request id, and a TCP-over-WS
 * tunnel. A phone is a phone on the wire; only the handshake and the capability
 * set differ. Keeping the shapes aligned is what lets the tool layer, the
 * evidence paths and the operator's mental model carry over.
 *
 * The device implements this document. Treat it as the source of truth.
 */

import { DEVICE_MAX_FRAME_BYTES, DEVICE_MAX_STREAM_BYTES, DEVICE_PUSH_CHUNK_BYTES } from "./device-transport.ts";

/** Bumped only when a frame changes shape; the console refuses what it cannot read. */
export const IOS_PROTOCOL_VERSION = 1;

export const IOS_MAX_STREAM_BYTES = DEVICE_MAX_STREAM_BYTES;
export const IOS_MAX_FRAME_BYTES = DEVICE_MAX_FRAME_BYTES;
export const IOS_PUSH_CHUNK_BYTES = DEVICE_PUSH_CHUNK_BYTES;

/** Which jailbreak layout the device runs; paths and launchctl differ per form. */
export type IosJailbreakForm = "rootful" | "rootless" | "roothide" | "unknown";

/** Anything the console mounts a tool for. Unknown strings are ignored. */
export type IosCapability =
	| "exec"
	| "pull"
	| "push"
	| "screencap"
	| "tcp"
	| "syslog"
	| "apps"
	| "app_info"
	| "ipa_pull"
	| "profiles"
	| "install_ipa"
	| "frida"
	| "decrypt"
	| "keychain";

export interface IosJailbreak {
	form: IosJailbreakForm;
	/** e.g. Dopamine, palera1n, unc0ver. Empty when the device cannot tell. */
	name: string;
	version: string;
}

/** Device → server: handshake. Everything else is refused before this. */
export interface IosHelloFrame {
	t: "hello";
	protocol: number;
	platform: "ios";
	token: string;
	deviceId: string;
	model: string;
	osVersion: string;
	build?: string;
	/** arm64 / arm64e; arm64e matters for PAC-aware tooling. */
	arch: string;
	jailbreak: IosJailbreak;
	hasRoot: boolean;
	appVersion?: string;
	capabilities?: IosCapability[];
}

/** Server → device: handshake accepted, and the console's protocol version. */
export interface IosWelcomeFrame {
	t: "welcome";
	deviceId: string;
	protocol: number;
}

/** Device → server: keepalive; the gateway refreshes the device's last-seen. */
export interface IosHeartbeatFrame {
	t: "hb";
}

/** Server → device: run one shell command (root when asRoot). */
export interface IosExecRequest {
	t: "exec";
	reqId: string;
	cmd: string;
	asRoot: boolean;
	timeoutMs: number;
}

/** Server → device: stream a file on the device back in `data` frames. */
export interface IosPullRequest {
	t: "pull";
	reqId: string;
	path: string;
	/** Refusal guard: the device must not stream more than this many bytes. */
	maxBytes: number;
}

/** Server → device: stream one file over HTTPS instead of WebSocket frames. */
export interface IosUploadRequest {
	t: "upload";
	reqId: string;
	path: string;
	/** Console-side session created by the tool. */
	uploadId: string;
	maxBytes: number;
}

/**
 * Server → device: write a file, one chunk at a time.
 *
 * `seq: 0` opens (truncates) the target and later chunks append; only the chunk
 * carrying `done: true` is answered with a `result` frame. The whole file must
 * never ride in one message (see DEVICE_PUSH_CHUNK_BYTES).
 */
export interface IosPushRequest {
	t: "push";
	reqId: string;
	path: string;
	seq: number;
	done: boolean;
	b64: string;
	/** "0700" by default; executable when the agent pushes a tool binary. */
	mode?: string;
}

/** Server → device: full-screen screenshot as PNG (returns through `data`). */
export interface IosScreencapRequest {
	t: "screencap";
	reqId: string;
}

// -- TCP tunnel -------------------------------------------------------------------------
// The console listens on loopback; the container's frida-cli connects to it, and
// the bytes travel over this socket to a port on the device (frida-server's
// 27042 is the first user). tunnelId + connId target one bidirectional stream.

export interface IosTcpOpenRequest {
	t: "tcp_open";
	reqId: string;
	tunnelId: string;
	connId: string;
	host: string;
	port: number;
}

export interface IosTcpSendRequest {
	t: "tcp_send";
	tunnelId: string;
	connId: string;
	b64: string;
}

export interface IosTcpCloseRequest {
	t: "tcp_close";
	tunnelId: string;
	connId: string;
}

/** Server → device: enumerate installed apps. `roots` is a test/debug override. */
export interface IosAppsListRequest {
	t: "apps_list";
	reqId: string;
	/** Include /Applications (system apps). Default false: user apps only. */
	system?: boolean;
	/** Override the scanned roots; used by the host contract test. */
	roots?: string[];
}

/** Server → device: one app's plist, signature, encryption and container facts. */
export interface IosAppInfoRequest {
	t: "app_info";
	reqId: string;
	bundleId: string;
	roots?: string[];
}

/**
 * Server → device: the file manifest of an installed app bundle.
 *
 * The device does not zip anything: it lists paths/sizes/modes/symlink targets
 * and the console pulls each file, then packages the IPA in the project
 * container with `zip`. That keeps the phone side free of an archive tool and
 * makes the IPA reproducible from the same manifest.
 */
export interface IosAppBundleRequest {
	t: "app_bundle";
	reqId: string;
	bundleId: string;
	roots?: string[];
}

/** Server → device: provisioning profiles visible on the device. */
export interface IosProfilesListRequest {
	t: "profiles_list";
	reqId: string;
}

/** Server → device: install an IPA already pushed to the device. */
export interface IosInstallRequest {
	t: "install";
	reqId: string;
	path: string;
}

/** Server → device: uninstall by bundle id. */
export interface IosUninstallRequest {
	t: "uninstall";
	reqId: string;
	bundleId: string;
}

export type IosRequest =
	| IosExecRequest
	| IosUploadRequest
	| IosPullRequest
	| IosPushRequest
	| IosScreencapRequest
	| IosTcpOpenRequest
	| IosTcpSendRequest
	| IosTcpCloseRequest
	| IosAppsListRequest
	| IosAppInfoRequest
	| IosAppBundleRequest
	| IosProfilesListRequest
	| IosInstallRequest
	| IosUninstallRequest;

/** Device → server: streamed payload chunk for a request id. */
export interface IosDataFrame {
	t: "data";
	reqId: string;
	seq: number;
	b64: string;
	done: boolean;
}

/** Device → server: the final answer for a request id. */
export interface IosResultFrame {
	t: "result";
	reqId: string;
	ok: boolean;
	code?: number;
	stdout?: string;
	stderr?: string;
	error?: string;
}

/** Device → server: a tunnel connection was established (or refused). */
export interface IosTcpOpenedFrame {
	t: "tcp_opened";
	reqId: string;
	tunnelId: string;
	connId: string;
	ok: boolean;
	error?: string;
}

/** Device → server: bytes read from the tunneled socket. */
export interface IosTcpDataDeviceFrame {
	t: "tcp_data";
	tunnelId: string;
	connId: string;
	b64: string;
}

/** Device → server: the tunneled socket closed (or failed to open). */
export interface IosTcpClosedDeviceFrame {
	t: "tcp_closed";
	tunnelId: string;
	connId: string;
}

export type IosDeviceFrame =
	| IosHelloFrame
	| IosHeartbeatFrame
	| IosDataFrame
	| IosResultFrame
	| IosTcpOpenedFrame
	| IosTcpDataDeviceFrame
	| IosTcpClosedDeviceFrame;

/**
 * A request without its id: the gateway assigns one. `push` is excluded on
 * purpose — a bulk payload goes through `IosGateway.pushFile`, which chunks it.
 */
type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
export type IosRequestInput = DistributiveOmit<Exclude<IosRequest, IosPushRequest>, "reqId">;

/** The aggregated answer the gateway hands a caller after a request completes. */
export interface IosResult {
	ok: boolean;
	code?: number;
	stdout?: string;
	stderr?: string;
	error?: string;
	/** Assembled `data` chunks in sequence order (pull / screencap / pcap). */
	bytes?: Buffer;
}
