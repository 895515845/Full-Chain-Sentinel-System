/**
 * The Droid plugin's registry: which devices exist, which tokens they use to
 * connect, and which are online.
 *
 * Storage lives in the agent directory (`droids.db`), not in the project work
 * directory, for the same reason as the vulnerability hub: the work directory is
 * mounted into the container, and the device registry must survive it.
 *
 * A device is identified by a deviceId the APK generates on first start and
 * keeps in its private storage; it authenticates with a token the operator
 * created in the console. Tokens are per device class, deletable (the page's
 * 删除 removes the row, so the secret can never authenticate again), and stored
 * in plain text next to the model keys (0600 on the directory is what protects
 * them, the same trade-off the model library makes).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SqliteDatabase, SqliteValue } from "./sqlite.ts";
import { openSqliteDatabase } from "./sqlite.ts";

export function droidDbPath(agentDir: string): string {
	return join(agentDir, "droids.db");
}

export interface DroidDevice {
	id: string;
	/** Operator-editable label; defaults to the model the device reported. */
	name: string;
	model: string;
	androidVersion: string;
	sdkInt: number;
	rooted: boolean;
	online: boolean;
	tokenId: string;
	firstSeen: string;
	lastSeen: string;
	/**
	 * Runtime-only, never persisted: the socket is still open but the device
	 * stopped sending anything. Android (or an emulator) can SIGSTOP the whole app
	 * process, and the kernel keeps the connection ESTABLISHED — so "online" alone
	 * lies for as long as the freeze lasts. The gateway sets this once the last
	 * frame is older than its liveness window.
	 */
	stale?: boolean;
	/** Runtime-only: milliseconds since the device's last frame (0 when fresh). */
	idleMs?: number;
}

export interface DroidToken {
	id: string;
	label: string;
	token: string;
	createdAt: string;
	lastUsedAt: string | null;
}

/** Device info as the APK reports it in `hello`; the registry fills in the rest. */
export interface DroidHello {
	deviceId: string;
	model: string;
	androidVersion: string;
	sdkInt: number;
	rooted: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS droid_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Legacy: deleting a token used to only set this column. Nothing writes it
  -- any more, and rows that still carry a value are dropped when the store
  -- opens; the column stays so those databases can still be read.
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS droid_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  android_version TEXT NOT NULL,
  sdk_int INTEGER NOT NULL,
  rooted INTEGER NOT NULL,
  online INTEGER NOT NULL DEFAULT 0,
  token_id TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_droid_devices_online ON droid_devices(online, last_seen);
CREATE TABLE IF NOT EXISTS droid_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface DeviceRow {
	id: string;
	name: string;
	model: string;
	android_version: string;
	sdk_int: number;
	rooted: number;
	online: number;
	token_id: string;
	first_seen: string;
	last_seen: string;
}

interface TokenRow {
	id: string;
	label: string;
	token: string;
	created_at: string;
	last_used_at: string | null;
}

function now(): string {
	return new Date().toISOString();
}

function toDevice(row: DeviceRow): DroidDevice {
	return {
		id: row.id,
		name: row.name,
		model: row.model,
		androidVersion: row.android_version,
		sdkInt: row.sdk_int,
		rooted: row.rooted === 1,
		online: row.online === 1,
		tokenId: row.token_id,
		firstSeen: row.first_seen,
		lastSeen: row.last_seen,
	};
}

function toToken(row: TokenRow): DroidToken {
	return {
		id: row.id,
		label: row.label,
		token: row.token,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	};
}

export class DroidStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		this.db = openSqliteDatabase(path);
		this.db.exec(SCHEMA);
		// One-time migration. A token used to be "revoked" by stamping
		// `revoked_at`, and the page offered no action on a row in that state, so
		// such a row was stuck in the list forever. Deleting is the only meaning
		// the operator has now, so the leftovers go too.
		this.db.prepare("DELETE FROM droid_tokens WHERE revoked_at IS NOT NULL").run();
	}

	// -- tokens ---------------------------------------------------------------

	createToken(label: string): DroidToken {
		const token: DroidToken = {
			id: randomUUID(),
			label: label.trim() || "未命名设备",
			// Long enough that guessing is hopeless, short enough to type into the APK once.
			token: `droid_${randomUUID().replace(/-/g, "")}`,
			createdAt: now(),
			lastUsedAt: null,
		};
		this.db
			.prepare("INSERT INTO droid_tokens (id, label, token, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)")
			.run(token.id, token.label, token.token, token.createdAt);
		return token;
	}

	listTokens(): DroidToken[] {
		const rows = this.db.prepare("SELECT * FROM droid_tokens ORDER BY created_at DESC, id").all() as TokenRow[];
		return rows.map(toToken);
	}

	/**
	 * The token record for a presented secret, or undefined (unknown or deleted).
	 * The `revoked_at` clause is belt and braces for a database written by an
	 * older console: such a row must never authenticate, even if the purge in the
	 * constructor were somehow skipped.
	 */
	findToken(token: string): DroidToken | undefined {
		if (!token) return undefined;
		const row = this.db.prepare("SELECT * FROM droid_tokens WHERE token = ? AND revoked_at IS NULL").get(token) as
			| TokenRow
			| undefined;
		return row ? toToken(row) : undefined;
	}

	touchToken(id: string): void {
		this.db.prepare("UPDATE droid_tokens SET last_used_at = ? WHERE id = ?").run(now(), id);
	}

	/** Delete a token (the page's 删除): the secret can never authenticate again. */
	deleteToken(id: string): boolean {
		const result = this.db.prepare("DELETE FROM droid_tokens WHERE id = ?").run(id);
		return Number(result.changes ?? 0) > 0;
	}

	// -- devices --------------------------------------------------------------

	/**
	 * Register (or refresh) a device that just said hello. The operator's label
	 * survives: only the reported facts and the timestamps are refreshed.
	 */
	upsertDevice(hello: DroidHello, tokenId: string): DroidDevice {
		const at = now();
		const existing = this.db.prepare("SELECT * FROM droid_devices WHERE id = ?").get(hello.deviceId) as
			| DeviceRow
			| undefined;
		if (existing) {
			this.db
				.prepare(
					"UPDATE droid_devices SET model = ?, android_version = ?, sdk_int = ?, rooted = ?, online = 1, token_id = ?, last_seen = ? WHERE id = ?",
				)
				.run(hello.model, hello.androidVersion, hello.sdkInt, hello.rooted ? 1 : 0, tokenId, at, hello.deviceId);
		} else {
			this.db
				.prepare(
					"INSERT INTO droid_devices (id, name, model, android_version, sdk_int, rooted, online, token_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
				)
				.run(
					hello.deviceId,
					hello.model,
					hello.model,
					hello.androidVersion,
					hello.sdkInt,
					hello.rooted ? 1 : 0,
					tokenId,
					at,
					at,
				);
		}
		this.touchToken(tokenId);
		return this.getDevice(hello.deviceId) as DroidDevice;
	}

	getDevice(id: string): DroidDevice | undefined {
		const row = this.db.prepare("SELECT * FROM droid_devices WHERE id = ?").get(id) as DeviceRow | undefined;
		return row ? toDevice(row) : undefined;
	}

	listDevices(): DroidDevice[] {
		const rows = this.db
			.prepare("SELECT * FROM droid_devices ORDER BY online DESC, last_seen DESC, id")
			.all() as DeviceRow[];
		return rows.map(toDevice);
	}

	onlineDevices(): DroidDevice[] {
		const rows = this.db
			.prepare("SELECT * FROM droid_devices WHERE online = 1 ORDER BY last_seen DESC, id")
			.all() as DeviceRow[];
		return rows.map(toDevice);
	}

	setDeviceOnline(id: string, online: boolean): void {
		this.db.prepare("UPDATE droid_devices SET online = ?, last_seen = ? WHERE id = ?").run(online ? 1 : 0, now(), id);
	}

	renameDevice(id: string, name: string): boolean {
		const trimmed = name.trim();
		if (!trimmed) return false;
		const result = this.db.prepare("UPDATE droid_devices SET name = ? WHERE id = ?").run(trimmed, id);
		return Number(result.changes ?? 0) > 0;
	}

	removeDevice(id: string): boolean {
		const result = this.db.prepare("DELETE FROM droid_devices WHERE id = ?").run(id);
		return Number(result.changes ?? 0) > 0;
	}

	/** Whether any enabled switch state is stored (key/value side table). */
	getMeta(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM droid_meta WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value;
	}

	setMeta(key: string, value: string): void {
		this.db
			.prepare(
				"INSERT INTO droid_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(key, value as SqliteValue);
	}

	close(): void {
		this.db.close();
	}
}
