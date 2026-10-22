/**
 * ios_decrypt and ios_keychain without a device or Docker: preflight failures,
 * the keychain probe, and the dumper output path.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { IosDevice } from "../src/ios.ts";
import { createIosDecryptTools, IOS_DECRYPT_TOOL_NAMES } from "../src/ios-decrypt-tool.ts";
import type { IosRequestInput, IosResult } from "../src/ios-protocol.ts";
import type { IosGatewayPort, IosToolContext } from "../src/ios-tool.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ios-decrypt-"));
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
	requests: Array<{ req: IosRequestInput }>;
}

function harness(options: { tunnelOk?: boolean; reply?: (req: IosRequestInput) => IosResult } = {}): Harness {
	const device = deviceOf();
	const requests: Harness["requests"] = [];
	const gateway: IosGatewayPort = {
		onlineDevices: () => [device],
		openTunnel: async () =>
			options.tunnelOk === true ? { ok: true, port: 41000, tunnelId: "it1" } : { ok: false, error: "设备不在线" },
		request: async (_deviceId, req) => {
			requests.push({ req });
			return options.reply?.(req) ?? { ok: true, code: 0, stdout: "", stderr: "" };
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
): Promise<Awaited<ReturnType<ReturnType<typeof createIosDecryptTools>[number]["execute"]>>> {
	const tool = createIosDecryptTools(ctx).find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool.execute("call-1", params as never, undefined, undefined, undefined as never);
}

const appInfo = JSON.stringify({
	path: "/private/var/containers/Bundle/Application/UUID/Demo.app",
	executable: "Demo",
	cryptid: 1,
	version: "1.2.3",
});

test("IOS_DECRYPT_TOOL_NAMES matches the registered tools", () => {
	const { ctx } = harness();
	const registered = createIosDecryptTools(ctx)
		.map((tool) => tool.name)
		.sort();
	expect([...IOS_DECRYPT_TOOL_NAMES].sort()).toEqual(registered);
});

test("ios_decrypt reports a bundle-manifest failure", async () => {
	const { ctx } = harness({
		reply: (req) => {
			if (req.t === "app_info") return { ok: true, stdout: appInfo };
			if (req.t === "app_bundle") return { ok: false, error: "找不到已安装的 App" };
			return { ok: false, error: "unexpected" };
		},
	});
	const result = await run(ctx, "ios_decrypt", { bundleId: "com.example.demo" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("找不到已安装的 App");
});

test("ios_decrypt tells the operator to start frida when the tunnel fails", async () => {
	const { ctx } = harness({
		tunnelOk: false,
		reply: (req) => {
			if (req.t === "app_info") return { ok: true, stdout: appInfo };
			if (req.t === "app_bundle") {
				return {
					ok: true,
					stdout: JSON.stringify({
						appPath: "/private/var/containers/Bundle/Application/UUID/Demo.app",
						bundleId: "com.example.demo",
						entries: [{ rel: "Info.plist", size: 2 }],
					}),
				};
			}
			if (req.t === "pull") return { ok: true, bytes: Buffer.from("hi") };
			return { ok: false, error: "unexpected" };
		},
	});
	const result = await run(ctx, "ios_decrypt", { bundleId: "com.example.demo" });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("ios_frida_setup");
	expect(textOf(result)).toContain("ios_jailbreak_bypass");
});

test("ios_keychain says it cannot dump when no dumper exists", async () => {
	const { ctx } = harness({
		reply: (req) =>
			req.t === "exec"
				? { ok: true, code: 0, stdout: "-rw-r--r-- 1 root wheel 4096 keychain-2.db\nDONE", stderr: "" }
				: { ok: false, error: "unexpected" },
	});
	const result = await run(ctx, "ios_keychain", {});
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("不可 dump");
	expect(textOf(result)).toContain("SecItemCopyMatching");
});

test("ios_keychain runs keychain_dumper and saves the output", async () => {
	const dir = workDir();
	const { ctx } = harness({
		reply: (req) => {
			if (req.t !== "exec") return { ok: false, error: "unexpected" };
			if (req.cmd.includes("DUMPER")) {
				return {
					ok: true,
					code: 0,
					stdout: "-rw-r--r-- keychain-2.db\nDUMPER /var/jb/usr/bin/keychain_dumper\nDONE",
					stderr: "",
				};
			}
			return { ok: true, code: 0, stdout: "svce=Demo acct=token data=secret", stderr: "" };
		},
	});
	const rooted: IosToolContext = { ...ctx, workDir: () => dir };
	const result = await run(rooted, "ios_keychain", {});
	expect(result.isError).toBeFalsy();
	expect(textOf(result)).toContain("keychain_dumper");
	const saved = join(dir, "evidence", "ios", "keychain");
	expect(existsSync(saved)).toBe(true);
	expect(textOf(result)).toContain("secret");
});
