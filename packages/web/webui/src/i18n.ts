/**
 * Browser-side language state.
 *
 * The selected language is persisted before the app renders. Switching reloads
 * the document: every page, dialog and module-level label is then rebuilt from
 * one language, which avoids mixed-language screens during a live switch.
 */

import { DEFAULT_UI_LANGUAGE, EN_MESSAGES, interpolate, isUiLanguage, type UiLanguage } from "../../src/i18n-messages.ts";

const STORAGE_KEY = "sentinel.ui.language";

/** The few browser globals this module needs, typed locally so the server tests can import it. */
interface BrowserGlobals {
	localStorage?: {
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
	};
	document?: {
		cookie: string;
		documentElement: { lang: string };
		title: string;
	};
}

function browser(): BrowserGlobals | undefined {
	return typeof globalThis === "undefined" ? undefined : (globalThis as unknown as BrowserGlobals);
}

function cookieLanguage(): string | null {
	const doc = browser()?.document;
	if (!doc) return null;
	for (const part of doc.cookie.split(";")) {
		const [name, value] = part.trim().split("=");
		if (name === STORAGE_KEY) return decodeURIComponent(value ?? "");
	}
	return null;
}

function storedLanguage(): UiLanguage | null {
	try {
		const raw = browser()?.localStorage?.getItem(STORAGE_KEY);
		if (isUiLanguage(raw)) return raw;
	} catch {
		// Private mode can reject storage; fall through to the cookie.
	}
	const raw = cookieLanguage();
	return isUiLanguage(raw) ? raw : null;
}

function applyDocumentLanguage(language: UiLanguage): void {
	const doc = browser()?.document;
	if (!doc) return;
	doc.documentElement.lang = language === "zh" ? "zh-CN" : "en";
	doc.title = language === "en" ? (EN_MESSAGES["全链哨兵 控制台"] ?? "Full Chain Sentinel console") : "全链哨兵 控制台";
}

let language: UiLanguage = storedLanguage() ?? DEFAULT_UI_LANGUAGE;

applyDocumentLanguage(language);

export function getLanguage(): UiLanguage {
	return language;
}

export function storeLanguage(next: UiLanguage): void {
	language = next;
	try {
		browser()?.localStorage?.setItem(STORAGE_KEY, next);
	} catch {
		// Private mode can reject storage; the cookie below still survives the reload.
	}
	const doc = browser()?.document;
	if (doc) doc.cookie = `${STORAGE_KEY}=${next}; path=/; max-age=31536000; SameSite=Lax`;
	applyDocumentLanguage(next);
}

export function t(source: string, vars?: Record<string, string | number>): string {
	const text = language === "en" ? (EN_MESSAGES[source] ?? source) : source;
	return interpolate(text, vars);
}
