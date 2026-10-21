/**
 * Unit tests for the per-conversation Android switch: it is carried by a
 * session entry, defaults to off, and the last entry wins on a branch.
 */

import { expect, test } from "vitest";
import { readSessionDroid, SESSION_DROID_CUSTOM_TYPE, sessionDroidFromEntry } from "../src/session-droid.ts";

function entry(customType: string, data: unknown): unknown {
	return { type: "custom", customType, data };
}

test("an absent entry means Android tools are off", () => {
	expect(readSessionDroid([])).toBe(false);
	expect(readSessionDroid([entry("zg-mode", { mode: "auto" })])).toBe(false);
});

test("the last droid entry wins, so switching off is recorded too", () => {
	expect(readSessionDroid([entry(SESSION_DROID_CUSTOM_TYPE, { enabled: true })])).toBe(true);
	expect(
		readSessionDroid([
			entry(SESSION_DROID_CUSTOM_TYPE, { enabled: true }),
			entry(SESSION_DROID_CUSTOM_TYPE, { enabled: false }),
		]),
	).toBe(false);
	expect(
		readSessionDroid([
			entry(SESSION_DROID_CUSTOM_TYPE, { enabled: false }),
			entry(SESSION_DROID_CUSTOM_TYPE, { enabled: true }),
		]),
	).toBe(true);
});

test("a cleared entry falls back to off, and malformed entries are ignored", () => {
	expect(
		readSessionDroid([entry(SESSION_DROID_CUSTOM_TYPE, { enabled: true }), entry(SESSION_DROID_CUSTOM_TYPE, null)]),
	).toBe(false);
	expect(readSessionDroid([entry(SESSION_DROID_CUSTOM_TYPE, "on")])).toBe(false);
	expect(sessionDroidFromEntry(null)).toBe(false);
	expect(sessionDroidFromEntry({ enabled: "true" })).toBeUndefined();
});
