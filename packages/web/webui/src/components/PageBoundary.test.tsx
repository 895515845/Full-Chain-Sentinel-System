/**
 * The page-level error boundary.
 *
 * Server-side rendering cannot trigger a boundary (React only catches render
 * errors in the browser), so the two pieces are tested directly: the pure
 * mapping from a thrown value to the message the card shows, and the card
 * itself, which is what an operator actually reads.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PageBoundary, PageErrorCard } from "./PageBoundary.tsx";

test("a thrown value becomes the message on the card", () => {
	expect(PageBoundary.getDerivedStateFromError(new TypeError("x is not a function"))).toEqual({
		message: "TypeError: x is not a function",
	});
	// Anything can be thrown, including a string; it still has to be readable.
	expect(PageBoundary.getDerivedStateFromError("boom")).toEqual({ message: "boom" });
});

test("the card names the page, shows the error and offers a way out", () => {
	const html = renderToStaticMarkup(
		createElement(PageErrorCard, {
			message: "TypeError: cannot read properties of undefined (reading 'state')",
			onRetry: () => {},
			onHome: () => {},
		}),
	);
	expect(html).toContain("这个页面出错了");
	expect(html).toContain("TypeError: cannot read properties of undefined (reading &#x27;state&#x27;)");
	expect(html).toContain("重试");
	expect(html).toContain("回到工作台");
});

test("children render untouched while nothing has thrown", () => {
	const html = renderToStaticMarkup(
		createElement(PageBoundary, {
			children: createElement("span", null, "内容正常"),
		}),
	);
	expect(html).toContain("内容正常");
	expect(html).not.toContain("这个页面出错了");
});
