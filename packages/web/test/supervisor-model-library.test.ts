/** The supervisor is a fourth model role, with the same reference/delete rules. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	addLibraryEntry,
	FOLLOW_MAIN,
	libraryView,
	readModelLibrary,
	removeLibraryEntry,
	resolveLibraryRole,
	setLibraryRole,
} from "../src/model-library.ts";

let root = "";
let agentDir = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-supervisor-library-"));
	agentDir = join(root, "agent");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function add(name: string, modelId: string): string {
	return addLibraryEntry(agentDir, {
		name,
		baseUrl: `http://${modelId}/v1`,
		apiKey: "",
		modelId,
	}).id;
}

describe("supervisor model role", () => {
	test("can point at its own entry and resolves it", () => {
		const main = add("主模型", "main-model");
		const supervisor = add("监督模型", "supervisor-model");
		setLibraryRole(agentDir, "supervisor", supervisor);
		expect(readModelLibrary(agentDir).roles.main).toEqual({ kind: "model", id: main });
		expect(resolveLibraryRole(agentDir, "supervisor")?.config.modelId).toBe("supervisor-model");
		expect(libraryView(agentDir).roles.supervisor).toBe(supervisor);
		expect(libraryView(agentDir).resolved.supervisor?.modelId).toBe("supervisor-model");
	});

	test("can follow the main model", () => {
		add("主模型", "main-model");
		setLibraryRole(agentDir, "supervisor", FOLLOW_MAIN);
		expect(resolveLibraryRole(agentDir, "supervisor")?.config.modelId).toBe("main-model");
		expect(resolveLibraryRole(agentDir, "supervisor")?.followedMain).toBe(true);
	});

	test("an entry used by the supervisor cannot be deleted until the role moves", () => {
		add("主模型", "main-model");
		const supervisor = add("监督模型", "supervisor-model");
		setLibraryRole(agentDir, "supervisor", supervisor);
		expect(() => removeLibraryEntry(agentDir, supervisor)).toThrow(/监督模型/);
		setLibraryRole(agentDir, "supervisor", FOLLOW_MAIN);
		expect(() => removeLibraryEntry(agentDir, supervisor)).not.toThrow();
	});
});
