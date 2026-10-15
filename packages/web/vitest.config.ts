import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 60000,
			env: { PI_OFFLINE: "1", SENTINEL_ALLOW_HOST_SESSIONS: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
		},
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/pi-coding-agent$/,
					replacement: workspaceSourcePaths.codingAgentIndex,
				},
			],
		},
	}),
);
