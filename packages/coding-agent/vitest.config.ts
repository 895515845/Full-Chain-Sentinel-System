import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

// Tests must not depend on (or create) the user's real agent directory. Point
// the default agent dir at a per-run temp directory; tests that stub the env
// themselves override this value.
const testAgentDir = mkdtempSync(join(tmpdir(), "zgagent-vitest-agent-"));

// find/grep tool tests need fd and rg. Tests run offline (no managed download),
// so expose the checked-in copies through PATH.
const fixtureBinDir = join(import.meta.dirname, "test", "fixtures", "bin");

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: {
				PI_OFFLINE: "1",
				ZGAGENT_CODING_AGENT_DIR: testAgentDir,
				PATH: `${fixtureBinDir}:${process.env.PATH ?? ""}`,
			},
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
