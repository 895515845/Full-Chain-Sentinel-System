/**
 * Turn `tshark -T json` HTTP packets into capture-store entries.
 *
 * tshark gives one JSON object per packet, not one object per HTTP exchange:
 * the request and its response can be many frames apart, and keep-alive reuses
 * one TCP stream for several exchanges. This parser keeps a FIFO per stream, so
 * a response is paired with the oldest unanswered request on that stream.
 *
 * Only plaintext HTTP is available from a pcap. HTTPS is handled by the
 * `ios_http_log` frida tool instead, at the NSURLSession layer.
 */

import type { HttpEntryInput } from "./captures.ts";

interface Layers {
	[key: string]: unknown;
}

interface TsharkPacket {
	_source?: { layers?: Layers };
}

const MAX_BODY = 256 * 1024;

function layersOf(packet: TsharkPacket): Layers | undefined {
	return packet._source?.layers;
}

/**
 * tshark nests fields under protocol objects (`layers.frame["frame.number"]`),
 * while older versions and the tests use flat keys. Flattening makes both
 * shapes readable without duplicating every field lookup.
 */
function flattenLayers(value: Layers, out: Layers = {}): Layers {
	for (const [key, item] of Object.entries(value)) {
		if (item && typeof item === "object" && !Array.isArray(item)) {
			flattenLayers(item as Layers, out);
		} else if (out[key] === undefined) {
			out[key] = item;
		}
	}
	return out;
}

function first(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		for (const candidate of value) {
			if (candidate === null || candidate === undefined) continue;
			if (typeof candidate === "object") continue;
			return String(candidate);
		}
		return undefined;
	}
	if (value === null || value === undefined || typeof value === "object") return undefined;
	return String(value);
}

function list(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => String(item));
	if (typeof value === "string") return [value];
	return [];
}

function headerLines(value: unknown): string {
	return list(value).join("\n").replace(/\r/g, "").trim();
}

function bodyOf(value: unknown): string {
	const text = first(value);
	if (!text) return "";
	// tshark renders binary bodies as colon-separated hex (`68:65:...`).
	if (/^(?:[0-9a-fA-F]{2}:)*[0-9a-fA-F]{2}$/.test(text)) {
		const bytes = Buffer.from(text.replace(/:/g, ""), "hex");
		const decoded = bytes.toString("utf8");
		if (!decoded.includes("\u0000") && Buffer.from(decoded, "utf8").equals(bytes)) {
			return decoded.slice(0, MAX_BODY);
		}
		return `base64:${bytes.subarray(0, MAX_BODY).toString("base64")}`;
	}
	if (text.length > MAX_BODY) return text.slice(0, MAX_BODY);
	return text;
}

function streamOf(layers: Layers): string {
	return first(layers["tcp.stream"]) ?? "0";
}

function frameOf(layers: Layers): number {
	const value = Number(first(layers["frame.number"]) ?? 0);
	return Number.isFinite(value) ? value : 0;
}

function urlOf(layers: Layers, host: string, uri: string): string {
	const full = first(layers["http.request.full_uri"]);
	if (full) return full;
	if (!uri) return "";
	return `http://${host}${uri.startsWith("/") ? "" : "/"}${uri}`;
}

/**
 * Parse one `tshark -r file.pcap -Y http -T json` document. Packets that carry
 * no HTTP request/response fields are ignored; malformed JSON returns an empty
 * list because the caller only has a pcap to report on, not a schema to trust.
 */
export function parseTsharkHttpJson(text: string): HttpEntryInput[] {
	let packets: TsharkPacket[];
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!Array.isArray(parsed)) return [];
		packets = parsed as TsharkPacket[];
	} catch {
		return [];
	}
	const records: HttpEntryInput[] = [];
	const pending = new Map<string, HttpEntryInput[]>();
	const ordered = packets
		.map((packet, index) => {
			const layers = layersOf(packet);
			return { packet, index, frame: layers ? frameOf(flattenLayers(layers)) : 0 };
		})
		.sort((left, right) => left.frame - right.frame || left.index - right.index);
	for (const { packet } of ordered) {
		const raw = layersOf(packet);
		if (!raw) continue;
		const layers = flattenLayers(raw);
		const stream = streamOf(layers);
		// A response also carries http.request.uri/full_uri, so it must be
		// classified before the request branch or it creates a phantom request.
		const responseCode = first(layers["http.response.code"]);
		if (responseCode) {
			const queue = pending.get(stream);
			const record = queue?.shift();
			if (!record) continue;
			record.status = Number(responseCode) || null;
			record.responseHeaders = headerLines(layers["http.response.line"]);
			record.responseBody = bodyOf(layers["http.file_data"]);
			continue;
		}
		const requestMethod = first(layers["http.request.method"]);
		const requestUri = first(layers["http.request.uri"]);
		if (requestMethod || requestUri) {
			const host = first(layers["http.host"]) ?? "";
			const headers = headerLines(layers["http.request.line"]);
			const record: HttpEntryInput = {
				method: requestMethod ?? "GET",
				url: urlOf(layers, host, requestUri ?? ""),
				status: null,
				requestHeaders: headers || (host ? `Host: ${host}` : ""),
				requestBody: bodyOf(layers["http.file_data"]),
				responseHeaders: "",
				responseBody: "",
			};
			if (!record.url) continue;
			records.push(record);
			const queue = pending.get(stream) ?? [];
			queue.push(record);
			pending.set(stream, queue);
		}
	}
	return records;
}
