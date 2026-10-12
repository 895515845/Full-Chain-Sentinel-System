/**
 * Model-library fixtures for tests.
 *
 * The runtime resolves every role through the library, so a test that needs "an
 * endpoint exists" writes one entry and points a role at it. Tests that exercise
 * the fallback chain use the default main role; the gatekeeper tests point the
 * judge role at their stub.
 */

import { addLibraryEntry, setLibraryRole } from "../src/model-library.ts";
import type { ZGModelConfig, ZGModelRoleName } from "../src/protocol.ts";

/** Write one entry and point `role` at it. Returns the new entry id. */
export function writeTestModel(agentDir: string, config: ZGModelConfig, role: ZGModelRoleName = "main"): string {
	const entry = addLibraryEntry(agentDir, {
		name: config.modelId,
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		modelId: config.modelId,
	});
	setLibraryRole(agentDir, role, entry.id);
	return entry.id;
}
