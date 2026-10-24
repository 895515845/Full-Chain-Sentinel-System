/**
 * Share links and Clash proxies, turned into sing-box outbounds.
 *
 * A subscription is a list of nodes written in whatever dialect the provider
 * prefers: `ss://`-style URIs (usually base64-encoded as a whole), a Clash
 * `proxies:` list, or a sing-box configuration. The console can only route
 * through sing-box, so every dialect has to be translated into one outbound
 * object — that translation is this file, and it is deliberately the only place
 * that knows about them.
 *
 * Two things this is not:
 *
 * - It is not a validator. A parsed outbound is fed to `sing-box check` before
 *   anything uses it, which is what catches the field a provider spelled in a way
 *   this file did not anticipate.
 * - It is not exhaustive. Protocols sing-box dropped (SSR) and plugins that have
 *   no equivalent are reported as skipped with a reason, so one odd node in a
 *   hundred does not lose the other ninety-nine.
 */

import { t } from "./i18n.ts";
import type { SentinelProxyNode } from "./protocol.ts";

/** A decoded outbound plus the tag it was given. */
type Outbound = Record<string, unknown>;

interface Parsed {
	node?: SentinelProxyNode;
	/** Why the link produced nothing, for the node list's "skipped" line. */
	error?: string;
}

/**
 * Base64 as providers write it: standard or URL-safe, padded or not. The
 * URL-safe alphabet is tried first because a `-` or `_` in otherwise-standard
 * base64 is far more likely to be the URL-safe alphabet than a typo.
 */
export function decodeBase64(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	try {
		const text = Buffer.from(padded, "base64").toString("utf-8");
		// A round trip is the only cheap way to tell real base64 from a share link
		// that merely happens to consist of base64 characters.
		return Buffer.from(text, "utf-8").toString("base64").replace(/=+$/, "") === padded.replace(/=+$/, "")
			? text
			: undefined;
	} catch {
		return undefined;
	}
}

function decodeText(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * A tag sing-box accepts and the operator can read. Names arrive with spaces,
 * emoji, duplicates and control characters; the tag is what the route and the
 * selector refer to, so it has to be unique and non-empty.
 */
export function uniqueTag(name: string, used: Set<string>): string {
	const base =
		name
			.trim()
			// eslint-disable-next-line no-control-regex -- control characters arrive in tags
			.replace(/[\u0000-\u001f\u007f]/g, "")
			.replace(/\s+/g, " ")
			.slice(0, 48) || "node";
	let tag = base;
	let index = 2;
	while (used.has(tag)) tag = `${base} ${index++}`;
	used.add(tag);
	return tag;
}

/** The `#fragment` of a URI, which is the node's name. */
function nameOf(url: URL, fallback: string): string {
	const fragment = decodeText(url.hash.replace(/^#/, "")).trim();
	return fragment || fallback;
}

/** `?query` as a plain record; a repeated key keeps its first value. */
function paramsOf(url: URL): Record<string, string> {
	const params: Record<string, string> = {};
	for (const [key, value] of url.searchParams) {
		if (!(key in params)) params[key] = value;
	}
	return params;
}

function truthy(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "" || normalized === "1" || normalized === "true" || normalized === "yes";
}

function portOf(url: URL, fallback?: number): number {
	if (url.port) return Number(url.port);
	if (fallback !== undefined) return fallback;
	return url.protocol === "https:" || url.protocol === "http:" ? (url.protocol === "https:" ? 443 : 80) : 443;
}

/**
 * The TLS block shared by every protocol here.
 *
 * `allowInsecure` / `insecure` / `skip-cert-verify` all mean the same thing and
 * all mean "do not verify the certificate" — kept because providers hand out
 * self-signed nodes, and it is the operator's own traffic.
 */
function tlsBlock(options: {
	enabled: boolean;
	serverName?: string;
	insecure?: boolean;
	alpn?: string[];
	fingerprint?: string;
	reality?: { publicKey: string; shortId: string };
}): Outbound | undefined {
	if (!options.enabled) return undefined;
	const tls: Outbound = { enabled: true };
	if (options.serverName) tls.server_name = options.serverName;
	if (options.insecure) tls.insecure = true;
	if (options.alpn && options.alpn.length > 0) tls.alpn = options.alpn;
	if (options.fingerprint) tls.utls = { enabled: true, fingerprint: options.fingerprint };
	if (options.reality?.publicKey) {
		tls.reality = { enabled: true, public_key: options.reality.publicKey };
		if (options.reality.shortId) (tls.reality as Outbound).short_id = options.reality.shortId;
	}
	return tls;
}

/**
 * The transport block: how the bytes reach the server once TLS is up.
 *
 * The share-link vocabulary (`net`, `type`, `path`, `host`, `serviceName`) and
 * Clash's (`network`, `ws-opts`, `grpc-opts`) are both folded into these
 * arguments by the callers.
 */
function transportBlock(options: {
	network?: string;
	path?: string;
	host?: string;
	serviceName?: string;
	headers?: Record<string, string>;
	/** `type=none|http` on a raw TCP link: HTTP obfuscation in front of it. */
	headerType?: string;
}): Outbound | undefined {
	const network = (options.network ?? "").trim().toLowerCase();
	if (!network || network === "tcp" || network === "raw") {
		if (options.headerType === "http") {
			return { type: "http", host: options.host ? [options.host] : undefined, path: options.path };
		}
		return undefined;
	}
	const headers = { ...(options.headers ?? {}) };
	if (options.host && !Object.keys(headers).some((key) => key.toLowerCase() === "host")) headers.Host = options.host;
	switch (network) {
		case "ws":
		case "websocket":
			return { type: "ws", path: options.path || "/", ...(Object.keys(headers).length > 0 ? { headers } : {}) };
		case "grpc":
			return { type: "grpc", service_name: options.serviceName || options.path || "" };
		case "h2":
		case "http":
			return { type: "http", host: options.host ? [options.host] : undefined, path: options.path || "/" };
		case "quic":
			return { type: "quic" };
		default:
			// kcp and anything newer have no sing-box equivalent; the node still works
			// over plain TCP, so the transport is dropped rather than the node.
			return undefined;
	}
}

/** Drop keys whose value is `undefined`, which JSON.stringify would omit anyway. */
function clean(value: Outbound): Outbound {
	const out: Outbound = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) out[key] = entry;
	}
	return out;
}

/** `ss://` in both spellings: SIP002 and the legacy whole-payload base64. */
function parseShadowsocks(url: URL, name: string): Parsed {
	const params = paramsOf(url);
	let method = "";
	let password = "";
	let host = url.hostname;
	let port = portOf(url);

	if (url.username || url.password) {
		// SIP002: the userinfo is base64(method:password).
		const decoded = decodeBase64(decodeText(`${url.username}${url.password ? `:${url.password}` : ""}`));
		if (!decoded) return { error: t("ss 链接的加密方式无法解码") };
		const separator = decoded.indexOf(":");
		if (separator === -1) return { error: t("ss 链接缺少加密方式或密码") };
		method = decoded.slice(0, separator);
		password = decoded.slice(separator + 1);
	} else {
		// Legacy: everything after the scheme is base64(method:password@host:port).
		const decoded = decodeBase64(decodeText(`${url.hostname}${url.pathname}`.replace(/\/$/, "")));
		if (!decoded) return { error: t("ss 链接无法解码") };
		const match = /^(.*?):(.*)@(.*):(\d+)$/.exec(decoded);
		if (!match) return { error: t("ss 链接格式无法识别") };
		method = match[1] ?? "";
		password = match[2] ?? "";
		host = match[3] ?? "";
		port = Number(match[4]);
	}
	if (!host || !Number.isFinite(port) || !method) return { error: t("ss 链接缺少服务器、端口或加密方式") };

	const outbound = clean({
		type: "shadowsocks",
		tag: "",
		server: host,
		server_port: port,
		method,
		password,
		plugin: params.plugin ? (params.plugin.split(";")[0] ?? "") : undefined,
		plugin_opts: params.plugin?.includes(";") ? params.plugin.slice(params.plugin.indexOf(";") + 1) : undefined,
	});
	return { node: { tag: "", name, protocol: "shadowsocks", outbound } };
}

/** `vmess://` — base64 of the v2rayN JSON blob, whose keys are abbreviations. */
function parseVmess(url: URL, name: string): Parsed {
	const decoded = decodeBase64(decodeText(url.href.replace(/^vmess:\/\//i, "")));
	if (!decoded) return { error: t("vmess 链接不是合法的 base64") };
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(decoded);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return { error: t("vmess 链接不是 JSON 对象") };
		raw = parsed as Record<string, unknown>;
	} catch {
		return { error: t("vmess 链接里的 JSON 无法解析") };
	}
	const str = (key: string): string => (raw[key] === undefined || raw[key] === null ? "" : String(raw[key]));
	const server = str("add");
	const port = Number(str("port"));
	if (!server || !Number.isFinite(port) || port <= 0) return { error: t("vmess 链接缺少服务器或端口") };

	const network = str("net") || "tcp";
	const tls = str("tls").toLowerCase();
	const outbound = clean({
		type: "vmess",
		tag: "",
		server,
		server_port: port,
		uuid: str("id"),
		security: str("scy") || "auto",
		alter_id: Number(str("aid")) || 0,
		tls: tlsBlock({
			enabled: tls === "tls",
			serverName: str("sni") || str("host") || server,
			insecure: truthy(str("verify_cert")) === false && str("verify_cert") !== "",
			alpn: str("alpn") ? str("alpn").split(",") : undefined,
			fingerprint: str("fp"),
		}),
		transport: transportBlock({
			network,
			path: str("path"),
			host: str("host"),
			serviceName: str("path"),
			headerType: str("type"),
		}),
	});
	return { node: { tag: "", name: str("ps") || name, protocol: "vmess", outbound } };
}

/** Fields shared by the `user@host:port` family: vless, trojan, hysteria2, tuic. */
function userHostPort(url: URL): { user: string; host: string; port: number } {
	return {
		user: decodeText(url.username),
		host: url.hostname,
		port: portOf(url),
	};
}

/**
 * TLS settings as the `?security=` family of parameters spells them, which is
 * what vless, trojan and hysteria2 links use.
 */
function linkTls(params: Record<string, string>, server: string, fallbackEnabled: boolean): Outbound | undefined {
	const security = (params.security ?? "").toLowerCase();
	const enabled = security === "tls" || security === "reality" || (fallbackEnabled && security !== "none");
	const alpn = params.alpn ? params.alpn.split(",").filter(Boolean) : undefined;
	const reality =
		security === "reality" && params.pbk ? { publicKey: params.pbk, shortId: params.sid ?? "" } : undefined;
	return tlsBlock({
		enabled,
		serverName: params.sni || params.host || server,
		insecure: truthy(params.allowinsecure) || truthy(params.insecure),
		alpn,
		fingerprint: params.fp,
		reality,
	});
}

function parseVless(url: URL, name: string): Parsed {
	const { user, host, port } = userHostPort(url);
	if (!user || !host || !Number.isFinite(port)) return { error: t("vless 链接缺少 uuid、服务器或端口") };
	const params = paramsOf(url);
	const outbound = clean({
		type: "vless",
		tag: "",
		server: host,
		server_port: port,
		uuid: user,
		flow: params.flow || undefined,
		tls: linkTls(params, host, false),
		transport: transportBlock({
			network: params.type,
			path: params.path,
			host: params.host,
			serviceName: params.serviceName,
		}),
	});
	return { node: { tag: "", name, protocol: "vless", outbound } };
}

function parseTrojan(url: URL, name: string): Parsed {
	const { user, host, port } = userHostPort(url);
	if (!user || !host || !Number.isFinite(port)) return { error: t("trojan 链接缺少密码、服务器或端口") };
	const params = paramsOf(url);
	const outbound = clean({
		type: "trojan",
		tag: "",
		server: host,
		server_port: port,
		password: user,
		tls: linkTls(params, host, true),
		transport: transportBlock({
			network: params.type,
			path: params.path,
			host: params.host,
			serviceName: params.serviceName,
		}),
	});
	return { node: { tag: "", name, protocol: "trojan", outbound } };
}

function parseHysteria2(url: URL, name: string): Parsed {
	const { user, host, port } = userHostPort(url);
	if (!host || !Number.isFinite(port)) return { error: t("hysteria2 链接缺少服务器或端口") };
	const params = paramsOf(url);
	const obfs = (params.obfs ?? "").toLowerCase();
	const outbound = clean({
		type: "hysteria2",
		tag: "",
		server: host,
		server_port: port,
		password: user || params.password || "",
		obfs: obfs && params["obfs-password"] ? { type: obfs, password: params["obfs-password"] } : undefined,
		tls: linkTls(params, host, true),
	});
	return { node: { tag: "", name, protocol: "hysteria2", outbound } };
}

function parseTuic(url: URL, name: string): Parsed {
	const { user, host, port } = userHostPort(url);
	if (!host || !Number.isFinite(port)) return { error: t("tuic 链接缺少服务器或端口") };
	const params = paramsOf(url);
	const outbound = clean({
		type: "tuic",
		tag: "",
		server: host,
		server_port: port,
		uuid: user || params.uuid || "",
		password: decodeText(url.password) || params.password || "",
		congestion_control: params.congestion_control || params.congestion || undefined,
		udp_relay_mode: params.udp_relay_mode || undefined,
		tls: linkTls(params, host, true),
	});
	return { node: { tag: "", name, protocol: "tuic", outbound } };
}

/** `socks://` and `http(s)://` links, which providers occasionally hand out. */
function parsePlainProxy(url: URL, name: string, kind: "socks" | "http"): Parsed {
	const host = url.hostname;
	const port = portOf(url);
	if (!host || !Number.isFinite(port)) return { error: t("代理链接缺少服务器或端口") };
	const user = decodeText(url.username);
	const password = decodeText(url.password);
	const outbound = clean(
		kind === "socks"
			? {
					type: "socks",
					tag: "",
					server: host,
					server_port: port,
					version: "5",
					username: user || undefined,
					password: password || undefined,
				}
			: {
					type: "http",
					tag: "",
					server: host,
					server_port: port,
					username: user || undefined,
					password: password || undefined,
					tls: url.protocol === "https:" ? { enabled: true } : undefined,
				},
	);
	return { node: { tag: "", name, protocol: kind, outbound } };
}

/**
 * One share link into one node. The tag is assigned by the caller, which is the
 * only place that knows every other tag in the subscription.
 */
export function parseShareLink(uri: string): Parsed {
	const line = uri.trim().replace(/\/$/, "");
	if (!line) return { error: t("空链接") };
	const scheme = /^([a-z0-9+.-]+):\/\//i.exec(line)?.[1]?.toLowerCase() ?? "";
	if (scheme === "ssr") return { error: t("sing-box 不支持 ssr，已跳过") };
	let url: URL;
	try {
		url = new URL(line);
	} catch {
		return { error: t("链接格式无法解析") };
	}
	const fallbackName = `${scheme} ${url.hostname}`;
	const name = nameOf(url, fallbackName);
	switch (scheme) {
		case "ss":
			return parseShadowsocks(url, name);
		case "vmess":
			return parseVmess(url, name);
		case "vless":
			return parseVless(url, name);
		case "trojan":
			return parseTrojan(url, name);
		case "hysteria2":
		case "hy2":
			return parseHysteria2(url, name);
		case "tuic":
			return parseTuic(url, name);
		case "socks":
		case "socks5":
			return parsePlainProxy(url, name, "socks");
		case "http":
		case "https":
			return parsePlainProxy(url, name, "http");
		default:
			return { error: t("不认识的协议：{scheme}", { scheme: scheme || t("无") }) };
	}
}

/** Whether a line looks like a share link rather than a stray word. */
export function isShareLink(line: string): boolean {
	return /^(ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|socks5?|https?):\/\//i.test(line.trim());
}

/**
 * Clash's `proxies:` entry into a sing-box outbound.
 *
 * Clash spells the same ideas with its own keys: `cipher` for ss, `ws-opts` and
 * `grpc-opts` for the transports, `skip-cert-verify` for an unverified
 * certificate. Everything else about a node is shared with the link formats, so
 * both paths end in the same `transportBlock` / `tlsBlock`.
 */
export function clashProxyToNode(entry: Record<string, unknown>, name: string): Parsed {
	const str = (key: string): string => (entry[key] === undefined || entry[key] === null ? "" : String(entry[key]));
	const server = str("server");
	const port = Number(str("port"));
	if (!server || !Number.isFinite(port) || port <= 0) return { error: t("节点缺少服务器或端口") };

	const nested = (key: string): Record<string, unknown> =>
		entry[key] && typeof entry[key] === "object" && !Array.isArray(entry[key])
			? (entry[key] as Record<string, unknown>)
			: {};
	/**
	 * Clash writes plugin options as a map (`{mode: websocket, host: x}`) where
	 * sing-box wants the `key=value;key=value` string form.
	 */
	const pluginOpts = (): string | undefined => {
		const opts = nested("plugin-opts");
		const pairs = Object.entries(opts)
			.filter(([, value]) => value !== undefined && value !== null && value !== false)
			.map(([key, value]) => (value === true ? key : `${key}=${String(value)}`));
		return pairs.length > 0 ? pairs.join(";") : undefined;
	};
	const ws = nested("ws-opts");
	const grpc = nested("grpc-opts");
	const reality = nested("reality-opts");
	const network =
		str("network") || (Object.keys(grpc).length > 0 ? "grpc" : Object.keys(ws).length > 0 ? "ws" : "tcp");
	const wsHeaders = ws.headers && typeof ws.headers === "object" ? (ws.headers as Record<string, string>) : undefined;
	const transport = transportBlock({
		network,
		path: str("ws-path") || (ws.path === undefined ? "" : String(ws.path)),
		host: str("ws-headers") || (wsHeaders?.Host ?? wsHeaders?.host ?? ""),
		serviceName: grpc["grpc-service-name"] === undefined ? "" : String(grpc["grpc-service-name"]),
		headers: wsHeaders,
	});
	const alpn = Array.isArray(entry.alpn) ? entry.alpn.map((value) => String(value)) : undefined;
	const tlsOptions = {
		serverName: str("servername") || str("sni") || str("server"),
		insecure: entry["skip-cert-verify"] === true,
		alpn,
		fingerprint: str("client-fingerprint"),
		reality:
			reality["public-key"] === undefined
				? undefined
				: {
						publicKey: String(reality["public-key"]),
						shortId: reality["short-id"] === undefined ? "" : String(reality["short-id"]),
					},
	};
	const tls = tlsBlock({
		...tlsOptions,
		enabled: entry.tls === true || str("tls") === "true" || Object.keys(reality).length > 0,
	});
	// hysteria2 and tuic are TLS by definition: Clash leaves the flag out, and
	// sing-box refuses an outbound of those types without it.
	const tlsRequired = tlsBlock({ ...tlsOptions, enabled: true });

	const type = str("type").toLowerCase();
	const common = { tag: "", server, server_port: port };
	switch (type) {
		case "ss":
			return {
				node: {
					tag: "",
					name,
					protocol: "shadowsocks",
					outbound: clean({
						...common,
						type: "shadowsocks",
						method: str("cipher"),
						password: str("password"),
						plugin: str("plugin") || undefined,
						plugin_opts: pluginOpts(),
					}),
				},
			};
		case "vmess":
			return {
				node: {
					tag: "",
					name,
					protocol: "vmess",
					outbound: clean({
						...common,
						type: "vmess",
						uuid: str("uuid"),
						security: str("cipher") || "auto",
						alter_id: Number(str("alterId")) || 0,
						tls,
						transport,
					}),
				},
			};
		case "vless":
			return {
				node: {
					tag: "",
					name,
					protocol: "vless",
					outbound: clean({
						...common,
						type: "vless",
						uuid: str("uuid"),
						flow: str("flow") || undefined,
						tls,
						transport,
					}),
				},
			};
		case "trojan":
			return {
				node: {
					tag: "",
					name,
					protocol: "trojan",
					outbound: clean({ ...common, type: "trojan", password: str("password"), tls, transport }),
				},
			};
		case "hysteria2":
		case "hysteria":
			return {
				node: {
					tag: "",
					name,
					protocol: "hysteria2",
					outbound: clean({
						...common,
						type: "hysteria2",
						password: str("password"),
						obfs:
							str("obfs") === "salamander" && str("obfs-password")
								? { type: "salamander", password: str("obfs-password") }
								: undefined,
						tls: tlsRequired,
					}),
				},
			};
		case "tuic":
			return {
				node: {
					tag: "",
					name,
					protocol: "tuic",
					outbound: clean({
						...common,
						type: "tuic",
						uuid: str("uuid"),
						password: str("password"),
						congestion_control: str("congestion-controller") || undefined,
						udp_relay_mode: str("udp-relay-mode") || undefined,
						tls: tlsRequired,
					}),
				},
			};
		case "socks5":
		case "socks":
			return {
				node: {
					tag: "",
					name,
					protocol: "socks",
					outbound: clean({
						...common,
						type: "socks",
						version: "5",
						username: str("username") || undefined,
						password: str("password") || undefined,
					}),
				},
			};
		case "http":
			return {
				node: {
					tag: "",
					name,
					protocol: "http",
					outbound: clean({
						...common,
						type: "http",
						username: str("username") || undefined,
						password: str("password") || undefined,
						tls,
					}),
				},
			};
		default:
			return { error: t("不认识的协议：{scheme}", { scheme: type || t("无") }) };
	}
}
