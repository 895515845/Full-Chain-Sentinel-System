/**
 * Unit tests for the per-session mode override entry: how it is read from a
 * branch, and that a cleared entry means "follow the global default".
 */

import { describe, expect, test } from "vitest";
import { isSessionMode, readSessionMode, SESSION_MODE_CUSTOM_TYPE, sessionModeFromEntry } from "../src/session-mode.ts";

const modeEntry = (data: unknown) => ({ type: "custom", customType: SESSION_MODE_CUSTOM_TYPE, data });

describe("isSessionMode", () => {
	test("accepts exactly the three modes", () => {
		for (const mode of ["review", "ai", "auto"]) expect(isSessionMode(mode)).toBe(true);
		for (const value of ["", "yolo", null, undefined, 3, {}]) expect(isSessionMode(value)).toBe(false);
	});
});

describe("sessionModeFromEntry", () => {
	test("reads the mode out of the entry payload", () => {
		expect(sessionModeFromEntry({ mode: "ai", at: 1 })).toBe("ai");
	});

	test("a null payload clears the override", () => {
		expect(sessionModeFromEntry(null)).toBeNull();
	});

	test("ignores an unknown payload shape", () => {
		expect(sessionModeFromEntry({ mode: "yolo" })).toBeUndefined();
		expect(sessionModeFromEntry("ai")).toBeUndefined();
	});
});

describe("readSessionMode", () => {
	test("defaults to following the global mode", () => {
		expect(readSessionMode([])).toBeNull();
		expect(readSessionMode([{ type: "message", role: "user" }])).toBeNull();
	});

	test("the last entry on the branch wins", () => {
		expect(readSessionMode([modeEntry({ mode: "ai" }), modeEntry({ mode: "auto" })])).toBe("auto");
		expect(readSessionMode([modeEntry({ mode: "ai" }), modeEntry(null)])).toBeNull();
	});

	test("ignores entries of other custom types", () => {
		expect(readSessionMode([{ type: "custom", customType: "zg-status", data: { status: "todo" } }])).toBeNull();
	});

	test("ignores a malformed payload instead of trusting it", () => {
		expect(readSessionMode([modeEntry({ mode: "yolo" })])).toBeNull();
	});
});
