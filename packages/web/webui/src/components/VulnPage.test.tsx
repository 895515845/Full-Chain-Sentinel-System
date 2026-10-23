/**
 * Render smoke test for the vulnerability hub's new controls.
 *
 * The hub gained provenance filters (target, session, 工程/任务) and batch
 * deletion. What is pinned here: every control is present, the task dropdown
 * waits for an engine (it is meaningless without one), the list offers a checkbox
 * per row plus a select-all, the batch button stays disabled until something is
 * ticked, the confirmation dialog states what disappears with the records, and
 * neither the list nor the detail pane offers a one-click single delete any more.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type {
	SentinelEngine,
	SentinelVulnerability,
	SentinelVulnStats,
	SentinelVulnSummary,
	SessionInfoView,
} from "../types.ts";
import { VulnDetail, VulnPage } from "./VulnPage.tsx";

const stats: SentinelVulnStats = {
	total: 2,
	bySeverity: { critical: 0, high: 2, medium: 0, low: 0, info: 0 },
	byStatus: { pending: 2, confirmed: 0, false_positive: 0, fixed: 0 },
};

function summary(overrides: Partial<SentinelVulnSummary> = {}): SentinelVulnSummary {
	return {
		id: "v1",
		label: "E2E-0001",
		number: 1,
		projectId: "p1",
		projectName: "靶场",
		sessionId: "s1",
		sessionName: "10.0.0.5 侦察",
		engineId: "e1",
		taskId: "t1",
		source: "工程任务「内网打点」",
		title: "未授权访问",
		severity: "high",
		cvss: 7.5,
		status: "pending",
		target: "10.0.0.5",
		description: "描述",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		severityMismatch: false,
		review: { state: "queued", at: 0, agentSeverity: "high", agentCvss: 7.5 },
		...overrides,
	};
}

const engines: SentinelEngine[] = [
	{
		id: "e1",
		projectId: "p1",
		projectName: "靶场",
		name: "内网打点",
		status: "completed",
		pauseNote: null,
		targets: [],
		doctrines: [],
		presetIds: [],
		presetOptional: true,
		limits: { concurrency: 2, roundLimit: 10, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
		gateMode: "auto",
		createdAt: 0,
		startedAt: null,
		endedAt: null,
		schedule: null,
		report: null,
		tasks: [
			{
				id: "t1",
				engineId: "e1",
				title: "Web 面侦察",
				objective: "找入口",
				target: "10.0.0.5",
				workspace: "/work/tasks/t1",
				status: "done",
				attempt: 1,
				criteria: [],
				roundLimit: 10,
				presetId: null,
				presetName: null,
				pendingContinue: null,
				sessionId: "s1",
				startedAt: null,
				endedAt: null,
				summary: null,
				error: null,
				usage: null,
				vulns: 1,
				autoResume: false,
			},
		],
	},
	{
		id: "e2",
		projectId: "p2",
		projectName: "别的项目",
		name: "别的工程",
		status: "running",
		pauseNote: null,
		targets: [],
		doctrines: [],
		presetIds: [],
		presetOptional: true,
		limits: { concurrency: 2, roundLimit: 10, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
		gateMode: "auto",
		createdAt: 0,
		startedAt: null,
		endedAt: null,
		schedule: null,
		report: null,
		tasks: [],
	},
];

const sessions: SessionInfoView[] = [
	{
		path: "/sessions/a.jsonl",
		id: "s1",
		cwd: "/work",
		name: "10.0.0.5 侦察",
		created: "2026-01-01T00:00:00.000Z",
		modified: "2026-01-01T00:00:00.000Z",
		messageCount: 3,
		firstMessage: "开始侦察",
	},
];

function renderPage(options: { filters?: Record<string, string>; deletePending?: string[] | null; preview?: { count: number; evidence: number; notes: number } | null } = {}): string {
	return renderToStaticMarkup(
		createElement(VulnPage, {
			items: [summary(), summary({ id: "v2", label: "E2E-0002", number: 2 })],
			stats,
			filters: options.filters ?? {},
			projectName: "靶场",
			projectId: "p1",
			engines,
			sessions,
			hasProject: true,
			deletePending: options.deletePending ?? null,
			deletePreview: options.preview ?? null,
			onFiltersChange: () => {},
			onOpen: () => {},
			onExport: () => {},
			onRetryReview: () => {},
			onReviewAllPending: () => {},
			onRequestDelete: () => {},
			onConfirmDelete: () => {},
			onCancelDelete: () => {},
		}),
	);
}

test("the hub offers target, session and 工程/任务 filters", () => {
	const html = renderPage();
	expect(html).toContain("目标（主机 / URL / IP:port）");
	// The empty option means "do not filter by this dimension"; it must not read as
	// a cross-project scope on a project-isolated page.
	expect(html).toContain("不限会话");
	expect(html).toContain("不限工程");
	expect(html).not.toContain("全部工程");
	expect(html).toContain("10.0.0.5 侦察");
	// Only the active project's engines are offered.
	expect(html).toContain("内网打点");
	expect(html).not.toContain("别的工程");
	// The task dropdown waits for an engine.
	expect(html).toContain("先选工程");
	expect(html).not.toContain("Web 面侦察");
	expect(html).toContain("清空全部");
	expect(html).toContain("完成");
	// The conditions live in a panel that starts collapsed; the row itself shows one
	// search box, the panel trigger and the 存疑 toggle.
	expect(html).toContain("vuln-filter-panel hidden");
	expect(html).toContain("筛选");
	expect(html).not.toContain("vuln-chip-row");
});

test("picking an engine lists its tasks and shows the condition as a chip", () => {
	const html = renderPage({ filters: { engineId: "e1" } });
	expect(html).toContain("不限任务");
	expect(html).toContain("Web 面侦察");
	// The engine in force is visible without opening the panel, and counted on the
	// trigger, so the operator can see and drop it in one click.
	expect(html).toContain("vuln-chip-row");
	expect(html).toContain("工程");
	expect(html).toContain("内网打点");
	expect(html).toContain('vuln-filter-count">1<');
});

test("without a project id no engine is offered, even when engines exist", () => {
	const html = renderToStaticMarkup(
		createElement(VulnPage, {
			items: [summary()],
			stats,
			filters: {},
			projectName: "靶场",
			projectId: null,
			engines,
			sessions,
			hasProject: true,
			deletePending: null,
			deletePreview: null,
			onFiltersChange: () => {},
			onOpen: () => {},
			onExport: () => {},
			onRetryReview: () => {},
			onReviewAllPending: () => {},
			onRequestDelete: () => {},
			onConfirmDelete: () => {},
			onCancelDelete: () => {},
		}),
	);
	// The row's 来源 text names an engine too, so check the dropdown itself.
	const engineAt = html.indexOf("工程（只列本项目");
	const engineSelect = html.slice(engineAt, html.indexOf("</select>", engineAt));
	expect(engineSelect).toContain("不限工程");
	expect(engineSelect).not.toContain("内网打点");
	expect(engineSelect).not.toContain("别的工程");
});

test("every row has a checkbox, plus a select-all in the header", () => {
	const html = renderPage();
	expect((html.match(/type="checkbox"/g) ?? []).length).toBe(3);
	expect(html).toContain("全选筛选结果");
	// Nothing is ticked yet, so the batch action is offered but disabled.
	const labelAt = html.indexOf("删除选中 (0)");
	const openAt = html.lastIndexOf("<button", labelAt);
	expect(html.slice(openAt, html.indexOf(">", openAt))).toContain("disabled");
	// There is no per-row delete any more.
	expect(html).not.toContain("确认删除");
});

test("the confirmation states the counts and asks once", () => {
	const html = renderPage({ deletePending: ["v1", "v2"], preview: { count: 2, evidence: 3, notes: 4 } });
	expect(html).toContain("删除漏洞记录");
	expect(html).toContain("将删除 2 条漏洞记录。");
	expect(html).toContain("3 条证据");
	expect(html).toContain("4 条复核备注");
	expect(html).toContain("确认删除");
});

test("the detail pane shows provenance names and no single delete", () => {
	const vuln: SentinelVulnerability = {
		...summary(),
		packet: "GET / HTTP/1.1",
		evidence: [],
		notes: [],
	};
	const html = renderToStaticMarkup(
		createElement(VulnDetail, {
			vuln,
			preview: null,
			provenance: { engine: "内网打点", task: "Web 面侦察", session: "10.0.0.5 侦察" },
			onClose: () => {},
			onUpdate: () => {},
			onPreview: () => {},
			onRetryReview: () => {},
		}),
	);
	expect(html).toContain("内网打点 / Web 面侦察");
	expect(html).toContain("10.0.0.5 侦察");
	expect(html).not.toContain("删除");
});
