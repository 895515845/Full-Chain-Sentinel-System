/**
 * Unit tests for the commander's retry accounting: decomposition is free,
 * only failed dispatches consume the retry budget.
 */

import { expect, test } from "vitest";
import { retryDecision } from "../src/commander-tools.ts";

test("first dispatch for a target is always allowed", () => {
	const decision = retryDecision([], 0, "10.0.0.1");
	expect(decision.allowed).toBe(true);
	expect(decision.attempt).toBe(1);
	expect(decision.failures).toBe(0);
});

test("successful multi-stage tasks never consume the retry budget", () => {
	const stages = [{ status: "done" }, { status: "done" }, { status: "done" }, { status: "running" }];
	for (const maxRetries of [0, 1]) {
		const decision = retryDecision(stages, maxRetries, "10.0.0.1");
		expect(decision.allowed).toBe(true);
		expect(decision.attempt).toBe(stages.length + 1);
		expect(decision.failures).toBe(0);
	}
});

test("failed dispatches consume the budget and then refuse", () => {
	// maxRetries 0: the first failure already blocks a re-dispatch.
	const one = retryDecision([{ status: "failed" }], 0, "10.0.0.1");
	expect(one.allowed).toBe(false);
	expect(one.failures).toBe(1);
	expect(one.error).toContain("1 次失败派发");

	// maxRetries 1: one failure is still within budget, a second is not.
	const withinBudget = retryDecision([{ status: "failed" }], 1, "10.0.0.1");
	expect(withinBudget.allowed).toBe(true);
	const overBudget = retryDecision([{ status: "failed" }, { status: "blocked" }], 1, "10.0.0.1");
	expect(overBudget.allowed).toBe(false);
	expect(overBudget.failures).toBe(2);
});

test("blocked and aborted count as failures; done does not offset them", () => {
	const mixed = [{ status: "done" }, { status: "blocked" }, { status: "aborted" }, { status: "done" }];
	const decision = retryDecision(mixed, 1, "10.0.0.1");
	expect(decision.allowed).toBe(false);
	expect(decision.failures).toBe(2);
	expect(decision.attempt).toBe(5);
});
