/**
 * The supervisor model call must survive two common OpenAI-compatible quirks:
 * an answer that arrived only in reasoning_content, and a reasoning model that
 * spent the whole completion budget and returned content: "" with
 * finish_reason=length.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { callSupervisorModel } from "../src/supervisor.ts";

const CONFIG = { baseUrl: "http://supervisor/v1", apiKey: "", modelId: "supervisor-model" };

function response(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as Response;
}

function completion(message: Record<string, unknown>, finishReason: string) {
	return {
		choices: [{ message, finish_reason: finishReason }],
		usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("callSupervisorModel", () => {
	test("uses reasoning_content when content is empty", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response(completion({ content: "", reasoning_content: '{"phase":"enum"}' }, "stop"))),
		);
		const reply = await callSupervisorModel(CONFIG, "input", new AbortController().signal);
		expect(reply.raw).toBe('{"phase":"enum"}');
	});

	test("retries once with a larger budget when finish_reason is length", async () => {
		const calls: Array<{ max_tokens: number }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: { body: string }) => {
				const body = JSON.parse(init.body) as { max_tokens: number };
				calls.push(body);
				return calls.length === 1
					? response(completion({ content: "" }, "length"))
					: response(completion({ content: '{"phase":"recon"}' }, "stop"));
			}),
		);
		const reply = await callSupervisorModel(CONFIG, "input", new AbortController().signal);
		expect(reply.raw).toBe('{"phase":"recon"}');
		expect(calls.map((call) => call.max_tokens)).toEqual([8192, 16384]);
	});

	test("reports finish_reason and token counts instead of a bare empty error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response(completion({ content: "" }, "content_filter"))),
		);
		await expect(callSupervisorModel(CONFIG, "input", new AbortController().signal)).rejects.toThrow(
			/finish_reason=content_filter.*completion_tokens=20/,
		);
	});
});
