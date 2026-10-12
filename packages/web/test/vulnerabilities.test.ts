/**
 * Unit tests for the vulnerability hub: numbering, project scoping, the review
 * timeline, the export, and the agent-facing tools.
 *
 * The hub's contract is that a record is project-scoped and that only the
 * operator moves it forward, so those two are what most of these assert.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
	defaultPermissions,
	excludeToolsFor,
	normalizePermissions,
	PERMISSION_PRESETS,
	readPermissionsConfig,
} from "../src/permissions.ts";
import type { ZGVulnerability } from "../src/protocol.ts";
import { createVulnerabilityTools, MAX_VULN_TITLE_CHARS, normalizeVulnTitle } from "../src/vuln-tool.ts";
import {
	isSeverityMismatch,
	severityForCvss,
	VulnerabilityStore,
	vulnerabilityDbPath,
	vulnLabel,
	vulnPrefix,
	type ZGVulnCreateInput,
} from "../src/vulnerabilities.ts";
import { buildVulnReport } from "../src/vulnerability-markdown.ts";

const roots: string[] = [];
const stores: VulnerabilityStore[] = [];

function openStore(): VulnerabilityStore {
	const root = mkdtempSync(join(tmpdir(), "zgagent-vuln-"));
	roots.push(root);
	const store = new VulnerabilityStore(vulnerabilityDbPath(root));
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// Already closed by the test.
		}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function input(overrides: Partial<ZGVulnCreateInput> = {}): ZGVulnCreateInput {
	return {
		projectId: "project-a",
		projectName: "e2e-project",
		source: "主代理",
		title: "后台登录处 SQL 注入",
		severity: "high",
		cvss: 8.1,
		target: "http://10.10.10.5/admin/login",
		description: "登录参数未过滤，可绕过认证。",
		packet: "POST /admin/login HTTP/1.1\nHost: 10.10.10.5\n\nuser=admin'--",
		...overrides,
	};
}

test("findings are numbered inside their project, with the project as prefix", () => {
	const store = openStore();
	const first = store.create(input());
	const second = store.create(input({ title: "越权访问" }));
	const otherProject = store.create(input({ projectId: "project-b", projectName: "另一个项目" }));

	expect(first.label).toBe("E2E-PROJECT-0001");
	expect(second.label).toBe("E2E-PROJECT-0002");
	expect(second.number).toBe(2);
	// A different project restarts at 1: the number identifies a finding inside
	// its own scope, not globally.
	expect(otherProject.label).toBe("另一个项目-0001");
	expect(store.countByProject("project-a")).toBe(2);
	expect(store.countByProject("project-b")).toBe(1);
});

test("a submitted finding starts as pending, with the submission in its timeline", () => {
	const store = openStore();
	const vuln = store.create(
		input({
			sessionId: "session-1",
			source: "子代理 run-9",
			evidence: [
				{ kind: "command", command: "sqlmap -u ...", output: "parameter 'user' is vulnerable" },
				{ kind: "file", path: "/work/evidence/sqlmap.txt" },
			],
			references: ["CWE-89"],
		}),
	);

	expect(vuln.status).toBe("pending");
	expect(vuln.sessionId).toBe("session-1");
	expect(vuln.source).toBe("子代理 run-9");
	expect(vuln.evidence).toHaveLength(2);
	expect(vuln.evidence[0]?.output).toContain("vulnerable");
	expect(vuln.evidence[1]?.path).toBe("/work/evidence/sqlmap.txt");
	expect(vuln.references).toEqual(["CWE-89"]);
	expect(vuln.notes).toHaveLength(1);
	expect(vuln.notes[0]?.author).toBe("agent");
	expect(vuln.notes[0]?.text).toContain("子代理 run-9");
});

test("the operator's edit is what moves a record, and it is recorded in the timeline", () => {
	const store = openStore();
	const created = store.create(input());
	const reviewed = store.update(created.id, { status: "confirmed", cvss: 7.5, note: "已复现" });

	expect(reviewed?.status).toBe("confirmed");
	expect(reviewed?.cvss).toBe(7.5);
	expect(reviewed?.notes).toHaveLength(2);
	const last = reviewed?.notes.at(-1);
	expect(last?.author).toBe("operator");
	expect(last?.statusFrom).toBe("pending");
	expect(last?.statusTo).toBe("confirmed");
	expect(last?.text).toContain("已复现");
	expect(last?.text).toContain("CVSS 8.1 → 7.5");
});

test("a patch that changes nothing adds no timeline entry", () => {
	const store = openStore();
	const created = store.create(input());
	const unchanged = store.update(created.id, { status: "pending" });
	expect(unchanged?.notes).toHaveLength(1);
	expect(store.update("missing-id", { status: "fixed" })).toBeUndefined();
});

test("findings can be found by label as well as by id, inside their project", () => {
	const store = openStore();
	const created = store.create(input());
	expect(store.find("project-a", created.label)?.id).toBe(created.id);
	expect(store.find("project-a", created.label.toLowerCase())?.id).toBe(created.id);
	// The same label in another project must not resolve to this record.
	expect(store.find("project-b", created.label)).toBeUndefined();
});

test("list filters by status, severity, target and free text", () => {
	const store = openStore();
	store.create(input({ title: "SQL 注入", severity: "critical", cvss: 9.8, target: "http://10.10.10.5/admin" }));
	const second = store.create(
		input({ title: "目录遍历", severity: "medium", cvss: 5.3, target: "http://10.10.10.5/files" }),
	);
	store.update(second.id, { status: "false_positive", note: "误报" });

	expect(store.list("project-a").map((item) => item.label)).toEqual(["E2E-PROJECT-0002", "E2E-PROJECT-0001"]);
	expect(store.list("project-a", { severity: "critical" })).toHaveLength(1);
	expect(store.list("project-a", { status: "pending" })).toHaveLength(1);
	expect(store.list("project-a", { status: "false_positive" })[0]?.title).toBe("目录遍历");
	expect(store.list("project-a", { target: "/files" })).toHaveLength(1);
	expect(store.list("project-a", { search: "目录" })).toHaveLength(1);
	// A `%` typed into the search box is a literal, not a wildcard.
	expect(store.list("project-a", { search: "%" })).toHaveLength(0);
});

test("stats count the project by severity and status", () => {
	const store = openStore();
	store.create(input({ severity: "critical", cvss: 9.8 }));
	store.create(input({ severity: "high", cvss: 8.0 }));
	const third = store.create(input({ severity: "high", cvss: 7.2 }));
	store.update(third.id, { status: "confirmed" });
	store.create(input({ projectId: "project-b", severity: "low", cvss: 2.1 }));

	const stats = store.stats("project-a");
	expect(stats.total).toBe(3);
	expect(stats.bySeverity.critical).toBe(1);
	expect(stats.bySeverity.high).toBe(2);
	expect(stats.bySeverity.low).toBe(0);
	expect(stats.byStatus.pending).toBe(2);
	expect(stats.byStatus.confirmed).toBe(1);
});

test("a mismatch between the severity label and the CVSS score is flagged, not rejected", () => {
	expect(severityForCvss(9.8)).toBe("critical");
	expect(severityForCvss(9)).toBe("critical");
	expect(severityForCvss(7)).toBe("high");
	expect(severityForCvss(4)).toBe("medium");
	expect(severityForCvss(0.1)).toBe("low");
	expect(severityForCvss(0)).toBe("info");
	expect(isSeverityMismatch("high", 9.8)).toBe(true);
	expect(isSeverityMismatch("high", 8.1)).toBe(false);

	const store = openStore();
	const mismatched = store.create(input({ severity: "low", cvss: 9.8 }));
	expect(mismatched.severityMismatch).toBe(true);
	expect(store.list("project-a")[0]?.severityMismatch).toBe(true);
});

test("deleting a project's findings leaves other projects alone", () => {
	const store = openStore();
	const first = store.create(input());
	store.create(input());
	store.create(input({ projectId: "project-b", projectName: "另一个项目" }));

	expect(store.deleteByProject("project-a")).toBe(2);
	expect(store.countByProject("project-a")).toBe(0);
	expect(store.countByProject("project-b")).toBe(1);
	// Evidence and timeline rows go with the record.
	expect(store.get(first.id)).toBeUndefined();
});

test("deleting one finding removes its evidence and timeline too", () => {
	const store = openStore();
	const created = store.create(input({ evidence: [{ kind: "command", command: "id", output: "uid=0" }] }));
	expect(store.delete(created.id)).toBe(true);
	expect(store.get(created.id)).toBeUndefined();
	expect(store.delete(created.id)).toBe(false);
});

test("the Markdown report orders by severity and keeps the raw packet fenced", () => {
	const store = openStore();
	const low = store.create(input({ title: "信息泄露", severity: "low", cvss: 3.1, packet: "GET /robots.txt" }));
	const critical = store.create(input({ title: "命令注入", severity: "critical", cvss: 9.8 }));
	store.update(low.id, { status: "confirmed", note: "已确认" });

	const vulns = store.list("project-a").map((summary) => store.get(summary.id) as ZGVulnerability);
	const report = buildVulnReport({
		projectId: "project-a",
		projectName: "e2e-project",
		vulns,
		generatedAt: new Date("2024-03-04T05:06:07.000Z"),
	});

	expect(report.filename).toBe("E2E-PROJECT-vulnerability-report-202403040506.md");
	expect(report.markdown).toContain("# 漏洞报告 — e2e-project");
	expect(report.markdown).toContain("- 漏洞总数：2");
	expect(report.markdown).toContain("- 等级分布：严重 1 / 低危 1");
	// Critical first, whatever the submission order was.
	expect(report.markdown.indexOf(critical.label)).toBeLessThan(report.markdown.indexOf(low.label));
	expect(report.markdown).toContain("### 原始数据包");
	expect(report.markdown).toContain("POST /admin/login HTTP/1.1");
	expect(report.markdown).toContain("已确认");
});

test("an empty export still produces a report", () => {
	const report = buildVulnReport({ projectId: "project-a", projectName: "e2e-project", vulns: [] });
	expect(report.markdown).toContain("本次导出没有漏洞记录。");
	expect(report.filename.endsWith(".md")).toBe(true);
});

test("the prefix is derived from the project name and never empty", () => {
	expect(vulnPrefix("e2e project")).toBe("E2E-PROJECT");
	expect(vulnPrefix("  ZG Agent  ")).toBe("ZG-AGENT");
	expect(vulnPrefix("!!!")).toBe("VULN");
	expect(vulnLabel("E2E-PROJECT", 3)).toBe("E2E-PROJECT-0003");
});

/** The hub tools, mounted the way the runtime mounts them. */
function mountTools(
	store: VulnerabilityStore,
	options: {
		project?: { id: string; name: string } | undefined;
		onHighSeverity?: (vuln: ZGVulnerability) => void;
	} = {},
) {
	const changes: number[] = [];
	const tools = createVulnerabilityTools({
		store,
		getProject: () => ("project" in options ? options.project : { id: "project-a", name: "e2e-project" }),
		getSessionId: () => "session-1",
		getSource: () => "主代理",
		...(options.onHighSeverity ? { onHighSeverity: options.onHighSeverity } : {}),
		onChange: () => changes.push(1),
	});
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const call = async (name: string, params: unknown) => {
		const tool = byName.get(name);
		if (!tool) throw new Error(`tool ${name} is not mounted`);
		// The SDK passes (toolCallId, params, signal, onUpdate, ctx); the hub tools
		// only read the first two.
		return await (
			tool.execute as unknown as (
				id: string,
				args: unknown,
			) => Promise<{ content: { text: string }[]; isError?: boolean }>
		)("call-1", params);
	};
	return { tools, call, changes };
}

test("vuln_submit records the finding and reports its label", async () => {
	const store = openStore();
	const high: ZGVulnerability[] = [];
	const { call, changes } = mountTools(store, { onHighSeverity: (vuln) => high.push(vuln) });

	const result = await call("vuln_submit", {
		title: "命令注入",
		severity: "critical",
		cvss: 9.8,
		target: "http://10.10.10.5/ping",
		description: "cmd 参数直接进入 shell。",
		packet: "GET /ping?cmd=;id HTTP/1.1",
		evidence: [{ kind: "command", command: "curl 'http://10.10.10.5/ping?cmd=;id'", output: "uid=0(root)" }],
	});

	expect(result.isError).toBeUndefined();
	expect(result.content[0]?.text).toContain("E2E-PROJECT-0001");
	expect(result.content[0]?.text).toContain("待确认");
	const stored = store.list("project-a")[0];
	expect(stored?.status).toBe("pending");
	expect(stored?.source).toBe("主代理");
	// A critical finding is pushed immediately, and the console is told to refresh.
	expect(high).toHaveLength(1);
	expect(high[0]?.label).toBe("E2E-PROJECT-0001");
	expect(changes).toHaveLength(1);
});

test("a title loses its plan-number prefix and trailing punctuation", () => {
	// Agents carry their plan number through a run and prefix it to every output;
	// the hub only wants the flaw.
	expect(normalizeVulnTitle("【计划编号 PLAN-0109】后台登录处 SQL 注入")).toBe("后台登录处 SQL 注入");
	expect(normalizeVulnTitle("【T1】【计划编号 3】附件下载服务匿名可达")).toBe("附件下载服务匿名可达");
	expect(normalizeVulnTitle("  1. 命令注入\n")).toBe("命令注入");
	expect(normalizeVulnTitle("命令注入。")).toBe("命令注入");
	// A trailing classification is part of the title and stays.
	expect(normalizeVulnTitle("登录端点匿名可达（CWE-307）")).toBe("登录端点匿名可达（CWE-307）");
});

test("vuln_submit normalizes the title it stores", async () => {
	const store = openStore();
	const { call } = mountTools(store);
	const result = await call("vuln_submit", {
		title: "【计划编号 PLAN-0508】/api/report/export 免验证码登录端点匿名可达。",
		severity: "medium",
		cvss: 5.3,
		target: "https://target/api/report/export",
		description: "免验证码登录端点匿名可达。",
		packet: "POST /api/report/export HTTP/1.1",
	});
	expect(result.isError).toBeUndefined();
	expect(store.list("project-a")[0]?.title).toBe("/api/report/export 免验证码登录端点匿名可达");
	expect(result.content[0]?.text).toContain("标题已规范化");
});

test("vuln_submit refuses a title that is still a paragraph", async () => {
	const store = openStore();
	const { call, changes } = mountTools(store);
	const long = `【计划编号 PLAN-0109】结论更正：api/report/export 非 SSRF，第一轮 0201 判定为误报（建议撤销）`;
	expect(long.length).toBeGreaterThan(MAX_VULN_TITLE_CHARS);
	const result = await call("vuln_submit", {
		title: long,
		severity: "info",
		cvss: 0,
		target: "https://target/api/report/export",
		description: "结论更正。",
		packet: "GET /api/report/export HTTP/1.1",
	});
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain(`上限 ${MAX_VULN_TITLE_CHARS} 字`);
	expect(result.content[0]?.text).toContain("写进 description");
	// Nothing lands, so the agent has to resubmit a real title.
	expect(store.countByProject("project-a")).toBe(0);
	expect(changes).toHaveLength(0);
});

test("vuln_submit rejects an out-of-range CVSS score", async () => {
	const store = openStore();
	const { call, changes } = mountTools(store);
	const result = await call("vuln_submit", {
		title: "x",
		severity: "high",
		cvss: 11,
		target: "t",
		description: "d",
		packet: "p",
	});
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain("0.0-10.0");
	expect(store.countByProject("project-a")).toBe(0);
	expect(changes).toHaveLength(0);
});

test("a medium finding does not trigger the immediate notification", async () => {
	const store = openStore();
	const high: ZGVulnerability[] = [];
	const { call } = mountTools(store, { onHighSeverity: (vuln) => high.push(vuln) });
	await call("vuln_submit", {
		title: "信息泄露",
		severity: "medium",
		cvss: 5.0,
		target: "http://10.10.10.5",
		description: "d",
		packet: "p",
	});
	expect(high).toHaveLength(0);
});

test("vuln_list and vuln_get read the hub back, and report a missing id", async () => {
	const store = openStore();
	const created = store.create(input({ title: "SQL 注入" }));
	const { call } = mountTools(store);

	const list = await call("vuln_list", {});
	expect(list.content[0]?.text).toContain(created.label);
	const filtered = await call("vuln_list", { severity: "low" });
	expect(filtered.content[0]?.text).toContain("没有符合条件");

	const full = await call("vuln_get", { id: created.label });
	expect(full.content[0]?.text).toContain("原始数据包");
	expect(full.content[0]?.text).toContain("user=admin'--");

	const missing = await call("vuln_get", { id: "E2E-PROJECT-9999" });
	expect(missing.isError).toBe(true);
	expect(missing.content[0]?.text).toContain("没有编号");
});

test("the hub tools refuse to work without a project", async () => {
	const store = openStore();
	const { call } = mountTools(store, { project: undefined });
	await expect(call("vuln_list", {})).rejects.toThrow(/尚未选择项目/);
});

test("a stored permissions file without the hub switches reads them as off", () => {
	// The file predates the two new switches, so the operator has never agreed to
	// them: adding a tool must not silently widen an existing configuration.
	const normalized = normalizePermissions({
		main: {
			read: true,
			bash: true,
			edit: true,
			write: true,
			codemode: true,
			tool_search: true,
			mcp: true,
			spawn_agent: true,
		},
		subagent: { read: true, bash: true, edit: true, write: true, codemode: true, tool_search: true, mcp: true },
	});
	expect(normalized.main.vuln_submit).toBe(false);
	expect(normalized.main.vuln_read).toBe(false);
	expect(normalized.subagent.vuln_submit).toBe(false);
	// A switch the file does mention keeps its value.
	expect(normalized.main.bash).toBe(true);
	expect(excludeToolsFor(normalized.main)).toContain("vuln_submit");
	expect(excludeToolsFor(normalized.main)).toContain("vuln_list");
});

test("a fresh install still gets every tool, and the read-only preset cannot submit", () => {
	const root = mkdtempSync(join(tmpdir(), "zgagent-perms-"));
	roots.push(root);
	const fresh = readPermissionsConfig(root);
	expect(fresh.main).toEqual(defaultPermissions().main);
	expect(fresh.main.vuln_submit).toBe(true);

	const recon = PERMISSION_PRESETS.find((preset) => preset.id === "recon");
	expect(recon?.main.vuln_read).toBe(true);
	expect(recon?.main.vuln_submit).toBe(false);
	expect(recon?.subagent.spawn_agent).toBe(false);
	expect(excludeToolsFor(recon?.main as never)).not.toContain("vuln_list");
	expect(excludeToolsFor(recon?.main as never)).toContain("vuln_submit");

	// A corrupt file must not lock the console out of its own tools.
	writeFileSync(join(root, "permissions.json"), "{not json");
	expect(readPermissionsConfig(root).main.vuln_submit).toBe(true);
});
