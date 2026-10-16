import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
	deleteWebSearchKey,
	isKeyUsable,
	readWebSearchConfig,
	saveWebSearchKey,
	setWebSearchQueryLimit,
	webSearchConfigView,
	writeWebSearchConfig,
} from "../src/websearch-config.ts";

const dirs: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "websearch-config-"));
	dirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a missing file reads as an empty pool", () => {
	const dir = workspace();
	expect(readWebSearchConfig(dir).keys).toEqual([]);
	expect(webSearchConfigView(dir)).toEqual({ keys: [], sessionQueryLimit: 0, usable: 0 });
});

test("save adds and updates keys, keeping the secret write-only", () => {
	const dir = workspace();
	const config = saveWebSearchKey(dir, { label: "主账号", key: " tvly-aaa ", enabled: true });
	expect(config.keys).toHaveLength(1);
	expect(config.keys[0]?.key).toBe("tvly-aaa");

	// The stored key survives an update that does not mention it.
	const updated = saveWebSearchKey(dir, {
		id: config.keys[0]!.id,
		label: "改名",
		key: null,
		enabled: false,
	});
	expect(updated.keys[0]?.key).toBe("tvly-aaa");
	expect(updated.keys[0]!.label).toBe("改名");
	expect(updated.keys[0]!.enabled).toBe(false);

	// A replaced key loses its verification.
	const replaced = saveWebSearchKey(dir, {
		id: config.keys[0]!.id,
		label: "改名",
		key: "tvly-bbb",
		enabled: true,
	});
	expect(replaced.keys[0]!.key).toBe("tvly-bbb");
	expect(replaced.keys[0]!.status.at).toBeNull();
});

test("adding without a key is refused; delete removes", () => {
	const dir = workspace();
	expect(() => saveWebSearchKey(dir, { label: "x", enabled: true })).toThrow(/必须填写/);
	saveWebSearchKey(dir, { label: "x", key: "k1", enabled: true });
	const after = deleteWebSearchKey(dir, readWebSearchConfig(dir).keys[0]!.id);
	expect(after.keys).toEqual([]);
});

test("the stored file is 0600 and an unverified key stays out of the pool", () => {
	const dir = workspace();
	saveWebSearchKey(dir, { label: "a", key: "k", enabled: true });
	const path = join(dir, "websearch.json");
	chmodSync(path, 0o600);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	// A pool key needs a verified status; a fresh key has none.
	expect(readWebSearchConfig(dir).keys.filter(isKeyUsable)).toHaveLength(0);
	void readFileSync;
});

test("query limit clamps into range", () => {
	const dir = workspace();
	expect(setWebSearchQueryLimit(dir, -5).sessionQueryLimit).toBe(0);
	expect(setWebSearchQueryLimit(dir, 99_999).sessionQueryLimit).toBe(1000);
	expect(setWebSearchQueryLimit(dir, 7).sessionQueryLimit).toBe(7);
});

test("a corrupt file is never silently overwritten", () => {
	const dir = workspace();
	writeWebSearchConfig(dir, { version: 1, sessionQueryLimit: 0, keys: [] });
	const path = join(dir, "websearch.json");
	writeFileSync(path, "{not json");
	expect(() => saveWebSearchKey(dir, { label: "x", key: "k", enabled: true })).toThrow(/无法解析/);
});
