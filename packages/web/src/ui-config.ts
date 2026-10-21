/** The console's persisted UI preferences. Kept separate from model/security config. */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_UI_LANGUAGE, isUiLanguage, type UiLanguage } from "./i18n-messages.ts";

export interface SentinelUiConfig {
	language: UiLanguage;
}

export function uiConfigPath(agentDir: string): string {
	return `${agentDir}/ui-config.json`;
}

export function readUiConfig(agentDir: string): SentinelUiConfig {
	const path = uiConfigPath(agentDir);
	if (!existsSync(path)) return { language: DEFAULT_UI_LANGUAGE };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { language?: unknown };
		return { language: isUiLanguage(parsed.language) ? parsed.language : DEFAULT_UI_LANGUAGE };
	} catch {
		return { language: DEFAULT_UI_LANGUAGE };
	}
}

export function writeUiConfig(agentDir: string, config: SentinelUiConfig): void {
	const path = uiConfigPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Windows does not implement POSIX modes; the file still lives in the config dir.
	}
}
