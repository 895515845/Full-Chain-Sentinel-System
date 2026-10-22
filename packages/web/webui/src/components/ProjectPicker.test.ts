/**
 * Render smoke test for the project picker.
 *
 * The picker is the only way to leave a project, so the regression pinned here is
 * a disabled trigger: while the viewed session runs, the button used to be
 * disabled, and a long run left the operator unable to open any other project.
 * Switching is safe for the run in flight (its tools captured their own project's
 * container and work directory), so the trigger must stay clickable and merely
 * say what happens to the run.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelProjectInfo } from "../types.ts";
import { ProjectPicker } from "./ProjectPicker.tsx";

function project(id: string, name: string): SentinelProjectInfo {
	return { id, name, cwd: `/work/${id}`, container: `sentinel-${id}`, vulnCount: 0, gateCount: 0 };
}

function render(streaming: boolean): string {
	return renderToStaticMarkup(
		createElement(ProjectPicker, {
			projects: [project("a", "项目 A"), project("b", "项目 B")],
			activeProject: project("a", "项目 A"),
			streaming,
			onSwitch: () => {},
			onAdd: async () => null,
			onRemove: async () => null,
		}),
	);
}

/** The trigger button only, so an unrelated disabled control cannot satisfy the check. */
function trigger(html: string): string {
	const start = html.indexOf("project-current");
	return start === -1 ? "" : html.slice(start, html.indexOf("</button>", start));
}

test("the project trigger stays usable while an agent is running", () => {
	const html = render(true);
	const button = trigger(html);
	expect(button).toContain("项目 A");
	expect(button).not.toContain("disabled");
	expect(button).toContain("后台继续运行");
});

test("an idle console keeps the trigger and shows the project directory", () => {
	const html = render(false);
	const button = trigger(html);
	expect(button).not.toContain("disabled");
	expect(button).toContain("/work/a");
});
