/**
 * Render smoke test for the loop-guard notice rows.
 *
 * The guard injects its reminders as `custom_message` entries, and the console
 * decides what to show from the message's `customType` plus the marker at the
 * start of its content. Getting either wrong renders nothing at all, which is a
 * silent failure: the model was interrupted and the operator sees no reason why.
 *
 * It lives next to the component rather than in `test/`: the root TypeScript
 * project has no JSX, so only the webui project can type-check a file that
 * imports a `.tsx` module.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { AgentMessageView } from "../types.ts";
import { MessageView } from "./MessageView.tsx";

function custom(customType: string, content: string): AgentMessageView {
	return { role: "custom", customType, content, timestamp: 1_700_000_000_000 };
}

test("a stutter notice folds under its own label", () => {
	const html = renderToStaticMarkup(
		createElement(MessageView, {
			message: custom("zg-loop-guard", "【输出重复】上一次输出陷入了重复（同一行连续出现 6 次），已被提前中止。"),
		}),
	);
	expect(html).toContain("输出重复已中止");
	expect(html).toContain("loop-guard-stutter");
	expect(html).toContain("【输出重复】");
});

test("a repeated tool call folds under the reminder label", () => {
	const html = renderToStaticMarkup(
		createElement(MessageView, {
			message: custom("zg-loop-guard", "【重复工具调用】同一个工具调用（bash）已经连续重复 3 次，参数完全一样。"),
		}),
	);
	expect(html).toContain("重复工具调用提醒");
	expect(html).toContain("loop-guard-repeat");
});

test("an unknown custom message still renders nothing", () => {
	const html = renderToStaticMarkup(createElement(MessageView, { message: custom("sentinel-unknown", "不应该出现的内容") }));
	expect(html).toBe("");
});

/**
 * A settled run folds a thinking block into one StepRow with a three-line
 * preview. The row's 「还有 N 行」 button used to be a dead end: the row called
 * `onFullscreen` but the thinking branches never forwarded it, so the click
 * landed nowhere. The button's tooltip names its destination, which makes the
 * forwarding visible to a static render.
 */
function thinkingOnly(text: string): AgentMessageView {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: text }],
		timestamp: 1_700_000_000_000,
	};
}

const LONG_THINKING = Array.from({ length: 9 }, (_, index) => `第 ${index + 1} 行推理`).join("\n");

test("a thinking row's 查看全部 opens the shared viewer", () => {
	const html = renderToStaticMarkup(
		createElement(MessageView, {
			message: thinkingOnly(LONG_THINKING),
			compact: true,
			onFullscreen: () => {},
		}),
	);
	// React separates adjacent text nodes with comment markers in SSR output,
	// so the count is matched loosely rather than as one literal string.
	expect(html).toMatch(/还有[\s\S]*?行，点击查看全部/);
	expect(html).toContain("在查看器中打开全部内容");
});

test("a thinking row without a viewer expands in place instead of doing nothing", () => {
	const html = renderToStaticMarkup(
		createElement(MessageView, { message: thinkingOnly(LONG_THINKING), compact: true }),
	);
	expect(html).toContain("就地展开全部内容");
});
