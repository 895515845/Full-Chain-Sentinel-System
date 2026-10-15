/**
 * Unit tests for the model library: legacy-slot migration, entry CRUD, the
 * delete guard, and role resolution (including 跟随主模型).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	readProviderModelConfig,
	removeProviderModelConfig,
	writeCommanderModelConfig,
	writeProviderModelConfig,
} from "../src/model-config.ts";
import {
	addLibraryEntry,
	duplicateLibraryEntry,
	FOLLOW_MAIN,
	libraryView,
	migrateModelLibrary,
	modelLibraryPath,
	nextEntryId,
	normalizeModelLibrary,
	readModelLibrary,
	readStoredModelLibrary,
	removeLibraryEntry,
	resolveLibraryRole,
	rolesUsing,
	setLibraryRole,
	setReviewerAuto,
	updateLibraryEntry,
	writeModelLibrary,
} from "../src/model-library.ts";

let root = "";
let agentDir = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-model-library-"));
	agentDir = join(root, "agent");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeLegacySlots(): void {
	writeProviderModelConfig(agentDir, "zg-endpoint", "Full Chain Sentinel Endpoint", {
		baseUrl: "http://main/v1",
		apiKey: "main-key",
		modelId: "main-model",
	});
	writeCommanderModelConfig(agentDir, { baseUrl: "http://cmdr/v1", apiKey: "cmdr-key", modelId: "cmdr-model" });
	writeProviderModelConfig(agentDir, "zg-judge", "Full Chain Sentinel Gatekeeper", {
		baseUrl: "http://judge/v1",
		apiKey: "judge-key",
		modelId: "judge-model",
	});
}

describe("migration from the fixed slots", () => {
	test("turns the three slots into entries that keep their provider ids", () => {
		writeLegacySlots();
		const library = migrateModelLibrary(agentDir);
		expect(library.entries.map((entry) => entry.id).sort()).toEqual(["zg-commander", "zg-endpoint", "zg-judge"]);
		expect(library.entries.find((entry) => entry.id === "zg-endpoint")?.name).toBe("主端点");
		expect(library.roles.main).toEqual({ kind: "model", id: "zg-endpoint" });
		expect(library.roles.judge).toEqual({ kind: "model", id: "zg-judge" });
		// The reviewer used to run on commander ?? main, so it keeps that endpoint.
		expect(library.roles.reviewer).toEqual({ kind: "model", id: "zg-commander" });
		expect(library.reviewerAuto).toBe(true);
	});

	test("keeps the old fallbacks: judge then reviewer fall back to the commander, then to main", () => {
		writeProviderModelConfig(agentDir, "zg-endpoint", "Full Chain Sentinel Endpoint", {
			baseUrl: "http://main/v1",
			apiKey: "",
			modelId: "main-model",
		});
		writeCommanderModelConfig(agentDir, { baseUrl: "http://cmdr/v1", apiKey: "", modelId: "cmdr-model" });
		const withCommander = migrateModelLibrary(agentDir);
		expect(withCommander.roles.judge).toEqual({ kind: "model", id: "zg-commander" });
		expect(withCommander.roles.reviewer).toEqual({ kind: "model", id: "zg-commander" });

		removeProviderModelConfig(agentDir, "zg-commander");
		const withoutCommander = migrateModelLibrary(agentDir);
		expect(withoutCommander.roles.judge).toEqual({ kind: "follow-main" });
		expect(withoutCommander.roles.reviewer).toEqual({ kind: "follow-main" });
		expect(withoutCommander.roles.main).toEqual({ kind: "model", id: "zg-endpoint" });
	});

	test("a fresh agent dir migrates to an empty library with no main model", () => {
		const library = migrateModelLibrary(agentDir);
		expect(library.entries).toEqual([]);
		expect(library.roles.main).toBeNull();
		expect(resolveLibraryRole(agentDir, "main")).toBeNull();
		expect(resolveLibraryRole(agentDir, "judge")).toBeNull();
	});

	test("reads migrate in memory, without creating the file", () => {
		writeLegacySlots();
		expect(readModelLibrary(agentDir).entries).toHaveLength(3);
		expect(readStoredModelLibrary(agentDir)).toBeNull();
		writeModelLibrary(agentDir, readModelLibrary(agentDir));
		expect(readStoredModelLibrary(agentDir)?.entries).toHaveLength(3);
	});
});

describe("entry CRUD", () => {
	test("the first entry becomes 主模型 and the key is stored, not echoed", () => {
		const entry = addLibraryEntry(agentDir, {
			name: "DeepSeek",
			baseUrl: "https://api.deepseek.com/v1",
			apiKey: "sk-secret",
			modelId: "deepseek-chat",
		});
		expect(entry.id).toBe("zg-model-1");
		const library = readModelLibrary(agentDir);
		expect(library.roles.main).toEqual({ kind: "model", id: entry.id });
		expect(readProviderModelConfig(agentDir, entry.id)?.apiKey).toBe("sk-secret");
		const view = libraryView(agentDir);
		expect(view.entries[0].hasKey).toBe(true);
		// The view is what the client receives, so the key must not be in it.
		expect(JSON.stringify(view)).not.toContain("sk-secret");
	});

	test("an entry without a name falls back to its model id, and the key stays empty for no-auth endpoints", () => {
		const entry = addLibraryEntry(agentDir, {
			name: "  ",
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "",
			modelId: "qwen3-coder",
		});
		expect(entry.name).toBe("qwen3-coder");
		expect(libraryView(agentDir).entries[0].hasKey).toBe(false);
	});

	test("ids keep counting past the migrated slots and past deletions", () => {
		writeLegacySlots();
		writeModelLibrary(agentDir, migrateModelLibrary(agentDir));
		const first = addLibraryEntry(agentDir, { name: "a", baseUrl: "http://a/v1", apiKey: "", modelId: "a" });
		const second = addLibraryEntry(agentDir, { name: "b", baseUrl: "http://b/v1", apiKey: "", modelId: "b" });
		expect([first.id, second.id]).toEqual(["zg-model-1", "zg-model-2"]);
		removeLibraryEntry(agentDir, second.id);
		// Ids are "highest + 1", so the id of the highest entry is reused once it
		// is gone; its provider entry was removed with it.
		expect(nextEntryId(readModelLibrary(agentDir).entries)).toBe("zg-model-2");
	});

	test("updating with a null key keeps the stored one, and an empty key clears it", () => {
		const entry = addLibraryEntry(agentDir, {
			name: "k",
			baseUrl: "http://k/v1",
			apiKey: "sk-keep",
			modelId: "m1",
		});
		updateLibraryEntry(agentDir, entry.id, {
			name: "k2",
			baseUrl: "http://k2/v1",
			apiKey: null,
			modelId: "m2",
		});
		expect(readProviderModelConfig(agentDir, entry.id)).toEqual({
			baseUrl: "http://k2/v1",
			apiKey: "sk-keep",
			modelId: "m2",
		});
		expect(readModelLibrary(agentDir).entries[0].name).toBe("k2");

		updateLibraryEntry(agentDir, entry.id, {
			name: "k2",
			baseUrl: "http://k2/v1",
			apiKey: "",
			modelId: "m2",
		});
		expect(readProviderModelConfig(agentDir, entry.id)?.apiKey).toBe("sentinel-no-auth");
	});

	test("updating a missing entry is refused", () => {
		expect(() =>
			updateLibraryEntry(agentDir, "zg-model-9", { name: "x", baseUrl: "http://x/v1", apiKey: null, modelId: "x" }),
		).toThrow(/模型不存在/);
	});

	test("base URL and model id are required", () => {
		expect(() => addLibraryEntry(agentDir, { name: "x", baseUrl: " ", apiKey: "", modelId: "m" })).toThrow(
			/Base URL/,
		);
		expect(() => addLibraryEntry(agentDir, { name: "x", baseUrl: "http://x/v1", apiKey: "", modelId: " " })).toThrow(
			/模型 ID/,
		);
	});

	test("copying keeps the endpoint and starts unassigned", () => {
		const entry = addLibraryEntry(agentDir, {
			name: "GLM",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
			apiKey: "sk-glm",
			modelId: "glm-4.7",
		});
		const copy = duplicateLibraryEntry(agentDir, entry.id);
		expect(copy.id).toBe("zg-model-2");
		expect(copy.name).toBe("GLM 副本");
		expect(readProviderModelConfig(agentDir, copy.id)).toEqual({
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
			apiKey: "sk-glm",
			modelId: "glm-4.7",
		});
		expect(rolesUsing(readModelLibrary(agentDir), copy.id)).toEqual([]);
	});
});

describe("the delete guard", () => {
	test("refuses to delete an entry a role points at and names the roles", () => {
		writeLegacySlots();
		writeModelLibrary(agentDir, migrateModelLibrary(agentDir));
		expect(() => removeLibraryEntry(agentDir, "zg-commander")).toThrow(/漏洞评审/);
		expect(() => removeLibraryEntry(agentDir, "zg-endpoint")).toThrow(/主模型/);
		// Nothing was removed.
		expect(readStoredModelLibrary(agentDir)?.entries).toHaveLength(3);
	});

	test("deletes an unassigned entry and its provider entry", () => {
		// The first entry is 主模型 by default, so the spare is the second one.
		addLibraryEntry(agentDir, { name: "main", baseUrl: "http://m/v1", apiKey: "", modelId: "m" });
		const spare = addLibraryEntry(agentDir, { name: "spare", baseUrl: "http://s/v1", apiKey: "", modelId: "s" });
		removeLibraryEntry(agentDir, spare.id);
		expect(readStoredModelLibrary(agentDir)?.entries.map((entry) => entry.id)).toEqual(["zg-model-1"]);
		expect(readProviderModelConfig(agentDir, spare.id)).toBeNull();
	});

	test("deleting an unknown entry is refused", () => {
		expect(() => removeLibraryEntry(agentDir, "zg-model-42")).toThrow(/模型不存在/);
	});
});

describe("role assignment", () => {
	beforeEach(() => {
		writeLegacySlots();
		writeModelLibrary(agentDir, migrateModelLibrary(agentDir));
	});

	test("judge and reviewer accept an entry id or 跟随主模型, and reject null", () => {
		setLibraryRole(agentDir, "judge", "zg-endpoint");
		expect(readModelLibrary(agentDir).roles.judge).toEqual({ kind: "model", id: "zg-endpoint" });
		setLibraryRole(agentDir, "judge", FOLLOW_MAIN);
		expect(readModelLibrary(agentDir).roles.judge).toEqual({ kind: "follow-main" });
		expect(() => setLibraryRole(agentDir, "reviewer", null)).toThrow(/必须选择/);
	});

	test("主模型 cannot follow itself and must name an existing entry", () => {
		expect(() => setLibraryRole(agentDir, "main", FOLLOW_MAIN)).toThrow(/不能跟随/);
		expect(() => setLibraryRole(agentDir, "main", "zg-model-9")).toThrow(/模型不存在/);
	});

	test("resolves 跟随主模型 through the main entry", () => {
		setLibraryRole(agentDir, "judge", FOLLOW_MAIN);
		const resolved = resolveLibraryRole(agentDir, "judge");
		expect(resolved?.config.modelId).toBe("main-model");
		expect(resolved?.entryName).toBe("主端点");
		expect(resolved?.followedMain).toBe(true);
	});

	test("resolves nothing when the entry's provider is gone", () => {
		removeProviderModelConfig(agentDir, "zg-judge");
		expect(resolveLibraryRole(agentDir, "judge")).toBeNull();
		// The role still points at the entry, which the screen shows as unresolved.
		expect(libraryView(agentDir).resolved.judge).toBeNull();
		expect(libraryView(agentDir).roles.judge).toBe("zg-judge");
	});

	test("the view lists which roles hold each entry", () => {
		const view = libraryView(agentDir);
		expect(view.entries.find((entry) => entry.id === "zg-commander")?.roles).toEqual(["reviewer"]);
		expect(view.entries.find((entry) => entry.id === "zg-endpoint")?.roles).toEqual(["main"]);
		expect(view.resolved.main?.modelId).toBe("main-model");
	});
});

describe("reviewer switch", () => {
	test("defaults to on and can be turned off", () => {
		expect(readModelLibrary(agentDir).reviewerAuto).toBe(true);
		setReviewerAuto(agentDir, false);
		expect(readModelLibrary(agentDir).reviewerAuto).toBe(false);
		expect(libraryView(agentDir).reviewerAuto).toBe(false);
	});
});

describe("normalizeModelLibrary", () => {
	test("degrades a garbage file to an empty library", () => {
		expect(normalizeModelLibrary(null).entries).toEqual([]);
		expect(normalizeModelLibrary("nope").roles.main).toBeNull();
		expect(normalizeModelLibrary({ entries: [{ id: "" }, 7, { id: "a" }] }).entries).toEqual([
			{ id: "a", name: "a" },
		]);
	});

	test("drops role references to entries that are not there", () => {
		const library = normalizeModelLibrary({
			entries: [{ id: "a", name: "A" }],
			roles: { main: { kind: "model", id: "gone" }, judge: { kind: "model", id: "gone" }, reviewer: "x" },
			reviewerAuto: "yes",
		});
		expect(library.roles.main).toBeNull();
		expect(library.roles.judge).toEqual({ kind: "follow-main" });
		expect(library.roles.reviewer).toEqual({ kind: "follow-main" });
		expect(library.reviewerAuto).toBe(true);
	});

	test("deduplicates entry ids", () => {
		const library = normalizeModelLibrary({
			entries: [
				{ id: "a", name: "one" },
				{ id: "a", name: "two" },
			],
		});
		expect(library.entries).toEqual([{ id: "a", name: "one" }]);
	});
});

describe("storage", () => {
	test("writes a versioned file at the documented path", () => {
		writeModelLibrary(agentDir, normalizeModelLibrary({ entries: [{ id: "a", name: "A" }] }));
		expect(modelLibraryPath(agentDir)).toBe(join(agentDir, "model-library.json"));
		expect(readStoredModelLibrary(agentDir)?.version).toBe(1);
	});

	test("a corrupt file reads as absent, so the runtime falls back to the migration", () => {
		writeModelLibrary(agentDir, normalizeModelLibrary({ entries: [{ id: "a", name: "A" }] }));
		writeModelLibrary(agentDir, normalizeModelLibrary({}));
		expect(readStoredModelLibrary(agentDir)?.entries).toEqual([]);
	});
});
