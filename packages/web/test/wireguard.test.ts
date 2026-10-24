/**
 * WireGuard profiles: the pasted configuration and the shell the sidecar runs.
 *
 * The reason this exists as a separate module is the same reason it is a separate
 * kind of sidecar: a proxy outbound cannot carry ICMP, so "ping goes through the
 * tunnel" needs a real interface and a real default route. What is pinned here is
 * what happens to the operator's file — the two lines taken out, the ones that
 * make it unusable when missing — and the shell that brings it up.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { SentinelWireGuard } from "../src/protocol.ts";
import { normalizeWireGuard } from "../src/proxy.ts";
import { writeProjectResolvConf, writeProjectWireGuardConfig } from "../src/singbox.ts";
import { buildWireGuardConfig, parseWireGuardConfig, wireGuardEntrypoint } from "../src/wireguard.ts";

const roots: string[] = [];

function setup(): string {
	const root = mkdtempSync(join(tmpdir(), "sentinel-wg-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** What a provider hands out. */
const PASTED = `[Interface]
PrivateKey = cHJpdmF0ZQ==
Address = 10.66.0.2/32
DNS = 10.66.0.1

[Peer]
PublicKey = cHVibGlj
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
`;

function tunnel(overrides: Partial<SentinelWireGuard> = {}): SentinelWireGuard {
	return { config: PASTED, dns: "", killSwitch: true, ...overrides };
}

test("a pasted configuration is kept as it was, minus the two lines that break wg-quick", () => {
	const parsed = parseWireGuardConfig(PASTED);
	expect(parsed.error).toBeUndefined();
	// `DNS =` would make wg-quick call resolvconf, which the image does not run.
	expect(parsed.config).not.toContain("DNS =");
	// The value is handed back so the container can be given `--dns` instead.
	expect(parsed.dns).toBe("10.66.0.1");
	// Everything else survives, including the peer block.
	expect(parsed.config).toContain("PrivateKey = cHJpdmF0ZQ==");
	expect(parsed.config).toContain("Endpoint = vpn.example.com:51820");
	expect(parsed.config).toContain("PersistentKeepalive = 25");
});

test("SaveConfig is dropped: the file is mounted read-only", () => {
	const parsed = parseWireGuardConfig(PASTED.replace("DNS = 10.66.0.1", "SaveConfig = true"));
	expect(parsed.config).not.toContain("SaveConfig");
});

test("a configuration that cannot be brought up says which part is missing", () => {
	expect(parseWireGuardConfig("").error).toContain("粘贴");
	expect(parseWireGuardConfig("[Peer]\nPublicKey = x").error).toContain("[Interface]");
	expect(parseWireGuardConfig(PASTED.replace(/PrivateKey = .*\n/, "")).error).toContain("PrivateKey");
	expect(parseWireGuardConfig(PASTED.replace(/Address = .*\n/, "")).error).toContain("Address");
	expect(parseWireGuardConfig(PASTED.replace(/\[Peer][\s\S]*/, "")).error).toContain("[Peer]");
	expect(parseWireGuardConfig(PASTED.replace(/PublicKey = .*\n/, "")).error).toContain("PublicKey");
	expect(parseWireGuardConfig(PASTED.replace(/Endpoint = .*\n/, "")).error).toContain("Endpoint");
	// A bare host is not enough: wg-quick cannot guess the port.
	expect(parseWireGuardConfig(PASTED.replace("vpn.example.com:51820", "vpn.example.com")).error).toContain(
		"host:port",
	);
	expect(parseWireGuardConfig(PASTED.replace(/AllowedIPs = .*\n/, "")).error).toContain("AllowedIPs");
});

test("the resolver comes from the file, and an explicit one wins", () => {
	expect(buildWireGuardConfig(tunnel()).dns).toBe("10.66.0.1");
	expect(buildWireGuardConfig(tunnel({ dns: "1.1.1.1" })).dns).toBe("1.1.1.1");
	// A pair, as a provider writes it, is kept whole; the container's resolv.conf
	// gets one line per address.
	expect(buildWireGuardConfig(tunnel({ dns: "10.66.0.1, 1.1.1.1" })).dns).toBe("10.66.0.1, 1.1.1.1");
	// Without either there is nothing to give the container, and Docker's own
	// resolver sits outside the tunnel.
	const noDns = PASTED.replace("DNS = 10.66.0.1\n", "");
	expect(buildWireGuardConfig({ config: noDns, dns: "", killSwitch: true }).error).toContain("DNS");
	// A name is not a resolver: mounting one would leave the container resolving
	// nothing while looking configured.
	expect(buildWireGuardConfig({ config: noDns, dns: "vpn-dns", killSwitch: true }).error).toContain("IP");
});

test("the resolver file holds one nameserver line per address", () => {
	const agentDir = setup();
	const written = writeProjectResolvConf(agentDir, "p1", "10.66.0.1, 1.1.1.1");
	expect(written.ok).toBe(true);
	const path = (written as { path: string }).path;
	expect(readFileSync(path, "utf-8")).toBe("nameserver 10.66.0.1\nnameserver 1.1.1.1\n");
	// The same rule as the tunnel's own file: no write, no new mtime.
	const again = writeProjectResolvConf(agentDir, "p1", "10.66.0.1,1.1.1.1");
	expect((again as { path: string }).path).toBe(path);
	expect(readFileSync(path, "utf-8")).toBe("nameserver 10.66.0.1\nnameserver 1.1.1.1\n");
	// Nothing usable in the value is an error, not an empty resolver file.
	expect(writeProjectResolvConf(agentDir, "p2", "").ok).toBe(false);
	expect(existsSync(join(agentDir, "proxy", "p2.resolv.conf"))).toBe(false);
});

test("the kill switch drops the direct default route after the tunnel is up", () => {
	const on = wireGuardEntrypoint(true);
	expect(on.startsWith("wg-quick up wg0")).toBe(true);
	expect(on).toContain("ip route del default");
	expect(on).toContain("ip -6 route del default");
	// The sidecar exists for its namespace: it must not exit.
	expect(on).toContain("exec sleep infinity");

	const off = wireGuardEntrypoint(false);
	expect(off).not.toContain("route del default");
	expect(off).toContain("exec sleep infinity");
});

test("stored values are normalized and the kill switch defaults to on", () => {
	const stored = normalizeWireGuard({ config: `  ${PASTED}  `, dns: " 1.1.1.1 " });
	expect(stored.config).toBe(PASTED.trim());
	expect(stored.dns).toBe("1.1.1.1");
	// A tunnel that silently falls back to the host network is the failure this
	// switch exists to prevent, so it is on unless it was explicitly turned off.
	expect(stored.killSwitch).toBe(true);
	expect(normalizeWireGuard({ killSwitch: false }).killSwitch).toBe(false);
});

test("the file is written once and not rewritten when nothing changed", () => {
	const agentDir = setup();
	const first = writeProjectWireGuardConfig(agentDir, "p1", tunnel());
	expect(first.ok).toBe(true);
	const written = first as { path: string; dns: string };
	// The private key is in this file, and the resolver comes back with it so the
	// caller can pass it to the container.
	expect(readFileSync(written.path, "utf-8")).toContain("PrivateKey = cHJpdmF0ZQ==");
	expect(written.dns).toBe("10.66.0.1");
	const before = readFileSync(written.path, "utf-8");
	const second = writeProjectWireGuardConfig(agentDir, "p1", tunnel());
	// An identical rewrite is skipped so the mtime keeps meaning "this changed".
	expect((second as { path: string }).path).toBe(written.path);
	expect(readFileSync(written.path, "utf-8")).toBe(before);
	// A real change does land.
	writeProjectWireGuardConfig(
		agentDir,
		"p1",
		tunnel({ config: PASTED.replace("vpn.example.com", "other.example.com") }),
	);
	expect(readFileSync(written.path, "utf-8")).toContain("Endpoint = other.example.com:51820");
});
