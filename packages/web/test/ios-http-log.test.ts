/** Parsing the SENTINEL_HTTP lines the ios_http_log frida script emits. */

import { expect, test } from "vitest";
import { resolveIosBuiltinScript } from "../src/frida-scripts-ios.ts";
import { parseHttpLogOutput, toHttpEntryInputs } from "../src/ios-http-log.ts";

test("the ios_http_log builtin is valid JavaScript and emits the marker", () => {
	const resolved = resolveIosBuiltinScript("ios_http_log");
	expect("source" in resolved).toBe(true);
	if (!("source" in resolved)) return;
	expect(() => new Function(resolved.source)).not.toThrow();
	expect(resolved.source).toContain("SENTINEL_HTTP");
	expect(resolved.source).toContain("dataTaskWithRequest:completionHandler:");
});

function line(payload: Record<string, unknown>): string {
	return `SENTINEL_HTTP ${JSON.stringify(payload)}`;
}

test("joins a request with its response by id", () => {
	const output = [
		"[http] hooked - dataTaskWithRequest:completionHandler:",
		line({
			kind: "request",
			id: 1,
			method: "POST",
			url: "https://api.example.com/v1/login",
			headers: { "Content-Type": "application/json", "X-Trace": "abc" },
			bodyText: '{"user":"demo"}',
			bodyB64: "",
			bodySize: 15,
		}),
		line({
			kind: "response",
			id: 1,
			status: 200,
			headers: { "Content-Type": "application/json" },
			bodyText: '{"token":"t"}',
			bodyB64: "",
			bodySize: 13,
		}),
	].join("\n");
	const records = parseHttpLogOutput(output);
	expect(records).toHaveLength(1);
	expect(records[0]).toMatchObject({
		id: 1,
		method: "POST",
		url: "https://api.example.com/v1/login",
		status: 200,
		requestBody: '{"user":"demo"}',
		responseBody: '{"token":"t"}',
	});
	expect(records[0]?.requestHeaders).toContain("Content-Type: application/json");
	expect(records[0]?.requestHeaders).toContain("X-Trace: abc");
});

test("keeps a request that never got a response", () => {
	const records = parseHttpLogOutput(
		line({ kind: "request", id: 4, method: "GET", url: "https://api.example.com/v1/ping", headers: {} }),
	);
	expect(records).toEqual([
		{
			id: 4,
			method: "GET",
			url: "https://api.example.com/v1/ping",
			status: null,
			requestHeaders: "",
			requestBody: "",
			responseHeaders: "",
			responseBody: "",
		},
	]);
});

test("binary bodies stay lossless as base64", () => {
	const binary = Buffer.from([0x00, 0xff, 0x10, 0x80]).toString("base64");
	const records = parseHttpLogOutput(
		line({
			kind: "request",
			id: 2,
			method: "POST",
			url: "https://api.example.com/upload",
			headers: {},
			bodyB64: binary,
			bodySize: 4,
		}),
	);
	expect(records[0]?.requestBody).toBe(`base64:${binary}`);
});

test("a lossy text decode falls back to base64", () => {
	const binary = Buffer.from([0xff, 0xfe, 0x00]).toString("base64");
	const records = parseHttpLogOutput(
		line({
			kind: "request",
			id: 3,
			method: "POST",
			url: "https://api.example.com/upload",
			headers: {},
			bodyText: "��\u0000",
			bodyB64: binary,
			bodySize: 3,
		}),
	);
	expect(records[0]?.requestBody).toBe(`base64:${binary}`);
});

test("ignores non-JSON and strips ANSI color codes", () => {
	const output = `\u001b[32m${line({ kind: "request", id: 1, method: "GET", url: "https://x.test/a" })}\u001b[0m\nSENTINEL_HTTP not-json`;
	const records = parseHttpLogOutput(output);
	expect(records).toHaveLength(1);
	expect(records[0]?.url).toBe("https://x.test/a");
});

test("toHttpEntryInputs drops the local id", () => {
	const [entry] = toHttpEntryInputs([
		{
			id: 9,
			method: "GET",
			url: "https://x.test/a",
			status: null,
			requestHeaders: "",
			requestBody: "",
			responseHeaders: "",
			responseBody: "",
		},
	]);
	expect(entry).not.toHaveProperty("id");
	expect(entry?.url).toBe("https://x.test/a");
});
