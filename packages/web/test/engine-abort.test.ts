/**
 * Regression: an unknown task id in abort_task used to throw an unhandled
 * rejection (through the fire-and-forget tool call) and crash the whole
 * console process. abortTask must answer with a result, never throw — the id
 * is model input, and a hallucinated or stale id is normal traffic.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EngineManager } from "../src/engine.ts";

let dir: string;
let manager: EngineManager;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "zg-engine-abort-"));
	// The acquire callback is never reached: every task below fails earlier.
	manager = new EngineManager(
		dir,
		{
			onChange: () => {},
			onCommanderEvent: () => {},
			onTaskEvent: () => {},
		},
		async () => {
			throw new Error("no session expected in this test");
		},
	);
});

afterAll(() => {
	manager.dispose();
	rmSync(dir, { recursive: true, force: true });
});

test("abortTask with an unknown id reports failure instead of throwing", async () => {
	const result = await manager.abortTask("task-does-not-exist", "测试");
	expect(result.ok).toBe(false);
	expect(result.error).toContain("不存在");
});

test("abortTask is a settled promise, so a void call cannot crash the process", async () => {
	let unhandled = false;
	const onRejection = () => {
		unhandled = true;
	};
	process.on("unhandledRejection", onRejection);
	void manager.abortTask("task-also-missing", "测试");
	await new Promise((resolve) => setImmediate(resolve));
	process.off("unhandledRejection", onRejection);
	expect(unhandled).toBe(false);
});
