/**
 * Unit tests for the hub tools' evidence paths.
 *
 * The file tools run with the host project directory as cwd while bash runs in
 * the same directory at /work, so an agent can submit either name. The hub must
 * store and show the container name, and must not accept an arbitrary host path.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { createVulnerabilityTools, evidencePathsToContainer } from "../src/vuln-tool.ts";
import { VulnerabilityStore } from "../src/vulnerabilities.ts";

let root = "";
let store: VulnerabilityStore | undefined;

afterEach(() => {
	store?.close();
	store = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function createTools(workDir: string): { tools: ToolDefinition[]; store: VulnerabilityStore } {
	root = mkdtempSync(join(tmpdir(), "sentinel-vuln-tool-"));
	store = new VulnerabilityStore(join(root, "vulns.db"));
	return {
		store,
		tools: createVulnerabilityTools({
			store,
			getProject: () => ({ id: "p1", name: "测试项目" }),
			getSessionId: () => "s1",
			getSource: () => "测试",
			getWorkDir: () => workDir,
		}),
	};
}

interface CallResult {
	isError?: boolean;
	details?: { id?: string };
}

type CallableTool = {
	name: string;
	execute: (toolCallId: string, params: never) => Promise<CallResult>;
};

function tool(tools: ToolDefinition[], name: string): CallableTool {
	const found = tools.find((item) => item.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found as unknown as CallableTool;
}

test("vuln_submit stores a host work-directory path as its /work name", async () => {
	const workDir = join(tmpdir(), "sentinel-project-1018");
	const { tools, store: hub } = createTools(workDir);
	const submit = tool(tools, "vuln_submit");
	const result = await submit.execute("c1", {
		title: "反序列化白名单绕过",
		severity: "critical",
		cvss: 9.8,
		target: "http://10.0.166.153:8000/",
		description: "getattr 白名单绕过导致命令执行",
		packet: "POST /",
		evidence: [{ kind: "file", path: join(workDir, "build2.py"), note: "利用脚本" }],
	} as never);
	expect(result.isError).not.toBe(true);
	const id = result.details?.id;
	expect(id).toBeTruthy();
	const vuln = hub.find("p1", id as string);
	expect(vuln?.evidence[0]?.path).toBe("/work/build2.py");
});

test("vuln_submit rejects evidence outside the work directory", async () => {
	const workDir = join(tmpdir(), "sentinel-project-1018");
	const { tools, store: hub } = createTools(workDir);
	const submit = tool(tools, "vuln_submit");
	const result = await submit.execute("c1", {
		title: "反序列化白名单绕过",
		severity: "critical",
		cvss: 9.8,
		target: "http://10.0.166.153:8000/",
		description: "getattr 白名单绕过导致命令执行",
		packet: "POST /",
		evidence: [{ kind: "file", path: "/etc/passwd", note: "越界文件" }],
	} as never);
	expect(result.isError).toBe(true);
	expect(hub.list("p1")).toHaveLength(0);
});

test("evidencePathsToContainer maps legacy host paths only inside the work directory", () => {
	const workDir = join(tmpdir(), "sentinel-project-1018");
	const { store: hub } = createTools(workDir);
	const legacy = hub.create({
		projectId: "p1",
		projectName: "测试项目",
		source: "测试",
		title: "历史记录",
		severity: "high",
		cvss: 8,
		target: "http://10.0.166.153:8000/",
		description: "旧记录里的宿主路径",
		packet: "POST /",
		evidence: [
			{ kind: "file", path: join(workDir, "build2.py") },
			{ kind: "file", path: "/work/evidence/nmap.txt" },
			{ kind: "file", path: "/etc/passwd" },
		],
	});
	const mapped = evidencePathsToContainer(legacy, workDir);
	expect(mapped.evidence.map((item) => item.path)).toEqual([
		"/work/build2.py",
		"/work/evidence/nmap.txt",
		"/etc/passwd",
	]);
});
