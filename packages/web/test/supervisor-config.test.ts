/** Global supervision settings: tolerant parse, clamping, and 0600 persistence. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	normalizeSupervisorConfig,
	readSupervisorConfig,
	SUPERVISOR_DEFAULTS,
	supervisorJsonPath,
	writeSupervisorConfig,
} from "../src/supervisor-config.ts";

let root = "";
let agentDir = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-supervisor-config-"));
	agentDir = join(root, "agent");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("normalizeSupervisorConfig", () => {
	test("missing values fall back to the defaults", () => {
		expect(normalizeSupervisorConfig({})).toEqual(SUPERVISOR_DEFAULTS);
	});

	test("clamps out-of-range thresholds instead of accepting them", () => {
		const config = normalizeSupervisorConfig({
			batchToolCalls: 999,
			duplicateThreshold: 1,
			noProgressCalls: 0,
			errorStreak: -4,
			timeoutMs: 100,
		});
		expect(config.batchToolCalls).toBe(100);
		expect(config.duplicateThreshold).toBe(2);
		expect(config.noProgressCalls).toBe(2);
		expect(config.errorStreak).toBe(2);
		expect(config.timeoutMs).toBe(5000);
	});

	test("keeps booleans and rejects non-boolean values", () => {
		expect(normalizeSupervisorConfig({ enabled: false }).enabled).toBe(false);
		expect(normalizeSupervisorConfig({ enabled: "yes" }).enabled).toBe(true);
	});
});

describe("file persistence", () => {
	test("round-trips a config at 0600", () => {
		writeSupervisorConfig(agentDir, {
			...SUPERVISOR_DEFAULTS,
			enabled: false,
			batchToolCalls: 30,
			timeoutMs: 45_000,
		});
		expect(readSupervisorConfig(agentDir)).toMatchObject({
			enabled: false,
			batchToolCalls: 30,
			timeoutMs: 45_000,
		});
		const text = readFileSync(supervisorJsonPath(agentDir), "utf-8");
		expect(text).toContain('"batchToolCalls": 30');
	});

	test("a corrupt file reads as the defaults", () => {
		writeSupervisorConfig(agentDir, SUPERVISOR_DEFAULTS);
		writeFileSync(supervisorJsonPath(agentDir), "{");
		expect(readSupervisorConfig(agentDir)).toEqual(SUPERVISOR_DEFAULTS);
	});
});
