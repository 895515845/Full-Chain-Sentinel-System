import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	modelsJsonPath,
	readProviderModelConfig,
	removeProviderModelConfig,
	writeProviderModelConfig,
} from "../src/model-config.ts";

let root = "";

function freshAgentDir(): string {
	root = mkdtempSync(join(tmpdir(), "sentinel-model-config-"));
	return root;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("provider model configuration", () => {
	test("declares image input so attachments are not dropped", () => {
		const agentDir = freshAgentDir();
		writeProviderModelConfig(agentDir, "zg-endpoint", "主端点", {
			baseUrl: "https://example.test/v1",
			apiKey: "k",
			modelId: "vision-model",
		});
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

		writeProviderModelConfig(agentDir, "zg-endpoint", "主端点", {
			baseUrl: "https://new.test/v1",
			apiKey: "",
			modelId: "text-only",
		});
		const written = JSON.parse(readFileSync(modelsJsonPath(agentDir), "utf-8")) as {
			providers: Record<string, { headers?: Record<string, string>; models: Array<{ input?: string[] }> }>;
		};
		expect(written.providers["zg-endpoint"]?.models[0]?.input).toEqual(["text"]);
		// Custom headers and unrelated providers survive the rewrite.
		expect(written.providers["zg-endpoint"]?.headers).toEqual({ "x-tenant": "blue" });
		expect(written.providers.other?.models[0]).toBeDefined();
	});

	test("round-trips one provider entry", () => {
		const agentDir = freshAgentDir();
		writeProviderModelConfig(agentDir, "zg-model-1", "备用", {
			baseUrl: "https://example.test/v1",
			apiKey: "secret",
			modelId: "m1",
		});
		expect(readProviderModelConfig(agentDir, "zg-model-1")).toEqual({
			baseUrl: "https://example.test/v1",
			apiKey: "secret",
			modelId: "m1",
			capabilities: { api: "openai-completions", input: ["text", "image"] },
		});
	});

	test("writes a placeholder bearer for an unauthenticated endpoint", () => {
		const agentDir = freshAgentDir();
		writeProviderModelConfig(agentDir, "zg-model-2", "本地", {
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "",
			modelId: "local",
		});
		expect(readProviderModelConfig(agentDir, "zg-model-2")?.apiKey).toBe("sentinel-no-auth");
	});

	test("removes one provider and leaves the others alone", () => {
		const agentDir = freshAgentDir();
		writeProviderModelConfig(agentDir, "a", "A", { baseUrl: "http://a/v1", apiKey: "", modelId: "a" });
		writeProviderModelConfig(agentDir, "b", "B", { baseUrl: "http://b/v1", apiKey: "", modelId: "b" });
		removeProviderModelConfig(agentDir, "a");
		expect(readProviderModelConfig(agentDir, "a")).toBeNull();
		expect(readProviderModelConfig(agentDir, "b")?.modelId).toBe("b");
	});

	test("returns null when the provider is missing", () => {
		expect(readProviderModelConfig(freshAgentDir(), "zg-endpoint")).toBeNull();
	});

	test("persists the declared protocol and capability set", () => {
		const agentDir = freshAgentDir();
		writeProviderModelConfig(agentDir, "zg-model-3", "全能力", {
			baseUrl: "https://api.anthropic.com",
			apiKey: "k",
			modelId: "claude-x",
			capabilities: {
				api: "anthropic-messages",
				contextWindow: 200000,
				maxTokens: 64000,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				promptCache: { short: 300, long: 3600 },
			},
		});
		expect(readProviderModelConfig(agentDir, "zg-model-3")).toEqual({
			baseUrl: "https://api.anthropic.com",
			apiKey: "k",
			modelId: "claude-x",
			capabilities: {
				api: "anthropic-messages",
				contextWindow: 200000,
				maxTokens: 64000,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				promptCache: { short: 300, long: 3600 },
			},
		});
		const written = JSON.parse(readFileSync(modelsJsonPath(agentDir), "utf-8")) as {
			providers: Record<string, { api?: string; models: Array<Record<string, unknown>> }>;
		};
		expect(written.providers["zg-model-3"]?.api).toBe("anthropic-messages");
		expect(written.providers["zg-model-3"]?.models[0]).toMatchObject({
			contextWindow: 200000,
			maxTokens: 64000,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			promptCache: { short: 300, long: 3600 },
		});
	});

	test("a capability save clears the fields the form owns but keeps advanced ones", () => {
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
						models: [
							{
								id: "m1",
								contextWindow: 1000,
								maxTokens: 100,
								reasoning: true,
								cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
								promptCache: { short: 60 },
								thinkingLevelMap: { medium: "high" },
								samplingParams: { temperature: 0.2 },
								compat: { supportsStore: false },
							},
						],
					},
				},
			}),
		);
		writeProviderModelConfig(agentDir, "zg-endpoint", "主端点", {
			baseUrl: "https://new.test/v1",
			apiKey: "k",
			modelId: "m1",
			capabilities: { api: "openai-responses", reasoning: false, input: ["text"] },
		});
		const written = JSON.parse(readFileSync(path, "utf-8")) as {
			providers: Record<
				string,
				{ api?: string; headers?: Record<string, string>; models: Array<Record<string, unknown>> }
			>;
		};
		const model = written.providers["zg-endpoint"]?.models[0] ?? {};
		expect(written.providers["zg-endpoint"]?.api).toBe("openai-responses");
		expect(model.contextWindow).toBeUndefined();
		expect(model.maxTokens).toBeUndefined();
		expect(model.reasoning).toBeUndefined();
		expect(model.cost).toBeUndefined();
		expect(model.promptCache).toBeUndefined();
		expect(model.input).toEqual(["text"]);
		// Fields the form does not own must survive.
		expect(model.thinkingLevelMap).toEqual({ medium: "high" });
		expect(model.samplingParams).toEqual({ temperature: 0.2 });
		expect(model.compat).toEqual({ supportsStore: false });
		expect(written.providers["zg-endpoint"]?.headers).toEqual({ "x-tenant": "blue" });
	});

	test("a save without capabilities keeps the stored capability set", () => {
		const agentDir = freshAgentDir();
		writeProviderModelConfig(agentDir, "zg-commander", "Commander", {
			baseUrl: "https://old.test/v1",
			apiKey: "",
			modelId: "m1",
			capabilities: { api: "anthropic-messages", contextWindow: 1000, reasoning: true },
		});
		writeProviderModelConfig(agentDir, "zg-commander", "Commander", {
			baseUrl: "https://new.test/v1",
			apiKey: "",
			modelId: "m2",
		});
		expect(readProviderModelConfig(agentDir, "zg-commander")?.capabilities).toEqual({
			api: "anthropic-messages",
			contextWindow: 1000,
			reasoning: true,
			input: ["text", "image"],
		});
	});
});
