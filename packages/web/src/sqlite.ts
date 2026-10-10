/**
 * SQLite access that works both from a Node checkout and from a compiled Bun binary.
 *
 * Node exposes `node:sqlite`; Bun does not implement it and exposes `bun:sqlite`
 * instead. A compiled single-file binary carries no `node_modules`, so the module
 * has to be chosen at runtime rather than imported statically: a static import of
 * either specifier fails to resolve on the other runtime.
 *
 * The two implementations agree on the call surface used here (`exec`, `prepare`,
 * `run`, `get`, `all`, `close`), which is what lets the sub-agent store stay
 * runtime-agnostic.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Values the store binds into statements. */
export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatement {
	run(...params: SqliteValue[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
	all(...params: SqliteValue[]): unknown[];
	get(...params: SqliteValue[]): unknown;
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface SqliteModule {
	DatabaseSync?: new (path: string) => SqliteDatabase;
	Database?: new (path: string) => SqliteDatabase;
}

function loadSqliteModule(): SqliteModule {
	// Try the runtime's own implementation first; the fallback covers a Bun binary
	// running against a Node build (or the reverse) without changing the caller.
	const specifiers = process.versions.bun ? ["bun:sqlite", "node:sqlite"] : ["node:sqlite", "bun:sqlite"];
	let lastError: unknown;
	for (const specifier of specifiers) {
		try {
			return require(specifier) as SqliteModule;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`无法加载 SQLite 运行时：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Open (creating if needed) the SQLite database at `path`. */
export function openSqliteDatabase(path: string): SqliteDatabase {
	const module = loadSqliteModule();
	const Database = module.DatabaseSync ?? module.Database;
	if (!Database) throw new Error("SQLite 运行时未导出 DatabaseSync/Database");
	return new Database(path);
}
