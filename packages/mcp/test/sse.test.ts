import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	isJsonRpcRequest,
	type JsonRpcMessage,
	McpAuthRequiredError,
	McpClient,
	McpConnectionClosedError,
	McpHttpError,
	SseTransport,
} from "../src/index.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

interface RecordedRequest {
	method: string;
	url: string;
	headers: IncomingMessage["headers"];
	body?: string;
}

/** An SSE response that stays open, so the server can keep writing to it. */
interface SseStream {
	response: ServerResponse;
	send(event: string, data: string): void;
	end(): void;
}

function startSse(response: ServerResponse): SseStream {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	return {
		response,
		send(event, data) {
			// One event per write, so the client's parser sees the same framing a real server sends.
			response.write(`event: ${event}\ndata: ${data}\n\n`);
		},
		end() {
			response.end();
		},
	};
}

/**
 * A minimal legacy HTTP+SSE server: `GET /sse` opens the stream and names the POST
 * endpoint, `POST /message` answers 202, and replies come back on the stream.
 */
async function startServer(
	options: { endpoint?: string; onMessage?: (message: JsonRpcMessage, stream: SseStream) => void } = {},
): Promise<{ url: string; requests: RecordedRequest[]; streams: SseStream[] }> {
	const requests: RecordedRequest[] = [];
	const streams: SseStream[] = [];
	const origin = await listen(async (request, response) => {
		const url = request.url ?? "/";
		if (request.method === "GET" && url === "/sse") {
			requests.push({ method: "GET", url, headers: request.headers });
			const stream = startSse(response);
			streams.push(stream);
			stream.send("endpoint", options.endpoint ?? `${origin}/message?sessionId=abc`);
			return;
		}
		if (request.method === "POST") {
			const body = await readBody(request);
			requests.push({ method: "POST", url, headers: request.headers, body });
			response.writeHead(202).end();
			const message = JSON.parse(body) as JsonRpcMessage;
			options.onMessage?.(message, streams[streams.length - 1]);
			return;
		}
		response.writeHead(404).end();
	});
	return { url: `${origin}/sse`, requests, streams };
}

/** Answer `initialize` and `tools/list` like a real server, so a client can connect. */
function answerProtocol(message: JsonRpcMessage, stream: SseStream): void {
	// Requests carry an id; notifications do not, and a real server answers only the former.
	if (!isJsonRpcRequest(message)) return;
	const result =
		message.method === "initialize"
			? {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "fake-sse", version: "1.0.0" },
				}
			: message.method === "tools/list"
				? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
				: {};
	stream.send("message", JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}

afterEach(closeServers);

describe("SseTransport", () => {
	it("takes the message endpoint from the first endpoint event", async () => {
		const { url, requests } = await startServer();
		const transport = new SseTransport({ url });
		await transport.start();
		expect(transport.endpoint?.href).toBe(`${new URL(url).origin}/message?sessionId=abc`);
		expect(requests[0].headers.accept).toBe("text/event-stream");
		await transport.close();
	});

	it("resolves a relative endpoint against the stream URL", async () => {
		const { url } = await startServer({ endpoint: "/message?sessionId=relative" });
		const transport = new SseTransport({ url });
		await transport.start();
		expect(transport.endpoint?.href).toBe(`${new URL(url).origin}/message?sessionId=relative`);
		await transport.close();
	});

	it("POSTs to the named endpoint and delivers the reply from the stream", async () => {
		const { url, requests } = await startServer({ onMessage: answerProtocol });
		const transport = new SseTransport({ url });
		const received: JsonRpcMessage[] = [];
		transport.onMessage((message) => received.push(message));
		await transport.start();
		await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
		await expect.poll(() => received.length).toBe(1);
		expect(received[0]).toMatchObject({ id: 1, result: {} });
		const post = requests.find((request) => request.method === "POST");
		expect(post?.url).toBe("/message?sessionId=abc");
		expect(post?.headers["content-type"]).toBe("application/json");
		expect(JSON.parse(post?.body ?? "{}")).toMatchObject({ method: "ping" });
		await transport.close();
	});

	it("rejects an empty endpoint event rather than POSTing to the stream URL", async () => {
		const { url } = await startServer({ endpoint: "" });
		const transport = new SseTransport({ url });
		await expect(transport.start()).rejects.toThrow(/empty message endpoint/);
		await transport.close();
	});

	it("fails start() when the stream never names an endpoint", async () => {
		const origin = await listen(async (request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			// Open and silent: nothing follows, which is what the connect timeout is for.
			request.on("close", () => response.end());
		});
		const transport = new SseTransport({ url: `${origin}/sse`, connectTimeoutMs: 50 });
		await expect(transport.start()).rejects.toThrow(/did not name a message endpoint/);
		await transport.close();
	});

	it("fails start() at once when the connection is refused", async () => {
		// A port that was just bound and released: connections are refused immediately, unlike a
		// filtered port, which would hang until the connect timeout.
		const probe = createServer(() => {});
		await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const { port } = probe.address() as AddressInfo;
		await new Promise<void>((resolve) => probe.close(() => resolve()));

		const transport = new SseTransport({ url: `http://127.0.0.1:${port}/sse` });
		const startedAt = Date.now();
		await expect(transport.start()).rejects.toThrow();
		// The reconnect backoff belongs to a stream that was up, not to the connect itself.
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		await transport.close();
	});

	it("rejects a non-http endpoint instead of following it", async () => {
		const { url } = await startServer({ endpoint: "file:///etc/passwd" });
		const transport = new SseTransport({ url });
		await expect(transport.start()).rejects.toThrow(/must be http or https/);
		await transport.close();
	});

	it("reports a 401 as McpAuthRequiredError", async () => {
		const origin = await listen(async (_request, response) => {
			response.writeHead(401, { "www-authenticate": 'Bearer realm="mcp"' }).end("no token");
		});
		const transport = new SseTransport({ url: `${origin}/sse` });
		await expect(transport.start()).rejects.toBeInstanceOf(McpAuthRequiredError);
		await transport.close();
	});

	it("rejects a response that is not an event stream", async () => {
		const origin = await listen(async (_request, response) => {
			response.writeHead(200, { "content-type": "application/json" }).end("{}");
		});
		const transport = new SseTransport({ url: `${origin}/sse` });
		await expect(transport.start()).rejects.toBeInstanceOf(McpHttpError);
		await transport.close();
	});

	it("reopens the stream after a drop and takes the new endpoint", async () => {
		let closed = 0;
		const origin = await listen(async (request, response) => {
			if (request.method === "GET") {
				const stream = startSse(response);
				stream.send("endpoint", `${origin}/message?sessionId=${closed}`);
				// Drop the first stream, so the transport has to reconnect.
				if (closed++ === 0) setTimeout(() => stream.end(), 10);
				return;
			}
			response.writeHead(202).end();
		});
		const transport = new SseTransport({
			url: `${origin}/sse`,
			reconnect: { initialDelayMs: 5, maxRetries: 3 },
		});
		await transport.start();
		expect(transport.endpoint?.search).toBe("?sessionId=0");
		await expect.poll(() => transport.endpoint?.search, { timeout: 2000 }).toBe("?sessionId=1");
		await transport.close();
	});

	it("reuses the auth provider token and retries once after a challenge", async () => {
		const seen: (string | undefined)[] = [];
		let challenged = false;
		const origin = await listen(async (request, response) => {
			const token = request.headers.authorization;
			seen.push(token);
			if (token !== "Bearer fresh") {
				challenged = true;
				response.writeHead(401, { "www-authenticate": 'Bearer realm="mcp"' }).end();
				return;
			}
			const stream = startSse(response);
			stream.send("endpoint", `${origin}/message`);
		});
		const transport = new SseTransport({
			url: `${origin}/sse`,
			authProvider: {
				token: async () => "stale",
				onUnauthorized: async () => {},
			},
		});
		// The provider keeps returning the stale token, so the retry is still rejected: what matters
		// is that the challenge was handed over exactly once and the request was retried.
		await expect(transport.start()).rejects.toBeInstanceOf(McpAuthRequiredError);
		expect(challenged).toBe(true);
		expect(seen).toEqual(["Bearer stale", "Bearer stale"]);
		await transport.close();
	});

	it("closes a connected client when the transport is closed", async () => {
		const { url } = await startServer({ onMessage: answerProtocol });
		const transport = new SseTransport({ url });
		const client = new McpClient({ name: "test", version: "1.0.0" });
		await client.connect(transport);
		expect(client.connectionState).toBe("connected");
		expect(client.serverCapabilities?.tools).toBeDefined();
		await transport.close();
		await expect.poll(() => client.connectionState).toBe("closed");
		await expect(transport.send({ jsonrpc: "2.0", method: "ping" })).rejects.toBeInstanceOf(McpConnectionClosedError);
	});

	it("reads a reply a server puts in the POST body instead of the stream", async () => {
		const origin = await listen(async (request, response) => {
			if (request.method === "GET") {
				startSse(response).send("endpoint", `${origin}/message`);
				return;
			}
			const body = JSON.parse(await readBody(request)) as JsonRpcMessage;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ jsonrpc: "2.0", id: "id" in body ? body.id : undefined, result: { inline: true } }),
			);
		});
		const transport = new SseTransport({ url: `${origin}/sse` });
		const received: JsonRpcMessage[] = [];
		transport.onMessage((message) => received.push(message));
		await transport.start();
		await transport.send({ jsonrpc: "2.0", id: 7, method: "ping" });
		expect(received[0]).toMatchObject({ id: 7, result: { inline: true } });
		await transport.close();
	});
});
