/**
 * Render smoke test for the operator terminal panel.
 *
 * The xterm instance itself is created in an effect (a real DOM is required), so what
 * is pinned here is the shell around it: that the panel names the project and the shell
 * state, and that it says out loud what the terminal is not — no approval, nothing in
 * the session record — because that is the one property an operator could otherwise
 * assume the wrong way round.
 *
 * It lives next to the component rather than in `test/`: the root TypeScript project has
 * no JSX, so only the webui project can type-check a file that imports a `.tsx` module.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TerminalPanel } from "./TerminalPanel.tsx";

const noop = (): void => {};

function render(projectName: string): string {
	return renderToStaticMarkup(
		createElement(TerminalPanel, {
			projectId: "project-1",
			projectName,
			onOpen: noop,
			onInput: noop,
			onClose: noop,
			onClosePanel: noop,
		}),
	);
}

test("the panel names the project, the shell state and what the shell is not", () => {
	const html = render("打点二");
	expect(html).toContain("终端");
	expect(html).toContain("打点二");
	expect(html).toContain("未打开");
	// The two properties that make this panel different from every other one.
	expect(html).toContain("不过审批");
	expect(html).toContain("不进会话记录");
	// Actions exist, and the shell cannot be ended before it started.
	expect(html).toContain("结束终端");
	expect(html).toContain("打开终端");
});
