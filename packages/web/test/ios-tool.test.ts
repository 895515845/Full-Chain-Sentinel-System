/**
 * The iOS tool surface, driven against a fake gateway port: pick the device,
 * route exec through the approval chain, stream a pull to disk, push in one
 * call, save a screenshot, and refuse paths outside the project.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { IosDevice } from "../src/ios.ts";
import type { IosRequestInput, IosResult } from "../src/ios-protocol.ts";
import { createIosTools, IOS_TOOL_NAMES, type IosGatewayPort, type IosToolContext } from "../src/ios-tool.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-ios-tool-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function deviceOf(overrides: Partial<IosDevice> = {}): IosDevice {
	return {
		id: "dvc-1",
		name: "测试 iPhone",
		model: "iPhone15,2",
		osVersion: "16.6.1",
		build: "20G75",
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
	requests: Array<{
		deviceId: string;
		req: IosRequestInput;
		options?: { timeoutMs?: number; onData?: (chunk: Buffer) => void };
	}>;
	pushes: Array<{ deviceId: string; path: string; bytes: Buffer; options?: { mode?: string; timeoutMs?: number } }>;
	guarded: string[];
}

function harness(device: IosDevice | null, reply?: (req: IosRequestInput) => IosResult): Harness {
	const requests: Harness["requests"] = [];
	const pushes: Harness["pushes"] = [];
	const guarded: string[] = [];
	const gateway: IosGatewayPort = {
		onlineDevices: () => (device ? [device] : []),
		request: async (deviceId, req, options) => {
			requests.push({ deviceId, req, options });
			if (req.t === "pull") options?.onData?.(Buffer.from("payload"));
			if (req.t === "screencap") return { ok: true, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
			return reply?.(req) ?? { ok: true, code: 0, stdout: "uid=0(root)", stderr: "" };
		},
		openTunnel: async () => ({ ok: false, error: "测试未实现隧道" }),
		pushFile: async (deviceId, path, bytes, options) => {
			pushes.push({ deviceId, path, bytes, options });
			return { ok: true, code: 0, stdout: `写入 ${bytes.length} 字节` };
		},
	};
	const ctx: IosToolContext = {
		gateway: () => gateway,
		enabled: () => true,
		workDir: () => dir,
		container: () => "test-container",
		guard: async (_name, command) => {
			guarded.push(command);
			return `${command} --approved`;
		},
	};
	return { ctx, requests, pushes, guarded };
}

async function run(ctx: IosToolContext, name: string, params: Record<string, unknown>) {
	const tool = createIosTools(ctx).find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`missing tool ${name}`);
	return tool.execute("call-1", params, undefined, undefined, undefined as never);
}

function textOf(result: Awaited<ReturnType<typeof run>>): string {
	const block = result.content[0] as { type: string; text?: string };
	return block.text ?? "";
}

test("ios_devices lists the model, jailbreak and root state", async () => {
	const { ctx } = harness(deviceOf());
	const result = await run(ctx, "ios_devices", {});
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("iPhone15,2");
	expect(textOf(result)).toContain("Dopamine 2.0");
	expect(textOf(result)).toContain("daemon 有 root");
});

test("ios_shell runs the command returned by the approval chain", async () => {
	const { ctx, requests, guarded } = harness(deviceOf());
	const result = await run(ctx, "ios_shell", { command: "id -u" });
	expect(result.isError).toBeFalsy();
	expect(guarded).toEqual(["id -u"]);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.req).toMatchObject({ t: "exec", cmd: "id -u --approved", asRoot: false });
	expect(textOf(result)).toContain("uid=0(root)");
});

test("a refused command never reaches the device", async () => {
	const { ctx, requests } = harness(deviceOf());
	ctx.guard = async () => {
		throw new Error("已拒绝");
	};
	const result = await run(ctx, "ios_shell", { command: "rm -rf /" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("命令未执行");
	expect(requests).toHaveLength(0);
});

test("ios_file_pull streams to a project path", async () => {
	const { ctx, requests } = harness(deviceOf());
	const result = await run(ctx, "ios_file_pull", { remotePath: "/tmp/db.sqlite", localPath: "out/db.sqlite" });
	expect(result.isError).toBeFalsy();
	expect(readFileSync(join(dir, "out/db.sqlite"), "utf8")).toBe("payload");
	expect(requests[0]?.options?.onData).toBeTypeOf("function");
	expect(textOf(result)).toContain("7 字节");
});

test("ios_file_pull refuses a path outside the project", async () => {
	const { ctx, requests } = harness(deviceOf());
	const result = await run(ctx, "ios_file_pull", { remotePath: "/tmp/a", localPath: "../../etc/passwd" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("工程目录内");
	expect(requests).toHaveLength(0);
});

test("ios_file_push reads the project file and sends it in one call", async () => {
	writeFileSync(join(dir, "frida.js"), "console.log('hi')");
	const { ctx, pushes } = harness(deviceOf());
	const result = await run(ctx, "ios_file_push", { localPath: "frida.js", remotePath: "/tmp/frida.js", mode: "0755" });
	expect(result.isError).toBeFalsy();
	expect(pushes).toHaveLength(1);
	expect(pushes[0]?.bytes.toString()).toBe("console.log('hi')");
	expect(pushes[0]?.options?.mode).toBe("0755");
});

test("ios_deps reports missing optional tools with install hints", async () => {
	const { ctx } = harness(deviceOf());
	const result = await run(ctx, "ios_deps", {});
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("frida-server");
	expect(textOf(result)).toContain("Sileo");
});

test("ios_screencap saves the PNG under evidence/ios/screenshots", async () => {
	const { ctx } = harness(deviceOf());
	const result = await run(ctx, "ios_screencap", { filename: "login.png" });
	expect(result.isError).toBeFalsy();
	const saved = readFileSync(join(dir, "evidence/ios/screenshots/login.png"));
	expect([...saved]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

test("a frozen device is refused before any command reaches the guard", async () => {
	const { ctx, guarded } = harness(deviceOf({ stale: true, idleMs: 50_000 }));
	const result = await run(ctx, "ios_shell", { command: "id" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("无响应");
	expect(guarded).toHaveLength(0);
});

test("no online device is a clear failure, not a hang", async () => {
	const { ctx } = harness(null);
	const result = await run(ctx, "ios_shell", { command: "id" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("没有在线的 iOS 设备");
});

test("ios_apps lists the installed inventory", async () => {
	const { ctx } = harness(deviceOf(), (req) => {
		if (req.t === "apps_list") {
			return {
				ok: true,
				stdout: JSON.stringify([
					{ bundleId: "com.example.demo", name: "Demo", version: "1.2.3", build: "45", type: "user" },
				]),
			};
		}
		return { ok: false, error: "unexpected" };
	});
	const result = await run(ctx, "ios_apps", {});
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("com.example.demo");
	expect(textOf(result)).toContain("1.2.3");
});

test("ios_app_info reports the encryption state", async () => {
	const { ctx } = harness(deviceOf(), (req) => {
		if (req.t === "app_info") {
			return {
				ok: true,
				stdout: JSON.stringify({
					bundleId: "com.example.demo",
					name: "Demo",
					version: "1.2.3",
					build: "45",
					minimumOS: "15.0",
					path: "/private/var/containers/Bundle/Application/UUID/Demo.app",
					executable: "Demo",
					arch: "arm64e",
					cryptid: 1,
					frameworks: ["AFNetworking.framework"],
					urlSchemes: ["demo"],
					hasCodeSignature: true,
					hasEmbeddedProvision: true,
					containerPath: "/private/var/mobile/Containers/Data/Application/UUID",
					bundleSize: 12345,
				}),
			};
		}
		return { ok: false, error: "unexpected" };
	});
	const result = await run(ctx, "ios_app_info", { bundleId: "com.example.demo" });
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("cryptid 1");
	expect(textOf(result)).toContain("AFNetworking.framework");
});

test("ios_profiles lists provisioning profiles", async () => {
	const { ctx } = harness(deviceOf(), (req) => {
		if (req.t === "profiles_list") {
			return {
				ok: true,
				stdout: JSON.stringify([
					{
						file: "abc.mobileprovision",
						name: "Demo Dev",
						uuid: "UUID-1",
						team: "TEAM",
						expiration: "2027-01-01",
						path: "/var/MobileDevice/ProvisioningProfiles/abc.mobileprovision",
					},
				]),
			};
		}
		return { ok: false, error: "unexpected" };
	});
	const result = await run(ctx, "ios_profiles", {});
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("Demo Dev");
	expect(textOf(result)).toContain("UUID-1");
});

test("ios_install goes through the guard before touching the device", async () => {
	const { ctx, guarded, requests } = harness(deviceOf(), (req) => {
		if (req.t === "install") {
			return { ok: true, stdout: JSON.stringify({ tool: "/usr/bin/appinst", code: 0, stdout: "installed" }) };
		}
		return { ok: false, error: "unexpected" };
	});
	const result = await run(ctx, "ios_install", { path: "/tmp/demo.ipa" });
	expect(result.isError).toBeFalsy();
	expect(guarded).toEqual(["appinst '/tmp/demo.ipa'"]);
	expect(requests.some((entry) => entry.req.t === "install")).toBe(true);
	expect(textOf(result)).toContain("appinst");
});

test("ios_ipa_pull stops when the bundle manifest fails", async () => {
	const { ctx } = harness(deviceOf(), (req) => {
		if (req.t === "app_bundle") return { ok: false, error: "找不到已安装的 App" };
		return { ok: false, error: "unexpected" };
	});
	const result = await run(ctx, "ios_ipa_pull", { bundleId: "com.missing.app" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("找不到已安装的 App");
});

test("IOS_TOOL_NAMES matches the registered tools", () => {
	const { ctx } = harness(deviceOf());
	const registered = createIosTools(ctx)
		.map((tool) => tool.name)
		.sort();
	expect([...IOS_TOOL_NAMES].sort()).toEqual(registered);
});

test("ipa_strings refuses a path outside the project", async () => {
	const { ctx } = harness(deviceOf());
	const result = await run(ctx, "ipa_strings", { path: "../outside.ipa" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("路径必须位于工程目录内");
});

test("ipa_search refuses a path outside the project", async () => {
	const { ctx } = harness(deviceOf());
	const result = await run(ctx, "ipa_search", { path: "/etc/passwd", pattern: "root" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("路径必须位于工程目录内");
});

test("ipa_plist refuses a path outside the project", async () => {
	const { ctx } = harness(deviceOf());
	const result = await run(ctx, "ipa_plist", { path: "../outside.ipa", entry: "Payload/Demo.app/Info.plist" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("路径必须位于工程目录内");
});
