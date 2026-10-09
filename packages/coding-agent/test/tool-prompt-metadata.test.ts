import { describe, expect, test } from "vitest";
import {
	createBashTool,
	createBashToolDefinition,
	createEditTool,
	createEditToolDefinition,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
} from "../src/core/tools/index.ts";
import { createToolDefinitionFromAgentTool } from "../src/core/tools/tool-definition-wrapper.ts";

const cwd = process.cwd();

/**
 * `baseToolsOverride` accepts AgentTools and rebuilds their definitions, so the
 * prompt metadata must survive that round-trip. Losing it drops the tool from the
 * system prompt's <tools> section and its guidelines from <rules>, which is what
 * happened to the web console's gated bash.
 */
describe("prompt metadata survives the AgentTool round-trip", () => {
	const cases = [
		{ name: "read", tool: createReadTool(cwd), definition: createReadToolDefinition(cwd) },
		{ name: "bash", tool: createBashTool(cwd), definition: createBashToolDefinition(cwd) },
		{ name: "edit", tool: createEditTool(cwd), definition: createEditToolDefinition(cwd) },
		{ name: "write", tool: createWriteTool(cwd), definition: createWriteToolDefinition(cwd) },
	];

	for (const { name, tool, definition } of cases) {
		test(`${name} keeps its snippet and guidelines`, () => {
			const rebuilt = createToolDefinitionFromAgentTool(tool);
			expect(definition.promptSnippet).toBeTruthy();
			expect(rebuilt.promptSnippet).toBe(definition.promptSnippet);
			expect(rebuilt.promptGuidelines).toEqual(definition.promptGuidelines);
		});
	}

	test("tools without prompt metadata stay free of undefined keys", () => {
		const rebuilt = createToolDefinitionFromAgentTool({
			name: "bare",
			label: "bare",
			description: "A tool without prompt metadata.",
			parameters: createReadToolDefinition(cwd).parameters,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		});
		expect("promptSnippet" in rebuilt).toBe(false);
		expect("promptGuidelines" in rebuilt).toBe(false);
	});
});
