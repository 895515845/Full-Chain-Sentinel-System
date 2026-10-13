/**
 * The preset agent one session runs under.
 *
 * A preset is system-prompt context: it decides what extra briefing the
 * conversation was given, and it can be changed mid-conversation — the composer's
 * 预设 Agent switch appends another entry and rebuilds the session, so the turns
 * that follow run under the new text while the earlier ones keep the briefing
 * that produced them. The choice is stored the way the mode and the manual status
 * are — as a `custom` session entry (`zg-preset`) — so it travels with the
 * conversation, survives a restart, is inherited by a fork, and never enters the
 * model's context. The text itself is not copied into the entry: the entry names
 * the preset, and the body is read from disk on every rebuild, so editing a
 * preset affects the next rebuild while the record of which preset was in force
 * stays exact.
 *
 * `null` means "no preset", which is what an absent entry means too: the session
 * runs as the plain default agent.
 */

export const SESSION_PRESET_CUSTOM_TYPE = "zg-preset";

/** The preset id one `zg-preset` entry carries; `null` clears it. */
export function sessionPresetFromEntry(data: unknown): string | null | undefined {
	if (data === null) return null;
	if (typeof data !== "object") return undefined;
	const id = (data as { id?: unknown }).id;
	return typeof id === "string" && id ? id : undefined;
}

/** The preset set by the last `zg-preset` entry on a branch; null means none. */
export function readSessionPreset(entries: readonly unknown[]): string | null {
	let found: string | null = null;
	for (const entry of entries) {
		const value = entry as { type?: string; customType?: string; data?: unknown };
		if (value.type !== "custom" || value.customType !== SESSION_PRESET_CUSTOM_TYPE) continue;
		found = sessionPresetFromEntry(value.data) ?? null;
	}
	return found;
}
