import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppSider } from "./AppSider.tsx";
import { MobileTopbar } from "./MobileTopbar.tsx";

vi.mock("../branding.ts", () => ({ PROJECT_REPOSITORY: "https://example.test/sentinel" }));

beforeEach(() => {
	vi.stubGlobal("localStorage", { getItem: () => null });
});

afterEach(() => vi.unstubAllGlobals());

function render(overrides: Partial<ComponentProps<typeof AppSider>> = {}) {
	return renderToStaticMarkup(
		createElement(AppSider, {
			collapsed: false,
			mobileOpen: false,
			inert: false,
			panelRef: null,
			onCloseMobile: () => {},
			onToggleCollapse: () => {},
			activePage: "chat",
			onNavigate: () => {},
			connected: true,
			mode: "review",
			modelConfigured: true,
			sessions: [
				{
					id: "session-1",
					path: "/sessions/one.jsonl",
					cwd: "/work",
					created: "2026-10-24T00:00:00Z",
					modified: "2026-10-24T00:00:00Z",
					messageCount: 1,
					firstMessage: "回归测试会话",
				},
			],
			engines: [],
			pluginPages: [],
			activeSessionId: "session-1",
			runningSessions: [],
			pendingApprovals: 0,
			pendingVulns: 0,
			onNewSession: () => {},
			onSwitchSession: () => {},
			onRenameSession: () => {},
			onDeleteSession: () => {},
			onSetSessionStatus: () => {},
			projectSlot: createElement("button", { type: "button" }, "切换项目"),
			onRefresh: () => {},
			authUser: null,
			onLogout: () => {},
			onSwitchLanguage: () => {},
			...overrides,
		}),
	);
}

test("sessions are native buttons and filters expose their selected state", () => {
	const html = render();
	expect(html).toMatch(/<button[^>]*aria-current="true"[^>]*session-row/);
	expect(html).toContain('aria-pressed="true"');
	expect(html).toContain('aria-controls="sider-submenu-chat"');
	expect(html).toContain('id="sider-submenu-chat"');
	expect(html).not.toContain('role="button"');
});

test("entering a settings page exposes the selected child without two current pages", () => {
	const html = render({ activePage: "settings.model" });
	expect(html).toContain('id="sider-submenu-settings"');
	expect(html.match(/aria-current="page"/g)).toHaveLength(1);
	expect(html).toMatch(/class="menu-sub-item active" aria-current="page"/);
});

test("collapsed desktop navigation does not reference hidden submenus", () => {
	const html = render({ collapsed: true });
	expect(html).not.toContain('aria-controls="sider-submenu-chat"');
	expect(html).not.toContain('id="sider-submenu-chat"');
	expect(html).toContain('aria-expanded="false"');
});

test("collapsed navigation marks settings current when a child page is selected", () => {
	const html = render({ collapsed: true, activePage: "settings.environment" });
	expect(html.match(/aria-current="page"/g)).toHaveLength(1);
	expect(html).toMatch(/aria-current="page" aria-expanded="false" title="设置"/);
});

test("closed mobile navigation is inert; open navigation retains projects and sessions", () => {
	expect(render({ inert: true })).toMatch(/<aside[^>]*inert=""/);
	const html = render({ mobileOpen: true });
	expect(html).not.toContain('inert=""');
	expect(html).toContain("切换项目");
	expect(html).toContain("回归测试会话");
});

test("the mobile trigger exposes its target and the current project", () => {
	const html = renderToStaticMarkup(
		createElement(MobileTopbar, {
			open: true,
			projectName: "测试项目",
			buttonRef: null,
			onToggle: () => {},
		}),
	);
	expect(html).toContain('aria-controls="app-navigation"');
	expect(html).toContain('aria-expanded="true"');
	expect(html).toContain('aria-label="收起侧边栏"');
	expect(html).toContain("测试项目");
});
