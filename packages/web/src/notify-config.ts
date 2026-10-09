/**
 * Notification configuration stored in notifications.json.
 *
 * The DingTalk custom-robot webhook carries an access_token in its URL, so the
 * file is written 0600 like models.json. The webhook is editable in the console
 * the same way the endpoint API key is: plaintext in the settings form, and
 * never sent to the model.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ZGNotifyConfig } from "./protocol.ts";

/** Notifications stay off until an operator configures and enables them. */
const DEFAULT_CONFIG: ZGNotifyConfig = {
	enabled: false,
	webhook: "",
	secret: "",
	keyword: "",
};

export function notificationsJsonPath(agentDir: string): string {
	return `${agentDir}/notifications.json`;
}

function coerce(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Read the persisted notification config; missing or broken files read as defaults. */
export function readNotifyConfig(agentDir: string): ZGNotifyConfig {
	const path = notificationsJsonPath(agentDir);
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { dingtalk?: Partial<ZGNotifyConfig> };
		const dingtalk = parsed.dingtalk ?? {};
		return {
			enabled: dingtalk.enabled === true,
			webhook: coerce(dingtalk.webhook),
			secret: coerce(dingtalk.secret),
			keyword: coerce(dingtalk.keyword),
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Persist the notification config, replacing the DingTalk section. */
export function writeNotifyConfig(agentDir: string, config: ZGNotifyConfig): void {
	const path = notificationsJsonPath(agentDir);
	const payload = {
		dingtalk: {
			enabled: config.enabled,
			webhook: config.webhook.trim(),
			secret: config.secret.trim(),
			keyword: config.keyword.trim(),
		},
	};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(payload, null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}
