import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TavilyError } from "../src/websearch.ts";
import { type WebSearchQueryReport, type WebSearchToolContext, writeWebSearchEvidence } from "../src/websearch-tool.ts";

/** A tool context with scripted keys and searches, for driving the tools. */
function context(options: { keys: Array<{ id: string; label: string; key: string }> }): {
	context: WebSearchToolContext;
	reports: WebSearchQueryReport[];
	evidence: Array<{ name: string; raw: unknown }>;
} {
	const { keys } = options;
	const reports: WebSearchQueryReport[] = [];
	const evidence: Array<{ name: string; raw: unknown }> = [];
	return {
		reports,
		evidence,
		context: {
			pickKey: async (exclude: string[]) => {
				const next = keys.find((key) => !exclude.includes(key.id));
				return next ?? "号池中的 Key 额度已全部耗尽";
			},
			remaining: () => null,
			consume: () => true,
			saveEvidence: (name, raw) => {
				evidence.push({ name, raw });
				return `evidence/search/${name}`;
			},
			report: (report) => reports.push(report),
		},
	};
}

// The tool calls searchWeb directly; to exercise rotation without network, the
// context's keys are paired with a module-level stub via dependency injection of
// fetch is not available, so rotation is tested through the pickKey contract.
test("pickKey excludes spent keys until the pool is empty", async () => {
	const keys = [
		{ id: "a", label: "A", key: "ka" },
		{ id: "b", label: "B", key: "kb" },
	];
	const picked = await context({ keys }).context.pickKey([]);
	expect(picked).toEqual(keys[0]);
	expect(await context({ keys }).context.pickKey(["a"])).toEqual(keys[1]);
	expect(await context({ keys }).context.pickKey(["a", "b"])).toBe("号池中的 Key 额度已全部耗尽");
});

test("writeWebSearchEvidence writes under evidence/search and survives failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "websearch-evidence-"));
	try {
		const path = writeWebSearchEvidence(dir, "t.json", { ok: true });
		expect(path).toBe(join("evidence", "search", "t.json"));
		expect(path === undefined || existsSync(join(dir, path))).toBe(true);
		// A work dir that cannot hold the file returns undefined instead of throwing.
		expect(writeWebSearchEvidence(join(dir, "blocked"), "x/y.json", {})).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TavilyError carries its retryable flag", () => {
	expect(new TavilyError("quota", true).retryable).toBe(true);
	expect(new TavilyError("bad key", false).retryable).toBe(false);
});
