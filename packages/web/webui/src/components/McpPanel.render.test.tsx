/**
 * Render smoke tests for the MCP settings page.
 *
 * The helpers are covered in McpPanel.test.ts; what these add is that the whole
 * page renders without throwing for each state a row can be in. The page needs a
 * browser to *look* right, but a null dereference or a bad prop would fail here
 * first, and this is the only automated check the JSX gets.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelMcpConfigView, SentinelMcpServerView } from "../types.ts";
import { McpPanel } from "./McpPanel.tsx";

function view(overrides: Partial<SentinelMcpServerView> = {}): SentinelMcpServerView {
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

function config(servers: SentinelMcpServerView[], permissionOn = true): SentinelMcpConfigView {
	return {
		servers,
		mounted: servers.filter((server) => server.enabled && server.transport === "http").length,
		permissionOn,
		path: "/home/operator/.sentinel/agent/mcp-servers.json",
	};
}

function render(view_: SentinelMcpConfigView): string {
	return renderToStaticMarkup(
		<McpPanel
			config={view_}
			busy={false}
			onSave={() => {}}
			onDelete={() => {}}
			onTest={async () => null}
			onOpenPermissions={() => {}}
		/>,
	);
}

test("renders the empty page", () => {
	const html = render(config([]));
	expect(html).toContain("还没有自定义 MCP 服务器");
	expect(html).toContain("stdio 服务器在宿主机上执行");
	expect(html).not.toContain("权限未开启");
});

test("renders each row state with its badge and reason", () => {
	const html = render(
		config([
			view(),
			view({ name: "off", enabled: false }),
			view({ name: "unacked", hostExecAcknowledged: false }),
			view({ name: "remote", transport: "http", hostExecAcknowledged: false, url: "https://example.com/mcp" }),
			view({ name: "old", transport: "sse", target: "https://example.com/sse", url: "https://example.com/sse" }),
		]),
	);
	expect(html).toContain("已挂载");
	expect(html).toContain("未启用");
	expect(html).toContain("未确认");
	expect(html).toContain("HTTP");
	// Both url transports are mounted rows; the cell names which one it is.
	expect(html).toContain("SSE");
	// Only a mounted row names the tool namespace it registers.
	expect(html).toContain("mcp__filesystem__");
	expect(html).toContain("未勾选宿主机执行确认");
});

test("renders a stored failure and the path the file lives at", () => {
	const html = render(
		config([view({ status: { at: 1_700_000_000_000, ok: false, error: "spawn npx ENOENT" } })]),
	);
	expect(html).toContain("失败");
	expect(html).toContain("mcp-servers.json");
});

test("renders the permission warning with a link to 权限", () => {
	const html = render(config([view()], false));
	expect(html).toContain("权限未开启");
	expect(html).toContain("去打开");
});

test("renders the footnote that explains what saving and testing do", () => {
	const html = render(config([view()]));
	expect(html).toContain("重建活动会话");
	expect(html).toContain("不显示实时连接状态");
});
