/**
 * Host contract test for the real Swift daemon.
 *
 * The iOS binary cannot run on a Linux CI box, so this suite is skipped unless a
 * macOS developer has built it first:
 *
 *   cd packages/web/ios
 *   swift build --disable-sandbox        # sandboxed environments need the flag
 *   cd ../.. && node node_modules/vitest/dist/cli.js --run test/ios-daemon.test.ts
 *
 * It covers the protocol the fake client only imitates: hello, exec, a
 * multi-chunk pull and push, a TCP tunnel, and the iOS-only screencap refusal on
 * macOS. Real-device validation is still a separate acceptance step.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { IosStore } from "../src/ios.ts";
import { IosGateway } from "../src/ios-gateway.ts";
import { wsUrlOf } from "./fake-ios.ts";

const binary = join(import.meta.dirname, "../ios/.build/debug/SentinelBridge");

describe.skipIf(!existsSync(binary))("SentinelBridge daemon", () => {
	test("speaks the gateway protocol end to end", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sentinelbridge-host-"));
		const store = new IosStore(join(dir, "ios.db"));
		const gateway = new IosGateway(store, { onDeviceChange: () => {}, log: () => {} });
		const server = createHttpServer();
		server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const token = store.createToken("host").token;
		const child = spawn(
			binary,
			["--url", `${wsUrlOf(server)}/ws/ios`, "--token", token, "--state-dir", join(dir, "state")],
			{ stdio: ["ignore", "ignore", "ignore"] },
		);

		const waitFor = async (predicate: () => boolean, ms = 10_000) => {
			const start = Date.now();
			while (!predicate()) {
				if (Date.now() - start > ms) throw new Error("device did not come online");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		};

		try {
			await waitFor(() => gateway.onlineDevices().length === 1);
			const device = gateway.onlineDevices()[0]!;
			expect(device.model).not.toBe("");
			expect(device.hasRoot).toBe(false);

			const exec = await gateway.request(
				device.id,
				{ t: "exec", cmd: "printf hello", asRoot: false, timeoutMs: 5000 },
				{ timeoutMs: 8000 },
			);
			expect(exec.ok).toBe(true);
			expect(exec.stdout).toBe("hello");

			const dirPath = join(dir, "remote.bin");
			const payload = Buffer.alloc(1_500_000, 5);
			writeFileSync(dirPath, payload);
			const pull = await gateway.request(
				device.id,
				{ t: "pull", path: dirPath, maxBytes: 10_000_000 },
				{ timeoutMs: 20_000 },
			);
			expect(pull.ok).toBe(true);
			expect(pull.bytes?.length).toBe(payload.length);

			const pushed = join(dir, "pushed.bin");
			const push = await gateway.pushFile(device.id, pushed, payload, { timeoutMs: 20_000 });
			expect(push.ok).toBe(true);
			expect(readFileSync(pushed).length).toBe(payload.length);

			// App inventory: a fake .app under a root the request overrides, so the
			// daemon's real Info.plist and Mach-O readers are exercised on the host.
			const appRoot = join(dir, "apps");
			const appDir = join(appRoot, "Demo.app");
			mkdirSync(appDir, { recursive: true });
			writeFileSync(
				join(appDir, "Info.plist"),
				`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.example.demo</string>
<key>CFBundleName</key><string>Demo</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
<key>CFBundleVersion</key><string>45</string>
<key>CFBundleExecutable</key><string>Demo</string>
<key>MinimumOSVersion</key><string>15.0</string>
</dict></plist>`,
			);
			const executable = Buffer.alloc(32);
			executable.writeUInt32BE(0xfeedfacf, 0);
			executable.writeUInt32BE(0x0100000c, 4);
			executable.writeUInt32LE(0, 16);
			executable.writeUInt32LE(0, 20);
			writeFileSync(join(appDir, "Demo"), executable);

			const apps = await gateway.request(device.id, { t: "apps_list", roots: [appRoot] }, { timeoutMs: 10_000 });
			expect(apps.ok).toBe(true);
			const listed = JSON.parse(apps.stdout ?? "[]") as Array<{ bundleId: string; name: string }>;
			expect(listed.map((app) => app.bundleId)).toEqual(["com.example.demo"]);
			expect(listed[0]?.name).toBe("Demo");

			const info = await gateway.request(
				device.id,
				{ t: "app_info", bundleId: "com.example.demo", roots: [appRoot] },
				{ timeoutMs: 10_000 },
			);
			expect(info.ok).toBe(true);
			const details = JSON.parse(info.stdout ?? "{}") as { arch?: string; cryptid?: number; version?: string };
			expect(details.arch).toBe("arm64");
			expect(details.cryptid).toBe(0);
			expect(details.version).toBe("1.2.3");

			const bundle = await gateway.request(
				device.id,
				{ t: "app_bundle", bundleId: "com.example.demo", roots: [appRoot] },
				{ timeoutMs: 10_000 },
			);
			expect(bundle.ok).toBe(true);
			const manifest = JSON.parse(bundle.stdout ?? "{}") as { entries: Array<{ rel: string }> };
			expect(manifest.entries.map((entry) => entry.rel).sort()).toEqual(["Demo", "Info.plist"]);

			// Provisioning profiles are CMS-signed; the plist is embedded as bytes.
			// The daemon scans for the XML rather than parsing PKCS#7, so a prefix
			// of arbitrary bytes is enough to prove the path works.
			writeFileSync(
				join(appDir, "embedded.mobileprovision"),
				Buffer.concat([
					Buffer.from("cms-signed-prefix\u0000\u0001"),
					Buffer.from(
						`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>UUID</key><string>PROFILE-UUID</string>
<key>Name</key><string>Demo Development</string>
<key>ExpirationDate</key><date>2027-01-01T00:00:00Z</date>
<key>Entitlements</key><dict>
<key>application-identifier</key><string>TEAM123.com.example.demo</string>
<key>get-task-allow</key><true/>
</dict>
</dict></plist>`,
					),
				]),
			);
			const withProfile = await gateway.request(
				device.id,
				{ t: "app_info", bundleId: "com.example.demo", roots: [appRoot] },
				{ timeoutMs: 10_000 },
			);
			expect(withProfile.ok).toBe(true);
			const provision = JSON.parse(withProfile.stdout ?? "{}") as {
				provisionUUID?: string;
				provisionApplicationIdentifier?: string;
				provisionEntitlements?: Record<string, unknown>;
			};
			expect(provision.provisionUUID).toBe("PROFILE-UUID");
			expect(provision.provisionApplicationIdentifier).toBe("TEAM123.com.example.demo");
			expect(provision.provisionEntitlements?.["get-task-allow"]).toBe(true);

			const echo = createTcpServer((socket) => socket.pipe(socket));
			await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
			const echoPort = (echo.address() as { port: number }).port;
			const tunnel = await gateway.openTunnel(device.id, "127.0.0.1", echoPort);
			expect(tunnel.ok).toBe(true);
			const client = createConnection({ host: "127.0.0.1", port: tunnel.port as number });
			await once(client, "connect");
			const data = once(client, "data");
			client.write("ping");
			expect(String((await data)[0])).toBe("ping");
			client.destroy();
			echo.close();

			// The console can drop a device (token deleted, manual kick); the
			// daemon must come back on its own with the same device id.
			gateway.disconnect(device.id);
			await waitFor(() => gateway.onlineDevices().length === 0);
			await waitFor(() => gateway.onlineDevices().some((online) => online.id === device.id));
			const reconnected = await gateway.request(
				device.id,
				{ t: "exec", cmd: "printf back", asRoot: false, timeoutMs: 5000 },
				{ timeoutMs: 8000 },
			);
			expect(reconnected.ok).toBe(true);
			expect(reconnected.stdout).toBe("back");

			// Screencap needs UIKit; on the host the daemon must say so instead of
			// hanging or returning an empty PNG.
			const screencap = await gateway.request(device.id, { t: "screencap" }, { timeoutMs: 5000 });
			expect(screencap.ok).toBe(false);
			expect(screencap.error).toContain("iOS");
		} finally {
			if (child.exitCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGTERM");
				await exited;
			}
			gateway.close();
			server.close();
			await new Promise((resolve) => setTimeout(resolve, 50));
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
