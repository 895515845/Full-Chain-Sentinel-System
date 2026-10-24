/**
 * Render smoke test for the 代理 page.
 *
 * The page needs a browser to *look* right, but a null dereference or a bad prop
 * fails here first, and this is the only automated check its JSX gets. What is
 * pinned is what the operator decides on: which profiles exist, which one the
 * default is, and whether the image their sidecars need is here.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelProjectInfo, SentinelProxy, SentinelProxyConfigView } from "../types.ts";
import { ProxyNodeDialog, ProxyPage } from "./ProxyPage.tsx";

function profile(overrides: Partial<SentinelProxy> = {}): SentinelProxy {
	return {
		id: "p1",
		name: "香港节点",
		mode: "simple",
		simple: { type: "socks5", server: "1.2.3.4", port: 1080, username: "", password: "", tls: false },
		subscription: null,
		nodes: [],
		nodeTag: "",
		skipped: [],
		routePrivateDirect: true,
		createdAt: 0,
		...overrides,
	};
}

function config(overrides: Partial<SentinelProxyConfigView> = {}): SentinelProxyConfigView {
	return {
		proxies: [profile()],
		defaultId: "p1",
		image: "ghcr.io/sagernet/sing-box:v1.13.15",
		imagePresent: true,
		testUrl: "https://www.gstatic.com/generate_204",
		...overrides,
	};
}

function project(overrides: Partial<SentinelProjectInfo> = {}): SentinelProjectInfo {
	return { id: "proj", name: "靶场", cwd: "/work", vulnCount: 0, gateCount: 0, ...overrides };
}

function render(view: SentinelProxyConfigView, projects: SentinelProjectInfo[] = []): string {
	return renderToStaticMarkup(
		createElement(ProxyPage, {
			config: view,
			projects,
			busy: false,
			onSave: async () => null,
			onDelete: async () => null,
			onRefreshSubscription: async () => null,
			onSetNode: async () => null,
			onTestNodes: async () => null,
			refreshingId: null,
			testingId: null,
		}),
	);
}

test("the table lists each profile with its exit and the default marker", () => {
	const html = render(config());
	expect(html).toContain("香港节点");
	expect(html).toContain("SOCKS5 1.2.3.4:1080");
	// The default is a property of the page, not of a profile.
	expect(html).toContain(">默认</span>");
	// The image and the default selector moved to 环境; this page is profiles only.
	expect(html).not.toContain("ghcr.io/sagernet/sing-box");
	expect(html).not.toContain("默认与镜像");
});

test("the project column counts only the projects a profile actually reaches", () => {
	// One project names the profile, one follows the default (which is the same
	// profile), and one is explicitly off.
	const html = render(config(), [
		project({ id: "a", name: "A", proxyId: "p1" }),
		project({ id: "b", name: "B" }),
		project({ id: "c", name: "C", proxyId: null }),
	]);
	const row = html.slice(html.indexOf("香港节点"), html.indexOf("编辑"));
	expect(row).toContain(">2</span>");
});

test("an empty page says what to do", () => {
	const empty = render(config({ proxies: [], defaultId: null }));
	expect(empty).toContain("还没有代理");
	expect(empty).toContain("新建一个之后");
});

test("the table says which kind of profile each row is", () => {
	const html = render(
		config({
			proxies: [
				profile(),
				profile({
					id: "p2",
					name: "机场",
					mode: "subscription",
					subscription: { url: "https://example.com/sub", userAgent: "sing-box", updatedAt: 0, error: null, intervalHours: 0 },
					nodes: [{ tag: "香港", name: "香港", protocol: "trojan", outbound: {} }],
					nodeTag: "香港",
				}),
			],
		}),
	);
	// An address is a plain proxy; a URL-backed profile is a subscription.
	expect(html).toContain("普通代理");
	expect(html).toContain(">订阅<");
});

test("a subscription profile shows its node count and the node it uses", () => {
	const html = render(
		config({
			proxies: [
				profile({
					mode: "subscription",
					subscription: { url: "https://example.com/sub", userAgent: "sing-box", updatedAt: 1, error: null, intervalHours: 0 },
					nodes: [
						{ tag: "香港 01", name: "香港 01", protocol: "vmess", outbound: {} },
						{ tag: "日本 02", name: "日本 02", protocol: "trojan", outbound: {} },
					],
					nodeTag: "日本 02",
				}),
			],
		}),
	);
	expect(html).toContain("2 个节点");
	expect(html).toContain("日本 02");
	// The row offers the node picker only for a subscription.
	expect(html).toContain(">节点</button>");
});

test("a subscription that was never read says so", () => {
	const html = render(
		config({
			proxies: [
				profile({
					mode: "subscription",
					subscription: { url: "https://example.com/sub", userAgent: "sing-box", updatedAt: 0, error: null, intervalHours: 0 },
					nodes: [],
				}),
			],
		}),
	);
	expect(html).toContain("订阅未拉取");
});

test("the node dialog shows measured latency, a timeout, and the test controls", () => {
	const proxy = profile({
		mode: "subscription",
		subscription: { url: "https://example.com/sub", userAgent: "sing-box", updatedAt: 1, error: null, intervalHours: 6 },
		nodes: [
			{ tag: "香港", name: "香港 01", protocol: "trojan", outbound: {}, latencyMs: 42, testedAt: 1 },
			{ tag: "日本", name: "日本 02", protocol: "vmess", outbound: {}, latencyMs: null, testedAt: 1 },
			{ tag: "美国", name: "美国 03", protocol: "vmess", outbound: {} },
		],
		nodeTag: "香港",
	});
	const html = renderToStaticMarkup(
		createElement(ProxyNodeDialog, {
			proxy,
			busy: false,
			refreshing: false,
			testing: false,
			testUrl: "https://www.gstatic.com/generate_204",
			onPick: () => {},
			onRefresh: () => {},
			onTest: () => {},
			onClose: () => {},
		}),
	);
	expect(html).toContain("42 ms");
	// A node that was tested and timed out says so; an untested one shows its protocol.
	expect(html).toContain("超时");
	expect(html).toContain("vmess");
	// The URL is editable, and the button tests every node at once.
	expect(html).toContain("测速地址");
	expect(html).toContain("https://www.gstatic.com/generate_204");
	expect(html).toContain("批量测速");
});
