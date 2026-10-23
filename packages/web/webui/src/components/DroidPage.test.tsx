/**
 * The Android device page's online bookkeeping.
 *
 * A device whose socket is open but that stopped answering (a frozen app keeps
 * the TCP connection ESTABLISHED) must not count as 在线: the tag says 无响应
 * and the summary counts only devices that answer.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { DroidDevice } from "../types.ts";
import { DroidPage } from "./DroidPage.tsx";

function device(overrides: Partial<DroidDevice> = {}): DroidDevice {
	return {
		id: "droid-1a2b",
		name: "打点二的手机",
		model: "Pixel 8",
		androidVersion: "16",
		sdkInt: 36,
		rooted: true,
		online: true,
		tokenId: "token-1",
		firstSeen: "2026-01-01T08:00:00.000Z",
		lastSeen: "2026-01-01T09:00:00.000Z",
		...overrides,
	};
}

function render(devices: DroidDevice[]): string {
	return renderToStaticMarkup(
		createElement(DroidPage, {
			connected: true,
			devices,
			tokens: [],
			listen: { host: "0.0.0.0", port: 9944 },
			listenConfig: { host: "0.0.0.0", port: 9944 },
			lanIps: ["192.168.1.10"],
			consoleUrl: "http://127.0.0.1:9944",
			send: () => {},
		}),
	);
}

test("an answering device is 在线 and counted", () => {
	const html = render([device()]);
	expect(html).toContain("在线");
	expect(html).not.toContain("无响应");
	expect(html).toContain("1/1 台在线");
});

test("a frozen device is 无响应 and not counted as online", () => {
	const html = render([device({ stale: true, idleMs: 45_000 })]);
	expect(html).toContain("无响应 45s");
	expect(html).not.toContain("1/1 台在线");
	expect(html).toContain("0/1 台在线");
});

test("a disconnected device stays 离线 with its last seen time", () => {
	const html = render([device({ online: false })]);
	expect(html).toContain("离线 ·");
	expect(html).toContain("0/1 台在线");
});
