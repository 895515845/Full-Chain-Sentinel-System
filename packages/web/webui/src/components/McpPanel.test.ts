/**
 * The MCP settings page's pure helpers.
 *
 * The page itself needs a browser; what is worth pinning here is the text
 * formats the editor round-trips (arguments, env, headers), the payload a save
 * sends, and the state a row reports — in particular that an stdio server
 * without the host-execution acknowledgment never reads as mounted.
 */

import { expect, test } from "vitest";
import type { SentinelMcpServerView } from "../types.ts";
import {
	draftOf,
	draftToInput,
	formatEnvText,
	formatHeadersText,
	mcpServerState,
	mountReason,
	parseArgsText,
	parseEnvText,
	parseHeadersText,
} from "./McpPanel.tsx";

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

test("mcpServerState reports the three states the row's rail and badge share", () => {
	expect(mcpServerState(view())).toBe("mounted");
	expect(mcpServerState(view({ enabled: false }))).toBe("disabled");
	expect(mcpServerState(view({ hostExecAcknowledged: false }))).toBe("unacknowledged");
	// The acknowledgment is an stdio question only.
	expect(mcpServerState(view({ transport: "http", hostExecAcknowledged: false }))).toBe("mounted");
	expect(mcpServerState(view({ transport: "sse", hostExecAcknowledged: false }))).toBe("mounted");
});

test("mountReason names the tool namespace for a mounted server", () => {
	expect(mountReason(view({ name: "work-files" }))).toContain("mcp__work_files__");
	expect(mountReason(view({ enabled: false }))).toContain("不连接");
	expect(mountReason(view({ hostExecAcknowledged: false }))).toContain("宿主机执行确认");
});

test("arguments are one per line", () => {
	expect(parseArgsText("-y\n\n  server  \n/work")).toEqual(["-y", "server", "/work"]);
	expect(parseArgsText("")).toEqual([]);
});

test("env lines without a KEY= prefix are dropped rather than stored empty", () => {
	expect(parseEnvText("A=1\nbroken\n=2\nB= two words ")).toEqual({ A: "1", B: "two words" });
	expect(formatEnvText({ A: "1", B: "2" })).toBe("A=1\nB=2");
});

test("header lines split at the first colon, so a value may contain one", () => {
	expect(parseHeadersText("Authorization: Bearer a:b\nbroken\nX-Trace:  1")).toEqual({
		Authorization: "Bearer a:b",
		"X-Trace": "1",
	});
	expect(formatHeadersText({ Authorization: "Bearer t" })).toBe("Authorization: Bearer t");
});

test("draftOf and draftToInput round-trip a stored server", () => {
	const server = view({
		args: ["-y", "server", "/work"],
		env: { TOKEN: "${T}" },
		headers: {},
		description: "文件",
		timeout: 30,
	});
	const draft = draftOf(server);
	expect(draft.original).toBe("filesystem");
	expect(draftToInput(draft)).toEqual({
		name: "filesystem",
		enabled: true,
		transport: "stdio",
		command: "npx",
		args: ["-y", "server", "/work"],
		env: { TOKEN: "${T}" },
		cwd: "",
		url: "",
		headers: {},
		description: "文件",
		exposure: "codemode",
		timeout: 30,
		hostExecAcknowledged: true,
	});
});

test("draftToInput reads an empty or unusable timeout as the extension default", () => {
	const base = { ...draftOf(view()), timeoutText: "" };
	expect(draftToInput(base).timeout).toBeNull();
	expect(draftToInput({ ...base, timeoutText: "0" }).timeout).toBeNull();
	expect(draftToInput({ ...base, timeoutText: "45" }).timeout).toBe(45);
});
