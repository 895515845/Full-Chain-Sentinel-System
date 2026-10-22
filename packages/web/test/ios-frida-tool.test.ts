/**
 * The iOS frida tools without a device or Docker: the gateway is a stub, so the
 * tests cover device picking, the rootless/rootful frida-server path, the
 * approval chain on ios_url_open and the tunnel-required error paths.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { IosDevice } from "../src/ios.ts";
import { createIosFridaTools, IOS_FRIDA_TOOL_NAMES } from "../src/ios-frida-tool.ts";
import type { IosRequestInput, IosResult } from "../src/ios-protocol.ts";
import type { IosGatewayPort, IosToolContext } from "../src/ios-tool.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ios-frida-"));
	dirs.push(dir);
	return dir;
}

function deviceOf(overrides: Partial<IosDevice> = {}): IosDevice {
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
		...overrides,
	};
}

interface Harness {
	ctx: IosToolContext;
	requests: Array<{ deviceId: string; req: IosRequestInput }>;
	pushes: Array<{ path: string }>;
	guarded: string[];
}

function harness(
	device: IosDevice | null,
	options: { tunnelOk?: boolean; reply?: (req: IosRequestInput) => IosResult } = {},
): Harness {
	const requests: Harness["requests"] = [];
	const pushes: Harness["pushes"] = [];
	const guarded: string[] = [];
	const gateway: IosGatewayPort = {
		onlineDevices: () => (device ? [device] : []),
		openTunnel: async () =>
			options.tunnelOk === true ? { ok: true, port: 41000, tunnelId: "it1" } : { ok: false, error: "设备不在线" },
		request: async (deviceId, req) => {
			requests.push({ deviceId, req });
			return options.reply?.(req) ?? { ok: true, code: 0, stdout: "", stderr: "" };
		},
		pushFile: async (_deviceId, path) => {
			pushes.push({ path });
			return { ok: true, code: 0, stdout: "written" };
		},
	};
	return {
		ctx: {
			gateway: () => gateway,
			enabled: () => true,
			workDir,
			container: () => "test-container",
			guard: async (_name, command) => {
				guarded.push(command);
				return command;
			},
		},
		requests,
		pushes,
		guarded,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

async function run(
	ctx: IosToolContext,
	name: string,
	params: Record<string, unknown>,
): Promise<Awaited<ReturnType<ReturnType<typeof createIosFridaTools>[number]["execute"]>>> {
	const tool = createIosFridaTools(ctx).find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool.execute("call-1", params as never, undefined, undefined, undefined as never);
}

test("IOS_FRIDA_TOOL_NAMES matches the registered tools", () => {
	const { ctx } = harness(deviceOf());
	const registered = createIosFridaTools(ctx)
		.map((tool) => tool.name)
		.sort();
	expect([...IOS_FRIDA_TOOL_NAMES].sort()).toEqual(registered);
});

test("ios_frida_setup names the missing frida-server binary", async () => {
	const { ctx } = harness(deviceOf());
	const result = await run(ctx, "ios_frida_setup", {});
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("找不到");
	expect(textOf(result)).toContain("ios-arm64");
});

test("ios_frida_setup pushes to the rootless path and reports the tunnel failure", async () => {
	const dir = workDir();
	writeFileSync(join(dir, "frida-server"), "fake");
	const { ctx, pushes } = harness(deviceOf({ jailbreakForm: "rootless" }));
	const rooted: IosToolContext = { ...ctx, workDir: () => dir };
	const result = await run(rooted, "ios_frida_setup", {});
	expect(result.isError).toBe(true);
	expect(pushes.map((push) => push.path)).toEqual(["/var/jb/usr/sbin/frida-server"]);
	expect(textOf(result)).toContain("隧道建立失败");
});

test("ios_frida_setup uses /usr/bin on a rootful device", async () => {
	const dir = workDir();
	writeFileSync(join(dir, "frida-server"), "fake");
	const { ctx, pushes } = harness(deviceOf({ jailbreakForm: "rootful" }));
	const rooted: IosToolContext = { ...ctx, workDir: () => dir };
	await run(rooted, "ios_frida_setup", {});
	expect(pushes.map((push) => push.path)).toEqual(["/usr/sbin/frida-server"]);
});

test("ios_http_log needs frida-server before it can capture", async () => {
	const { ctx } = harness(deviceOf());
	const result = await run(ctx, "ios_http_log", { app: "com.example.demo", seconds: 5 });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("先运行 ios_frida_setup");
});

test("ios_frida tells the operator to run setup first when the tunnel fails", async () => {
	const { ctx } = harness(deviceOf());
	const result = await run(ctx, "ios_frida", { app: "com.example.demo", scripts: ["ios_ssl_bypass"] });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("先运行 ios_frida_setup");
});

test("ios_url_open goes through the guard and opens the URL", async () => {
	const { ctx, guarded, requests } = harness(deviceOf());
	const result = await run(ctx, "ios_url_open", { url: "demo://open?x=1" });
	expect(result.isError).toBeFalsy();
	expect(guarded).toEqual(["uiopen 'demo://open?x=1'"]);
	expect(requests[0]?.req.t).toBe("exec");
	expect(textOf(result)).toContain("已打开 demo://open?x=1");
});

test("ios_url_open refuses when the guard rejects", async () => {
	const { ctx } = harness(deviceOf());
	const denied: IosToolContext = {
		...ctx,
		guard: async () => {
			throw new Error("操作被拒绝");
		},
	};
	const result = await run(denied, "ios_url_open", { url: "demo://x" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("操作被拒绝");
});
