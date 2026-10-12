/**
 * Console authentication, against a real server on an ephemeral port.
 *
 * The flow it must hold together: a fresh install has no credentials, so the
 * first visitor creates the account (setup); every later visit logs in; the
 * cookie opens /api and the WebSocket; a wrong password is throttled; changing
 * the password logs the other session out.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { authFilePath, readStoredAuth, SESSION_COOKIE } from "../src/auth.ts";
import { startZGServer } from "../src/server.ts";

const roots: string[] = [];
const servers: Array<{ close: () => void }> = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function openServer(): Promise<{
	started: Awaited<ReturnType<typeof startZGServer>>;
	url: string;
	root: string;
}> {
	const root = mkdtempSync(join(tmpdir(), "zgagent-auth-"));
	roots.push(root);
	const started = await startZGServer({ cwd: root, agentDir: root, host: "127.0.0.1", port: 0 });
	servers.push(started);
	return { started, url: started.url, root };
}

function cookieOf(response: Response): string {
	const setCookie = response.headers.get("set-cookie");
	expect(setCookie, "login/setup must set the session cookie").toBeTruthy();
	const pair = setCookie?.split(";")[0] ?? "";
	expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
	return pair;
}

async function json(url: string, path: string, init: RequestInit & { cookie?: string } = {}) {
	const headers = new Headers(init.headers);
	if (init.cookie) headers.set("cookie", init.cookie);
	if (init.body) headers.set("content-type", "application/json");
	return fetch(`${url}${path}`, { ...init, headers });
}

/** A WebSocket that presents the session cookie, the way the browser does. */
function openSocket(url: string, cookie: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const address = url.replace("http://", "ws://");
		const ws = new WebSocket(`${address}/ws`, { headers: { cookie } });
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});
}

test("a fresh install asks for setup, and setup both creates the account and logs in", async () => {
	const { started, root } = await openServer();
	const { url } = started;

	const state = await json(url, "/api/auth/state");
	expect(state.status).toBe(200);
	expect(await state.json()).toEqual({ configured: false, username: null });

	// Everything else is closed: the API, the health route, the WebSocket.
	expect((await json(url, "/api/auth/session")).status).toBe(401);
	expect((await json(url, "/api/health")).status).toBe(401);
	await expect(openSocket(url, "")).rejects.toMatchObject({ message: "Unexpected server response: 401" });

	// The bundle itself stays open: the login screen is part of it.
	expect((await fetch(`${url}/`)).status).toBe(200);

	const tooShort = await json(url, "/api/auth/setup", {
		method: "POST",
		body: JSON.stringify({ username: "op", password: "short" }),
	});
	expect(tooShort.status).toBe(400);

	const created = await json(url, "/api/auth/setup", {
		method: "POST",
		body: JSON.stringify({ username: "operator", password: "correct horse battery" }),
	});
	expect(created.status).toBe(200);
	const cookie = cookieOf(created);

	// The account file keeps only the hash, and only the owner can read it.
	const authPath = authFilePath(root);
	const mode = statSync(authPath).mode & 0o777;
	expect(mode).toBe(0o600);
	const stored = readStoredAuth(root);
	expect(stored?.username).toBe("operator");
	expect(readFileSync(authPath, "utf8")).not.toContain("correct horse battery");

	const session = await json(url, "/api/auth/session", { cookie });
	expect(session.status).toBe(200);
	expect(await session.json()).toEqual({ ok: true, username: "operator" });

	const health = await json(url, "/api/health", { cookie });
	expect(health.status).toBe(200);

	const socket = await openSocket(url, cookie);
	expect(socket.readyState).toBe(WebSocket.OPEN);
	socket.close();

	// A second setup attempt cannot overwrite the account.
	expect(
		(
			await json(url, "/api/auth/setup", {
				method: "POST",
				body: JSON.stringify({ username: "other", password: "another password" }),
			})
		).status,
	).toBe(409);
});

test("login rejects wrong credentials, throttles, and accepts the right ones", async () => {
	const { url } = await openServer();
	await json(url, "/api/auth/setup", {
		method: "POST",
		body: JSON.stringify({ username: "operator", password: "correct horse battery" }),
	});

	const wrong = await json(url, "/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ username: "operator", password: "wrong password" }),
	});
	expect(wrong.status).toBe(401);

	// Five failures lock the address: even the correct password waits out the lock.
	for (let i = 0; i < 4; i += 1) {
		await json(url, "/api/auth/login", {
			method: "POST",
			body: JSON.stringify({ username: "operator", password: "wrong password" }),
		});
	}
	const locked = await json(url, "/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ username: "operator", password: "correct horse battery" }),
	});
	expect(locked.status).toBe(429);
	expect(await locked.json()).toMatchObject({ error: expect.stringContaining("秒") });
});

test("logout clears the session, and a password change kills the old cookie", async () => {
	const { url } = await openServer();
	const created = await json(url, "/api/auth/setup", {
		method: "POST",
		body: JSON.stringify({ username: "operator", password: "correct horse battery" }),
	});
	const firstCookie = cookieOf(created);

	expect((await json(url, "/api/auth/logout", { method: "POST", cookie: firstCookie })).status).toBe(200);
	expect((await json(url, "/api/auth/session", { cookie: firstCookie })).status).toBe(401);

	const second = await json(url, "/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ username: "operator", password: "correct horse battery" }),
	});
	const secondCookie = cookieOf(second);

	const badCurrent = await json(url, "/api/auth/change-password", {
		method: "POST",
		cookie: secondCookie,
		body: JSON.stringify({ current: "not the password", next: "a better passphrase" }),
	});
	expect(badCurrent.status).toBe(400);

	const changed = await json(url, "/api/auth/change-password", {
		method: "POST",
		cookie: secondCookie,
		body: JSON.stringify({ current: "correct horse battery", next: "a better passphrase" }),
	});
	expect(changed.status).toBe(200);
	const newCookie = cookieOf(changed);

	// The old cookie signed with the previous secret no longer works.
	expect((await json(url, "/api/auth/session", { cookie: secondCookie })).status).toBe(401);
	expect((await json(url, "/api/auth/session", { cookie: newCookie })).status).toBe(200);

	// And the new password is the one that logs in now.
	const relaunch = await json(url, "/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ username: "operator", password: "a better passphrase" }),
	});
	expect(relaunch.status).toBe(200);
});
