/**
 * Option A: the audit page is a table-first view. These assertions pin the
 * filters, KPI strip, row content and the right-side detail drawer.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type {
	SentinelSupervisorAuditItem,
	SentinelSupervisorAuditPage,
	SentinelSupervisorDetail,
} from "../types.ts";
import { SupervisorAuditPage } from "./SupervisorAuditPage.tsx";

function item(overrides: Partial<SentinelSupervisorAuditItem> = {}): SentinelSupervisorAuditItem {
	return {
		sessionId: "s1",
		sessionPath: "/tmp/s1.jsonl",
		sessionName: "支付接口复测",
		projectId: "p1",
		projectName: "支付网关",
		mode: "observe",
		delivery: "confirm",
		status: "running",
		armedAt: 1,
		startedAt: 2,
		endedAt: null,
		updatedAt: 1_700_000_000_000,
		episodeCount: 3,
		callCount: 42,
		phase: "vuln_mapping",
		intent: "重复测试 SQLi",
		progress: "stalled",
		adviceCount: 1,
		usage: { input: 10_000, output: 2_400, total: 12_400 },
		lastError: null,
		...overrides,
	};
}

const page: SentinelSupervisorAuditPage = {
	items: [item()],
	total: 1,
	page: 1,
	pageSize: 30,
	stats: { total: 1, advancing: 0, stalled: 1, looping: 0, stopped: 0, pendingAdvice: 1 },
};

const detail: SentinelSupervisorDetail = {
	session: item(),
	episodes: [
		{
			id: "ep1",
			sessionId: "s1",
			seq: 1,
			at: 1_700_000_000_000,
			trigger: "batch",
			phase: "vuln_mapping",
			intent: "SQLi 无差异",
			actions: [],
			outcomes: [],
			tested: [],
			deadEnds: ["/api/user?id SQLi"],
			newEvidence: [],
			openQuestions: [],
			nextCandidates: ["转向 IDOR"],
			duplicateSignals: [],
			progress: "stalled",
			confidence: 0.8,
			advice: null,
			model: "stub",
			usage: { input: 10, output: 5, total: 15 },
			error: null,
			durationMs: 100,
		},
	],
	logs: [{ at: 1_700_000_000_000, kind: "episode", text: "episode 完成" }],
	advice: [
		{
			id: "a1",
			sessionId: "s1",
			episodeId: "ep1",
			at: 1_700_000_000_000,
			delivery: "confirm",
			status: "pending",
			text: "停止 SQLi",
			sentAt: null,
		},
	],
};

function render(withDetail: boolean): string {
	return renderToStaticMarkup(
		<SupervisorAuditPage
			page={page}
			detail={withDetail ? detail : null}
			projects={[{ id: "p1", name: "支付网关", cwd: "/tmp" }]}
			onQuery={() => {}}
			onSelect={() => {}}
			onBack={() => {}}
			onOpenSession={() => {}}
		/>,
	);
}

describe("SupervisorAuditPage", () => {
	test("renders filters, stats, the table and a detail drawer", () => {
		const html = render(true);
		expect(html).toContain("全部模式");
		expect(html).toContain("全部进度");
		expect(html).toContain("监督会话");
		expect(html).toContain("支付接口复测");
		expect(html).toContain("12.4k");
		expect(html).toContain("待确认建议");
		expect(html).toContain("Episode");
		expect(html).toContain("episode 完成");
		expect(html).toContain("打开会话");
	});

	test("without a selection the table is shown without a drawer", () => {
		const html = render(false);
		expect(html).toContain("支付接口复测");
		expect(html).not.toContain("打开会话");
	});
});
