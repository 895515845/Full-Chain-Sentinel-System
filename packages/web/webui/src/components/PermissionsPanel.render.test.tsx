/**
 * Render smoke tests for the permissions page's MCP rows.
 *
 * The page needs a browser to *look* right, but a null dereference or a bad prop
 * would fail here first, and this is the only automated check the JSX gets. The
 * case worth pinning is the one the page exists for: MCP allowed as a whole while
 * one server is switched off, which a single switch cannot express.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelMcpServerView, SentinelPermissionPreset, SentinelPermissionsConfig } from "../types.ts";
import { PermissionsPanel } from "./PermissionsPanel.tsx";

function server(overrides: Partial<SentinelMcpServerView> = {}): SentinelMcpServerView {
	return {
		name: "filesystem",
		enabled: true,
		transport: "stdio",
		target: "npx -y server",
		command: "npx",
		args: ["-y", "server"],
		env: {},
		cwd: "",
		url: "",
		headers: {},
		description: "",
		exposure: "codemode",
		timeout: null,
		hostExecAcknowledged: true,
		status: { at: null, ok: true },
		...overrides,
	};
}

function config(mcp: boolean): SentinelPermissionsConfig {
	const set = {
		read: true,
		bash: true,
		edit: true,
		write: true,
		codemode: true,
		tool_search: true,
		mcp,
		spawn_agent: true,
		vuln_submit: true,
		vuln_read: true,
		poc_read: true,
		asset_read: true,
		web_search: true,
	};
	return { main: { ...set }, subagent: { ...set }, commander: { bash: true, read: true }, subagentMaxTurns: 40 };
}

function render(
	servers: SentinelMcpServerView[] | null,
	options: { mcp?: boolean; busy?: boolean; mcpBusy?: boolean } = {},
): string {
	const presets: SentinelPermissionPreset[] = [];
	return renderToStaticMarkup(
		<PermissionsPanel
			config={config(options.mcp ?? true)}
			presets={presets}
			tools={[]}
			mcpServers={servers}
			mcpBusy={options.mcpBusy ?? false}
			busy={options.busy ?? false}
			onSave={() => {}}
			onRefresh={() => {}}
			onToggleMcpServer={() => {}}
		/>,
	);
}

test("lists one row per server under the MCP switch", () => {
	const html = render([
		server({ name: "filesystem", transport: "stdio", target: "npx -y server" }),
		server({ name: "remote", transport: "http", url: "https://example.com/mcp", target: "https://example.com/mcp" }),
		server({ name: "legacy", transport: "sse", url: "https://example.com/sse", target: "https://example.com/sse" }),
	]);
	expect(html).toContain("perm-mcp");
	expect(html).toContain("filesystem");
	expect(html).toContain("remote");
	expect(html).toContain("legacy");
	// The transport badge, so a stdio row is not mistaken for a remote one.
	expect(html).toContain(">stdio<");
	expect(html).toContain(">HTTP<");
	expect(html).toContain(">SSE<");
	// The point of the rows: MCP on, one server off, and both visible at once.
	expect(html).toContain("npx -y server");
});

test("a switched-off server says why it contributes nothing", () => {
	const html = render([server({ enabled: false })]);
	expect(html).toContain("已停用：不连接、不注册工具，Agent 看不到它");
});

test("a stdio server without the host-execution acknowledgment says so", () => {
	const html = render([server({ hostExecAcknowledged: false })]);
	expect(html).toContain("未勾选宿主机执行确认：不连接、不注册工具");
});

test("with the master switch off the rows still render, annotated", () => {
	const html = render([server({ name: "filesystem" }), server({ name: "remote", transport: "http" })], { mcp: false });
	expect(html).toContain("filesystem");
	expect(html).toContain("remote");
	expect(html).toContain("主开关已关闭：全部不挂载");
});

test("says where servers come from when none are configured", () => {
	const html = render([]);
	expect(html).toContain("还没有配置服务器（设置 → MCP）");
	// The old wording named a file the console no longer reads.
	expect(html).not.toContain("连接 mcp.json");
	expect(html).toContain("项目目录与配置目录里的 mcp.json 都不读");
});

test("distinguishes 'not loaded yet' from 'none configured'", () => {
	const html = render(null);
	expect(html).toContain("正在读取 MCP 配置…");
	expect(html).not.toContain("还没有配置服务器");
});

test("a per-server switch in flight disables the rows", () => {
	const busy = render([server()], { mcpBusy: true });
	expect(busy).toContain("disabled");
});
