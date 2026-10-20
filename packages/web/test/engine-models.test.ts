/**
 * Regression: the engine's commander runtime is created once, and models.json
 * writes used to be invisible to it. Saving the commander endpoint (or a library
 * entry) while the console was running therefore only took effect after a full
 * restart.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EngineManager } from "../src/engine.ts";
import { writeCommanderModelConfig } from "../src/model-config.ts";
import { writeTestModel } from "./model-fixtures.ts";

let dir = "";
let manager: EngineManager;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-engine-models-"));
	manager = new EngineManager(
		dir,
		{ onChange: () => {}, onCommanderEvent: () => {}, onTaskEvent: () => {} },
		async () => {
			throw new Error("no session expected in this test");
		},
	);
});

afterEach(() => {
	manager.dispose();
	rmSync(dir, { recursive: true, force: true });
});

test("a commander endpoint saved after the runtime was built resolves without a restart", async () => {
	// The main role gives the manager a reason to build its runtime before the
	// commander endpoint exists.
	writeTestModel(dir, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-main", modelId: "main-model" });
	const resolve = () =>
		(
			manager as unknown as { resolveCommanderModel: () => Promise<{ id: string } | undefined> }
		).resolveCommanderModel();

	expect((await resolve())?.id).toBe("main-model");

	// What save_commander_config writes, followed by the server's invalidation.
	writeCommanderModelConfig(dir, { baseUrl: "http://127.0.0.1:8/v1", apiKey: "sk-commander", modelId: "cmd-model" });
	manager.markModelsDirty();

	expect((await resolve())?.id).toBe("cmd-model");
});
