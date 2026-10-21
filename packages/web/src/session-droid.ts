/**
 * The Android toolset switch for one conversation.
 *
 * The switch used to be a console-wide setting, so turning 安卓 on in one chat
 * mounted droid_* / apk_* in every open chat. It belongs to the conversation:
 * a Web-only session should stay free of Android tools even while another
 * session is driving a phone. The choice is a `custom` session entry
 * (`zg-droid`), the same mechanism the mode and preset use: it travels with the
 * conversation, survives a restart, and is inherited by a fork without entering
 * the model's context.
 *
 * `false` is both the default and what a cleared entry means. New conversations
 * therefore start clean, and a session only gets Android tools after its own
 * switch is turned on.
 */

export const SESSION_DROID_CUSTOM_TYPE = "zg-droid";

/** The switch one `zg-droid` entry carries; `null` clears it. */
export function sessionDroidFromEntry(data: unknown): boolean | undefined {
	if (data === null) return false;
	if (typeof data !== "object") return undefined;
	const enabled = (data as { enabled?: unknown }).enabled;
	return typeof enabled === "boolean" ? enabled : undefined;
}

/** The switch set by the last `zg-droid` entry on a branch; absent means off. */
export function readSessionDroid(entries: readonly unknown[]): boolean {
	let found = false;
	for (const entry of entries) {
		const value = entry as { type?: string; customType?: string; data?: unknown };
		if (value.type !== "custom" || value.customType !== SESSION_DROID_CUSTOM_TYPE) continue;
		const enabled = sessionDroidFromEntry(value.data);
		if (enabled !== undefined) found = enabled;
	}
	return found;
}
