/**
 * Unit tests for permission normalization, focused on the commander section:
 * an absent section reads as off (the file predates it), a fresh install
 * defaults it on, and explicit values survive a round-trip.
 */

import { expect, test } from "vitest";
import { defaultPermissions, normalizePermissions, PERMISSION_PRESETS } from "../src/permissions.ts";

test("fresh defaults give the commander its fenced bash and read", () => {
	const config = defaultPermissions();
	expect(config.commander).toEqual({ bash: true, read: true });
});

test("a stored file without a commander section reads it as off", () => {
	const legacy = normalizePermissions({
		main: defaultPermissions().main,
		subagent: defaultPermissions().subagent,
	});
	expect(legacy.commander).toEqual({ bash: false, read: false });
});

test("explicit commander switches survive normalization", () => {
	const config = normalizePermissions({
		main: defaultPermissions().main,
		subagent: defaultPermissions().subagent,
		commander: { bash: true, read: false },
	});
	expect(config.commander).toEqual({ bash: true, read: false });
});

test("corrupt entries in the commander section read as off", () => {
	const config = normalizePermissions({
		main: defaultPermissions().main,
		subagent: defaultPermissions().subagent,
		commander: { bash: "yes", read: 1 },
	});
	expect(config.commander).toEqual({ bash: false, read: false });
});

test("every preset carries a commander set consistent with its philosophy", () => {
	const byId = new Map(PERMISSION_PRESETS.map((preset) => [preset.id, preset]));
	expect(byId.get("standard")?.commander).toEqual({ bash: true, read: true });
	// Recon runs nothing: the commander keeps read but loses bash.
	expect(byId.get("recon")?.commander).toEqual({ bash: false, read: true });
	expect(byId.get("locked")?.commander).toEqual({ bash: false, read: false });
});

test("normalization keeps the sub-agent subset rule intact", () => {
	const config = normalizePermissions({
		main: { ...defaultPermissions().main, bash: false },
		subagent: defaultPermissions().subagent,
		commander: { bash: true, read: true },
	});
	expect(config.main.bash).toBe(false);
	expect(config.subagent.bash).toBe(false);
	expect(config.subagent.spawn_agent).toBe(false);
});
