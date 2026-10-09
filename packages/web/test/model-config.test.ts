import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { modelsJsonPath, readModelConfig, writeModelConfig } from "../src/model-config.ts";

let root = "";

function freshAgentDir(): string {
	root = mkdtempSync(join(tmpdir(), "zgagent-model-config-"));
	return root;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("endpoint model configuration", () => {
	test("declares image input so attachments are not dropped", () => {
		const agentDir = freshAgentDir();
		writeModelConfig(agentDir, { baseUrl: "https://example.test/v1", apiKey: "k", modelId: "vision-model" });
		const written = JSON.parse(readFileSync(modelsJsonPath(agentDir), "utf-8")) as {
			providers: Record<string, { models: Array<{ input?: string[] }> }>;
		};
		// Pi drops images for models whose input omits "image"; the provider-model
		// default is text only, so this must be written explicitly.
		expect(written.providers["zg-endpoint"]?.models[0]?.input).toEqual(["text", "image"]);
	});

	test("keeps an operator-edited capability list", () => {
		const agentDir = freshAgentDir();
		const path = modelsJsonPath(agentDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"zg-endpoint": {
						baseUrl: "https://old.test/v1",
						apiKey: "old",
						api: "openai-completions",
						headers: { "x-tenant": "blue" },
						models: [{ id: "text-only", input: ["text"] }],
					},
					other: { baseUrl: "https://other.test/v1", models: [{ id: "keep-me" }] },
				},
			}),
		);

		writeModelConfig(agentDir, { baseUrl: "https://new.test/v1", apiKey: "", modelId: "text-only" });
		const written = JSON.parse(readFileSync(modelsJsonPath(agentDir), "utf-8")) as {
			providers: Record<string, { headers?: Record<string, string>; models: Array<{ input?: string[] }> }>;
		};
		expect(written.providers["zg-endpoint"]?.models[0]?.input).toEqual(["text"]);
		// Custom headers and unrelated providers survive the rewrite.
		expect(written.providers["zg-endpoint"]?.headers).toEqual({ "x-tenant": "blue" });
		expect(written.providers.other?.models[0]).toBeDefined();
	});

	test("round-trips the endpoint the console edits", () => {
		const agentDir = freshAgentDir();
		writeModelConfig(agentDir, { baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "m1" });
		expect(readModelConfig(agentDir)).toEqual({
			baseUrl: "https://example.test/v1",
			apiKey: "secret",
			modelId: "m1",
		});
	});

	test("returns null when no endpoint is configured", () => {
		expect(readModelConfig(freshAgentDir())).toBeNull();
	});
});
