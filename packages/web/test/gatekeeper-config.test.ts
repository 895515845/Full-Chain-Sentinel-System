/**
 * Unit tests for the gatekeeper settings file: defaults, clamping, the corrupt
 * file fallback, and the fact that a fresh console starts in the mode that asks
 * a human.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	DEFAULT_CONCURRENCY,
	DEFAULT_TIMEOUT_MS,
	gatekeeperJsonPath,
	MAX_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	normalizeGatekeeperConfig,
	readGatekeeperConfig,
	writeGatekeeperConfig,
} from "../src/gatekeeper-config.ts";

let root = "";
let agentDir = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "zgagent-gate-config-"));
	agentDir = join(root, "agent");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("normalizeGatekeeperConfig", () => {
	test("reads a missing or broken object as the defaults", () => {
		for (const raw of [undefined, null, "nonsense", 42, {}]) {
			expect(normalizeGatekeeperConfig(raw)).toEqual({
				mode: "review",
				timeoutMs: DEFAULT_TIMEOUT_MS,
				concurrency: DEFAULT_CONCURRENCY,
			});
		}
	});

	test("keeps every valid mode", () => {
		for (const mode of ["review", "ai", "auto"] as const) {
			expect(normalizeGatekeeperConfig({ mode }).mode).toBe(mode);
		}
	});

	test("rejects an unknown mode instead of trusting it", () => {
		expect(normalizeGatekeeperConfig({ mode: "yolo" }).mode).toBe("review");
	});

	test("clamps the timeout into its usable range", () => {
		expect(normalizeGatekeeperConfig({ timeoutMs: 10 }).timeoutMs).toBe(MIN_TIMEOUT_MS);
		expect(normalizeGatekeeperConfig({ timeoutMs: 10_000_000 }).timeoutMs).toBe(MAX_TIMEOUT_MS);
		expect(normalizeGatekeeperConfig({ timeoutMs: 2500.4 }).timeoutMs).toBe(2500);
		expect(normalizeGatekeeperConfig({ timeoutMs: Number.NaN }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
	});

	test("keeps 0 concurrency, which means no limit", () => {
		expect(normalizeGatekeeperConfig({ concurrency: 0 }).concurrency).toBe(0);
		expect(normalizeGatekeeperConfig({ concurrency: -5 }).concurrency).toBe(0);
		expect(normalizeGatekeeperConfig({ concurrency: 4 }).concurrency).toBe(4);
		expect(normalizeGatekeeperConfig({ concurrency: 1000 }).concurrency).toBe(64);
	});
});

describe("read and write", () => {
	test("a fresh agent dir reads as the defaults", () => {
		expect(readGatekeeperConfig(agentDir)).toEqual({
			mode: "review",
			timeoutMs: DEFAULT_TIMEOUT_MS,
			concurrency: DEFAULT_CONCURRENCY,
		});
	});

	test("round-trips a written config", () => {
		writeGatekeeperConfig(agentDir, { mode: "ai", timeoutMs: 8000, concurrency: 4 });
		expect(readGatekeeperConfig(agentDir)).toEqual({ mode: "ai", timeoutMs: 8000, concurrency: 4 });
	});

	test("writes normalized values, so the file never holds a bad one", () => {
		writeGatekeeperConfig(agentDir, { mode: "ai", timeoutMs: 1, concurrency: -1 });
		const raw = JSON.parse(readFileSync(gatekeeperJsonPath(agentDir), "utf-8")) as Record<string, unknown>;
		expect(raw).toEqual({ mode: "ai", timeoutMs: MIN_TIMEOUT_MS, concurrency: 0 });
	});

	test("a corrupt file falls back to the defaults instead of locking the console out", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(gatekeeperJsonPath(agentDir), "{ not json", "utf-8");
		expect(readGatekeeperConfig(agentDir).mode).toBe("review");
	});
});
