/**
 * Server-side language state for WebSocket/API messages.
 *
 * The console is single-tenant: one saved language applies to every connected
 * browser. AI-generated content, prompts and stored history are never run
 * through this translator.
 */

import { DEFAULT_UI_LANGUAGE, translate, type UiLanguage } from "./i18n-messages.ts";

let language: UiLanguage = DEFAULT_UI_LANGUAGE;

export function getServerLanguage(): UiLanguage {
	return language;
}

export function setServerLanguage(next: UiLanguage): void {
	language = next;
}

export function t(source: string, vars?: Record<string, string | number>): string {
	return translate(language, source, vars);
}
