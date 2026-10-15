/**
 * Container network mode: the stored setting and the `docker run` flags it becomes.
 *
 * These pin the decisions with consequences. Host is the default, so a fresh
 * install can receive a reverse shell and see the real LAN. NET_ADMIN is granted
 * only in bridge mode, where it is confined to the container's own namespace —
 * in host mode the same capability would reach the host's interfaces and routes.
 * `host.docker.internal` is pinned in both modes, because the name only resolves by
 * itself on Docker Desktop and OrbStack and the frida tunnel needs it everywhere.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
	containerNetworkFlags,
	containerNetworkPath,
	DEFAULT_CONTAINER_NETWORK,
	normalizeContainerNetwork,
	readContainerNetwork,
	writeContainerNetwork,
} from "../src/container-network.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "sentinel-network-"));
	roots.push(root);
	return root;
}

test("a missing or malformed setting means host", () => {
	const root = tempDir();
	expect(DEFAULT_CONTAINER_NETWORK).toBe("host");
	expect(readContainerNetwork(root)).toBe("host");
	writeFileSync(containerNetworkPath(root), "{ not json");
	expect(readContainerNetwork(root)).toBe("host");
	writeFileSync(containerNetworkPath(root), JSON.stringify({ network: "whatever" }));
	expect(readContainerNetwork(root)).toBe("host");
	expect(normalizeContainerNetwork(undefined)).toBe("host");
	expect(normalizeContainerNetwork("bridge")).toBe("bridge");
	expect(normalizeContainerNetwork("host")).toBe("host");
});

test("the choice round-trips through a private file", () => {
	const root = tempDir();
	writeContainerNetwork(root, "bridge");
	expect(readContainerNetwork(root)).toBe("bridge");
	expect(JSON.parse(readFileSync(containerNetworkPath(root), "utf-8"))).toEqual({ network: "bridge" });
	expect(statSync(containerNetworkPath(root)).mode & 0o777).toBe(0o600);
	writeContainerNetwork(root, "host");
	expect(readContainerNetwork(root)).toBe("host");
});

test("host mode keeps NET_RAW, drops NET_ADMIN, and points the host name at loopback", () => {
	const flags = containerNetworkFlags("host").join(" ");
	expect(flags).toContain("--network host");
	expect(flags).toContain("NET_RAW");
	// In host mode NET_ADMIN would let a command inside the container reconfigure the
	// host's own interfaces, routes and firewall.
	expect(flags).not.toContain("NET_ADMIN");
	// The container's loopback is the host's loopback in this mode.
	expect(flags).toContain("host.docker.internal:127.0.0.1");
});

test("bridge mode grants NET_ADMIN and reaches the host through Docker's gateway", () => {
	const flags = containerNetworkFlags("bridge").join(" ");
	expect(flags).toContain("--network bridge");
	expect(flags).toContain("NET_RAW");
	expect(flags).toContain("NET_ADMIN");
	expect(flags).toContain("host.docker.internal:host-gateway");
});
