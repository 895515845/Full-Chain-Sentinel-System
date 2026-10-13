/**
 * Unit tests for the per-session preset entry: how it is read from a branch,
 * and that an absent or cleared entry means "plain default agent".
 */

import { describe, expect, test } from "vitest";
import { readSessionPreset, SESSION_PRESET_CUSTOM_TYPE, sessionPresetFromEntry } from "../src/session-preset.ts";

const presetEntry = (data: unknown) => ({ type: "custom", customType: SESSION_PRESET_CUSTOM_TYPE, data });

describe("sessionPresetFromEntry", () => {
	test("reads the preset id out of the entry payload", () => {
		expect(sessionPresetFromEntry({ id: "web-recon", at: 1 })).toBe("web-recon");
	});

	test("a null payload clears the choice", () => {
		expect(sessionPresetFromEntry(null)).toBeNull();
	});

	test("ignores an unknown payload shape", () => {
		expect(sessionPresetFromEntry({ id: 7 })).toBeUndefined();
		expect(sessionPresetFromEntry({ id: "" })).toBeUndefined();
		expect(sessionPresetFromEntry("web-recon")).toBeUndefined();
	});
});

describe("readSessionPreset", () => {
	test("defaults to no preset", () => {
		expect(readSessionPreset([])).toBeNull();
		expect(readSessionPreset([{ type: "message", role: "user" }])).toBeNull();
	});

	test("the last entry on the branch wins", () => {
		expect(readSessionPreset([presetEntry({ id: "web-recon" }), presetEntry({ id: "ad-enum" })])).toBe("ad-enum");
		expect(readSessionPreset([presetEntry({ id: "web-recon" }), presetEntry(null)])).toBeNull();
	});

	test("ignores entries of other custom types", () => {
		expect(readSessionPreset([{ type: "custom", customType: "zg-mode", data: { mode: "ai" } }])).toBeNull();
		expect(readSessionPreset([{ type: "custom", customType: "zg-status", data: { status: "todo" } }])).toBeNull();
	});

	test("ignores a malformed payload instead of trusting it", () => {
		expect(readSessionPreset([presetEntry({ id: 7 })])).toBeNull();
	});
});
