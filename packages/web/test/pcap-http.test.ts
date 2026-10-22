/** Pairing plaintext HTTP packets from `tshark -T json` into capture entries. */

import { expect, test } from "vitest";
import { parseTsharkHttpJson } from "../src/pcap-http.ts";

function packet(frame: number, stream: number, http: Record<string, unknown>): unknown {
	return {
		_source: {
			layers: {
				"frame.number": [String(frame)],
				"tcp.stream": [String(stream)],
				...http,
			},
		},
	};
}

const CAPTURE = [
	packet(1, 0, {
		"http.request.method": ["GET"],
		"http.host": ["api.example.com"],
		"http.request.uri": ["/v1/users?id=7"],
		"http.request.line": [
			"GET /v1/users?id=7 HTTP/1.1\r\n",
			"Host: api.example.com\r\n",
			"Authorization: Bearer a\r\n",
		],
	}),
	packet(2, 0, {
		"http.response.code": ["200"],
		"http.response.line": ["HTTP/1.1 200 OK\r\n", "Content-Type: application/json\r\n"],
		"http.file_data": ['{"id":7,"name":"demo"}'],
	}),
	packet(3, 0, {
		"http.request.method": ["POST"],
		"http.host": ["api.example.com"],
		"http.request.full_uri": ["https://api.example.com/v1/order"],
		"http.request.line": ["POST /v1/order HTTP/1.1\r\n", "Content-Type: application/json\r\n"],
		"http.file_data": ['{"orderId":9}'],
	}),
	packet(4, 0, {
		"http.response.code": ["403"],
		"http.response.line": ["HTTP/1.1 403 Forbidden\r\n"],
		"http.file_data": ['{"code":403}'],
	}),
	packet(5, 1, {
		"http.request.method": ["GET"],
		"http.host": ["static.example.com"],
		"http.request.uri": ["/app.js"],
	}),
];

test("pairs keep-alive requests and responses on the same stream", () => {
	const entries = parseTsharkHttpJson(JSON.stringify(CAPTURE));
	expect(entries).toHaveLength(3);
	expect(entries[0]).toMatchObject({
		method: "GET",
		url: "http://api.example.com/v1/users?id=7",
		status: 200,
		requestBody: "",
		responseBody: '{"id":7,"name":"demo"}',
	});
	expect(entries[0]?.requestHeaders).toContain("Authorization: Bearer a");
	expect(entries[1]).toMatchObject({
		method: "POST",
		url: "https://api.example.com/v1/order",
		status: 403,
		requestBody: '{"orderId":9}',
		responseBody: '{"code":403}',
	});
	// No response captured: still evidence, status stays unknown.
	expect(entries[2]).toMatchObject({ method: "GET", status: null, url: "http://static.example.com/app.js" });
});

test("ignores packets without HTTP fields and malformed JSON", () => {
	expect(parseTsharkHttpJson(JSON.stringify([{ _source: { layers: { "frame.number": ["1"] } } }]))).toEqual([]);
	expect(parseTsharkHttpJson("not json")).toEqual([]);
	expect(parseTsharkHttpJson("{}")).toEqual([]);
});

test("caps a huge body instead of copying megabytes into the store", () => {
	const huge = "x".repeat(300_000);
	const entries = parseTsharkHttpJson(
		JSON.stringify([
			packet(1, 0, {
				"http.request.method": ["POST"],
				"http.host": ["api.example.com"],
				"http.request.uri": ["/upload"],
				"http.file_data": [huge],
			}),
		]),
	);
	expect(entries[0]?.requestBody.length).toBe(256 * 1024);
});

test("reads tshark's nested protocol objects and decodes hex bodies", () => {
	const nested = [
		{
			_source: {
				layers: {
					frame: { "frame.number": "10" },
					tcp: { "tcp.stream": "3" },
					http: {
						"http.request.method": "GET",
						"http.host": "api.example.com",
						"http.request.uri": "/v1/ping",
						"http.request.full_uri": "http://api.example.com/v1/ping",
						"http.request.line": ["Host: api.example.com\r\n", "Accept: */*\r\n"],
					},
				},
			},
		},
		{
			_source: {
				layers: {
					frame: { "frame.number": "11" },
					tcp: { "tcp.stream": "3" },
					http: {
						"HTTP/1.1 200 OK\r\n": { "http.response.code": "200" },
						"http.response.line": ["Content-Type: text/plain\r\n"],
						"http.file_data": "68:65:6c:6c:6f",
					},
				},
			},
		},
	];
	const entries = parseTsharkHttpJson(JSON.stringify(nested));
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({
		method: "GET",
		url: "http://api.example.com/v1/ping",
		status: 200,
		responseBody: "hello",
	});
	expect(entries[0]?.responseHeaders).toContain("Content-Type: text/plain");
});
