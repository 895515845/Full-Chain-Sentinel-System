import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readUiConfig, uiConfigPath, writeUiConfig } from "../src/ui-config.ts";

function root(): string {
	return mkdtempSync(join(tmpdir(), "sentinel-ui-config-"));
}

test("the console defaults to Chinese when no preference exists", () => {
	expect(readUiConfig(root())).toEqual({ language: "zh" });
});

test("the selected language is persisted and read back", () => {
	const dir = root();
	writeUiConfig(dir, { language: "en" });
	expect(readUiConfig(dir)).toEqual({ language: "en" });
	expect(JSON.parse(readFileSync(uiConfigPath(dir), "utf8"))).toEqual({ language: "en" });
});

test("invalid or damaged preferences fall back to Chinese", () => {
	const dir = root();
	writeFileSync(uiConfigPath(dir), JSON.stringify({ language: "fr" }));
	expect(readUiConfig(dir)).toEqual({ language: "zh" });
	writeFileSync(uiConfigPath(dir), "{ not json");
	expect(readUiConfig(dir)).toEqual({ language: "zh" });
});
