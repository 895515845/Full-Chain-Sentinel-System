/**
 * Switching a running project's node without touching its container.
 *
 * The sidecar's configuration already lists every node and fronts them with a
 * `selector`, and sing-box's Clash API can move that selector at runtime. So the
 * expensive part of a node change — recreating the container, which loses its
 * layer and breaks every shell in it — was never necessary; what was missing was
 * a control path to the selector.
 *
 * Three rules make this safe to offer:
 *
 * - The API listens inside the sidecar's namespace, which the project container
 *   shares, so it is locked with a per-sidecar secret. The secret lives in the
 *   generated configuration, which is mounted only into the sidecar.
 * - The switch is recorded in the project, so a later rebuild starts on the node
 *   the operator last chose rather than reverting to the profile's default.
 * - When the sidecar is not running there is nothing to switch: the choice is
 *   still recorded, and the caller says it applies at the next start.
 */

import { t } from "./i18n.ts";
import type { SentinelProject } from "./projects.ts";
import { projectProxySettings, projectSidecarName } from "./projects.ts";
import type { SentinelProxy } from "./protocol.ts";
import { AUTO_NODE_TAG, PROXY_OUTBOUND_TAG, projectProxyConfigPath, proxyEnabled, readProxies } from "./proxy.ts";
import { proxyApiEndpoint } from "./singbox.ts";

/** How long the sidecar gets to answer a switch before the caller falls back. */
const SWITCH_TIMEOUT_MS = 4000;

/** Whether a node tag can be switched to: a node of the profile, or the auto group. */
export function switchableNode(proxy: SentinelProxy | null, nodeTag: string): boolean {
	if (nodeTag === AUTO_NODE_TAG) return true;
	return Boolean(proxy?.nodes.some((node) => node.tag === nodeTag));
}

/**
 * Move the running sidecar's selector to `nodeTag`.
 *
 * Returns `applied: false` when the sidecar is not running — not an error, just
 * "there is nothing to switch right now". A sidecar that is up but refuses is an
 * error, because that means the choice did not take effect and the operator needs
 * to know.
 */
export async function switchProjectNode(
	agentDir: string,
	project: SentinelProject,
	nodeTag: string,
	/** How the sidecar's control port is found; injectable for tests. */
	resolveEndpoint = proxyApiEndpoint,
): Promise<{ applied: boolean; error?: string }> {
	const settings = projectProxySettings(agentDir, project);
	if (!proxyEnabled(settings)) return { applied: false, error: t("这个项目没有使用代理") };
	if (settings.mode !== "subscription") return { applied: false, error: t("这个代理只有一个出口，没有可切换的节点") };

	const wanted = project.proxyId === undefined ? readProxies(agentDir).defaultId : project.proxyId;
	const profile = readProxies(agentDir).proxies.find((entry) => entry.id === wanted) ?? null;
	if (!switchableNode(profile, nodeTag)) return { applied: false, error: t("节点不存在") };

	// The published port belongs to the sidecar, not to the container that shares
	// its namespace: Docker records bindings per container, and the consumer has
	// none of its own.
	const api = await resolveEndpoint(projectSidecarName(project), projectProxyConfigPath(agentDir, project.id));
	if (!api) return { applied: false };

	try {
		const response = await fetch(`http://127.0.0.1:${api.port}/proxies/${encodeURIComponent(PROXY_OUTBOUND_TAG)}`, {
			method: "PUT",
			headers: { "content-type": "application/json", authorization: `Bearer ${api.secret}` },
			body: JSON.stringify({ name: nodeTag }),
			signal: AbortSignal.timeout(SWITCH_TIMEOUT_MS),
		});
		if (response.status === 204 || response.ok) return { applied: true };
		// 400 means the sidecar is up but does not know that tag, which the console
		// believes it wrote: worth reporting rather than silently deferring.
		if (response.status === 400) return { applied: false, error: t("代理容器不认识这个节点，请重建容器") };
		// Anything else (401, 404, 502…) means the container is not there to answer.
		return { applied: false };
	} catch {
		// No sidecar listening on that port: the choice still applies at next start.
		return { applied: false };
	}
}
