/**
 * The iOS toolset switch for one conversation.
 *
 * A mirror of `session-droid.ts` for the same reason: mounting iOS tools in
 * every chat would put `ios_*` in Web-only sessions, and the switch has to
 * travel with the conversation. The custom entry type is separate (`zg-ios`)
 * so one chat can drive a phone while another drives an iPhone, and a fork
 * inherits whichever switch was on.
 *
 * `false` is both the default and what a cleared entry means.
 */

export const SESSION_IOS_CUSTOM_TYPE = "zg-ios";

/** The switch one `zg-ios` entry carries; `null` clears it. */
export function sessionIosFromEntry(data: unknown): boolean | undefined {
	if (data === null) return false;
	if (typeof data !== "object") return undefined;
	const enabled = (data as { enabled?: unknown }).enabled;
	return typeof enabled === "boolean" ? enabled : undefined;
}

/** The switch set by the last `zg-ios` entry on a branch; absent means off. */
export function readSessionIos(entries: readonly unknown[]): boolean {
	let found = false;
	for (const entry of entries) {
		const value = entry as { type?: string; customType?: string; data?: unknown };
		if (value.type !== "custom" || value.customType !== SESSION_IOS_CUSTOM_TYPE) continue;
		const enabled = sessionIosFromEntry(value.data);
		if (enabled !== undefined) found = enabled;
	}
	return found;
}
