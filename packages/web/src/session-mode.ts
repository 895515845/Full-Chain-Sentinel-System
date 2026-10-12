/**
 * The operator's mode override for one session.
 *
 * The console-wide default lives in gatekeeper.json and is what most sessions
 * follow. A session that needs a different answer — a long unattended run, or a
 * conversation where the operator wants to see every command — carries its own
 * choice as a `custom` session entry (`zg-mode`), the same mechanism the manual
 * status uses: it travels with the conversation, survives a restart, is
 * inherited by a fork, and never enters the model's context.
 *
 * `null` means "follow the global default", which is why a cleared entry and an
 * absent one behave identically.
 */

import type { ZGMode } from "./protocol.ts";
import { ZG_MODES } from "./protocol.ts";

export const SESSION_MODE_CUSTOM_TYPE = "zg-mode";

export function isSessionMode(value: unknown): value is ZGMode {
	return typeof value === "string" && (ZG_MODES as readonly string[]).includes(value);
}

/** The override one `zg-mode` entry carries; `null` clears it. */
export function sessionModeFromEntry(data: unknown): ZGMode | null | undefined {
	if (data === null) return null;
	if (typeof data !== "object") return undefined;
	const mode = (data as { mode?: unknown }).mode;
	return isSessionMode(mode) ? mode : undefined;
}

/** The override set by the last `zg-mode` entry on a branch; null means follow the default. */
export function readSessionMode(entries: readonly unknown[]): ZGMode | null {
	let found: ZGMode | null = null;
	for (const entry of entries) {
		const value = entry as { type?: string; customType?: string; data?: unknown };
		if (value.type !== "custom" || value.customType !== SESSION_MODE_CUSTOM_TYPE) continue;
		found = sessionModeFromEntry(value.data) ?? null;
	}
	return found;
}
