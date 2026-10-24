/**
 * The dialogs behind a project row's overflow menu.
 *
 * This exists because the menu once set four `pending*` states while the page
 * rendered only one dialog: 停止容器, 重建容器 and 删除项目… changed state and
 * showed nothing, so they read as decoration. What is pinned here is that every
 * action the menu can open has a dialog, and that it is the right one.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelProjectInfo } from "../types.ts";
import { ProjectRowDialogs, type ProjectRowAction, projectRowActionLabel } from "./ProjectRowDialogs.tsx";

function project(overrides: Partial<SentinelProjectInfo> = {}): SentinelProjectInfo {
	return {
		id: "proj",
		name: "靶场-01",
		cwd: "/tmp/p",
		container: "sentinel-abc123-01",
		state: "running",
		sessionCount: 2,
		vulnCount: 3,
		gateCount: 1,
		...overrides,
	};
}

function render(action: ProjectRowAction | null, target: SentinelProjectInfo | null = project()): string {
	return renderToStaticMarkup(
		createElement(ProjectRowDialogs, {
			action,
			project: target,
			config: { proxies: [], defaultId: null, image: "", imagePresent: true, testUrl: "" },
			busy: false,
			onStop: () => {},
			onRecreate: () => {},
			onRemove: () => {},
			onSaveProxy: () => {},
			onCancel: () => {},
		}),
	);
}

test("nothing is rendered while the menu is closed", () => {
	expect(render(null)).toBe("");
	// A dialog whose project vanished with a refresh must not throw.
	expect(render("stop", null)).toBe("");
});

test("stop asks for confirmation and says what stopping costs", () => {
	const html = render("stop");
	expect(html).toContain("停止容器");
	expect(html).toContain("靶场-01");
	expect(html).toContain("确认停止");
	expect(html).toContain("工具调用与对话都无法进行");
	// The container layer is lost, the work directory is not.
	expect(html).toContain("/work");
	expect(html).not.toContain("确认重建");
});

test("recreate asks for confirmation and names the settings it applies", () => {
	const html = render("recreate");
	expect(html).toContain("重建容器");
	expect(html).toContain("确认重建");
	expect(html).toContain("网络模式与代理设置");
	expect(html).not.toContain("确认停止");
});

test("delete offers both scopes and gates them on the project name", () => {
	const html = render("delete");
	expect(html).toContain("删除项目");
	expect(html).toContain("仅删除容器");
	expect(html).toContain("删除项目数据");
	// Nothing is clickable until the name is typed, so both start disabled.
	expect(html).toContain("disabled");
	expect(html).toContain("输入项目名 靶场-01 以确认");
});

test("proxy opens the proxy choice, not a container action", () => {
	const html = render("proxy");
	expect(html).toContain("项目代理");
	expect(html).not.toContain("确认停止");
	expect(html).not.toContain("确认重建");
});

test("every action has a menu label", () => {
	const labels = (["stop", "recreate", "delete", "proxy"] as const).map(projectRowActionLabel);
	expect(labels).toEqual(["停止容器", "重建容器", "删除项目…", "代理设置…"]);
});
