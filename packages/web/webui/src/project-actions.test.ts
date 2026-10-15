/**
 * The project-action contract.
 *
 * Create / remove / rebuild are answered by the server's `projects` broadcast on
 * success and by an `error` message on failure. This pins both, because waiting only
 * for the error is a silent failure: the picker hides the project list behind its
 * create form, so a stuck form makes a created project invisible until a reload.
 */
import { expect, test, vi } from "vitest";
import { ProjectAction } from "./project-actions.ts";

test("the projects broadcast releases the form as a success", async () => {
	const action = new ProjectAction();
	const sent: string[] = [];
	const pending = action.run(() => sent.push("add_project"));
	expect(sent).toEqual(["add_project"]);
	action.succeeded();
	await expect(pending).resolves.toBeNull();
});

test("a refusal releases the form with the server's reason", async () => {
	const action = new ProjectAction();
	const pending = action.run(() => {});
	action.failed("已存在同名项目");
	await expect(pending).resolves.toBe("已存在同名项目");
});

test("a late message with nothing pending is a no-op, and the timeout is a backstop", async () => {
	vi.useFakeTimers();
	try {
		const action = new ProjectAction();
		expect(() => action.succeeded()).not.toThrow();
		const pending = action.run(() => {}, 1000);
		vi.advanceTimersByTime(1000);
		await expect(pending).resolves.toBeNull();
	} finally {
		vi.useRealTimers();
	}
});
