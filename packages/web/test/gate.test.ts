/**
 * The console's secret entry: the pure rules (token, cookie, entry path) and the
 * behavior against a real server on an ephemeral port.
 *
 * What has to hold: until the entry URL is opened, every path answers a plain 404
 * — the page, a static asset, the API, the console socket — so an engine that
 * fetches `/` has nothing to fingerprint. Opening `/<token>` sets a cookie and
 * redirects to `/`, and from then on the console is exactly what it was before,
 * password included: the gate hides the console, it does not authenticate anyone.
 * The device gateway is the one exemption, because the APK cannot present a
 * browser cookie and carries its own device token instead.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
	GATE_COOKIE,
	GATE_TOKEN_MAX_CHARS,
	gateCookieValue,
	generateGateToken,
	isGateEntry,
	isGateToken,
} from "../src/gate.ts";
import { startSentinelServer } from "../src/server.ts";

const roots: string[] = [];
const servers: Array<{ close: () => void }> = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A server as the CLI starts it: authentication and the gate both on. */
async function openGatedServer(): Promise<{ url: string; token: string; cookie: string }> {
	const root = mkdtempSync(join(tmpdir(), "sentinel-gate-"));
	roots.push(root);
	const started = await startSentinelServer({ cwd: root, agentDir: root, host: "127.0.0.1", port: 0 });
	servers.push(started);
	// The startup URL *is* the entry URL: it is the one address the log prints.
	const entry = new URL(started.url);
	const token = entry.pathname.slice(1);
	return { url: entry.origin, token, cookie: `${GATE_COOKIE}=${gateCookieValue(token)}` };
}

/** How the server answered a WebSocket handshake, as the client reports it. */
function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve) => {
		const socket = new WebSocket(url, { headers });
		socket.on("error", (error: Error) => resolve(error.message));
		socket.on("open", () => {
			socket.close();
			resolve("101");
		});
	});
}

test("a generated token is URL-safe and different every time", () => {
	const tokens = new Set(Array.from({ length: 50 }, () => generateGateToken()));
	expect(tokens.size).toBe(50);
	for (const token of tokens) expect(isGateToken(token)).toBe(true);
});

test("an operator token is usable only when it can be one path segment", () => {
	expect(isGateToken("abcdefgh")).toBe(true);
	expect(isGateToken("a".repeat(GATE_TOKEN_MAX_CHARS))).toBe(true);
	expect(isGateToken("a".repeat(GATE_TOKEN_MAX_CHARS + 1))).toBe(false);
	// A slash or a space would produce an entry URL that cannot be opened, which is
	// why the CLI rejects them before the console starts.
	expect(isGateToken("has/slash")).toBe(false);
	expect(isGateToken("has space")).toBe(false);
});

test("the entry path matches the entry and nothing else", () => {
	const token = "abcdefgh1234";
	expect(isGateEntry(`/${token}`, token)).toBe(true);
	expect(isGateEntry(`/${token}/`, token)).toBe(true);
	expect(isGateEntry("/", token)).toBe(false);
	expect(isGateEntry(`/${token}x`, token)).toBe(false);
	expect(isGateEntry("/index.html", token)).toBe(false);
});

test("every path is a plain 404 until the entry URL is opened", async () => {
	const { url } = await openGatedServer();
	// `/` is what a search engine fetches, `/api/auth/state` is what a scanner
	// probes next, an asset path is what it tries after that. None may admit that
	// a console is here.
	for (const path of ["/", "/index.html", "/assets/index-abc.js", "/api/auth/state", "/api/health", "/ws"]) {
		const response = await fetch(`${url}${path}`);
		expect(response.status, path).toBe(404);
		expect(await response.text(), path).toBe("Not Found\n");
	}
	// No redirect to the entry URL either: pointing a scanner at the door would
	// defeat the whole thing.
	const root = await fetch(`${url}/`, { redirect: "manual" });
	expect(root.headers.get("location")).toBeNull();
});

test("opening the entry URL sets the cookie and redirects to the console", async () => {
	const { url, token } = await openGatedServer();
	const entry = await fetch(`${url}/${token}`, { redirect: "manual" });
	expect(entry.status).toBe(302);
	expect(entry.headers.get("location")).toBe("/");
	const setCookie = entry.headers.get("set-cookie") ?? "";
	expect(setCookie).toContain(`${GATE_COOKIE}=`);
	expect(setCookie).toContain("HttpOnly");
	// Lax, not Strict: the operator opens this from a chat window or a log, and the
	// redirect to / that follows is a cross-site navigation.
	expect(setCookie).toContain("SameSite=Lax");

	// Anything else at that depth is just another 404.
	const wrong = await fetch(`${url}/${token.slice(0, -1)}x`, { redirect: "manual" });
	expect(wrong.status).toBe(404);
});

test("with the cookie the console is itself again, password included", async () => {
	const { url, cookie } = await openGatedServer();
	const page = await fetch(`${url}/`, { headers: { cookie } });
	expect(page.status).toBe(200);
	expect(page.headers.get("content-type")).toContain("text/html");

	// The gate passes the request on; authentication still decides what it may do.
	const state = await fetch(`${url}/api/auth/state`, { headers: { cookie } });
	expect(state.status).toBe(200);
	expect(await state.json()).toMatchObject({ configured: false });
	expect((await fetch(`${url}/api/health`, { headers: { cookie } })).status).toBe(401);
});

test("the console socket needs the gate cookie; the device gateway does not", async () => {
	const { url, cookie } = await openGatedServer();
	const ws = url.replace("http", "ws");
	expect(await upgradeStatus(`${ws}/ws`)).toContain("404");
	// Past the gate the session check answers instead, so the gate did not swallow it.
	expect(await upgradeStatus(`${ws}/ws`, { cookie })).toContain("401");
	// The APK cannot present a browser cookie; its own device token is the check.
	expect(await upgradeStatus(`${ws}/ws/droid?token=nope`)).toContain("401");
});

test("a fixed token outlives the next start, and the gate can be turned off", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-gate-fixed-"));
	roots.push(root);
	const fixed = await startSentinelServer({
		cwd: root,
		agentDir: root,
		host: "127.0.0.1",
		port: 0,
		gateToken: "my-secret-entry",
	});
	servers.push(fixed);
	expect(new URL(fixed.url).pathname).toBe("/my-secret-entry");
	// A cookie minted for a fixed token keeps working across restarts, which is what
	// makes a bookmarked console usable after a service restart.
	const cookie = `${GATE_COOKIE}=${gateCookieValue("my-secret-entry")}`;
	expect((await fetch(`${fixed.url}/`, { headers: { cookie } })).status).toBe(200);

	const open = await startSentinelServer({ cwd: root, agentDir: root, host: "127.0.0.1", port: 0, gate: false });
	servers.push(open);
	expect(new URL(open.url).pathname).toBe("/");
	expect((await fetch(open.url)).status).toBe(200);
});
