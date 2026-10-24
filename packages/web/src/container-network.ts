/**
 * How a project container joins the network.
 *
 * Host mode is the default. The container shares the host's network namespace, so
 * a listener started inside it — a reverse shell, a payload server, a handler — is
 * reachable by the target at the host's address, `127.0.0.1` inside the container
 * means the host's loopback (Burp, a local range, the console itself), and the
 * container sees the real LAN, VPN and internal DNS instead of Docker's bridge.
 * Bridge mode keeps Docker's isolation: the container has its own address, reaches
 * the host through `host.docker.internal`, and publishes no ports — which is also
 * why nothing outside the host can connect back into it.
 *
 * Stored in `<agentDir>/container-network.json`. A missing or malformed file means
 * host, which is what the environment page shows.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SentinelContainerNetwork } from "./protocol.ts";

export const DEFAULT_CONTAINER_NETWORK: SentinelContainerNetwork = "host";

export function containerNetworkPath(agentDir: string): string {
	return join(agentDir, "container-network.json");
}

/** A JSON file can hold anything; only the two known modes are accepted. */
export function normalizeContainerNetwork(value: unknown): SentinelContainerNetwork {
	return value === "bridge" ? "bridge" : DEFAULT_CONTAINER_NETWORK;
}

export function readContainerNetwork(agentDir: string): SentinelContainerNetwork {
	try {
		const parsed = JSON.parse(readFileSync(containerNetworkPath(agentDir), "utf-8")) as { network?: unknown };
		return normalizeContainerNetwork(parsed?.network);
	} catch {
		return DEFAULT_CONTAINER_NETWORK;
	}
}

export function writeContainerNetwork(agentDir: string, network: SentinelContainerNetwork): void {
	const file = containerNetworkPath(agentDir);
	mkdirSync(dirname(file), { recursive: true });
	const body = { network: normalizeContainerNetwork(network) };
	writeFileSync(file, `${JSON.stringify(body, null, "\t")}\n`, { mode: 0o600 });
}

/**
 * `docker run` flags for a mode, capabilities included.
 *
 * `host.docker.internal` is pinned in both modes, because the name only resolves
 * by itself on Docker Desktop and OrbStack: host mode points it at the container's
 * own loopback (which is the host), bridge mode at Docker's host gateway, so the
 * frida tunnel reaches the gateway's listener on a plain Linux engine too.
 *
 * NET_ADMIN is granted only in bridge mode, where it is confined to the container's
 * own namespace. In host mode the same capability would let a command inside the
 * container reconfigure the host's interfaces, routes and firewall, so it is
 * dropped; NET_RAW stays, since raw sockets are what the scanners need.
 */
export function containerNetworkFlags(network: SentinelContainerNetwork): string[] {
	if (normalizeContainerNetwork(network) === "bridge") {
		return [
			"--network",
			"bridge",
			"--cap-add",
			"NET_RAW",
			"--cap-add",
			"NET_ADMIN",
			"--add-host",
			"host.docker.internal:host-gateway",
		];
	}
	return ["--network", "host", "--cap-add", "NET_RAW", "--add-host", "host.docker.internal:127.0.0.1"];
}

/**
 * `docker run` flags for a container that takes its network from a sing-box
 * sidecar. Every packet then enters the sidecar's tunnel.
 *
 * NET_ADMIN is not granted: the tunnel interface belongs to the sidecar, which is
 * the only container that has to create and route it. NET_RAW stays, because raw
 * sockets are what the scanners need.
 *
 * There is no `--add-host` here, and there cannot be: Docker refuses a custom
 * host mapping together with a container network mode ("conflicting options").
 * `host.docker.internal` therefore comes from Docker's embedded DNS, which
 * resolves it on Docker Desktop; on a plain Linux engine the console adds the
 * line to the container's `/etc/hosts` after every start instead, because Docker
 * rewrites that file each time the container starts.
 */
export function sidecarNetworkFlags(sidecar: string): string[] {
	return ["--network", `container:${sidecar}`, "--cap-add", "NET_RAW"];
}
