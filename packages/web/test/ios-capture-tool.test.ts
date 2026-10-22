/**
 * iOS capture tools with a stub gateway: tcpdump discovery, start/status
 * output, the empty-pcap guard and the work-directory boundary on localPath.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { IosDevice } from "../src/ios.ts";
import { createIosCaptureTools, IOS_CAPTURE_TOOL_NAMES } from "../src/ios-capture-tool.ts";
import type { IosRequestInput, IosResult } from "../src/ios-protocol.ts";
import type { IosGatewayPort, IosToolContext } from "../src/ios-tool.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ios-capture-"));
	dirs.push(dir);
	return dir;
}

function deviceOf(): IosDevice {
	return {
		id: "dev-1",
		name: "iPhone 13",
		model: "iPhone13,2",
		osVersion: "15.4.1",
		build: "19E258",
		arch: "arm64e",
		jailbreakForm: "rootless",
		jailbreakName: "Dopamine",
		jailbreakVersion: "2.0",
		hasRoot: true,
		online: true,
		tokenId: "tok-1",
		firstSeen: "2026-10-22T00:00:00.000Z",
		lastSeen: "2026-10-22T00:00:00.000Z",
		stale: false,
		idleMs: 0,
	};
}

interface Harness {
	ctx: IosToolContext;
	requests: Array<{ deviceId: string; req: IosRequestInput }>;
}

function harness(reply?: (req: IosRequestInput) => IosResult): Harness {
	const device = deviceOf();
	const requests: Harness["requests"] = [];
	const gateway: IosGatewayPort = {
		onlineDevices: () => [device],
		openTunnel: async () => ({ ok: false, error: "未实现" }),
		request: async (deviceId, req) => {
			requests.push({ deviceId, req });
			return reply?.(req) ?? { ok: true, code: 0, stdout: "", stderr: "" };
		},
		pushFile: async () => ({ ok: true, code: 0, stdout: "" }),
	};
	return {
		ctx: {
			gateway: () => gateway,
			enabled: () => true,
			workDir,
			container: () => "test-container",
			guard: async (_name, command) => command,
		},
		requests,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

async function run(
	ctx: IosToolContext,
	name: string,
	params: Record<string, unknown>,
): Promise<Awaited<ReturnType<ReturnType<typeof createIosCaptureTools>[number]["execute"]>>> {
	const tool = createIosCaptureTools(ctx).find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool.execute("call-1", params as never, undefined, undefined, undefined as never);
}

test("IOS_CAPTURE_TOOL_NAMES matches the registered tools", () => {
	const { ctx } = harness();
	const registered = createIosCaptureTools(ctx)
		.map((tool) => tool.name)
		.sort();
	expect([...IOS_CAPTURE_TOOL_NAMES].sort()).toEqual(registered);
});

test("ios_capture_start reports a missing tcpdump package", async () => {
	const { ctx } = harness(() => ({ ok: true, code: 3, stdout: "NO_TCPDUMP", stderr: "" }));
	const result = await run(ctx, "ios_capture_start", {});
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("Sileo");
});

test("ios_capture_start passes the interface and BPF filter", async () => {
	const { ctx, requests } = harness(() => ({
		ok: true,
		code: 0,
		stdout: "STARTED /var/jb/usr/bin/tcpdump",
		stderr: "",
	}));
	const result = await run(ctx, "ios_capture_start", { iface: "en0", filter: "host api.example.com" });
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("接口 en0");
	const command = requests[0]?.req.t === "exec" ? requests[0].req.cmd : "";
	expect(command).toContain("-i 'en0'");
	expect(command).toContain("'host api.example.com'");
});

test("ios_capture_start refuses when tcpdump did not start", async () => {
	const { ctx } = harness(() => ({ ok: true, code: 0, stdout: "FAILED\npermission denied", stderr: "" }));
	const result = await run(ctx, "ios_capture_start", {});
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("tcpdump 未启动");
});

test("ios_capture_pull rejects an empty pcap", async () => {
	const { ctx } = harness((req) =>
		req.t === "pull" ? { ok: true, bytes: Buffer.alloc(0) } : { ok: true, code: 0, stdout: "", stderr: "" },
	);
	const result = await run(ctx, "ios_capture_pull", {});
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("pcap 为空");
});

test("ios_capture_pull refuses localPath outside the project", async () => {
	const { ctx } = harness((req) =>
		req.t === "pull" ? { ok: true, bytes: Buffer.from("pcap-bytes") } : { ok: true, code: 0, stdout: "", stderr: "" },
	);
	const result = await run(ctx, "ios_capture_pull", { localPath: "../outside.pcap" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("路径必须位于工程目录内");
});
