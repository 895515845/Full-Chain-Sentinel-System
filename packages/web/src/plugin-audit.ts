/**
 * The plugin center's audit trail.
 *
 * Tool calls are already in the session transcript, because a plugin's tools are
 * MCP tools like any other. What the transcript cannot show is the settings-page
 * side: who installed an image, who allowed host networking, who rotated a key.
 * Those actions are appended here as one JSON object per line.
 *
 * The file is best effort. An audit write must never fail an operation that
 * already happened; the operation is the fact, this is the record of it.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

export interface PluginAuditEntry {
	at: number;
	action:
		| "install"
		| "uninstall"
		| "start"
		| "stop"
		| "enable"
		| "disable"
		| "config"
		| "artifact"
		| "ui-open"
		| "ui-tool"
		| "ui-artifact"
		| "ui-storage"
		| "host-add"
		| "host-remove";
	hostId?: string;
	pluginId?: string;
	version?: string;
	ok: boolean;
	/** Values worth keeping that are not secrets, e.g. the approved network mode. */
	detail?: Record<string, unknown>;
	error?: string;
}

export function pluginAuditPath(agentDir: string): string {
	return join(agentDir, "plugin-audit.jsonl");
}

export function appendPluginAudit(agentDir: string, entry: Omit<PluginAuditEntry, "at">): void {
	try {
		const path = pluginAuditPath(agentDir);
		mkdirSync(dirname(path), { recursive: true });
		if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
		appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
	} catch {
		// The operation already happened; losing the log line is better than failing it.
	}
}
