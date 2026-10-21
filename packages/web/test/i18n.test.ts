import { expect, test } from "vitest";
import { interpolate, translate } from "../src/i18n-messages.ts";

test("Chinese passes through and English uses the shared dictionary", () => {
	expect(translate("zh", "保存")).toBe("保存");
	expect(translate("en", "保存")).toBe("Save");
	// A missing translation falls back to the source instead of showing a key.
	expect(translate("en", "还没有翻译的句子")).toBe("还没有翻译的句子");
});

test("placeholders survive translation and are filled by name", () => {
	expect(interpolate("已选择 {count} 项", { count: 3 })).toBe("已选择 3 项");
	expect(interpolate("已选择 {count} 项")).toBe("已选择 {count} 项");
	expect(translate("en", "工程进度快照：{name}", { name: "alpha" })).toContain("alpha");
});
