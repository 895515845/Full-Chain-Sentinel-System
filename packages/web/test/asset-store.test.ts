/**
 * Unit tests for the asset-mapping query log: what is stored, what is filtered,
 * and that a removed project takes its rows with it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AssetStore, assetsDbPath } from "../src/asset-store.ts";

let root = "";
let store: AssetStore | undefined;

function freshStore(): AssetStore {
	root = mkdtempSync(join(tmpdir(), "sentinel-assets-db-"));
	store = new AssetStore(assetsDbPath(root));
	return store;
}

afterEach(() => {
	store?.close();
	store = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

const RECORD = { ip: "1.1.1.1", port: 80, title: "后台" };

test("stores a query with its records and reads it back", () => {
	const assets = freshStore();
	const saved = assets.save({
		projectId: "p1",
		platform: "fofa",
		query: 'ip="1.1.1.1"',
		page: 2,
		size: 20,
		total: 67742,
		count: 1,
		ok: true,
		latencyMs: 123,
		quota: "本次消耗 0 F 点",
		sessionId: "s-1",
		source: "主代理",
		evidencePath: "evidence/asset/fofa-p2.json",
		records: [RECORD],
	});
	expect(saved.id).toMatch(/^aq-/);
	expect(saved.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	const read = assets.get(saved.id);
	expect(read).toBeDefined();
	expect(read).toMatchObject({
		projectId: "p1",
		platform: "fofa",
		query: 'ip="1.1.1.1"',
		page: 2,
		size: 20,
		total: 67742,
		count: 1,
		ok: true,
		latencyMs: 123,
		quota: "本次消耗 0 F 点",
		sessionId: "s-1",
		source: "主代理",
		evidencePath: "evidence/asset/fofa-p2.json",
		records: [RECORD],
	});
});

test("a failed query is logged too, because it spent a call", () => {
	const assets = freshStore();
	assets.save({
		projectId: "p1",
		platform: "quake",
		query: "bad syntax",
		page: 1,
		size: 20,
		total: 0,
		count: 0,
		ok: false,
		latencyMs: 0,
		error: "q2001 筛选字段传参错误",
		records: [],
	});
	const page = assets.list("p1");
	expect(page.total).toBe(1);
	expect(page.items[0]).toMatchObject({ ok: false, error: "q2001 筛选字段传参错误", records: [] });
	// Optional fields stay absent rather than becoming empty strings.
	expect(page.items[0].quota).toBeUndefined();
	expect(page.items[0].evidencePath).toBeUndefined();
});

test("lists newest first, filters by platform and search, and pages", () => {
	const assets = freshStore();
	const base = {
		projectId: "p1",
		page: 1,
		size: 20,
		total: 1,
		count: 1,
		ok: true,
		latencyMs: 5,
		records: [],
	};
	assets.save({ ...base, platform: "fofa", query: "a.example.com" }, new Date("2026-01-01T00:00:00Z"));
	assets.save({ ...base, platform: "quake", query: "b.example.com" }, new Date("2026-01-02T00:00:00Z"));
	assets.save({ ...base, platform: "quake", query: "c.other.net" }, new Date("2026-01-03T00:00:00Z"));

	expect(assets.list("p1").items.map((item) => item.query)).toEqual(["c.other.net", "b.example.com", "a.example.com"]);
	expect(assets.list("p1", { platform: "quake" }).total).toBe(2);
	expect(assets.list("p1", { search: "EXAMPLE" }).total).toBe(2);
	expect(assets.list("p1", { platform: "quake", search: "other" }).items[0].query).toBe("c.other.net");

	const first = assets.list("p1", {}, 1, 2);
	expect(first.items).toHaveLength(2);
	expect(first.hasMore).toBe(true);
	const second = assets.list("p1", {}, 2, 2);
	expect(second.items).toHaveLength(1);
	expect(second.hasMore).toBe(false);
});

test("rows are scoped to their project and purged with it", () => {
	const assets = freshStore();
	const base = {
		platform: "hunter" as const,
		page: 1,
		size: 20,
		total: 1,
		count: 1,
		ok: true,
		latencyMs: 5,
		records: [],
	};
	assets.save({ ...base, projectId: "p1", query: "one" });
	assets.save({ ...base, projectId: "p2", query: "two" });
	assets.save({ ...base, projectId: "p1", query: "three" });
	expect(assets.countProject("p1")).toBe(2);
	expect(assets.list("p2").items.map((item) => item.query)).toEqual(["two"]);
	expect(assets.purgeProject("p1")).toBe(2);
	expect(assets.countProject("p1")).toBe(0);
	expect(assets.list("p1").total).toBe(0);
	// The other project is untouched.
	expect(assets.list("p2").total).toBe(1);
});

test("a corrupt record blob reads as no records rather than throwing", () => {
	const assets = freshStore();
	const saved = assets.save({
		projectId: "p1",
		platform: "fofa",
		query: "x",
		page: 1,
		size: 20,
		total: 1,
		count: 1,
		ok: true,
		latencyMs: 1,
		records: [RECORD],
	});
	// Reach into the file the same way a truncated write would.
	const raw = assets as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };
	raw.db.prepare("UPDATE asset_queries SET records = ? WHERE id = ?").run("{ truncated", saved.id);
	expect(assets.get(saved.id)?.records).toEqual([]);
});
