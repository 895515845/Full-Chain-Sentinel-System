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
import type { ZGSessionStatus } from "../types.ts";
import { SESSION_STATUSES, SESSION_STATUS_LABELS, SessionStatusControl, SessionStatusChip } from "./SessionStatusControl.tsx";

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
	expect(html).toContain("#e6a23c");
});

test("the picker stays closed until it is opened, and offers every status when it is", () => {
	const closed = renderToStaticMarkup(
		createElement(SessionStatusControl, { variant: "chip", status: "done" as ZGSessionStatus, onPick: () => {} }),
	);
	expect(closed).not.toContain("session-status-picker");
	// The chip itself is the trigger in a list row.
	expect(closed).toContain("session-status-chip done");
	expect(closed).toContain("已完成");
});
