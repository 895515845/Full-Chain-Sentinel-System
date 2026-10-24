/**
 * WireGuard profiles: one tunnel, and everything in the container goes into it.
 *
 * A proxy outbound can only carry TCP and UDP — sing-box's outbound interface has
 * no ICMP path at all — so "ping goes through the tunnel too" rules out running
 * WireGuard as a sing-box outbound. What makes ping work is a real interface with
 * a real default route, which is what `wg-quick` sets up: it creates `wg0`, adds
 * the address, and installs a route for every `AllowedIPs` entry, pinning the
 * peer's endpoint to the original gateway so the encapsulated packets do not loop
 * back into the tunnel.
 *
 * The configuration is the operator's, pasted as-is. Two lines are taken out of it
 * first:
 *
 * - `DNS = …` makes `wg-quick` call `resolvconf`, which the image does not run;
 *   the value is handed to the container as `--dns` instead, which is also what
 *   keeps lookups inside the tunnel.
 * - `SaveConfig = true` would make `wg-quick` write back to a read-only mount.
 */

import { t } from "./i18n.ts";
import type { SentinelWireGuard } from "./protocol.ts";

/** The interface name `wg-quick` derives from the configuration's file name. */
export const WIREGUARD_INTERFACE = "wg0";

/** One `Key = Value` line of an ini file. */
interface IniLine {
	section: string;
	key: string;
	value: string;
}

function parseIni(text: string): IniLine[] {
	const lines: IniLine[] = [];
	let section = "";
	for (const raw of text.split(/\r?\n/)) {
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
		const header = /^\[(.+)]$/.exec(trimmed);
		if (header) {
			section = (header[1] ?? "").trim();
			continue;
		}
		const separator = trimmed.indexOf("=");
		if (separator === -1) continue;
		lines.push({
			section,
			key: trimmed.slice(0, separator).trim(),
			value: trimmed.slice(separator + 1).trim(),
		});
	}
	return lines;
}

/**
 * What a pasted configuration has to contain to be a tunnel we can bring up.
 *
 * The checks are the ones `wg-quick` would fail on anyway, moved earlier so the
 * operator gets a sentence instead of a sidecar that exits.
 */
export function parseWireGuardConfig(text: string): {
	/** The file to mount, with `DNS` and `SaveConfig` removed. */
	config?: string;
	/** The resolver named by `DNS =`, if the configuration had one. */
	dns?: string;
	error?: string;
} {
	const body = text.trim();
	if (!body) return { error: t("粘贴 WireGuard 配置（[Interface] 与 [Peer]）") };
	const lines = parseIni(body);
	if (lines.length === 0) return { error: t("配置里没有可识别的键值行") };

	const value = (section: string, key: string): string =>
		lines.find((line) => line.section.toLowerCase() === section && line.key.toLowerCase() === key)?.value ?? "";

	if (!lines.some((line) => line.section.toLowerCase() === "interface")) {
		return { error: t("配置缺少 [Interface] 段") };
	}
	if (!value("interface", "privatekey")) return { error: t("WireGuard 缺少本端私钥（PrivateKey）") };
	if (!value("interface", "address")) return { error: t("WireGuard 缺少隧道内地址（Address）") };

	if (!lines.some((line) => line.section.toLowerCase() === "peer")) {
		return { error: t("配置缺少 [Peer] 段") };
	}
	if (!value("peer", "publickey")) return { error: t("WireGuard 缺少对端公钥（PublicKey）") };
	const endpoint = value("peer", "endpoint");
	if (!endpoint) return { error: t("WireGuard 缺少对端地址（Endpoint）") };
	if (!/^[^\s:]+:\d{1,5}$/.test(endpoint)) {
		return { error: t("WireGuard 的 Endpoint 要写成 host:port，端口不能省") };
	}
	if (!value("peer", "allowedips")) return { error: t("WireGuard 缺少 AllowedIPs") };

	const dns = value("interface", "dns");
	const dropped = new Set(["dns", "saveconfig"]);
	// Everything else is kept exactly as pasted — PostUp rules, keepalives, extra
	// peers — because it is the operator's configuration, not ours.
	const kept = body
		.split(/\r?\n/)
		.filter((raw) => {
			const trimmed = raw.trim();
			const separator = trimmed.indexOf("=");
			if (separator === -1) return true;
			return !dropped.has(trimmed.slice(0, separator).trim().toLowerCase());
		})
		.join("\n")
		.trimEnd();
	return { config: `${kept}\n`, dns: dns || undefined };
}

/**
 * The file to mount, and the resolver the container should use.
 *
 * `dns` on the profile overrides the configuration's own `DNS =` line, which is
 * what the operator reaches for when the pasted file does not carry one.
 */
export function buildWireGuardConfig(wireguard: SentinelWireGuard): {
	config?: string;
	dns?: string;
	error?: string;
} {
	const parsed = parseWireGuardConfig(wireguard.config);
	if (parsed.error || !parsed.config) return { error: parsed.error ?? t("配置生成失败") };
	const dns = wireguard.dns.trim() || parsed.dns || "";
	if (!dns) {
		return { error: t("配置里没有 DNS，请补一行 DNS = 10.66.0.1，或在上面的 DNS 里填一个") };
	}
	return { config: parsed.config, dns };
}

/**
 * The shell the sidecar runs.
 *
 * `wg-quick up` brings the interface up and installs the routes; the kill switch
 * then removes the direct default route, so a tunnel that drops does not silently
 * fall back to the host's network. The route to the peer's endpoint stays, because
 * `wg-quick` added it with a more specific prefix — that is what keeps the
 * encapsulated packets leaving.
 *
 * The container is kept alive with `sleep`: it exists for its namespace, and a
 * sidecar that exits would take the project container's network with it.
 */
export function wireGuardEntrypoint(killSwitch: boolean): string {
	const steps = ["wg-quick up wg0"];
	if (killSwitch) {
		// `|| true`: a container whose default route is already gone is not an error,
		// and failing here would leave the sidecar down for no reason.
		steps.push("ip route del default 2>/dev/null || true", "ip -6 route del default 2>/dev/null || true");
	}
	steps.push("exec sleep infinity");
	return steps.join("; ");
}
