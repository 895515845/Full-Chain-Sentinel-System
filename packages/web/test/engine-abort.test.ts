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
import { removeProviderModelConfig, writeCommanderModelConfig } from "../src/model-config.ts";
import { readStoredModelLibrary, setLibraryRole } from "../src/model-library.ts";
import { writeTestModel } from "./model-fixtures.ts";

let dir: string;
let manager: EngineManager;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-engine-abort-"));
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

test("setGateMode refuses an unknown engine instead of writing a row for it", () => {
	expect(() => manager.setGateMode("engine-does-not-exist", "ai")).toThrow(/不存在/);
});

test("judgeAvailable follows the 守门模型 role, so the AI gate is offered only when one resolves", () => {
	expect(manager.judgeAvailable()).toBe(false);
	writeTestModel(dir, { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", modelId: "judge" }, "judge");
	expect(manager.judgeAvailable()).toBe(true);
	// 跟随主模型 is an explicit choice now, not a fallback: it still resolves while
	// 主模型 does, and the commander slot plays no part in the judge chain.
	setLibraryRole(dir, "judge", "follow-main");
	writeCommanderModelConfig(dir, { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", modelId: "commander" });
	expect(manager.judgeAvailable()).toBe(true);
	// Remove the main entry's provider and nothing is left to resolve.
	const mainId = readStoredModelLibrary(dir)?.roles.main?.id ?? "";
	removeProviderModelConfig(dir, mainId);
	expect(manager.judgeAvailable()).toBe(false);
});
