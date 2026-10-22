/**
 * Unit tests for the per-conversation iOS switch: carried by a session entry,
 * default off, independent of the Android switch, last entry wins.
 */

import { expect, test } from "vitest";
import { readSessionDroid, SESSION_DROID_CUSTOM_TYPE } from "../src/session-droid.ts";
import { readSessionIos, SESSION_IOS_CUSTOM_TYPE, sessionIosFromEntry } from "../src/session-ios.ts";

function entry(customType: string, data: unknown): unknown {
	return { type: "custom", customType, data };
}

test("an absent entry means iOS tools are off", () => {
	expect(readSessionIos([])).toBe(false);
	expect(readSessionIos([entry("zg-mode", { mode: "auto" })])).toBe(false);
});

test("the last ios entry wins, so switching off is recorded too", () => {
	expect(readSessionIos([entry(SESSION_IOS_CUSTOM_TYPE, { enabled: true })])).toBe(true);
	expect(
		readSessionIos([
			entry(SESSION_IOS_CUSTOM_TYPE, { enabled: true }),
			entry(SESSION_IOS_CUSTOM_TYPE, { enabled: false }),
		]),
	).toBe(false);
	expect(
		readSessionIos([
			entry(SESSION_IOS_CUSTOM_TYPE, { enabled: false }),
			entry(SESSION_IOS_CUSTOM_TYPE, { enabled: true }),
		]),
	).toBe(true);
});

test("a cleared entry falls back to off, and malformed entries are ignored", () => {
	expect(
		readSessionIos([entry(SESSION_IOS_CUSTOM_TYPE, { enabled: true }), entry(SESSION_IOS_CUSTOM_TYPE, null)]),
	).toBe(false);
	expect(readSessionIos([entry(SESSION_IOS_CUSTOM_TYPE, "on")])).toBe(false);
	expect(sessionIosFromEntry(null)).toBe(false);
	expect(sessionIosFromEntry({ enabled: "true" })).toBeUndefined();
});

test("the iOS and Android switches do not read each other's entries", () => {
	const branch = [
		entry(SESSION_DROID_CUSTOM_TYPE, { enabled: true }),
		entry(SESSION_IOS_CUSTOM_TYPE, { enabled: false }),
	];
	expect(readSessionDroid(branch)).toBe(true);
	expect(readSessionIos(branch)).toBe(false);
});
