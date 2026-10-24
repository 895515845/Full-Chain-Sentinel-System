/**
 * Subscriptions: fetch one URL, get a list of nodes.
 *
 * Providers answer the same URL with whichever dialect fits the client asking:
 * base64-encoded share links, a plain list of them, a Clash configuration, or a
 * sing-box one. All four arrive here and leave as `SentinelProxyNode`s, so the
 * rest of the console never has to know which was used.
 *
 * The result is cached in the profile rather than fetched on demand: starting a
 * project container must work on a machine that cannot reach the provider, and a
 * subscription that is down should never be the reason a container will not
 * start. Fetching happens when the operator saves or presses 刷新.
 */

import { parse as parseYaml } from "yaml";
import { t } from "./i18n.ts";
import type { SentinelProxyNode } from "./protocol.ts";
import { clashProxyToNode, decodeBase64, isShareLink, parseShareLink, uniqueTag } from "./share-link.ts";

/** A subscription is a list of servers, not a payload: past this it is not one. */
export const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;

/** Generous, because providers are often slow and this is a one-off. */
const FETCH_TIMEOUT_MS = 20000;

/** Panels switch format on this; `sing-box` is the one that yields JSON most often. */
export const DEFAULT_SUBSCRIPTION_USER_AGENT = "sing-box/1.13.15";

/** One node that could not be turned into an outbound, and why. */
export interface SkippedNode {
	name: string;
	reason: string;
}

export interface ParsedSubscription {
	nodes: SentinelProxyNode[];
	skipped: SkippedNode[];
}

/**
 * Download a subscription.
 *
 * Redirects are followed because the links providers hand out are usually
 * shorteners; the size cap is enforced both from `Content-Length` and while
 * reading, because a hostile or broken server controls both.
 */
export async function downloadSubscription(url: string, userAgent: string): Promise<{ text?: string; error?: string }> {
	const trimmed = url.trim();
	if (!/^https?:\/\//i.test(trimmed)) return { error: t("订阅地址必须是 http(s) 链接") };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(trimmed, {
			headers: { "user-agent": userAgent.trim() || DEFAULT_SUBSCRIPTION_USER_AGENT },
			redirect: "follow",
			signal: controller.signal,
		});
		if (!response.ok) return { error: t("订阅返回 HTTP {status}", { status: response.status }) };
		const declared = Number(response.headers.get("content-length") ?? 0);
		if (declared > MAX_SUBSCRIPTION_BYTES)
			return { error: t("订阅超过 {kb} KB 上限", { kb: MAX_SUBSCRIPTION_BYTES / 1024 }) };
		const reader = response.body?.getReader();
		if (!reader) return { error: t("订阅响应没有内容") };
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_SUBSCRIPTION_BYTES) {
				await reader.cancel();
				return { error: t("订阅超过 {kb} KB 上限", { kb: MAX_SUBSCRIPTION_BYTES / 1024 }) };
			}
			chunks.push(value);
		}
		return { text: Buffer.concat(chunks).toString("utf-8") };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: /abort/i.test(message) ? t("订阅请求超时") : t("订阅请求失败：{error}", { error: message }) };
	} finally {
		clearTimeout(timer);
	}
}

/** Outbound types that describe a server rather than a routing decision. */
const SERVER_OUTBOUND_TYPES = new Set([
	"shadowsocks",
	"vmess",
	"vless",
	"trojan",
	"hysteria2",
	"tuic",
	"socks",
	"http",
]);

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A sing-box configuration, or an array of outbounds, as nodes.
 *
 * `direct`, `block`, `selector` and `urltest` are dropped: they are routing
 * decisions that only make sense next to the configuration they came from, and
 * this console writes its own route section.
 */
function nodesFromSingbox(parsed: unknown): ParsedSubscription | undefined {
	const list = Array.isArray(parsed)
		? parsed
		: isObject(parsed) && Array.isArray(parsed.outbounds)
			? parsed.outbounds
			: undefined;
	if (!list) return undefined;
	const used = new Set<string>(["proxy", "direct"]);
	const nodes: SentinelProxyNode[] = [];
	const skipped: SkippedNode[] = [];
	for (const entry of list) {
		if (!isObject(entry)) continue;
		const type = String(entry.type ?? "").toLowerCase();
		if (!SERVER_OUTBOUND_TYPES.has(type)) continue;
		const name = String(entry.tag ?? "").trim() || `${type} ${String(entry.server ?? "")}`;
		const tag = uniqueTag(name, used);
		const outbound: Record<string, unknown> = { ...entry, tag };
		// A pasted configuration may carry its own `detour` into a tag this console
		// does not have; dropping it is better than failing the check.
		delete outbound.detour;
		delete outbound.domain_resolver;
		nodes.push({ tag, name, protocol: type, outbound });
	}
	return { nodes, skipped };
}

/**
 * A Clash configuration's `proxies:` list. `proxy-groups` are ignored for the
 * same reason sing-box's selectors are: the console builds its own.
 */
function nodesFromClash(parsed: unknown): ParsedSubscription | undefined {
	if (!isObject(parsed) || !Array.isArray(parsed.proxies)) return undefined;
	const used = new Set<string>(["proxy", "direct"]);
	const nodes: SentinelProxyNode[] = [];
	const skipped: SkippedNode[] = [];
	for (const entry of parsed.proxies) {
		if (!isObject(entry)) continue;
		const name = String(entry.name ?? "").trim() || `${String(entry.type ?? "")} ${String(entry.server ?? "")}`;
		const parsedNode = clashProxyToNode(entry, name);
		if (!parsedNode.node) {
			skipped.push({ name, reason: parsedNode.error ?? t("无法解析") });
			continue;
		}
		const tag = uniqueTag(name, used);
		parsedNode.node.tag = tag;
		parsedNode.node.outbound.tag = tag;
		nodes.push(parsedNode.node);
	}
	return { nodes, skipped };
}

function nodesFromLinks(lines: string[]): ParsedSubscription {
	const used = new Set<string>(["proxy", "direct"]);
	const nodes: SentinelProxyNode[] = [];
	const skipped: SkippedNode[] = [];
	for (const line of lines) {
		if (!isShareLink(line)) continue;
		const parsed = parseShareLink(line);
		if (!parsed.node) {
			skipped.push({ name: line.slice(0, 60), reason: parsed.error ?? t("无法解析") });
			continue;
		}
		const tag = uniqueTag(parsed.node.name, used);
		parsed.node.tag = tag;
		parsed.node.outbound.tag = tag;
		nodes.push(parsed.node);
	}
	return { nodes, skipped };
}

/** Lines that could be share links, with comments and blanks removed. */
function linkLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && !line.startsWith("//"));
}

/** A Clash configuration announces itself with one of these keys. */
const CLASH_KEYS = /^\s*(proxies|proxy-groups|proxy-providers|mixed-port|socks-port)\s*:/m;

/**
 * Whatever the provider sent into nodes.
 *
 * The order matters, and each step is a guess that the next one can still
 * correct. JSON is unambiguous. Base64 comes next because half the providers
 * encode the whole list, and decoding first means the YAML and link-list checks
 * see the useful text rather than the envelope. A base64 blob is itself valid
 * YAML (a plain string), which is why the YAML check runs only when the text
 * announces a Clash key. Everything else is read line by line.
 */
export function parseSubscription(text: string): ParsedSubscription {
	const body = text.trim();
	if (!body) return { nodes: [], skipped: [{ name: "", reason: t("订阅内容为空") }] };

	if (body.startsWith("{") || body.startsWith("[")) {
		try {
			const singbox = nodesFromSingbox(JSON.parse(body));
			if (singbox) return singbox;
		} catch {
			// Not JSON after all; the other shapes below still apply.
		}
	}

	// An envelope only counts as one when what is inside is recognisable.
	const decoded = decodeBase64(body);
	const candidate = decoded && (isShareLink(linkLines(decoded)[0] ?? "") || CLASH_KEYS.test(decoded)) ? decoded : body;
	if (isShareLink(linkLines(candidate)[0] ?? "")) return nodesFromLinks(linkLines(candidate));

	if (CLASH_KEYS.test(candidate)) {
		try {
			const clash = nodesFromClash(parseYaml(candidate));
			if (clash) return clash;
		} catch {
			// A YAML document this parser cannot read falls through to the link list,
			// which finds nothing and reports an empty subscription.
		}
	}

	return nodesFromLinks(linkLines(candidate));
}
