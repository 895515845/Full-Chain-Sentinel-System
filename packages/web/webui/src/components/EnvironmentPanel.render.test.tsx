/**
 * Render smoke test for the environment page.
 *
 * The complaint this pins down: the container network and the proxy defaults used
 * to be two cards with two save buttons, so "which network will a new container
 * get" meant reading two places. They are one card with one 保存 now, and that is
 * what is asserted here — one heading, one button, both settings inside it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { EMPTY_WIREGUARD } from "../types.ts";
import type { SentinelEnvReport, SentinelProxyConfigView } from "../types.ts";
import { EnvironmentPanel } from "./EnvironmentPanel.tsx";

function proxyConfig(overrides: Partial<SentinelProxyConfigView> = {}): SentinelProxyConfigView {
	return {
		proxies: [
			{
				id: "p1",
				name: "香港节点",
				mode: "simple",
				simple: { type: "socks5", server: "1.2.3.4", port: 1080, username: "", password: "", tls: false },
						subscription: null,
				wireguard: { ...EMPTY_WIREGUARD },
				nodes: [],
				nodeTag: "",
				skipped: [],
				routePrivateDirect: true,
				createdAt: 0,
			},
		],
		defaultId: "p1",
		image: "ghcr.io/sagernet/sing-box:v1.13.15",
		imagePresent: true,
		testUrl: "https://www.gstatic.com/generate_204",
		...overrides,
	};
}

function report(config: SentinelProxyConfigView): SentinelEnvReport {
	return {
		at: "2026-10-24T00:00:00.000Z",
		ok: true,
		url: "http://127.0.0.1:49187",
		items: [],
		sources: { baseImage: "", aptMirror: "", pipIndex: "", npmRegistry: "", goProxy: "" },
		containerNetwork: "host",
		proxies: config,
	} as SentinelEnvReport;
}

function render(config: SentinelProxyConfigView = proxyConfig()): string {
	return renderToStaticMarkup(
		createElement(EnvironmentPanel, {
			report: report(config),
			building: false,
			buildLog: [],
			onRefresh: () => {},
			onBuild: () => {},
			onAbortBuild: () => {},
			onSaveSources: () => {},
			sourcesSavedAt: null,
			networkSavedAt: null,
			proxyConfig: config,
			pullingImage: false,
			onSaveNetworkAndProxy: () => {},
			onPullProxyImage: () => {},
		}),
	);
}

test("the network mode and the proxy defaults live in one card with one save", () => {
	const html = render();
	expect(html).toContain("容器网络与代理");
	// Everything the two old cards held is inside this one: the mode radios, the
	// default proxy and the image, and a single 保存 for the lot.
	const card = html.slice(html.indexOf("容器网络与代理"), html.indexOf("env-build"));
	expect(card).toContain("默认代理");
	expect(card).toContain("sidecar 镜像");
	expect(card).toContain("香港节点");
	expect(card.match(/>保存<\/button>/g) ?? []).toHaveLength(1);
	// The old heading is gone.
	expect(html).not.toContain(">代理默认与镜像<");
});

test("a missing proxy image is stated on the same card", () => {
	const html = render(proxyConfig({ imagePresent: false }));
	expect(html).toContain("镜像不在本地");
	// Pulling is an action, so it keeps its own button.
	expect(html).toContain("拉取镜像");
});
