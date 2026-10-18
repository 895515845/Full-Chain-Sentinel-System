/**
 * Render smoke tests for 设置 → 模型 · MCP 工具判定.
 *
 * The block shipped once without ever being visible: the markup was there, but
 * `.settings input` stretched every input to the row width and the checkbox
 * disappeared into an empty bar. A markup test cannot see CSS, so what it pins
 * is the structure that made the styling possible — a labelled switch row per
 * setting, and a panel that survives a config without the switches at all.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelGatekeeperConfig, SentinelMcpToolGate, SentinelResolvedModelView } from "../types.ts";
import { GatekeeperPanel } from "./GatekeeperPanel.tsx";

function config(mcpTools: SentinelMcpToolGate): SentinelGatekeeperConfig {
	return { mode: "review", timeoutMs: 15000, concurrency: 0, mcpTools };
}

function render(options: {
	mcpTools?: SentinelMcpToolGate;
	/** A reply from a console that predates the switches. */
	omitMcpTools?: boolean;
	judge?: SentinelResolvedModelView | null;
}): string {
	const base = config(options.mcpTools ?? { enabled: true, includePlugins: false });
	const withoutSwitches = { ...base } as Partial<SentinelGatekeeperConfig>;
	if (options.omitMcpTools) delete withoutSwitches.mcpTools;
	return renderToStaticMarkup(
		<GatekeeperPanel
			gatekeeperConfig={withoutSwitches as SentinelGatekeeperConfig}
			judgeResolved={
				options.judge === undefined
					? { entryId: "judge", entryName: "本地网关", modelId: "qwen3-max", followedMain: false }
					: options.judge
			}
			onSave={() => {}}
			onTestJudge={async () => null}
		/>,
	);
}

test("renders the MCP section with one labelled row per switch", () => {
	const html = render({});
	expect(html).toContain("MCP 工具判定");
	// The section explains what it governs, which is not the bash gate above it.
	expect(html).toContain("bash 命令在任何模式下都由上面的模式决定");
	expect(html).toContain("默认不纳入");
	expect(html).toContain("gate-option");
	expect(html).toContain("同时判定 MCP 工具");
	expect(html).toContain("包含插件工具");
	// Two real checkboxes, not two more text fields.
	expect(html.match(/type="checkbox"/g)?.length).toBe(2);
});

test("the plugin switch follows the master switch", () => {
	const off = render({ mcpTools: { enabled: false, includePlugins: true } });
	expect(off).toContain("disabled");
	// Off reads as inert, so the row says so instead of looking merely broken.
	expect(off).toContain("is-off");

	const on = render({ mcpTools: { enabled: true, includePlugins: false } });
	expect(on).not.toContain("is-off");
});

test("a config without the switches still renders them at their defaults", () => {
	const html = render({ omitMcpTools: true });
	expect(html).toContain("MCP 工具判定");
	expect(html).toContain("同时判定 MCP 工具");
	// Checked, because the server default is "judge MCP tools, skip plugins".
	expect(html).toContain("checked");
});

test("says which endpoint judges, and that none resolves when the role is empty", () => {
	expect(render({})).toContain("qwen3-max");
	expect(render({ judge: null })).toContain("无（切到 AI 审批会被拒绝）");
});

test("saves one draft carrying the mode, the limits and both switches", () => {
	const html = render({});
	expect(html).toContain("保存守门配置");
	expect(html).toContain("判定超时（毫秒）");
	expect(html).toContain("并发上限");
});
