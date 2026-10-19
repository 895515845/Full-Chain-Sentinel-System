/**
 * Unit tests for the gatekeeper audit store: append-only recording, filtering,
 * pagination, the header statistics, and the project cascade.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GatekeeperStore } from "../src/gatekeeper-store.ts";
import { openSqliteDatabase } from "../src/sqlite.ts";

let root = "";
let store: GatekeeperStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-gate-store-"));
	store = new GatekeeperStore(join(root, "gatekeeper.db"));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

let clock = 1_700_000_000_000;

function record(over: Partial<Parameters<GatekeeperStore["record"]>[0]> = {}) {
	clock += 1000;
	return store.record({
		at: clock,
		projectId: "p1",
		projectName: "项目一",
		sessionId: "s1",
		source: "主代理",
		tool: "bash",
		command: "nmap -sV target",
		cwd: "/work",
		decision: "allow",
		latencyMs: 120,
		model: "judge-stub",
		modelFrom: "judge",
		inputTokens: 900,
		outputTokens: 3,
		totalTokens: 903,
		...over,
	});
}

describe("record", () => {
	test("returns the stored record with an assigned id", () => {
		const decision = record();
		expect(decision.id).toMatch(/^gate-/);
		expect(decision.decision).toBe("allow");
		expect(decision.projectName).toBe("项目一");
		expect(decision.totalTokens).toBe(903);
	});

	test("keeps a block reason and a failure error", () => {
		const blocked = record({ decision: "block", reason: "命中第 4 条" });
		const failed = record({ decision: "failed", error: "端点返回 500" });
		expect(store.list({ decision: "block" }).items[0].reason).toBe("命中第 4 条");
		expect(store.list({ decision: "failed" }).items[0].error).toBe("端点返回 500");
		expect(blocked.reason).toBe("命中第 4 条");
		expect(failed.error).toBe("端点返回 500");
	});

	test("records who let the call through, defaulting to the judge", () => {
		// The store predates the approval column for one release, and nothing
		// that already calls `record` has a reason to name a bucket: only the
		// gatekeeper wrote rows. `ai` is therefore the default.
		expect(record().approval).toBe("ai");
		expect(record({ tool: "read", approval: "auto" }).approval).toBe("auto");
		expect(record({ tool: "bash", approval: "human" }).approval).toBe("human");
	});

	test("truncates a long command and flags it", () => {
		const decision = record({ command: `curl -d "${"a".repeat(20_000)}" target` });
		expect(decision.commandTruncated).toBe(true);
		expect(decision.command.length).toBeLessThan(9000);
		expect(decision.command.endsWith("（已截断）")).toBe(true);
	});

	test("omits absent optional fields instead of storing empty ones", () => {
		const decision = record({ reason: undefined, error: undefined, model: undefined });
		expect("reason" in decision).toBe(false);
		expect("error" in decision).toBe(false);
		expect("model" in decision).toBe(false);
	});
});

describe("list", () => {
	test("returns newest first and paginates", () => {
		for (let index = 0; index < 5; index += 1) record({ command: `cmd-${index}` });
		const first = store.list(undefined, 1, 2);
		expect(first.total).toBe(5);
		expect(first.pageSize).toBe(2);
		expect(first.items.map((item) => item.command)).toEqual(["cmd-4", "cmd-3"]);
		const second = store.list(undefined, 2, 2);
		expect(second.items.map((item) => item.command)).toEqual(["cmd-2", "cmd-1"]);
	});

	test("filters by decision, source, session, project, and time", () => {
		record({ decision: "block", source: "子代理", sessionId: "s2" });
		record({ decision: "failed", projectId: "p2" });
		const allow = record();
		expect(store.list({ decision: "block" }).total).toBe(1);
		expect(store.list({ source: "子代理" }).total).toBe(1);
		expect(store.list({ sessionId: "s2" }).total).toBe(1);
		expect(store.list({ projectId: "p2" }).total).toBe(1);
		expect(store.list({ since: allow.at }).total).toBe(1);
	});

	test("searches the command and the reason, and treats % as a literal", () => {
		record({ command: "hydra -l admin target" });
		record({ decision: "block", command: "rm -f /etc/passwd", reason: "删除系统文件" });
		expect(store.list({ search: "hydra" }).total).toBe(1);
		expect(store.list({ search: "删除系统" }).total).toBe(1);
		expect(store.list({ search: "%" }).total).toBe(0);
	});

	test("combines filters with AND", () => {
		record({ decision: "block", source: "子代理" });
		record({ decision: "block", source: "主代理" });
		expect(store.list({ decision: "block", source: "子代理" }).total).toBe(1);
	});

	test("filters by approval, and by two buckets at once", () => {
		// The audit page's 「自动审批」 tab is one query over two buckets; an
		// `ai`-only tab must not leak an unjudged row and vice versa.
		record({ tool: "bash", approval: "ai" });
		record({ tool: "bash", approval: "human" });
		record({ tool: "read", approval: "auto" });
		record({ tool: "read", approval: "auto" });
		expect(store.list({ approval: ["ai"] }).total).toBe(1);
		expect(store.list({ approval: ["auto", "human"] }).total).toBe(3);
		// An empty list means "all three", not "none": a tab is never empty by
		// construction, and an absent list is how the unfiltered page reads.
		expect(store.list({}).total).toBe(4);
		expect(store.list({ approval: [] }).total).toBe(4);
	});
});

describe("approval column migration", () => {
	test("a database written before the column keeps its rows and reads as ai", () => {
		const path = join(root, "old.db");
		const before = openSqliteDatabase(path);
		before.exec("PRAGMA journal_mode = WAL");
		before.exec(`CREATE TABLE gate_decisions (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, project_id TEXT, project_name TEXT,
  session_id TEXT, source TEXT NOT NULL, tool TEXT NOT NULL, command TEXT NOT NULL,
  command_truncated INTEGER NOT NULL DEFAULT 0, cwd TEXT, decision TEXT NOT NULL,
  reason TEXT, latency_ms INTEGER NOT NULL, model TEXT, model_from TEXT,
  input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, error TEXT)`);
		before
			.prepare(
				"INSERT INTO gate_decisions (id, at, source, tool, command, decision, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("gate-old", 1, "主代理", "bash", "whoami", "allow", 12);
		before.close();

		const migrated = new GatekeeperStore(path);
		const rows = migrated.list(undefined).items;
		expect(rows.length).toBe(1);
		// Every row that predates the column was a judgment, so it must stay on
		// the 「AI 审批」 tab rather than being re-labelled as unjudged.
		expect(rows[0].approval).toBe("ai");
		expect(migrated.stats().byApproval.ai).toBe(1);
		migrated.close();

		// And the second open is a no-op, not an error.
		const again = new GatekeeperStore(path);
		expect(again.list(undefined).total).toBe(1);
		again.close();
	});
});

describe("bucketCounts", () => {
	test("counts all three buckets, ignoring the filter's approval", () => {
		// The tab strip reads this: with the 「自动审批」 tab open its own
		// approval filter is in the filter, and the counts on the other tab must
		// survive it.
		record({ tool: "bash", approval: "ai" });
		record({ tool: "bash", approval: "ai" });
		record({ tool: "bash", approval: "human" });
		record({ tool: "read", approval: "auto" });
		expect(store.bucketCounts({ approval: ["auto", "human"] })).toEqual({ ai: 2, human: 1, auto: 1 });
		expect(store.bucketCounts({ approval: ["ai"] })).toEqual({ ai: 2, human: 1, auto: 1 });
		expect(store.bucketCounts(undefined)).toEqual({ ai: 2, human: 1, auto: 1 });
	});

	test("still honours every other filter", () => {
		record({ tool: "bash", approval: "ai", projectId: "p1" });
		record({ tool: "read", approval: "auto", projectId: "p2" });
		expect(store.bucketCounts({ approval: ["ai"], projectId: "p1" })).toEqual({ ai: 1, human: 0, auto: 0 });
		expect(store.bucketCounts({ projectId: "p2" })).toEqual({ ai: 0, human: 0, auto: 1 });
	});
});

describe("stats", () => {
	test("counts every decision kind and computes the block rate", () => {
		record({ decision: "allow" });
		record({ decision: "allow" });
		record({ decision: "block" });
		record({ decision: "failed", error: "端点超时" });
		const stats = store.stats();
		expect(stats.total).toBe(4);
		expect(stats.byDecision).toEqual({ allow: 2, block: 1, failed: 1 });
		expect(stats.blockRate).toBeCloseTo(0.25);
		expect(stats.avgLatencyMs).toBe(120);
		expect(stats.totalTokens).toBe(3612);
	});

	test("counts rows per approval bucket so each tab can summarise itself", () => {
		record({ tool: "bash", approval: "ai" });
		record({ tool: "bash", approval: "human" });
		record({ tool: "read", approval: "auto" });
		expect(store.stats().byApproval).toEqual({ ai: 1, human: 1, auto: 1 });
		// The tab's own numbers, not the other tab's.
		expect(store.stats({ approval: ["auto", "human"] }).byApproval).toEqual({ ai: 0, human: 1, auto: 1 });
	});

	test("reports the failure count, the newest failure, and its message", () => {
		record({ decision: "failed", error: "旧错误" });
		record({ decision: "failed", error: "新错误" });
		const stats = store.stats();
		expect(stats.failures).toBe(2);
		expect(stats.lastFailureAt).toBe(clock);
		expect(stats.lastError).toBe("新错误");
	});

	test("is empty on a fresh database", () => {
		const stats = store.stats();
		expect(stats.total).toBe(0);
		expect(stats.blockRate).toBe(0);
		expect(stats.avgLatencyMs).toBe(0);
		expect(stats.failures).toBe(0);
		expect(stats.lastFailureAt).toBeNull();
		expect(stats.lastError).toBeNull();
	});

	test("narrows to the filter it is given", () => {
		record({ decision: "block", source: "子代理" });
		record({ decision: "allow", source: "主代理" });
		expect(store.stats({ source: "子代理" }).total).toBe(1);
		expect(store.stats({ source: "子代理" }).byDecision.block).toBe(1);
	});
});

describe("project cascade", () => {
	test("counts and deletes one project's records only", () => {
		record({ projectId: "p1" });
		record({ projectId: "p1" });
		record({ projectId: "p2" });
		expect(store.countByProject("p1")).toBe(2);
		expect(store.purgeProject("p1")).toBe(2);
		expect(store.countByProject("p1")).toBe(0);
		expect(store.list(undefined).total).toBe(1);
	});
});
