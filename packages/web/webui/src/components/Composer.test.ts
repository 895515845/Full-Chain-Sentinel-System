/**
 * The composer's idle hint.
 *
 * A preset agent may bring its own line for the input box — that is how an
 * operator says what this agent expects to be asked — and the box must never end
 * up looking blank: no preset, an empty hint, or a preset whose body went missing
 * all keep the console's default text.
 *
 * Only the pure helper is covered here; the box itself needs a browser.
 */

import { expect, test } from "vitest";
import { composerHint, formatThroughput } from "./Composer.tsx";

const DEFAULT_HINT = "输入目标与任务，Enter 发送，Shift+Enter 换行，可粘贴截图或拖入文件";

test("a preset with a hint replaces the default text", () => {
	expect(composerHint({ id: "web", name: "Web 侦察", missing: false, placeholder: "说说这次要看的目标" })).toBe(
		"说说这次要看的目标",
	);
});

test("no preset, a blank hint, or a missing preset keeps the default text", () => {
	expect(composerHint(null)).toBe(DEFAULT_HINT);
	expect(composerHint({ id: "web", name: "Web 侦察", missing: false, placeholder: "   " })).toBe(DEFAULT_HINT);
	// The body file is gone, so the session runs the default agent and says so.
	expect(composerHint({ id: "web", name: "Web 侦察", missing: true, placeholder: "说说这次要看的目标" })).toBe(
		DEFAULT_HINT,
	);
});

test("throughput formatting keeps low speeds readable and hides missing values", () => {
	expect(formatThroughput(0)).toBe("—");
	expect(formatThroughput(Number.NaN)).toBe("—");
	expect(formatThroughput(3.14159)).toBe("3.14");
	expect(formatThroughput(12.34)).toBe("12.3");
	expect(formatThroughput(123.4)).toBe("123");
});
