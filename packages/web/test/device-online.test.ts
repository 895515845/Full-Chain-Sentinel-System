/**
 * Device online/offline bookkeeping, for both platforms.
 *
 * "在线" has to mean "this device will answer right now". Two things used to
 * break that: the online flag survived a console restart (nothing was
 * connected, the row still said online), and a frozen device kept its socket
 * open, so it stayed online while answering nothing. The gateway now clears the
 * flags when it starts, and the pages treat "no frames" as not online.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type DroidHello, DroidStore, droidDbPath } from "../src/droid.ts";
import { DroidGateway } from "../src/droid-gateway.ts";
import { IosStore, iosDbPath } from "../src/ios.ts";
import { IosGateway } from "../src/ios-gateway.ts";
import type { IosHelloFrame } from "../src/ios-protocol.ts";

const stores: Array<{
	clearOnline(): void;
	close(): void;
	listDevices(): Array<{ online: boolean; id: string; name: string }>;
}> = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tempRoots: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

const droidHello = (deviceId: string): DroidHello => ({
	deviceId,
	model: "Pixel 8",
	androidVersion: "16",
	sdkInt: 36,
	rooted: true,
});

const iosHello = (deviceId: string): IosHelloFrame =>
	({
		t: "hello",
		platform: "ios",
		protocol: 1,
		deviceId,
		model: "iPhone 15",
		osVersion: "17.4",
		build: "21E219",
		arch: "arm64",
		jailbreak: { form: "rootful", name: "Dopamine", version: "2.0" },
		hasRoot: true,
	}) as unknown as IosHelloFrame;

test("an android device that was online at shutdown is offline after the gateway starts", () => {
	const dir = tempDir("device-online-droid-");
	mkdirSync(join(dir, "agent"), { recursive: true });
	const store = new DroidStore(droidDbPath(join(dir, "agent")));
	stores.push(store);
	const token = store.createToken("测试");
	store.upsertDevice(droidHello("droid-1"), token.id);
	store.setDeviceOnline("droid-1", true);
	expect(store.listDevices().map((device) => device.online)).toEqual([true]);

	// Constructing the gateway is what happens on every console start.
	new DroidGateway(store, { onDeviceChange: () => {}, log: () => {} });
	expect(store.listDevices().map((device) => device.online)).toEqual([false]);
});

test("an ios device that was online at shutdown is offline after the gateway starts", () => {
	const dir = tempDir("device-online-ios-");
	mkdirSync(join(dir, "agent"), { recursive: true });
	const store = new IosStore(iosDbPath(join(dir, "agent")));
	stores.push(store);
	const token = store.createToken("测试");
	store.upsertDevice(iosHello("ios-1"), token.id);
	store.setDeviceOnline("ios-1", true);
	expect(store.listDevices().map((device) => device.online)).toEqual([true]);

	new IosGateway(store, { onDeviceChange: () => {}, log: () => {} });
	expect(store.listDevices().map((device) => device.online)).toEqual([false]);
});
