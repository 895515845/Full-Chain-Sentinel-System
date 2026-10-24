/**
 * Render smoke test for the projects page's container controls.
 *
 * A project's container and its data are separate: the page has to show which
 * state a container is in and offer the action that applies (start when it is
 * stopped or gone, stop when it runs), and the delete dialog has to offer both
 * scopes. The dialogs themselves open from local state, so what is pinned here
 * is the row for each state plus the option list the dialog is built from.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { EMPTY_PROXY_CONFIG, type SentinelProjectInfo } from "../types.ts";
import { ProjectsPage } from "./ProjectsPage.tsx";
import { deleteConfirmMatches, PROJECT_REMOVE_OPTIONS } from "./ProjectDeleteDialog.tsx";
import { projectProxyId } from "./ProjectProxyDialog.tsx";

function project(overrides: Partial<SentinelProjectInfo> = {}): SentinelProjectInfo {
	return {
		id: "p1",
		name: "靶场",
		cwd: "/Users/operator/.sentinel/projects/靶场",
		container: "sentinel-abc123",
		state: "running",
		manualStop: false,
		vulnCount: 0,
		gateCount: 0,
		sessionCount: 0,
		...overrides,
	};
}

function render(projects: SentinelProjectInfo[], activeId: string | null = projects[0]?.id ?? null): string {
	return renderToStaticMarkup(
		createElement(ProjectsPage, {
			projects,
			activeProject: projects.find((entry) => entry.id === activeId) ?? null,
			busy: false,
			proxyConfig: EMPTY_PROXY_CONFIG,
			onCreate: async () => null,
			onRecreate: async () => null,
			onRemove: async () => null,
			onStop: async () => null,
			onStart: async () => null,
			onSaveProxy: async () => null,
		}),
	);
}

/** The row's action area, so a hint in a title cannot be read as a button. */
function actionsFor(html: string, projectName: string): string {
	const nameAt = html.indexOf(projectName);
	const rowAt = html.lastIndexOf('<div class="data-row', nameAt);
	const actionsAt = html.indexOf('class="data-actions project-actions"', rowAt);
	// Read the rendered action cell.
	return html.slice(actionsAt, html.indexOf("</div>", actionsAt));
}

test("the table is 项目 / 会话 / 漏洞 / 操作 with the counts from the server", () => {
	const html = render([
		project({ id: "p1", name: "运行中项目", sessionCount: 4, vulnCount: 12, gateCount: 3 }),
	]);
	expect(html).toContain(">项目<");
	expect(html).toContain(">会话<");
	expect(html).toContain(">漏洞<");
	expect(html).toContain(">操作<");
	// The counts come from each project record, so every row has real numbers.
	expect(html).toContain(">4</span>");
	expect(html).toContain(">12</span>");
});

test("switching projects is not offered in the table; stopped projects can start their container", () => {
	const running = render([project({ id: "p1", name: "运行中项目", state: "running" })]);
	const runningActions = actionsFor(running, "运行中项目");
	expect(runningActions).not.toContain(">进入</button>");
	expect(runningActions).not.toContain("当前项目</span>");

	// Running projects expose management actions without switching the active project.
	const other = render([project({ id: "p1", name: "当前项目" }), project({ id: "p2", name: "别的项目" })]);
	const otherActions = actionsFor(other, "别的项目");
	expect(otherActions).not.toContain(">进入</button>");
	expect(otherActions).not.toContain(">启动容器</button>");

	// Stopped by the operator: entering is refused, so the row offers the start.
	const stopped = render([project({ id: "p1", name: "停过的项目", state: "stopped", manualStop: true })], null);
	const stoppedActions = actionsFor(stopped, "停过的项目");
	expect(stoppedActions).toContain(">启动容器</button>");
	expect(stoppedActions).not.toContain(">进入</button>");
	expect(stopped).toContain("已停止（手动）");
});

test("the container name is shortened for the row and kept in full in the tooltip", () => {
	const html = render([project({ container: "zgagent-f80cbea7-f1f" })]);
	expect(html).toContain("zgagent-f80cb…f1f");
	expect(html).toContain('title="zgagent-f80cbea7-f1f"');
});

test("a container that is gone is offered start as a recreate", () => {
	const missing = render([project({ id: "p3", name: "没容器的项目", state: "missing", manualStop: true })], null);
	expect(missing).toContain("无容器");
	expect(actionsFor(missing, "没容器的项目")).toContain("启动容器");
	expect(missing).toContain("容器不存在：点「启动容器」会按当前设置重新创建");
});

test("the status carries the reason, not just the word", () => {
	const stopped = render([project({ state: "stopped", manualStop: true })]);
	expect(stopped).toContain("容器已被手动停止：进入该项目前需要点「启动容器」");
	// A container stopped outside the console may be started again on use.
	const exited = render([project({ state: "stopped", manualStop: false })]);
	expect(exited).toContain("容器已停止：点「启动容器」即可重新启动，容器里的安装内容都还在");
});

test("only the exact project name unlocks the delete actions", () => {
	expect(deleteConfirmMatches("靶场", "靶场")).toBe(true);
	expect(deleteConfirmMatches("靶", "靶场")).toBe(false);
});

test("the delete dialog offers both scopes, the data one as the dangerous one", () => {
	expect(PROJECT_REMOVE_OPTIONS.map((option) => option.scope)).toEqual(["container", "data"]);
	const containerOnly = PROJECT_REMOVE_OPTIONS[0];
	const withData = PROJECT_REMOVE_OPTIONS[1];
	expect(containerOnly?.label).toBe("仅删除容器");
	expect(containerOnly?.danger).toBe(false);
	expect(containerOnly?.label).toBe("仅删除容器");
	expect(withData?.label).toBe("删除项目数据");
	expect(withData?.danger).toBe(true);
	expect(withData?.danger).toBe(true);
});

test("a proxied project carries the profile's name in the row", () => {
	const proxied = render([project({ name: "走代理的项目", proxyName: "香港节点" })], null);
	expect(proxied).toContain("香港节点");
	const direct = render([project({ name: "直连的项目", proxyName: null })], null);
	expect(direct).not.toContain("香港节点");
});

test("the project dialog's choices become the stored pointer", () => {
	// Following the default is the absence of a choice, not a copy of it: a copy
	// would stop tracking a later change to the default.
	expect(projectProxyId({ kind: "inherit" })).toBeUndefined();
	// Off is an explicit choice, and it survives a deleted profile.
	expect(projectProxyId({ kind: "off" })).toBeNull();
	expect(projectProxyId({ kind: "proxy", id: "p1" })).toBe("p1");
});
