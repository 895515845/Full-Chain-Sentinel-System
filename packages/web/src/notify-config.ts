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

/**
 * Characters of notification body kept by default. 500 was too short to read a
 * finding from the phone, so the body is longer and the operator can change it.
 */
export const DEFAULT_SUMMARY_LIMIT = 2000;

/** Notifications stay off until an operator configures and enables them. */
const DEFAULT_CONFIG: ZGNotifyConfig = {
	enabled: false,
	webhook: "",
	secret: "",
	keyword: "",
	kinds: { runs: true, vulns: true, goals: true, engines: true, pocs: true },
	summaryLimit: DEFAULT_SUMMARY_LIMIT,
};

/** Every kind on unless the file says otherwise, so an old config keeps pushing. */
function coerceKinds(value: unknown): ZGNotifyConfig["kinds"] {
	const kinds = (value ?? {}) as Partial<ZGNotifyConfig["kinds"]>;
	return {
		runs: kinds.runs !== false,
		vulns: kinds.vulns !== false,
		goals: kinds.goals !== false,
		engines: kinds.engines !== false,
		pocs: kinds.pocs !== false,
	};
}

/** A limit is a character count: 0 means "keep everything", anything else is positive. */
function coerceSummaryLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SUMMARY_LIMIT;
	const limit = Math.floor(value);
	return limit <= 0 ? 0 : limit;
}

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
			kinds: coerceKinds(dingtalk.kinds),
			summaryLimit: coerceSummaryLimit(dingtalk.summaryLimit),
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
			kinds: coerceKinds(config.kinds),
			summaryLimit: coerceSummaryLimit(config.summaryLimit),
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
