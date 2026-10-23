/**
 * The project delete dialog.
 *
 * The two scopes are the two buttons, so the dialog has no preselection to get
 * wrong: what matters is that both actions stay disabled until the full project
 * name is typed, that the destructive one is the only solid red button, and that
 * the body says what each scope takes.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelProjectInfo } from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { deleteConfirmMatches, ProjectDeleteDialog, PROJECT_REMOVE_OPTIONS } from "./ProjectDeleteDialog.tsx";

const project: SentinelProjectInfo = {
	id: "p1",
	name: "安卓渗透",
	cwd: "/Users/operator/.sentinel/projects/安卓渗透",
	container: "sentinel-7f3a91",
	state: "running",
	manualStop: false,
	vulnCount: 12,
	gateCount: 3,
};

function renderDelete(): string {
	return renderToStaticMarkup(
		createElement(ProjectDeleteDialog, {
			project,
			busy: false,
			sessionCount: 5,
			onConfirm: () => {},
			onCancel: () => {},
		}),
	);
}

test("the dialog names the project and states what it holds in one line", () => {
	const html = renderDelete();
	expect(html).toContain("删除项目");
	expect(html).toContain("安卓渗透");
	expect(html).toContain("sentinel-7f3a91");
	expect(html).toContain("5 个会话");
	expect(html).toContain("12 条漏洞记录");
	expect(html).toContain("3 条审批记录");
	// The body explains both scopes in one paragraph; there is no separate
	// description block and no cards.
	expect(html).toContain("仅删除容器只删掉容器本身");
	expect(html).toContain("不可恢复");
});

test("both scopes are footer buttons, and both wait for the typed name", () => {
	const html = renderDelete();
	expect(html).toContain("取消");
	// Disabled until the name matches: the actions are the choice, so neither may
	// be reachable by a stray click.
	const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)];
	const containerButton = buttons.find((match) => match[1] === "仅删除容器");
	const dataButton = buttons.find((match) => match[1] === "删除项目数据");
	expect(containerButton?.[0]).toContain("disabled");
	expect(dataButton?.[0]).toContain("disabled");
	// Only the destructive one is solid red.
	expect(containerButton?.[0]).not.toContain("solid");
	expect(dataButton?.[0]).toContain("danger");
});

test("the typed name has to match exactly", () => {
	expect(deleteConfirmMatches("安卓渗透", "安卓渗透")).toBe(true);
	// Surrounding space is forgiven, anything else is not.
	expect(deleteConfirmMatches("  安卓渗透 ", "安卓渗透")).toBe(true);
	expect(deleteConfirmMatches("安卓渗", "安卓渗透")).toBe(false);
	expect(deleteConfirmMatches("", "安卓渗透")).toBe(false);
	expect(deleteConfirmMatches("安卓渗透2", "安卓渗透")).toBe(false);
});

test("the option list keeps the safe scope first and only the data scope dangerous", () => {
	expect(PROJECT_REMOVE_OPTIONS.map((option) => option.scope)).toEqual(["container", "data"]);
	expect(PROJECT_REMOVE_OPTIONS[0]?.danger).toBe(false);
	expect(PROJECT_REMOVE_OPTIONS[1]?.danger).toBe(true);
});

test("the shell is a dialog and its footer carries the decision", () => {
	const html = renderToStaticMarkup(
		createElement(ConfirmDialog, {
			title: "停止容器",
			subtitle: "安卓渗透",
			onCancel: () => {},
			footer: createElement("button", { type: "button" }, "确认停止"),
			children: createElement("p", { className: "confirm-note" }, "停止后工具调用与对话都无法进行"),
		}),
	);
	expect(html).toContain('role="dialog"');
	expect(html).toContain("停止容器");
	expect(html).toContain("安卓渗透");
	expect(html).toContain("取消");
	expect(html).toContain("确认停止");
});
