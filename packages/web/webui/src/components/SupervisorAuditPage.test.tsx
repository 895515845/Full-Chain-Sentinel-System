/**
 * Option A: the audit page is a table-first view. These assertions pin the
 * filters, KPI strip, row content and the detail modal.
 *
 * The detail opens in the console's own modal shell (Overlay) over the table;
 * with no selection the table is all there is.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type {
	SentinelSupervisorAdvice,
	SentinelSupervisorAuditItem,
	SentinelSupervisorAuditPage,
	SentinelSupervisorDetail,
	SentinelSupervisorEpisode,
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
		strategy: "steady",
		strategyCustomId: null,
		strategyName: "稳健交付",
		strategyInstructions: "",
		strategyNote: "",
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

const episode = (seq: number): SentinelSupervisorEpisode => ({
	id: `ep${seq}`,
	sessionId: "s1",
	seq,
	at: 1_700_000_000_000 + seq * 1000,
	trigger: "batch",
	phase: "vuln_mapping",
	intent: `第 ${seq} 轮`,
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
});

const advice = (seq: number): SentinelSupervisorAdvice => ({
	id: `a${seq}`,
	sessionId: "s1",
	episodeId: `ep${seq}`,
	at: 1_700_000_000_000 + seq * 1000,
	delivery: "confirm",
	status: "pending",
	text: `建议 ${seq}`,
	sentAt: null,
});

const detail: SentinelSupervisorDetail = {
	session: item(),
	// A page holds three episodes and three advice, twenty log lines: seven
	// episodes make three pages, the others two, so each pager differs.
	episodes: [1, 2, 3, 4, 5, 6, 7].map(episode),
	logs: Array.from({ length: 21 }, (_, index) => ({
		at: 1_700_000_000_000 + index * 1000,
		kind: "episode" as const,
		text: `episode 完成 ${index + 1}`,
	})),
	advice: [1, 2, 3, 4].map(advice),
};

function render(withDetail: boolean): string {
	return renderToStaticMarkup(
		<SupervisorAuditPage
			page={page}
			detail={withDetail ? detail : null}
			projects={[{ id: "p1", name: "支付网关", cwd: "/tmp" }]}
			customStrategies={[]}
			onQuery={() => {}}
			onSelect={() => {}}
			onBack={() => {}}
			onOpenSession={() => {}}
		/>,
	);
}

describe("SupervisorAuditPage", () => {
	test("renders filters, stats, the table and a detail modal", () => {
		const html = render(true);
		expect(html).toContain("全部模式");
		expect(html).toContain("全部进度");
		expect(html).toContain("全部预设");
		expect(html).toContain("稳健交付");
		expect(html).toContain("监督会话");
		expect(html).toContain("支付接口复测");
		expect(html).toContain("12.4k");
		expect(html).toContain("待确认建议");
		expect(html).toContain("已停止");
		expect(html).toContain("Episode");
		expect(html).toContain("episode 完成");
		expect(html).toContain("打开会话");
		expect(html).toContain("modal-backdrop");
	});

	test("the row carries the session status, its mode and a localized trigger", () => {
		const html = render(true);
		expect(html).toContain("监督中");
		expect(html).toContain("观察");
		expect(html).toContain("批量触发");
		expect(html).toContain("停滞");
	});

	test("every column counts its entries and pages on its own", () => {
		const html = render(true);
		expect(html).toContain("Episode <span class=\"sva-count\">7</span>");
		expect(html).toContain("建议 <span class=\"sva-count\">4</span>");
		expect(html).toContain("日志 <span class=\"sva-count\">21</span>");
		// Episodes page three at a time, advice and logs page two times.
		expect(html).toContain("1 / 3");
		expect(html).toContain("1 / 2");
		// The first page only, not the whole list.
		expect(html).toContain("第 3 轮");
		expect(html).not.toContain("第 4 轮");
	});

	test("an advice states its status in a badge, not in a coloured border", () => {
		const html = render(true);
		// The card keeps one neutral border; the state rides on a badge, the way
		// a gate row states its verdict.
		expect(html).toContain('class="sva-advice pending"');
		expect(html).toContain('class="sva-advice-status sva-flag warn"');
		expect(html).toContain("待确认");
	});

	test("without a selection there is no modal, only the table", () => {
		const html = render(false);
		expect(html).toContain("支付接口复测");
		expect(html).not.toContain("打开会话");
		expect(html).not.toContain("modal-backdrop");
	});
});
