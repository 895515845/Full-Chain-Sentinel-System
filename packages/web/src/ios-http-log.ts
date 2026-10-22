/**
 * Parse the structured lines the `ios_http_log` frida script prints.
 *
 * The script sees requests and responses at the NSURLSession layer, before TLS,
 * so it works without a proxy or a trusted CA. It emits one JSON object per
 * event with the `SENTINEL_HTTP ` prefix; this module joins a request with its
 * response and turns both into the shape the capture store already knows.
 */

import type { HttpEntryInput } from "./captures.ts";

export interface HttpLogRecord extends HttpEntryInput {
	/** Stable per-run id, useful when the operator wants to correlate two runs. */
	id: number;
}

interface LogMessage {
	kind?: unknown;
	id?: unknown;
	method?: unknown;
	url?: unknown;
	status?: unknown;
	headers?: unknown;
	bodyText?: unknown;
	bodyB64?: unknown;
	bodySize?: unknown;
	bodyNote?: unknown;
	error?: unknown;
}

const MARKER = "SENTINEL_HTTP ";
/** A response body larger than this is stored as a base64 marker, not decoded. */
const MAX_INLINE_BODY = 256 * 1024;

function stripAnsi(text: string): string {
	// frida-cli adds color codes when its stdout is a TTY; the container is not
	// a TTY, but stripping once keeps the parser usable with manual runs too.
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function linesOf(headers: unknown): string {
	if (!headers || typeof headers !== "object") return "";
	const pairs: string[] = [];
	for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
		if (value === null || value === undefined) continue;
		pairs.push(`${name}: ${String(value)}`);
	}
	return pairs.join("\n");
}

function textOf(bodyText: unknown, bodyB64: unknown): string {
	if (typeof bodyText === "string" && bodyText.length > 0) {
		// The frida side decodes UTF-8 opportunistically; if the decoded text
		// does not round-trip to the captured bytes, keep the lossless base64.
		if (typeof bodyB64 === "string" && bodyB64.length > 0) {
			const original = Buffer.from(bodyB64, "base64");
			if (!Buffer.from(bodyText, "utf8").equals(original)) return `base64:${bodyB64}`;
		}
		return bodyText;
	}
	if (typeof bodyB64 !== "string" || bodyB64.length === 0) return "";
	const bytes = Buffer.from(bodyB64, "base64");
	if (bytes.length > MAX_INLINE_BODY) return `base64:${bodyB64}`;
	const text = bytes.toString("utf8");
	// Valid UTF-8 round-trips; binary data (images, protobuf) does not and is
	// kept as base64 so the evidence stays lossless.
	if (!text.includes("\u0000") && Buffer.from(text, "utf8").equals(bytes)) return text;
	return `base64:${bodyB64}`;
}

function statusOf(value: unknown): number | null {
	const status = typeof value === "number" ? value : Number(value);
	return Number.isFinite(status) && status > 0 ? status : null;
}

/**
 * Join request/response events by id. A request without a response stays in the
 * result with status null: the app may have crashed or the frida run ended
 * before the response arrived, and that is still useful evidence.
 */
export function parseHttpLogOutput(output: string): HttpLogRecord[] {
	const records = new Map<number, HttpLogRecord>();
	const text = stripAnsi(output);
	for (const line of text.split(/\r?\n/)) {
		const at = line.indexOf(MARKER);
		if (at < 0) continue;
		let message: LogMessage;
		try {
			message = JSON.parse(line.slice(at + MARKER.length)) as LogMessage;
		} catch {
			continue;
		}
		const id = typeof message.id === "number" ? message.id : Number(message.id);
		if (!Number.isFinite(id)) continue;
		const kind = String(message.kind ?? "");
		if (kind === "request") {
			const url = typeof message.url === "string" ? message.url : "";
			if (!url) continue;
			records.set(id, {
				id,
				method: typeof message.method === "string" && message.method ? message.method : "GET",
				url,
				status: null,
				requestHeaders: linesOf(message.headers),
				requestBody: textOf(message.bodyText, message.bodyB64),
				responseHeaders: "",
				responseBody: "",
			});
			continue;
		}
		if (kind === "response") {
			const record = records.get(id);
			if (!record) continue;
			record.status = statusOf(message.status);
			record.responseHeaders = linesOf(message.headers);
			record.responseBody = textOf(message.bodyText, message.bodyB64);
		}
	}
	return [...records.values()].sort((left, right) => left.id - right.id);
}

/** Drop the parser's local id before the record reaches the capture store. */
export function toHttpEntryInputs(records: HttpLogRecord[]): HttpEntryInput[] {
	return records.map(({ id: _id, ...entry }) => entry);
}
