import { expect, test } from "vitest";
import { extractWeb, probeTavilyKey, searchWeb, usageRemaining, type WebFetch } from "../src/websearch.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch stub that records requests and answers from a queue. */
function stubFetch(
	responses: Array<{ status: number; body: unknown }>,
	calls: Array<{ url: string; init?: RequestInit }> = [],
): WebFetch {
	let index = 0;
	return async (url, init) => {
		calls.push({ url, init });
		const next = responses[Math.min(index, responses.length - 1)]!;
		index++;
		return jsonResponse(next.body, next.status);
	};
}

test("searchWeb posts the query with bearer auth and normalizes hits", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl = stubFetch(
		[
			{
				status: 200,
				body: {
					query: "example",
					answer: "an answer",
					results: [
						{ title: "t", url: "https://a.example/", content: "c", score: 0.9, published_date: "2025-01-01" },
					],
				},
			},
		],
		calls,
	);
	const result = await searchWeb({ key: "k", keyId: "main", query: "example", fetchImpl });
	expect(calls[0]?.init?.method).toBe("POST");
	const headers = calls[0]?.init?.headers as Record<string, string>;
	expect(headers.authorization).toBe("Bearer k");
	expect(result.results).toHaveLength(1);
	expect(result.results[0]?.url).toBe("https://a.example/");
	expect(result.answer).toBe("an answer");
	expect(result.keyId).toBe("main");
});

test("searchWeb clamps max_results and passes domain filters", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	await searchWeb({
		key: "k",
		keyId: "x",
		query: "q",
		maxResults: 99,
		includeDomains: [" example.com "],
		fetchImpl: stubFetch([{ status: 200, body: { results: [] } }], calls),
	});
	const body = JSON.parse(String(calls[0]?.init?.body)) as { max_results: number; include_domains: string[] };
	expect(body.max_results).toBe(20);
	expect(body.include_domains).toEqual(["example.com"]);
});

test("searchWeb maps quota codes to retryable errors", async () => {
	for (const [status, retryable] of [
		[401, false],
		[429, true],
		[432, true],
		[433, true],
		[500, true],
	] as const) {
		let message = "";
		try {
			await searchWeb({ key: "k", keyId: "x", query: "q", fetchImpl: stubFetch([{ status, body: {} }]) });
		} catch (error) {
			message = `${(error as Error).message}:${(error as { retryable?: boolean }).retryable}`;
		}
		expect(message).toContain(`:${retryable}`);
	}
});

test("extractWeb keeps successes and failures apart and drops non-http urls", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl = stubFetch(
		[
			{
				status: 200,
				body: {
					results: [{ url: "https://a.example/", raw_content: "text" }],
					failed_results: [{ url: "https://b.example/", error: "timeout" }],
				},
			},
		],
		calls,
	);
	const result = await extractWeb({ key: "k", keyId: "x", urls: ["https://a.example/", "ftp://nope"], fetchImpl });
	expect(result.pages).toHaveLength(1);
	expect(result.pages[0]?.content).toBe("text");
	expect(result.failed[0]?.error).toBe("timeout");
	const body = JSON.parse(String(calls[0]?.init?.body)) as { urls: string[] };
	expect(body.urls).toEqual(["https://a.example/"]);
});

test("usageRemaining takes the tighter of key and plan caps", () => {
	expect(usageRemaining({ plan: "p", keyUsed: 10, keyLimit: 100, planUsed: 990, planLimit: 1000 })).toBe(10);
	expect(usageRemaining({ plan: "p", keyUsed: 10, keyLimit: 100, planUsed: 5, planLimit: 1000 })).toBe(90);
	// Null caps read as unlimited on that side.
	expect(usageRemaining({ plan: "p", keyUsed: 0, keyLimit: null, planUsed: 9, planLimit: 10 })).toBe(1);
	expect(usageRemaining({ plan: "p", keyUsed: 0, keyLimit: null, planUsed: 0, planLimit: null })).toBeNull();
});

test("probeTavilyKey reports plan and remaining credits", async () => {
	const probe = await probeTavilyKey({
		key: "k",
		fetchImpl: stubFetch([
			{
				status: 200,
				body: {
					key: { usage: 3, limit: null },
					account: { current_plan: "Researcher", plan_usage: 3, plan_limit: 1000 },
				},
			},
		]),
	});
	expect(probe.ok).toBe(true);
	expect(probe.message).toContain("Researcher");
	expect(probe.message).toContain("剩余 997");
});
