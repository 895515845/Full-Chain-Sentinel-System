/**
 * Share links and subscriptions into sing-box outbounds.
 *
 * This is the translation table for everything a provider might hand out, so the
 * cases here are the shapes real subscriptions use — including the ones that are
 * wrong. What is pinned is the mapping itself: a field spelled the way the link
 * vocabulary spells it has to come out spelled the way sing-box spells it, or the
 * node silently connects to nothing.
 *
 * The generated configurations are additionally checked against the real
 * `sing-box check` in the environment; here the assertions are about the shape.
 */
import { expect, test } from "vitest";
import { decodeBase64, parseShareLink, uniqueTag } from "../src/share-link.ts";
import { parseSubscription } from "../src/subscription.ts";

/** The outbound a link produced, failing the test when it produced none. */
function outboundOf(uri: string): Record<string, unknown> {
	const parsed = parseShareLink(uri);
	if (!parsed.node) throw new Error(parsed.error ?? "链接未解析");
	return parsed.node.outbound;
}

test("base64 is accepted in both alphabets, padded or not", () => {
	// The URL-safe alphabet differs in exactly two characters; providers use both.
	expect(decodeBase64(Buffer.from("hello?").toString("base64"))).toBe("hello?");
	expect(decodeBase64(Buffer.from("hello?").toString("base64url"))).toBe("hello?");
	expect(decodeBase64("aGVsbG8")).toBe("hello");
	// Not base64 at all, and a share link that merely looks like it.
	expect(decodeBase64("ss://abc")).toBeUndefined();
	expect(decodeBase64("")).toBeUndefined();
});

test("tags are unique and readable", () => {
	const used = new Set<string>();
	expect(uniqueTag("香港 01", used)).toBe("香港 01");
	expect(uniqueTag("香港 01", used)).toBe("香港 01 2");
	// Control characters arrive in real subscriptions; they are dropped rather than
	// carried into the JSON configuration.
	expect(uniqueTag("a\u0000b", used)).toBe("ab");
	expect(uniqueTag("   ", used)).toBe("node");
});

test("ss:// in the SIP002 spelling", () => {
	const outbound = outboundOf(
		`ss://${Buffer.from("aes-256-gcm:pa ss").toString("base64url")}@1.2.3.4:8388#%E9%A6%99%E6%B8%AF`,
	);
	expect(outbound).toMatchObject({
		type: "shadowsocks",
		server: "1.2.3.4",
		server_port: 8388,
		method: "aes-256-gcm",
		password: "pa ss",
	});
	// The plugin is `name;opts` in the query, two fields in sing-box.
	const plugin = outboundOf(
		`ss://${Buffer.from("aes-128-gcm:pw").toString("base64")}@1.2.3.4:8388?plugin=${encodeURIComponent("v2ray-plugin;mode=websocket")}#x`,
	);
	expect(plugin).toMatchObject({ plugin: "v2ray-plugin", plugin_opts: "mode=websocket" });
});

test("ss:// in the legacy whole-payload spelling", () => {
	const payload = Buffer.from("chacha20-ietf-poly1305:pw@5.6.7.8:9000").toString("base64url");
	const outbound = outboundOf(`ss://${payload}#legacy`);
	expect(outbound).toMatchObject({
		type: "shadowsocks",
		server: "5.6.7.8",
		server_port: 9000,
		method: "chacha20-ietf-poly1305",
		password: "pw",
	});
});

test("vmess:// carries a JSON blob whose keys are abbreviations", () => {
	const blob = {
		v: "2",
		ps: "东京 01",
		add: "jp.example.com",
		port: "443",
		id: "11111111-2222-3333-4444-555555555555",
		aid: "0",
		scy: "auto",
		net: "ws",
		type: "none",
		host: "cdn.example.com",
		path: "/ws",
		tls: "tls",
		sni: "jp.example.com",
		fp: "chrome",
	};
	const outbound = outboundOf(`vmess://${Buffer.from(JSON.stringify(blob)).toString("base64")}`);
	expect(outbound).toMatchObject({
		type: "vmess",
		server: "jp.example.com",
		server_port: 443,
		uuid: "11111111-2222-3333-4444-555555555555",
		security: "auto",
		alter_id: 0,
		tls: { enabled: true, server_name: "jp.example.com", utls: { enabled: true, fingerprint: "chrome" } },
		transport: { type: "ws", path: "/ws", headers: { Host: "cdn.example.com" } },
	});
	// The node's name comes from `ps`, not from the fragment.
	expect(parseShareLink(`vmess://${Buffer.from(JSON.stringify(blob)).toString("base64")}`).node?.name).toBe("东京 01");
});

test("vmess:// with grpc puts the service name where sing-box wants it", () => {
	const blob = { add: "a.example.com", port: 443, id: "u", net: "grpc", path: "svc", tls: "tls" };
	const outbound = outboundOf(`vmess://${Buffer.from(JSON.stringify(blob)).toString("base64")}`);
	expect(outbound.transport).toEqual({ type: "grpc", service_name: "svc" });
});

test("vless:// with reality", () => {
	const key = "7iOCizBhv2_psTeUoP_cQOV_RixCPE7V9R0lJ4cgAZ0";
	const outbound = outboundOf(
		`vless://11111111-2222-3333-4444-555555555555@r.example.com:443?security=reality&pbk=${key}&sid=00&fp=chrome&flow=xtls-rprx-vision&type=tcp#reality`,
	);
	expect(outbound).toMatchObject({
		type: "vless",
		uuid: "11111111-2222-3333-4444-555555555555",
		flow: "xtls-rprx-vision",
		tls: {
			enabled: true,
			server_name: "r.example.com",
			utls: { enabled: true, fingerprint: "chrome" },
			reality: { enabled: true, public_key: key, short_id: "00" },
		},
	});
	// A raw TCP transport is not a transport block in sing-box.
	expect(outbound.transport).toBeUndefined();
});

test("vless:// over ws keeps the path and the Host header", () => {
	const outbound = outboundOf(
		"vless://u@w.example.com:443?security=tls&type=ws&path=%2Fray&host=cdn.example.com&sni=w.example.com#ws",
	);
	expect(outbound.transport).toEqual({ type: "ws", path: "/ray", headers: { Host: "cdn.example.com" } });
	expect(outbound.tls).toMatchObject({ enabled: true, server_name: "w.example.com" });
});

test("trojan:// is TLS by definition", () => {
	const outbound = outboundOf("trojan://pw@t.example.com:443?sni=t.example.com#tj");
	expect(outbound).toMatchObject({
		type: "trojan",
		password: "pw",
		tls: { enabled: true, server_name: "t.example.com" },
	});
	// A node that says `security=none` is not TLS, which sing-box accepts for trojan
	// only because the operator asked for it explicitly.
	expect(outboundOf("trojan://pw@t.example.com:443?security=none#tj").tls).toBeUndefined();
});

test("hysteria2:// maps obfs and the certificate switch", () => {
	const outbound = outboundOf("hysteria2://pw@hy.example.com:8443?obfs=salamander&obfs-password=xyz&insecure=1#hy");
	expect(outbound).toMatchObject({
		type: "hysteria2",
		password: "pw",
		obfs: { type: "salamander", password: "xyz" },
		tls: { enabled: true, insecure: true },
	});
	// `hy2://` is the same scheme under its short name.
	expect(outboundOf("hy2://pw@hy.example.com:8443#x").type).toBe("hysteria2");
});

test("tuic:// and the plain proxy schemes", () => {
	expect(outboundOf("tuic://uuid:pw@tu.example.com:443?congestion_control=bbr#t")).toMatchObject({
		type: "tuic",
		uuid: "uuid",
		password: "pw",
		congestion_control: "bbr",
	});
	expect(outboundOf("socks5://user:pw@10.0.0.1:1080#s")).toMatchObject({
		type: "socks",
		version: "5",
		username: "user",
		password: "pw",
	});
	expect(outboundOf("https://10.0.0.2:8443#h")).toMatchObject({ type: "http", tls: { enabled: true } });
});

test("links that cannot become a node say why", () => {
	expect(parseShareLink("ssr://whatever").error).toContain("ssr");
	expect(parseShareLink("wireguard://x@y:1").error).toContain("协议");
	expect(parseShareLink("vmess://not-base64!!").error).toContain("base64");
	expect(parseShareLink("vless://@example.com:443").error).toContain("缺少");
	// A vmess payload that decodes to JSON but is not an object.
	expect(parseShareLink(`vmess://${Buffer.from("[1,2]").toString("base64")}`).error).toContain("JSON");
});

test("a base64 subscription of share links", () => {
	const links = [
		`ss://${Buffer.from("aes-256-gcm:pw").toString("base64url")}@1.1.1.1:8388#%E9%A6%99%E6%B8%AF`,
		"trojan://pw@2.2.2.2:443#tokyo",
		"# a comment line",
		"",
	].join("\n");
	const parsed = parseSubscription(Buffer.from(links, "utf-8").toString("base64"));
	expect(parsed.nodes.map((node) => node.tag)).toEqual(["香港", "tokyo"]);
	expect(parsed.skipped).toEqual([]);
});

test("a plain list of share links, and the junk in it", () => {
	const parsed = parseSubscription(
		["ss://not-base64", "trojan://pw@2.2.2.2:443#tokyo", "hello world", "ssr://legacy"].join("\n"),
	);
	expect(parsed.nodes.map((node) => node.tag)).toEqual(["tokyo"]);
	// Both the unparseable ss link and the unsupported ssr are reported, not dropped.
	expect(parsed.skipped).toHaveLength(2);
	expect(parsed.skipped[0]?.reason).toBeTruthy();
});

test("a Clash configuration", () => {
	const yaml = `
port: 7890
proxies:
  - name: "Clash ss"
    type: ss
    server: hk.example.com
    port: 8388
    cipher: chacha20-ietf-poly1305
    password: pw1
    plugin: v2ray-plugin
    plugin-opts:
      mode: websocket
      tls: true
  - name: "Clash vmess ws"
    type: vmess
    server: ws.example.com
    port: 443
    uuid: 11111111-2222-3333-4444-555555555555
    alterId: 0
    cipher: auto
    tls: true
    servername: ws.example.com
    network: ws
    ws-opts:
      path: /path
      headers:
        Host: ws.example.com
  - name: "Clash hy2"
    type: hysteria2
    server: hy.example.com
    port: 8443
    password: pw2
    obfs: salamander
    obfs-password: obfspw
    skip-cert-verify: true
  - name: "Clash ssr"
    type: ssr
    server: old.example.com
    port: 1234
proxy-groups:
  - name: auto
    type: url-test
    proxies: ["Clash ss"]
`;
	const parsed = parseSubscription(yaml);
	expect(parsed.nodes.map((node) => node.tag)).toEqual(["Clash ss", "Clash vmess ws", "Clash hy2"]);
	// Clash writes plugin options as a map; sing-box wants the string form.
	expect(parsed.nodes[0]?.outbound).toMatchObject({
		type: "shadowsocks",
		method: "chacha20-ietf-poly1305",
		plugin: "v2ray-plugin",
		plugin_opts: "mode=websocket;tls",
	});
	expect(parsed.nodes[1]?.outbound).toMatchObject({
		type: "vmess",
		tls: { enabled: true, server_name: "ws.example.com" },
		transport: { type: "ws", path: "/path", headers: { Host: "ws.example.com" } },
	});
	// hysteria2 is TLS by definition even though Clash leaves the flag out.
	expect(parsed.nodes[2]?.outbound).toMatchObject({
		obfs: { type: "salamander", password: "obfspw" },
		tls: { enabled: true, insecure: true },
	});
	expect(parsed.skipped[0]?.reason).toContain("ssr");
});

test("a sing-box configuration, pasted whole", () => {
	const config = JSON.stringify({
		log: { level: "info" },
		outbounds: [
			{ type: "direct", tag: "direct" },
			{ type: "socks", tag: "本机", server: "127.0.0.1", server_port: 7890 },
			{ type: "urltest", tag: "auto", outbounds: ["本机"] },
			// A pasted outbound may carry a detour into a tag we do not have.
			{ type: "trojan", tag: "tj", server: "t.example.com", server_port: 443, password: "pw", detour: "auto" },
		],
	});
	const parsed = parseSubscription(config);
	expect(parsed.nodes.map((node) => node.tag)).toEqual(["本机", "tj"]);
	// `direct` and the group types are routing decisions, not nodes.
	expect(parsed.nodes[1]?.outbound.detour).toBeUndefined();
});

test("duplicate names in one subscription become distinct tags", () => {
	const parsed = parseSubscription(["trojan://a@1.1.1.1:443#香港", "trojan://b@2.2.2.2:443#香港"].join("\n"));
	expect(parsed.nodes.map((node) => node.tag)).toEqual(["香港", "香港 2"]);
	expect(parsed.nodes.every((node) => node.outbound.tag === node.tag)).toBe(true);
});

test("an empty subscription is reported rather than silently empty", () => {
	expect(parseSubscription("").skipped[0]?.reason).toContain("为空");
	// An HTML error page served with a 200 is the common failure.
	const html = parseSubscription("<html><body>token expired</body></html>");
	expect(html.nodes).toEqual([]);
});
