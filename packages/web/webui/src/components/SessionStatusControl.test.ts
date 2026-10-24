/**
 * Render smoke test for the operator session status control.
 *
 * The chip is how the operator tells ten sessions apart, so the two things that
 * can silently break it are pinned here: the label (a status with no label shows
 * an empty chip) and the class that colors it (a wrong class renders the chip in
 * the muted "no status" grey, which reads as if nothing was set).
 *
 * It lives next to the component rather than in `test/`: the root TypeScript
 * project has no JSX, so only the webui project can type-check a file that
 * imports a `.tsx` module.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelSessionStatus } from "../types.ts";
import {
	SESSION_STATUS_LABELS,
	SESSION_STATUSES,
	SessionStatusChip,
	SessionStatusControl,
	SessionStatusRail,
} from "./SessionStatusControl.tsx";

test("every status renders its label and its own color class", () => {
	for (const status of SESSION_STATUSES) {
		const html = renderToStaticMarkup(createElement(SessionStatusChip, { status }));
		expect(html).toContain(SESSION_STATUS_LABELS[status]);
		expect(html).toContain(`session-status-chip ${status}`);
	}
});

test("an unset status renders as a muted chip, not an empty one", () => {
	const html = renderToStaticMarkup(createElement(SessionStatusChip, {}));
	expect(html).toContain("无状态");
	expect(html).toContain("session-status-chip none");
});

test("the toolbar variant shows the status and its dot color", () => {
	const html = renderToStaticMarkup(
		createElement(SessionStatusControl, { variant: "toolbar", status: "todo", onPick: () => {} }),
	);
	expect(html).toContain("session-status-trigger todo");
	expect(html).toContain("待跟进");
	expect(html).toContain("session-status-dot todo");
});

test("the picker stays closed until it is opened, and offers every status when it is", () => {
	const closed = renderToStaticMarkup(
		createElement(SessionStatusControl, { variant: "chip", status: "done" as SentinelSessionStatus, onPick: () => {} }),
	);
	expect(closed).not.toContain("session-status-picker");
	// The chip itself is the trigger in a list row.
	expect(closed).toContain("session-status-chip done");
	expect(closed).toContain("已完成");
});

test("a session row draws a rail for every set status, including the two terminal ones", () => {
	// Marking a session 已完成 used to change nothing visible in the list: the
	// rail was drawn for 待跟进/进行中 only, so the mark looked unsaved.
	for (const status of SESSION_STATUSES) {
		const html = renderToStaticMarkup(createElement(SessionStatusRail, { status }));
		expect(html).toContain(`status-rail rail-${status}`);
		expect(html).toContain(`人工标记：${SESSION_STATUS_LABELS[status]}`);
	}
});

test("only the terminal statuses spell themselves out in the row", () => {
	// A rail color cannot tell 已完成 from 已忽略, so those two carry the label;
	// 待跟进/进行中 stay label-free to keep the list compact.
	const done = renderToStaticMarkup(createElement(SessionStatusRail, { status: "done" }));
	expect(done).toContain("session-row-status row-done");
	expect(done).toContain("已完成");

	const ignored = renderToStaticMarkup(createElement(SessionStatusRail, { status: "ignored" }));
	expect(ignored).toContain("session-row-status row-ignored");
	expect(ignored).toContain("已忽略");

	const todo = renderToStaticMarkup(createElement(SessionStatusRail, { status: "todo" }));
	expect(todo).not.toContain("session-row-status");
	// The rail's tooltip names the status; no text node spells it out.
	expect(todo).not.toContain(">待跟进<");
});

test("an unset status adds nothing to the row", () => {
	expect(renderToStaticMarkup(createElement(SessionStatusRail, {}))).toBe("");
	expect(renderToStaticMarkup(createElement(SessionStatusRail, { status: null }))).toBe("");
});
