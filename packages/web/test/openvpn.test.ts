/**
 * OpenVPN profiles: the pasted `.ovpn`, the files the sidecar mounts, and the shell
 * it runs.
 *
 * What is pinned here is what happens to the operator's file and what a failure
 * looks like. The stakes are higher than for a proxy profile: the sidecar's main
 * process *is* the tunnel, so a line that makes it exit takes the project
 * container's network with it, and a killed sidecar cannot be reported from inside
 * the container. The other half is the file's contents: credentials belong to the
 * profile, never to the pasted text, and the script hooks are dropped because the
 * sidecar runs with `--script-security 2` for its own hook.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
	buildOpenVpnProfile,
	describeOpenVpn,
	openVpnEntrypoint,
	openVpnHookScript,
	openVpnRemote,
	parseOpenVpnConfig,
} from "../src/openvpn.ts";
import type { SentinelOpenVpn } from "../src/protocol.ts";
import { normalizeOpenVpn } from "../src/proxy.ts";
import { readPushedDns, readPushedDnsWhenReady, writeProjectOpenVpnFiles } from "../src/singbox.ts";

const roots: string[] = [];

function setup(): string {
	const root = mkdtempSync(join(tmpdir(), "sentinel-ovpn-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** What a provider hands out: one file, certificates inlined. */
const PASTED = `client
dev tun
proto udp
remote vpn.example.com 1194
resolv-retry infinite
nobind
persist-key
persist-tun
daemon
log /var/log/openvpn.log
auth-user-pass
remote-cert-tls server
dhcp-option DNS 10.8.0.1
<ca>
-----BEGIN CERTIFICATE-----
MIIBca
-----END CERTIFICATE-----
</ca>
<cert>
-----BEGIN CERTIFICATE-----
MIICcert
-----END CERTIFICATE-----
</cert>
<key>
-----BEGIN PRIVATE KEY-----
MIIEkey
-----END PRIVATE KEY-----
</key>
key-direction 1
<tls-auth>
-----BEGIN OpenVPN Static key V1-----
deadbeef
-----END OpenVPN Static key V1-----
</tls-auth>
redirect-gateway def1
`;

function tunnel(overrides: Partial<SentinelOpenVpn> = {}): SentinelOpenVpn {
	return { config: PASTED, dns: "", username: "", password: "", killSwitch: true, ...overrides };
}

test("a pasted configuration is kept as it is, minus the lines that break the sidecar", () => {
	const parsed = parseOpenVpnConfig(PASTED);
	expect(parsed.error).toBeUndefined();
	// `daemon` would fork and let the sidecar exit, taking the container's network
	// with it; a log file would take the readiness signal off stdout.
	expect(parsed.config).not.toContain("daemon");
	expect(parsed.config).not.toContain("/var/log/openvpn.log");
	// The credentials come from the profile, mounted as their own file.
	expect(parsed.config).not.toContain("auth-user-pass");
	// Everything else survives, inline certificates included.
	expect(parsed.config).toContain("<ca>");
	expect(parsed.config).toContain("MIIEkey");
	expect(parsed.config).toContain("<tls-auth>");
	expect(parsed.config).toContain("key-direction 1");
	expect(parsed.config).toContain("redirect-gateway def1");
	expect(parsed.config).toContain("remote vpn.example.com 1194");
	expect(parsed.remote).toBe("vpn.example.com:1194");
	// The resolver in the file is handed back for the project container.
	expect(parsed.dns).toEqual(["10.8.0.1"]);
	// The configuration needs credentials, which is a question for the profile.
	expect(parsed.needsCredentials).toBe(true);
});

test("script hooks are dropped: the sidecar runs with script-security 2 for its own", () => {
	const withHooks = `${PASTED}up /etc/openvpn/update-resolv-conf
down /etc/openvpn/update-resolv-conf
route-up /usr/local/bin/leak.sh
tls-verify /usr/local/bin/verify.sh
`;
	const parsed = parseOpenVpnConfig(withHooks);
	expect(parsed.error).toBeUndefined();
	expect(parsed.config).not.toContain("update-resolv-conf");
	expect(parsed.config).not.toContain("leak.sh");
	expect(parsed.config).not.toContain("tls-verify");
});

test("a configuration that cannot become a tunnel says which part is missing", () => {
	// No remote at all.
	expect(parseOpenVpnConfig("client\ndev tun\n<ca>\nx\n</ca>\n").error).toContain("remote");
	// Certificates handed out as separate files cannot be mounted from one file.
	const external = PASTED.replace(/<ca>[\s\S]*?<\/ca>\n/, "").replace("<key>", "ca ca.crt\n<key>");
	expect(parseOpenVpnConfig(external).error).toContain("ca.crt");
	// A tap device is a different kind of interface than the one we route.
	expect(parseOpenVpnConfig(PASTED.replace("dev tun", "dev tap0")).error).toContain("tun");
	// A one-time password cannot be typed into a container that never asks.
	expect(parseOpenVpnConfig(`${PASTED}static-challenge "Enter OTP" 1\n`).error).toContain("动态口令");
	// Empty input is a sentence, not a crash.
	expect(parseOpenVpnConfig("   ").error).toContain("粘贴");
});

test("credentials come from the profile, and a configuration that needs them says so", () => {
	const built = buildOpenVpnProfile(tunnel({ username: "ops", password: "s3cret" }));
	expect(built.error).toBeUndefined();
	expect(built.credentials).toBe("ops\ns3cret\n");
	// The pasted text never holds the password.
	expect(built.config).not.toContain("s3cret");

	const missing = buildOpenVpnProfile(tunnel());
	expect(missing.error).toContain("auth-user-pass");

	// A configuration without auth-user-pass needs no credentials at all.
	const passwordless = PASTED.replace("auth-user-pass\n", "");
	const open = buildOpenVpnProfile({ ...tunnel(), config: passwordless });
	expect(open.error).toBeUndefined();
	expect(open.credentials).toBeUndefined();
});

test("the profile's resolver wins over the file's", () => {
	const withCredentials = { username: "ops", password: "s3cret" };
	expect(buildOpenVpnProfile(tunnel(withCredentials)).dns).toEqual(["10.8.0.1"]);
	expect(buildOpenVpnProfile(tunnel({ ...withCredentials, dns: "1.1.1.1, 8.8.8.8" })).dns).toEqual([
		"1.1.1.1",
		"8.8.8.8",
	]);
	// A value with no IP in it is refused rather than quietly replaced by the file's
	// own line, which would hide the typo.
	expect(buildOpenVpnProfile(tunnel({ ...withCredentials, dns: "vpn-dns" })).error).toContain("IP");
	// No resolver anywhere is a valid profile: the server may push one, and the hook
	// picks it up once it does.
	const none = PASTED.replace("dhcp-option DNS 10.8.0.1\n", "");
	expect(buildOpenVpnProfile({ ...tunnel(withCredentials), config: none }).dns).toEqual([]);
});

test("the hook writes the pushed resolvers and drops the default route when asked", () => {
	const on = openVpnHookScript(true);
	expect(on).toContain("foreign_option_");
	expect(on).toContain("pushed-dns.conf");
	expect(on).toContain("ip route del default");
	expect(on).toContain("ip -6 route del default");
	// `ip` lives in /usr/sbin, and OpenVPN execs the hook without a PATH search.
	expect(on).toContain("PATH=/usr/sbin:/usr/bin:/sbin:/bin");

	const off = openVpnHookScript(false);
	expect(off).toContain("pushed-dns.conf");
	expect(off).not.toContain("route del default");
});

test("the sidecar runs the client in the foreground with its own hook", () => {
	const plain = openVpnEntrypoint({ credentials: false });
	expect(plain).toContain("mkdir -p /dev/net");
	expect(plain).toContain("mknod /dev/net/tun c 10 200");
	// `exec`: the log of this process is the only place readiness and failure can be
	// read from, and a sidecar that exits takes the container's network with it.
	expect(plain).toContain("exec openvpn");
	// `--cd` has to come before `--config`: relative paths in the file resolve
	// against it, and the options after it win over the file's.
	expect(plain.indexOf("--cd")).toBeLessThan(plain.indexOf("--config"));
	expect(plain).toContain("--verb 3");
	expect(plain).not.toContain("--auth-user-pass");
	// The hook is the one script the sidecar may run, and its value is a command.
	expect(plain).toContain("--script-security 2");
	expect(plain).toContain('--route-up "/bin/sh /etc/openvpn/client/hook.sh"');

	const withCredentials = openVpnEntrypoint({ credentials: true });
	expect(withCredentials).toContain("--auth-user-pass auth.txt");
	// A password is not cached in memory across reconnects.
	expect(withCredentials).toContain("--auth-nocache");
});

test("stored values are normalized and the kill switch defaults to on", () => {
	const stored = normalizeOpenVpn({
		config: `  ${PASTED}  `,
		username: " ops ",
		password: "s3 cret",
		dns: " 1.1.1.1 ",
	});
	expect(stored.config).toBe(PASTED.trim());
	expect(stored.username).toBe("ops");
	// The password is not trimmed: a trailing space may be part of it.
	expect(stored.password).toBe("s3 cret");
	expect(stored.dns).toBe("1.1.1.1");
	expect(stored.killSwitch).toBe(true);
	expect(normalizeOpenVpn({ killSwitch: false }).killSwitch).toBe(false);
});

test("the description names the server and never the password", () => {
	expect(describeOpenVpn(tunnel())).toBe("OpenVPN vpn.example.com:1194");
	expect(openVpnRemote("client\nremote 10.8.0.1\nport 1195\n")).toBe("10.8.0.1:1195");
	// Port 1194 is what a `remote` without one means.
	expect(openVpnRemote("remote vpn.example.com")).toBe("vpn.example.com:1194");
	expect(describeOpenVpn({ config: "" })).toBe("未配置");
});

test("the files are written once, and the pushed resolvers are cleared for the next run", () => {
	const agentDir = setup();
	const first = writeProjectOpenVpnFiles(agentDir, "p1", tunnel({ username: "ops", password: "s3cret" }));
	expect(first.ok).toBe(true);
	const files = (
		first as { files: { configPath: string; authPath?: string; hookPath: string; pushedDnsPath: string } }
	).files;
	expect(readFileSync(files.configPath, "utf-8")).not.toContain("daemon");
	expect(readFileSync(files.authPath ?? "", "utf-8")).toBe("ops\ns3cret\n");
	// The hook the sidecar mounts, with the kill switch the profile asked for.
	expect(readFileSync(files.hookPath, "utf-8")).toContain("ip route del default");
	// 0600: the configuration carries the private key, the credentials file the
	// password.
	expect(statSync(files.configPath).mode & 0o777).toBe(0o600);
	expect(statSync(files.authPath ?? "").mode & 0o777).toBe(0o600);

	// Something the hook wrote during the previous connection must not be read as
	// this connection's resolver.
	writeFileSync(files.pushedDnsPath, "nameserver 10.8.0.1\n");
	const again = writeProjectOpenVpnFiles(agentDir, "p1", tunnel({ username: "ops", password: "s3cret" }));
	expect((again as { files: { configPath: string } }).files.configPath).toBe(files.configPath);
	expect(readFileSync(files.pushedDnsPath, "utf-8")).toBe("");
	expect(readPushedDns(files.pushedDnsPath)).toEqual([]);

	// Dropping the username removes the credentials file rather than leaving a
	// password on disk for a profile that no longer uses it.
	writeProjectOpenVpnFiles(agentDir, "p1", { ...tunnel(), config: PASTED.replace("auth-user-pass\n", "") });
	expect(existsSync(files.authPath ?? "")).toBe(false);
});

test("a pushed resolver is read back as a nameserver list", async () => {
	const agentDir = setup();
	const path = join(agentDir, "pushed.conf");
	writeFileSync(path, "nameserver 10.8.0.1\nnameserver 10.8.0.2\n");
	expect(readPushedDns(path)).toEqual(["10.8.0.1", "10.8.0.2"]);
	// Nothing pushed yet is an empty list, not an error.
	writeFileSync(path, "");
	expect(readPushedDns(path)).toEqual([]);
	// The hook may not have run yet when the tunnel interface first appears.
	expect(await readPushedDnsWhenReady(path, 50)).toEqual([]);
});
