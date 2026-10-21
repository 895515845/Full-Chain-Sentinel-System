/**
 * Console authentication.
 *
 * The console can run commands in the project container and reads the model
 * endpoint configuration, so an open port is an open shell. One administrator
 * account (username + password, scrypt-hashed, no plaintext on disk) guards
 * every API route and the WebSocket.
 *
 * Sessions are stateless: the cookie carries an expiry plus an HMAC of it,
 * keyed by a random secret stored next to the password hash. Changing the
 * password rotates the secret, which logs out every other session at once.
 * The browser keeps the cookie for 30 days (or for the session only, when
 * "记住登录" is unchecked); the server has no session store to clean up.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { t } from "./i18n.ts";

/** The cookie survives 30 days when 记住登录 is on; otherwise it is a session cookie. */
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Name of the session cookie. */
export const SESSION_COOKIE = "sentinel-auth";

/** Minimum accepted password length; this account can run commands. */
export const MIN_PASSWORD_CHARS = 8;

export interface StoredAuth {
	version: 1;
	username: string;
	/** scrypt salt and hash, hex. */
	salt: string;
	hash: string;
	/** Session-signing secret, hex. Rotated on password change. */
	secret: string;
	createdAt: string;
	/**
	 * Sessions whose expiry was issued before this moment are refused. Logout
	 * bumps it: the token is stateless, so this is what makes logout real.
	 */
	validAfter: number;
}

/** Path of the credential file, which never contains a plaintext password. */
export function authFilePath(agentDir: string): string {
	return join(agentDir, "auth.json");
}

/** The stored credentials, or null when missing or unreadable (first run). */
export function readStoredAuth(agentDir: string): StoredAuth | null {
	try {
		const raw = JSON.parse(readFileSync(authFilePath(agentDir), "utf8")) as Partial<StoredAuth>;
		if (
			raw.version !== 1 ||
			typeof raw.username !== "string" ||
			typeof raw.salt !== "string" ||
			typeof raw.hash !== "string" ||
			typeof raw.secret !== "string"
		) {
			return null;
		}
		return {
			version: 1,
			username: raw.username,
			salt: raw.salt,
			hash: raw.hash,
			secret: raw.secret,
			createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
			validAfter: typeof raw.validAfter === "number" ? raw.validAfter : 0,
		};
	} catch {
		return null;
	}
}

function hashPassword(password: string, salt: string): string {
	return scryptSync(password, salt, 64).toString("hex");
}

const USERNAME_RE = /^[\w.-]{1,40}$/u;

/** The first-run validation, shared by the setup and change-password paths. */
export function validateCredentials(username: string, password: string): string | null {
	if (!USERNAME_RE.test(username)) return t("用户名只能是字母、数字、点、下划线或连字符，最长 40 字符");
	if (password.length < MIN_PASSWORD_CHARS) return t("密码至少 {n} 个字符", { n: MIN_PASSWORD_CHARS });
	return null;
}

/** Create the credential file (0600) and return it; the caller sets the session cookie. */
export function createAuth(agentDir: string, username: string, password: string): StoredAuth {
	const problem = validateCredentials(username, password);
	if (problem) throw new Error(problem);
	const auth: StoredAuth = {
		version: 1,
		username,
		salt: randomBytes(16).toString("hex"),
		hash: "",
		secret: randomBytes(32).toString("hex"),
		createdAt: new Date().toISOString(),
		validAfter: 0,
	};
	auth.hash = hashPassword(password, auth.salt);
	mkdirSync(dirname(authFilePath(agentDir)), { recursive: true });
	writeFileSync(authFilePath(agentDir), `${JSON.stringify(auth, null, "\t")}\n`, { mode: 0o600 });
	return auth;
}

/** Constant-time credential check; a wrong username and a wrong password look the same. */
export function verifyLogin(stored: StoredAuth, username: string, password: string): boolean {
	const userOk = safeEqual(username, stored.username);
	const passOk = safeEqual(hashPassword(password, stored.salt), stored.hash);
	return userOk && passOk;
}

function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/** Change the password: new hash, new signing secret, so other sessions die. */
export function changePassword(agentDir: string, stored: StoredAuth, password: string): StoredAuth {
	if (password.length < MIN_PASSWORD_CHARS) throw new Error(t("密码至少 {n} 个字符", { n: MIN_PASSWORD_CHARS }));
	const next: StoredAuth = {
		...stored,
		salt: randomBytes(16).toString("hex"),
		secret: randomBytes(32).toString("hex"),
		validAfter: Date.now(),
	};
	next.hash = hashPassword(password, next.salt);
	writeFileSync(authFilePath(agentDir), `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
	return next;
}

function sign(secret: string, expiry: number): string {
	return createHmac("sha256", secret).update(String(expiry)).digest("hex");
}

/** A session token: `<expiry ms>.<hmac>`; the secret lives in auth.json, not in the cookie. */
export function issueSessionToken(stored: StoredAuth, now = Date.now()): { value: string; maxAge: number } {
	const expiry = now + REMEMBER_TTL_MS;
	return { value: `${expiry}.${sign(stored.secret, expiry)}`, maxAge: Math.floor(REMEMBER_TTL_MS / 1000) };
}

export function verifySessionToken(stored: StoredAuth, value: string | undefined, now = Date.now()): boolean {
	if (!value) return false;
	const dot = value.indexOf(".");
	if (dot <= 0) return false;
	const expiry = Number(value.slice(0, dot));
	if (!Number.isSafeInteger(expiry) || expiry <= now) return false;
	// A logout (or password change) at T rejects tokens issued before T. The
	// token carries only its expiry, so the issue time is derived from it.
	const issuedAt = expiry - REMEMBER_TTL_MS;
	if (issuedAt <= stored.validAfter) return false;
	const expected = sign(stored.secret, expiry);
	return safeEqual(value.slice(dot + 1), expected);
}

/**
 * `Set-Cookie` header value for a fresh session. A positive `maxAge` makes it a
 * persistent cookie (记住登录); 0 omits the attribute so the browser drops it
 * when the session ends.
 */
export function sessionCookieHeader(token: string, maxAge: number): string {
	const lifetime = maxAge > 0 ? `; Max-Age=${maxAge}` : "";
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${lifetime}`;
}

/** `Set-Cookie` that erases the session cookie. */
export function clearSessionCookieHeader(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Cookies of one request, as a plain record. */
export function parseCookies(request: { headers: { cookie?: string } }): Record<string, string> {
	const header = request.headers.cookie;
	const cookies: Record<string, string> = {};
	if (!header) return cookies;
	for (const part of header.split(";")) {
		const at = part.indexOf("=");
		if (at <= 0) continue;
		cookies[part.slice(0, at).trim()] = part.slice(at + 1).trim();
	}
	return cookies;
}

/**
 * Whether this request carries a valid session. `stored` null means auth is not
 * configured (first run); routes stay closed until the account is created.
 */
export function hasValidSession(
	stored: StoredAuth | null,
	request: { headers: { cookie?: string } },
	now = Date.now(),
): boolean {
	if (!stored) return false;
	return verifySessionToken(stored, parseCookies(request)[SESSION_COOKIE], now);
}

/**
 * Login throttling: one process-wide counter per remote address. Five failures
 * lock that address out for 30 seconds, so guessing is not worth scripting.
 */
export function createLoginLimiter() {
	const failures = new Map<string, { count: number; lockedUntil: number }>();
	const WINDOW_MS = 30_000;
	const MAX_FAILURES = 5;
	return {
		/** Milliseconds this address is still locked out, 0 when requests may pass. */
		blocked(key: string, now = Date.now()): number {
			const entry = failures.get(key);
			if (!entry) return 0;
			return entry.lockedUntil > now ? entry.lockedUntil - now : 0;
		},
		failure(key: string, now = Date.now()): void {
			const entry = failures.get(key) ?? { count: 0, lockedUntil: 0 };
			entry.count += 1;
			if (entry.count >= MAX_FAILURES) {
				entry.lockedUntil = now + WINDOW_MS;
				entry.count = 0;
			}
			failures.set(key, entry);
		},
		success(key: string): void {
			failures.delete(key);
		},
	};
}

export type LoginLimiter = ReturnType<typeof createLoginLimiter>;

/**
 * Invalidate every session issued so far (logout). The caller clears the cookie
 * separately; a stolen cookie stops working here.
 */
export function revokeSessions(agentDir: string, stored: StoredAuth, now = Date.now()): void {
	const next: StoredAuth = { ...stored, validAfter: now };
	writeFileSync(authFilePath(agentDir), `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
}
