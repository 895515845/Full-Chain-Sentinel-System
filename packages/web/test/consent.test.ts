/**
 * The first-visit authorization promise: the pure rules, and the gate itself
 * against a real server on an ephemeral port.
 *
 * What has to hold: a fresh account cannot use the console at all until it
 * accepts the statement — the API answers 403 and the WebSocket is refused —
 * while the statement itself stays reachable so the page can show it. Acceptance
 * is recorded on the server, so reopening the console (or restarting it) does not
 * ask again; a different account, or an edited statement, asks again.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { SESSION_COOKIE } from "../src/auth.ts";
import {
	CONSENT_TEXT,
	consentFilePath,
	consentStatus,
	consentText,
	consentTextHash,
	isConsentExemptPath,
	readConsentRecord,
	writeConsentRecord,
} from "../src/consent.ts";
import { startSentinelServer } from "../src/server.ts";

const roots: string[] = [];
const servers: Array<{ close: () => void }> = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function openServer(root?: string): Promise<{
	started: Awaited<ReturnType<typeof startSentinelServer>>;
	url: string;
	root: string;
}> {
	const dir = root ?? mkdtempSync(join(tmpdir(), "sentinel-consent-"));
	if (!root) roots.push(dir);
	// The gate is off: this file is about the promise, and a gated server answers
	// 404 to anything that has not opened the entry URL first.
	const started = await startSentinelServer({ cwd: dir, agentDir: dir, host: "127.0.0.1", port: 0, gate: false });
	servers.push(started);
	return { started, url: started.url, root: dir };
}

async function json(url: string, path: string, init: RequestInit & { cookie?: string } = {}) {
	const headers = new Headers(init.headers);
	if (init.cookie) headers.set("cookie", init.cookie);
	if (init.body) headers.set("content-type", "application/json");
	return fetch(`${url}${path}`, { ...init, headers });
}

/** Creates the account and returns its session cookie, the way the first visitor does. */
async function createAccount(url: string): Promise<string> {
	const response = await json(url, "/api/auth/setup", {
		method: "POST",
		body: JSON.stringify({ username: "operator", password: "sentinel-test-password" }),
	});
	expect(response.status).toBe(200);
	const pair = response.headers.get("set-cookie")?.split(";")[0] ?? "";
	expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
	return pair;
}

/** How the server answered a WebSocket handshake, as the client reports it. */
function upgradeStatus(url: string, cookie: string): Promise<string> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`${url.replace("http://", "ws://")}/ws`, { headers: { cookie } });
		ws.on("error", (error: Error) => resolve(error.message));
		ws.on("open", () => {
			ws.close();
			resolve("101");
		});
	});
}

test("a fresh account has to accept the statement before the console answers", async () => {
	const { url, root } = await openServer();
	const cookie = await createAccount(url);

	// The console is closed: the API, the health route, and the socket.
	const health = await json(url, "/api/health", { cookie });
	expect(health.status).toBe(403);
	expect(await health.json()).toEqual({ error: "consent_required" });
	expect(await upgradeStatus(url, cookie)).toContain("403");

	// The statement stays reachable, and the session tells the client why.
	const statement = await json(url, "/api/consent", { cookie });
	expect(statement.status).toBe(200);
	const payload = (await statement.json()) as { required: boolean; text: { promise: string } };
	expect(payload.required).toBe(true);
	expect(payload.text.promise).toBe(CONSENT_TEXT.promise);

	const session = await json(url, "/api/auth/session", { cookie });
	expect(session.status).toBe(200);
	expect(await session.json()).toMatchObject({ username: "operator", consent: { required: true, acceptedAt: null } });

	// Accepting needs an explicit flag: a bare POST must not record anything.
	expect((await json(url, "/api/consent/accept", { method: "POST", cookie, body: "{}" })).status).toBe(400);
	expect(readConsentRecord(root)).toBeNull();
	expect(consentStatus(root, "operator").required).toBe(true);
});

test("accepting the statement records it and opens the console for good", async () => {
	const { url, root } = await openServer();
	const cookie = await createAccount(url);

	const accepted = await json(url, "/api/consent/accept", {
		method: "POST",
		cookie,
		body: JSON.stringify({ accepted: true }),
	});
	expect(accepted.status).toBe(200);
	expect(await accepted.json()).toMatchObject({ ok: true, version: 1 });

	// The record is on disk, readable only by its owner.
	const record = readConsentRecord(root);
	expect(record).toMatchObject({ version: 1, username: "operator", textHash: consentTextHash() });
	expect(statSync(consentFilePath(root)).mode & 0o777).toBe(0o600);

	// The console is now open, socket included.
	expect((await json(url, "/api/health", { cookie })).status).toBe(200);
	expect(await upgradeStatus(url, cookie)).toBe("101");
	const statement = await json(url, "/api/consent", { cookie });
	expect(await statement.json()).toMatchObject({ required: false });

	// The next start reads the same record from disk, so it does not ask again.
	expect(consentStatus(root, "operator").required).toBe(false);
});

test("the promise is per account and per wording", () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-consent-rules-"));
	roots.push(root);

	// Nothing recorded yet.
	expect(consentStatus(root, "operator")).toEqual({ required: true, acceptedAt: null, version: 1 });
	// No account or no directory: nothing to tie the promise to, so it is required.
	expect(consentStatus(undefined, "operator").required).toBe(true);
	expect(consentStatus(root, null).required).toBe(true);

	const record = writeConsentRecord(root, "operator");
	expect(consentStatus(root, "operator")).toEqual({
		required: false,
		acceptedAt: record.acceptedAt,
		version: 1,
	});
	// Another account inherits nothing.
	expect(consentStatus(root, "someone-else").required).toBe(true);

	// Editing the statement invalidates the record: consent is to the wording read.
	writeFileSync(consentFilePath(root), `${JSON.stringify({ ...record, textHash: "stale" })}\n`);
	expect(consentStatus(root, "operator").required).toBe(true);

	// A corrupt or truncated record is treated as no record.
	writeFileSync(consentFilePath(root), "{ not json");
	expect(consentStatus(root, "operator").required).toBe(true);
	expect(readConsentRecord(root)).toBeNull();
});

test("the statement says what it has to say, and its emphasis markers are balanced", () => {
	const text = consentText();
	// The four things the gate exists for.
	expect(text).toContain("未授权");
	expect(text).toContain("违法");
	expect(text).toContain(CONSENT_TEXT.promise);
	expect(text).toContain("由使用者自行承担");
	// The account name is not part of the statement; the hash covers the wording.
	expect(consentTextHash()).toMatch(/^[0-9a-f]{16}$/);

	const parts = [
		CONSENT_TEXT.title,
		CONSENT_TEXT.subtitle,
		CONSENT_TEXT.intro,
		...CONSENT_TEXT.clauses.flatMap((clause) => [clause.title, clause.body]),
		CONSENT_TEXT.illegal,
		CONSENT_TEXT.aiTitle,
		...CONSENT_TEXT.ai,
		CONSENT_TEXT.promise,
		CONSENT_TEXT.ack,
		CONSENT_TEXT.footnote,
	];
	for (const part of parts) {
		expect((part.match(/\*\*/g) ?? []).length % 2, `unbalanced emphasis in: ${part.slice(0, 24)}`).toBe(0);
	}
});

test("only the statement and the session stay reachable before the promise", () => {
	expect(isConsentExemptPath("/api/consent")).toBe(true);
	expect(isConsentExemptPath("/api/consent/accept")).toBe(true);
	expect(isConsentExemptPath("/api/auth/session")).toBe(true);
	// Everything that touches the agent, the projects, or the containers waits.
	for (const path of ["/api/health", "/api/upload", "/api/auth/change-password", "/api/consent/accept/extra"]) {
		expect(isConsentExemptPath(path)).toBe(false);
	}
});

test("the record file is what the console reads back after a restart", () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-consent-file-"));
	roots.push(root);
	writeConsentRecord(root, "operator", new Date("2026-01-02T03:04:05.000Z"));
	const stored = JSON.parse(readFileSync(consentFilePath(root), "utf8")) as Record<string, unknown>;
	expect(stored).toEqual({
		version: 1,
		textHash: consentTextHash(),
		username: "operator",
		acceptedAt: "2026-01-02T03:04:05.000Z",
	});
});
