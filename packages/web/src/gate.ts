/**
 * The console's secret entry.
 *
 * Binding a wildcard address makes the console a public page, and a public page
 * gets found: engines like FOFA fetch `/`, fingerprint what answers, and index it
 * — and a login form alone already says "Full Chain Sentinel console here". The gate removes
 * that answer. Startup picks a random token and prints one URL; opening `/<token>`
 * sets a cookie and redirects to `/`, and every other request without that cookie
 * is answered with a plain 404 — no redirect, no login page, no fingerprint.
 *
 * The cookie is an HMAC of the token, so it carries no secret of its own and the
 * server keeps no gate state: holding the cookie means having opened the entry
 * URL, which is already enough to walk in the front door. The token is fresh on
 * every start (an operator who needs a stable one passes `--gate-token`), so a
 * leaked URL stops working after a restart.
 *
 * The gate is not authentication. It decides whether a stranger learns that a
 * console is here; the password decides whether they can use it. A request that
 * passes the gate still has to log in.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { parseCookies } from "./auth.ts";

/** Cookie that proves the operator opened this startup's entry URL. */
export const GATE_COOKIE = "sentinel-gate";
/** 9 random bytes → 12 URL-safe characters; 72 bits is far past guessing. */
const GATE_TOKEN_BYTES = 9;
/** Shortest operator-supplied token (`--gate-token`); below this it is guessable. */
export const GATE_TOKEN_MIN_CHARS = 8;
/** Longest operator-supplied token: it has to read as one path segment. */
export const GATE_TOKEN_MAX_CHARS = 64;
/** How long the browser keeps the gate cookie. A restart invalidates it anyway. */
export const GATE_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** Domain separator, so this HMAC can never be confused with another use. */
const GATE_HMAC_LABEL = "sentinel-gate";

/** A fresh entry token, URL-safe so it can be a path segment. */
export function generateGateToken(): string {
	return randomBytes(GATE_TOKEN_BYTES).toString("base64url");
}

/** Whether an operator-supplied token is usable as the entry path segment. */
export function isGateToken(value: string): boolean {
	return new RegExp(`^[A-Za-z0-9_-]{${GATE_TOKEN_MIN_CHARS},${GATE_TOKEN_MAX_CHARS}}$`).test(value);
}

/**
 * The cookie value for a token. It is an HMAC rather than the token itself: the
 * cookie is sent on every request and lands in access logs, so it should not be
 * the string that opens the door.
 */
export function gateCookieValue(token: string): string {
	return createHmac("sha256", token).update(GATE_HMAC_LABEL).digest("base64url");
}

/**
 * `Set-Cookie` handed out by the entry URL. `SameSite=Lax`, not `Strict`: the
 * operator usually opens the printed URL from a chat window or a log, and the
 * redirect to `/` that follows is a cross-site navigation, where a `Strict`
 * cookie would not be sent and the console would 404 on its own front page.
 */
export function gateCookieHeader(token: string): string {
	return `${GATE_COOKIE}=${gateCookieValue(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GATE_COOKIE_MAX_AGE_SECONDS}`;
}

/** Whether a request carries the gate cookie for this startup's token. */
export function hasValidGate(request: { headers: { cookie?: string } }, token: string): boolean {
	const offered = Buffer.from(parseCookies(request)[GATE_COOKIE] ?? "");
	const expected = Buffer.from(gateCookieValue(token));
	return offered.length > 0 && offered.length === expected.length && timingSafeEqual(offered, expected);
}

/** Whether a path is this startup's entry URL, `/<token>` (trailing slash allowed). */
export function isGateEntry(pathname: string, token: string): boolean {
	return pathname === `/${token}` || pathname === `/${token}/`;
}

/**
 * The answer to every request that has not passed the gate. It is deliberately
 * the most boring response a web server can give — a plain 404 with a plain
 * body — because anything else (a redirect to the entry, a login page, a
 * distinctive error) is exactly what a scanner records.
 */
export function sendGateNotFound(response: ServerResponse): void {
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	response.end("Not Found\n");
}
