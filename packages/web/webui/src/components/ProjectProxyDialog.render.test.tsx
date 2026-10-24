/**
 * Render smoke test for a project's proxy choice.
 *
 * The dialog is where a project gets pinned to one exit, so what is pinned here is
 * the part that is easy to get wrong: a subscription profile offers its nodes, the
 * profile's own choice is the default, and a plain profile offers none.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { EMPTY_WIREGUARD } from "../types.ts";
import type { SentinelProjectInfo, SentinelProxy, SentinelProxyConfigView } from "../types.ts";
import { ProjectProxyDialog, projectProxyChoice, projectProxyNode } from "./ProjectProxyDialog.tsx";

function profile(overrides: Partial<SentinelProxy> = {}): SentinelProxy {
	return {
		id: "p1",
		name: "机场",
		mode: "simple",
		simple: { type: "socks5", server: "1.2.3.4", port: 1080, username: "", password: "", tls: false },
		subscription: null,
		wireguard: { ...EMPTY_WIREGUARD },
		nodes: [],
		nodeTag: "",
		skipped: [],
		routePrivateDirect: true,
		createdAt: 0,
		...overrides,
	};
}

function subscription(): SentinelProxy {
	return profile({
		id: "p2",
		name: "机场订阅",
		mode: "subscription",
		subscription: { url: "https://example.com/sub", userAgent: "sing-box", updatedAt: 1, error: null, intervalHours: 0 },
		nodes: [
			{ tag: "香港", name: "香港 01", protocol: "trojan", outbound: {} },
			{ tag: "日本", name: "日本 02", protocol: "vmess", outbound: {} },
		],
		nodeTag: "香港",
	});
}

function project(overrides: Partial<SentinelProjectInfo> = {}): SentinelProjectInfo {
	return {
		id: "proj",
		name: "靶场-01",
		cwd: "/tmp/p",
		container: "c",
		state: "running",
		proxyId: "p2",
		proxyName: "机场订阅",
		...overrides,
	};
}

function render(target: SentinelProjectInfo): string {
	return renderToStaticMarkup(
		createElement(ProjectProxyDialog, {
			project: target,
			config: {
				proxies: [profile(), subscription()],
				defaultId: "p1",
				image: "",
				imagePresent: true,
				testUrl: "",
			},
			busy: false,
			onConfirm: () => {},
			onCancel: () => {},
		}),
	);
}

test("a subscription profile offers its nodes next to the profile", () => {
	const html = render(project());
	expect(html).toContain("机场订阅");
	expect(html).toContain("2 个节点，可以只给这个项目指定一个");
	// The profile's own node is the default, so the select shows it.
	expect(html).toContain("跟随档案默认");
	expect(html).toContain("香港 01");
	expect(html).toContain("日本 02");
});

test("a plain profile offers no node list", () => {
	const html = render(project({ proxyId: "p1", proxyName: "机场" }));
	// The profile is selected, and being an address it has nothing to expand.
	expect(html).toContain("SOCKS5 1.2.3.4:1080");
	expect(html).not.toContain("project-proxy-node");
});

test("a pinned node is what the dialog starts from", () => {
	const html = render(project({ proxyNode: "日本" }));
	// The select is rendered with the pinned tag selected.
	expect(html).toContain('value="日本" selected');
});

test("the stored choice round-trips through the helpers", () => {
	const inherit = projectProxyChoice(project({ proxyId: undefined, proxyName: null }));
	expect(inherit).toEqual({ kind: "inherit" });
	expect(projectProxyNode(inherit)).toBeUndefined();

	const off = projectProxyChoice(project({ proxyId: null, proxyName: null }));
	expect(off).toEqual({ kind: "off" });

	const pinned = projectProxyChoice(project({ proxyNode: "日本" }));
	expect(pinned).toEqual({ kind: "proxy", id: "p2", nodeTag: "日本" });
	expect(projectProxyNode(pinned)).toBe("日本");
});
