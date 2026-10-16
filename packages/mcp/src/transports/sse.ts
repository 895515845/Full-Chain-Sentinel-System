import type { AuthProvider, McpFetch } from "../auth-provider.ts";
import { type JsonRpcMessage, McpConnectionClosedError, parseJsonRpcMessage, toError } from "../protocol/jsonrpc.ts";
import { consumeSseStream, McpAuthRequiredError, McpHttpError, type SseEvent } from "./streamable-http.ts";
import { DEFAULT_MAX_MESSAGE_BYTES, type McpTransport, TransportEvents } from "./transport.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_MAX_RETRIES = 5;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const ERROR_MESSAGE_BODY_CHARS = 500;

export interface SseReconnectOptions {
	/** Delay before the first reconnection attempt. Default: 1000. */
	initialDelayMs?: number;
	/** Upper bound for the exponential backoff. Default: 30000. */
	maxDelayMs?: number;
	/** Consecutive failed attempts before giving up on the stream. Default: 5. */
	maxRetries?: number;
}

export interface SseTransportOptions {
	url: string | URL;
	headers?: Record<string, string>;
	fetch?: McpFetch;
	maxMessageBytes?: number;
	authProvider?: AuthProvider;
	/**
	 * How long the server gets to open the stream and name its message endpoint. Without it a server
	 * that accepts the connection and then says nothing would hold `start()` forever. Default: 15000.
	 */
	connectTimeoutMs?: number;
	/** Reconnection of a dropped stream. */
	reconnect?: SseReconnectOptions;
}

/**
 * The MCP 2024-11-05 HTTP+SSE transport, which the current spec replaced with streamable HTTP.
 *
 * The shape differs from streamable HTTP in two ways that the whole class follows from. The client
 * opens one long-lived `GET` stream and reads everything the server says there, so `send()` never
 * waits for an answer. And the URL to POST to is not the URL passed in: the server names it in the
 * first `endpoint` event, which may be relative and may carry a session query parameter.
 *
 *   GET  /sse                  -> 200 text/event-stream
 *   <-- event: endpoint
 *       data: /message?sessionId=abc
 *   POST /message?sessionId=abc  (initialize, ...)
 *   <-- event: message
 *       data: {"jsonrpc":"2.0","id":1,...}
 *
 * Kept in this package rather than beside the console that uses it so the CLI, the `/mcp` manager,
 * OAuth, and the connect-retry logic all reach it through the same `createDefaultTransport`.
 */
export class SseTransport extends TransportEvents implements McpTransport {
	readonly url: URL;
	readonly options: Readonly<SseTransportOptions>;
	private fetch: McpFetch;
	private controller = new AbortController();
	private started = false;
	private closed = false;
	private endpointValue: URL | undefined;
	/** Settles `start()`: resolved by the first `endpoint` event, rejected by a failure before it. */
	private pending: { resolve: () => void; reject: (error: Error) => void } | undefined;

	constructor(options: SseTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
		this.url = new URL(options.url);
		const fetch = options.fetch ?? globalThis.fetch;
		// Called without a receiver: `this.fetch(...)` would pass the transport as `this`, which
		// Cloudflare Workers reject for the platform fetch ("Illegal invocation").
		this.fetch = (input, init) => fetch(input, init);
	}

	/** Where JSON-RPC messages are POSTed, once the server has named it. */
	get endpoint(): URL | undefined {
		return this.endpointValue;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP SSE transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
		const ready = new Promise<void>((resolve, reject) => {
			this.pending = { resolve, reject };
		});
		// The stream outlives start(), so it is pumped in the background; start() only waits for the
		// endpoint, which is what makes `send()` safe to call the moment connect() returns.
		void this.pump();
		const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const timer = setTimeout(() => {
			this.fail(new Error(`MCP SSE stream did not name a message endpoint within ${timeoutMs}ms`));
		}, timeoutMs);
		try {
			await ready;
		} finally {
			clearTimeout(timer);
		}
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.started || this.closed) throw new McpConnectionClosedError();
		const endpoint = this.endpointValue;
		if (!endpoint) throw new Error("MCP SSE transport has no message endpoint yet");
		const response = await this.authorizedFetch(endpoint, "POST", {
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify(message),
		});
		await this.checkResponse(response);
		// The spec answers a POST with 202 and no body, and puts the reply on the stream. Servers that
		// answer inline are not following it, but the reply is still the client's to read: dropping it
		// would leave the request waiting for a message that never comes.
		if (contentType(response) === "application/json") {
			const text = await readBoundedText(response, this.maxMessageBytes());
			if (text.trim()) {
				try {
					this.emitMessage(parseJsonRpcMessage(JSON.parse(text)));
				} catch (error) {
					this.emitError(error);
				}
			}
			return;
		}
		await discard(response);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		// The spec ends the session when the GET stream closes, which the abort just did. There is no
		// DELETE step here: that belongs to streamable HTTP, whose session id is what it deletes.
		this.emitClose();
	}

	private maxMessageBytes(): number {
		return this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
	}

	/**
	 * Keeps one GET stream open for the transport's whole life, reopening it after a drop.
	 *
	 * A reopened stream may name a different message endpoint, so the endpoint is cleared first and
	 * taken from the next `endpoint` event. Messages the server sent while the stream was down are
	 * lost: this transport defines no resumability, and a lost reply surfaces as a request timeout.
	 */
	private async pump(): Promise<void> {
		let attempt = 0;
		while (!this.closed) {
			try {
				const stream = await this.openStream();
				attempt = 0;
				await consumeSseStream(stream, {
					maxEventBytes: this.maxMessageBytes(),
					onEvent: (event) => this.handleEvent(event),
				});
			} catch (error) {
				if (this.closed) return;
				// While the endpoint is still unknown, this is the connect, and the connect's
				// retry policy belongs to the caller: `McpServerConnection` already retries a
				// transient failure with its own short delays. Backing off here as well would
				// stack the two, turning a mistyped URL into half a minute of waiting.
				if (this.pending !== undefined || !isRetryable(error)) {
					this.fail(toError(error));
					return;
				}
			}
			if (this.closed) return;
			this.endpointValue = undefined;
			if (attempt >= this.maxRetries()) {
				this.fail(new Error("MCP SSE stream dropped and could not be reopened"));
				return;
			}
			if (!(await this.sleep(this.reconnectDelay(attempt++)))) return;
		}
	}

	/** Open the server-to-client stream. */
	private async openStream(): Promise<ReadableStream<Uint8Array>> {
		const response = await this.authorizedFetch(this.url, "GET", { headers: { accept: "text/event-stream" } });
		await this.checkResponse(response);
		const type = contentType(response);
		if (type !== "text/event-stream" || !response.body) {
			await discard(response);
			throw new McpHttpError(
				response.status,
				`MCP SSE endpoint did not return an event stream (content type: ${type ?? "missing"})`,
			);
		}
		return response.body;
	}

	private handleEvent(event: SseEvent): void {
		if (event.event === "endpoint") {
			this.setEndpoint(event.data);
			return;
		}
		// Other named events are the server's own; only unnamed or `message` events carry JSON-RPC.
		if (event.event !== undefined && event.event !== "message") return;
		if (!event.data.trim()) return;
		try {
			this.emitMessage(parseJsonRpcMessage(JSON.parse(event.data)));
		} catch (error) {
			this.emitError(error);
		}
	}

	private setEndpoint(data: string): void {
		const text = data.trim();
		// An empty payload would resolve to the stream's own URL, which is not what the server meant.
		if (!text) {
			this.fail(new Error("MCP SSE server sent an empty message endpoint"));
			return;
		}
		let url: URL;
		try {
			// Relative endpoints resolve against the stream's URL, which is how the spec's own examples
			// read, and `new URL` accepts both spellings.
			url = new URL(text, this.url);
		} catch {
			this.fail(new Error(`MCP SSE server sent an unusable message endpoint: ${text}`));
			return;
		}
		// A server does not get to pick the scheme: `file:` or `data:` here would turn every later
		// request into a local read.
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			this.fail(new Error(`MCP SSE message endpoint must be http or https, got ${url.protocol}`));
			return;
		}
		this.endpointValue = url;
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		pending.resolve();
	}

	/** Before `start()` settles a failure rejects it; afterwards it closes the transport. */
	private fail(error: Error): void {
		const pending = this.pending;
		if (pending) {
			this.pending = undefined;
			pending.reject(error);
			return;
		}
		this.emitError(error);
		this.emitClose();
	}

	/**
	 * Fetch with auth headers. A 401 (or a 403 asking for more scope) is handed to the auth provider
	 * once, and the request is retried with whatever credentials it left behind.
	 */
	private async authorizedFetch(
		url: URL,
		method: "GET" | "POST",
		init: { headers: Record<string, string>; body?: string },
	): Promise<Response> {
		const onUnauthorized = this.options.authProvider?.onUnauthorized?.bind(this.options.authProvider);
		for (let attempt = 0; ; attempt++) {
			const token = await this.options.authProvider?.token();
			const headers = new Headers(this.options.headers);
			for (const [name, value] of Object.entries(init.headers)) headers.set(name, value);
			if (token) headers.set("Authorization", `Bearer ${token}`);
			const response = await this.fetch(url, {
				method,
				headers,
				body: init.body,
				signal: this.controller.signal,
			});
			if (attempt > 0 || !onUnauthorized || !needsAuthorization(response)) return response;
			try {
				await onUnauthorized({ response, serverUrl: url, fetch: this.fetch, token });
			} finally {
				await discard(response);
			}
		}
	}

	private async checkResponse(response: Response): Promise<void> {
		if (response.ok) return;
		const body = (await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY_BYTES);
		if (response.status === 401) throw new McpAuthRequiredError(response, body);
		throw new McpHttpError(response.status, describeHttpFailure(response.status, body), body);
	}

	/** Resolves false when the transport closed while waiting. */
	private sleep(ms: number): Promise<boolean> {
		const signal = this.controller.signal;
		if (signal.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			const onAbort = () => {
				clearTimeout(timer);
				resolve(false);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve(true);
			}, ms);
			// A reconnect wait alone does not keep the process alive.
			timer.unref?.();
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private reconnectDelay(attempt: number): number {
		const initial = this.options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
		const max = this.options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
		return Math.min(initial * 2 ** attempt, max);
	}

	private maxRetries(): number {
		return this.options.reconnect?.maxRetries ?? DEFAULT_RECONNECT_MAX_RETRIES;
	}
}

function contentType(response: Response): string | undefined {
	return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

/** 401, or 403 with an `insufficient_scope` bearer challenge (step-up authorization). */
function needsAuthorization(response: Response): boolean {
	if (response.status === 401) return true;
	if (response.status !== 403) return false;
	return /(?:^|[\s,])error="?insufficient_scope"?/i.test(response.headers.get("www-authenticate") ?? "");
}

/** Statuses worth retrying when the stream fails to (re)open. */
function isRetryable(error: unknown): boolean {
	if (error instanceof McpHttpError) {
		const status = error.status;
		return status === 408 || status === 429 || status >= 500;
	}
	// `fetch` reports network failures, including a connection dropped mid-body, as `TypeError`.
	if (error instanceof TypeError) return true;
	const code = (error as { code?: unknown } | undefined)?.code;
	return typeof code === "string" && (code.startsWith("E") || code.startsWith("UND_ERR"));
}

function discard(response: Response): Promise<void> {
	return response.body?.cancel().catch(() => {}) ?? Promise.resolve();
}

function describeHttpFailure(status: number, body: string): string {
	const text = body.trim();
	const snippet = text.length > ERROR_MESSAGE_BODY_CHARS ? `${text.slice(0, ERROR_MESSAGE_BODY_CHARS - 3)}...` : text;
	return `MCP SSE request failed with status ${status}${snippet ? `: ${snippet}` : ""}`;
}

/** Read a response body with a cap, so a server cannot make the client buffer without bound. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error(`MCP SSE response exceeds ${maxBytes} bytes`);
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	return text;
}
