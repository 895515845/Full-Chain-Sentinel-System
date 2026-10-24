/**
 * OpenVPN profiles: one tunnel, and everything in the container goes into it.
 *
 * The same reasoning as the WireGuard module: a proxy engine's outbound can only
 * carry TCP and UDP, so "ping goes through the tunnel too" needs a real interface
 * with a real route. OpenVPN is a userspace daemon rather than a kernel module,
 * which is the difference that shapes this file: the sidecar's main process *is*
 * the tunnel, so it can never be backgrounded and everything the console needs to
 * know about a running tunnel comes from its log.
 *
 * The configuration is the operator's, pasted whole — a provider hands out one
 * `.ovpn` with the certificates inlined, and that file already carries the cipher,
 * the remote and the routes. Except for a list of lines that cannot survive in a
 * sidecar:
 *
 * - `daemon` would fork and let the sidecar exit, taking the project container's
 *   network namespace with it.
 * - `log`, `log-append` and `status` move the log off stdout, which is the only
 *   place the console can read readiness and failure from.
 * - `auth-user-pass` is replaced by the credentials file the console mounts, so a
 *   password never has to be written into the pasted text.
 * - `up`, `down`, `route-up`, `tls-verify` and friends are dropped rather than
 *   run: they point at scripts the image does not carry (the usual
 *   `update-resolv-conf`), and the sidecar has to run with `--script-security 2`
 *   for its own hook, which would otherwise turn a provider's file into arbitrary
 *   code execution.
 */

import { isIP } from "node:net";
import { t } from "./i18n.ts";
import type { SentinelOpenVpn } from "./protocol.ts";

/**
 * The nameservers in a value, keeping only what a `nameserver` line accepts.
 *
 * The WireGuard path applies the same rule when it writes its own resolver file;
 * this module keeps its own copy so the dependency stays one-way (the proxy module
 * describes an OpenVPN profile and must not be imported here).
 */
function nameservers(value: string): string[] {
	return value.split(/[\s,]+/).filter((entry) => isIP(entry) !== 0);
}

/** Where the mounted files live inside the sidecar. */
export const OPENVPN_CLIENT_DIR = "/etc/openvpn/client";

/** The configuration's file name inside the sidecar. */
export const OPENVPN_CONFIG_FILE = "client.ovpn";

/** Credentials file the console mounts when the profile carries a username. */
export const OPENVPN_AUTH_FILE = "auth.txt";

/** The console's own hook, mounted read-only and run through `/bin/sh`. */
export const OPENVPN_HOOK_FILE = "hook.sh";

/** Where the hook writes the resolvers the server pushed. */
export const OPENVPN_PUSHED_DNS_FILE = "pushed-dns.conf";

/**
 * Options whose value names a script. Dropped for the two reasons in the module
 * comment; a configuration that needs one of them cannot run in this sidecar
 * anyway.
 */
const SCRIPT_OPTIONS = new Set([
	"up",
	"down",
	"route-up",
	"route-pre-down",
	"ipchange",
	"tls-verify",
	"auth-user-pass-verify",
	"client-connect",
	"client-disconnect",
	"learn-address",
]);

/** Options that would break the sidecar or hide its log. */
const DROPPED_OPTIONS = new Set([
	"daemon",
	"log",
	"log-append",
	"status",
	"writepid",
	"auth-user-pass",
	...SCRIPT_OPTIONS,
]);

/**
 * Options whose value is a path to key material. A pasted configuration that names
 * one of these was handed out as several files, and the console mounts exactly one.
 */
const FILE_OPTIONS = new Set([
	"ca",
	"cert",
	"key",
	"pkcs12",
	"dh",
	"secret",
	"crl-verify",
	"tls-auth",
	"tls-crypt",
	"tls-crypt-v2",
]);

interface Directive {
	name: string;
	value: string;
}

type ConfigLine =
	| { kind: "directive"; name: string; value: string; raw: string }
	| { kind: "block-start"; name: string; raw: string }
	| { kind: "block-end"; name: string; raw: string }
	| { kind: "block-body"; name: string; raw: string }
	| { kind: "other"; raw: string };

/** `<connection>` holds options, not key material, so its body stays readable. */
const TRANSPARENT_BLOCK = "connection";

/**
 * Walk a configuration line by line, saying what each line is.
 *
 * Inline certificate blocks matter here: their bodies are base64 that must not be
 * mistaken for options, and a `<ca>` block is what makes a configuration
 * self-contained.
 */
function walkConfig(text: string, visit: (line: ConfigLine) => void): void {
	let block = "";
	for (const raw of text.split(/\r?\n/)) {
		const trimmed = raw.trim();
		const start = /^<([a-zA-Z0-9_-]+)>$/.exec(trimmed);
		if (start) {
			const name = (start[1] ?? "").toLowerCase();
			if (name !== TRANSPARENT_BLOCK) block = name;
			visit({ kind: "block-start", name, raw });
			continue;
		}
		const end = /^<\/([a-zA-Z0-9_-]+)>$/.exec(trimmed);
		if (end) {
			const name = (end[1] ?? "").toLowerCase();
			if (block === name) block = "";
			visit({ kind: "block-end", name, raw });
			continue;
		}
		if (block) {
			visit({ kind: "block-body", name: block, raw });
			continue;
		}
		const option = /^([a-zA-Z0-9_-]+)(?:\s+(.*))?$/.exec(trimmed);
		if (!option) {
			// Blank lines and comments (`#` or `;`), kept as they were written.
			visit({ kind: "other", raw });
			continue;
		}
		visit({ kind: "directive", name: (option[1] ?? "").toLowerCase(), value: (option[2] ?? "").trim(), raw });
	}
}

/** The host and port of the first `remote`, as a table can show them. */
export function openVpnRemote(text: string): string {
	const directives: Directive[] = [];
	walkConfig(text, (line) => {
		if (line.kind === "directive") directives.push({ name: line.name, value: line.value });
	});
	const remote = directives.find((entry) => entry.name === "remote")?.value.split(/\s+/)[0] ?? "";
	if (!remote) return "";
	const written = directives.find((entry) => entry.name === "remote")?.value.split(/\s+/)[1] ?? "";
	const declared = directives.find((entry) => entry.name === "port")?.value ?? "";
	const port = /^\d{1,5}$/.test(written) ? written : /^\d{1,5}$/.test(declared) ? declared : "1194";
	return `${remote}:${port}`;
}

/**
 * What a pasted configuration has to contain to become a tunnel, and the file to
 * mount once it does.
 *
 * The checks are the ones the client would fail on at startup, moved earlier so the
 * operator gets a sentence instead of a sidecar that exits or, worse, retries
 * forever.
 */
export function parseOpenVpnConfig(text: string): {
	/** The file to mount, with the lines from `DROPPED_OPTIONS` removed. */
	config?: string;
	/** `host:port` of the first remote. */
	remote?: string;
	/** Resolvers named by the configuration itself, if any. */
	dns?: string[];
	/** The configuration asks for a username and password. */
	needsCredentials?: boolean;
	error?: string;
} {
	const body = text.trim();
	if (!body) return { error: t("粘贴 OpenVPN 配置（.ovpn，内联证书）") };

	const directives: Directive[] = [];
	const blocks = new Set<string>();
	const kept: string[] = [];
	walkConfig(body, (line) => {
		if (line.kind === "block-start") blocks.add(line.name);
		if (line.kind === "directive") {
			directives.push({ name: line.name, value: line.value });
			if (DROPPED_OPTIONS.has(line.name)) return;
		}
		kept.push(line.raw);
	});

	const first = (name: string): string => directives.find((entry) => entry.name === name)?.value ?? "";
	const has = (name: string): boolean => directives.some((entry) => entry.name === name);

	const dev = first("dev");
	if (dev && !/^tun/i.test(dev)) {
		return { error: t("OpenVPN 只支持 tun 模式，配置里是 dev {dev}", { dev }) };
	}
	const remote = openVpnRemote(body);
	if (!remote) return { error: t("配置里没有 remote 服务器地址") };
	if (!/:\d{1,5}$/.test(remote)) return { error: t("remote 的端口要在 1-65535 之间") };

	// A configuration handed out as several files cannot be mounted from one: the
	// paths in it point at the operator's machine, not at the sidecar.
	for (const name of FILE_OPTIONS) {
		if (!has(name) || blocks.has(name)) continue;
		return {
			error: t("配置用 {name} {file} 引用外部文件；请粘贴内联证书的完整 .ovpn", {
				name,
				file: first(name),
			}),
		};
	}
	if (!blocks.has("ca")) {
		return { error: t("配置缺少内联的 <ca> 证书；分开的证书文件请先合并进一份 .ovpn") };
	}
	if (has("static-challenge")) {
		return { error: t("配置要求动态口令（static-challenge），控制台只支持静态用户名密码") };
	}

	const dns = nameservers(
		directives
			.filter((entry) => entry.name === "dhcp-option" && /^DNS\s+/i.test(entry.value))
			.map((entry) => entry.value.replace(/^DNS\s+/i, ""))
			.join(", "),
	);
	return {
		config: `${kept.join("\n").trimEnd()}\n`,
		remote,
		dns,
		needsCredentials: has("auth-user-pass"),
	};
}

/**
 * The file to mount and the credentials that go with it.
 *
 * Credentials are the profile's, never the configuration's: the pasted text can
 * say `auth-user-pass` without ever holding the password, which is what keeps it
 * out of a file the operator might paste somewhere else.
 */
export function buildOpenVpnProfile(openvpn: SentinelOpenVpn): {
	config?: string;
	remote?: string;
	/** Resolvers for the project container; empty means "whatever the server pushes". */
	dns?: string[];
	/** `user\npassword\n` for the mounted credentials file. */
	credentials?: string;
	error?: string;
} {
	const parsed = parseOpenVpnConfig(openvpn.config);
	if (parsed.error || !parsed.config) return { error: parsed.error ?? t("配置生成失败") };

	const username = openvpn.username.trim();
	const mounted = Boolean(username);
	if (parsed.needsCredentials && !mounted) {
		return { error: t("配置要求用户名密码（auth-user-pass），请在上面的用户名与密码里填上") };
	}
	// A value with no IP in it would be mounted as a resolver glibc cannot use; the
	// file's own `dhcp-option DNS` is a fallback, not a place to hide a typo.
	const typed = openvpn.dns.trim();
	const dns = nameservers(typed);
	if (typed && dns.length === 0) return { error: t("DNS 要填 IP 地址，多个用逗号分隔") };
	return {
		config: parsed.config,
		remote: parsed.remote ?? "",
		dns: dns.length > 0 ? dns : (parsed.dns ?? []),
		credentials: mounted ? `${username}\n${openvpn.password}\n` : undefined,
	};
}

/**
 * The hook the sidecar runs after every successful connection.
 *
 * Two jobs, both of which have to happen at that exact moment: hand the pushed
 * resolvers to the console (the project container's `/etc/resolv.conf` is
 * generated from them), and drop the direct default route when the kill switch is
 * on. The routes OpenVPN added stay — including the host route to the server that
 * keeps the encapsulated packets leaving.
 */
export function openVpnHookScript(killSwitch: boolean): string {
	const lines = [
		"#!/bin/sh",
		"# Written by the console for one project; runs after every successful connection.",
		"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
		"export PATH",
		"",
		"# The resolvers the server pushed, for the project container's /etc/resolv.conf.",
		": > /etc/openvpn/client/pushed-dns.conf",
		"i=1",
		'while [ "$i" -le 20 ]; do',
		'\toption=$(printenv "foreign_option_$i" 2>/dev/null || true)',
		'\tcase "$option" in',
		'\t\t"dhcp-option DNS "*)',
		"\t\t\techo \"nameserver $(printf '%s' \"$option\" | cut -d' ' -f3)\" >> /etc/openvpn/client/pushed-dns.conf",
		"\t\t\t;;",
		"\tesac",
		"\ti=$((i + 1))",
		"done",
	];
	if (killSwitch) {
		lines.push(
			"",
			"# Kill switch: the direct default route goes once the tunnel is up, so a dead",
			"# tunnel cannot fall back to the host network.",
			"ip route del default 2>/dev/null || true",
			"ip -6 route del default 2>/dev/null || true",
		);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * The shell the sidecar runs.
 *
 * `exec` matters: the console reads readiness and failures from this process's log,
 * and a sidecar that exits takes the project container's network with it. The tun
 * device is created when the host has no node for it, the same way the sing-box
 * sidecar does it.
 *
 * `--route-up` is quoted for the container's shell because its value is a command
 * with an argument; `--script-security 2` is what lets the client run it at all.
 */
export function openVpnEntrypoint(options: { credentials: boolean }): string {
	const command = ["openvpn", "--cd", OPENVPN_CLIENT_DIR, "--config", OPENVPN_CONFIG_FILE, "--verb", "3"];
	if (options.credentials) command.push("--auth-user-pass", OPENVPN_AUTH_FILE, "--auth-nocache");
	command.push("--script-security", "2", "--route-up", `"/bin/sh ${OPENVPN_CLIENT_DIR}/${OPENVPN_HOOK_FILE}"`);
	return ["mkdir -p /dev/net", "[ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200", `exec ${command.join(" ")}`].join(
		"; ",
	);
}

/** One line for the 代理 page and the project rows; never includes the password. */
export function describeOpenVpn(openvpn: Pick<SentinelOpenVpn, "config">): string {
	const remote = openVpnRemote(openvpn.config);
	return remote ? `OpenVPN ${remote}` : t("未配置");
}
