/**
 * Custom proxy: the profiles, the sing-box configuration they become, and the
 * order the container pair is created in.
 *
 * These pin the decisions that are expensive to get wrong. A wrong route rule or
 * a missing DNS escape hatch produces a container that resolves nothing, and a
 * sidecar started after its container produces one that runs with no interfaces
 * at all — neither of which looks like a proxy problem from inside the container.
 *
 * The generated configuration is also checked against the real sing-box grammar
 * once, in the environment: `sing-box check` accepts it, the tun comes up, and an
 * upstream SOCKS5 server sees the traffic.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { sidecarNetworkFlags } from "../src/container-network.ts";
import {
	addProject,
	listProjects,
	projectProxySettings,
	recreateProject,
	type SentinelProject,
	setProjectProxy,
	startProject,
	stopProject,
} from "../src/projects.ts";
import type { SentinelProxySettings, SentinelSimpleProxy } from "../src/protocol.ts";
import {
	buildSingboxConfig,
	DEFAULT_SINGBOX_IMAGE,
	deleteProxy,
	describeProxy,
	normalizeProxyMode,
	proxiesPath,
	proxyEnabled,
	readProxies,
	resolveProjectProxy,
	saveProxy,
	setDefaultProxy,
	setProxyImage,
} from "../src/proxy.ts";
import { singboxContainerNameFor } from "../src/singbox.ts";
import { installFakeDocker } from "./fake-docker.ts";

const roots: string[] = [];
const restores: Array<() => void> = [];

afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function agentDirIn(root: string): string {
	const dir = join(root, "agent");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function setup(): { agentDir: string; logPath: string; stateDir: string; root: string } {
	const root = tempDir("sentinel-proxy-");
	const agentDir = agentDirIn(root);
	const logPath = join(root, "docker.log");
	const fake = installFakeDocker(root, join(root, "projects", "demo"), logPath);
	restores.push(fake.restore);
	return { agentDir, logPath, stateDir: fake.stateDir, root };
}

function calls(logPath: string): string[] {
	return readFileSync(logPath, "utf-8").trim().split("\n");
}

/** The parsed configuration, as an object, for assertions about its shape. */
function configOf(settings: Parameters<typeof buildSingboxConfig>[0]): Record<string, never> {
	const built = buildSingboxConfig(settings);
	if (built.error || !built.config) throw new Error(built.error ?? "配置未生成");
	return JSON.parse(built.config);
}

/**
 * Effective settings, the shape `buildSingboxConfig` consumes. The console builds
 * these from a profile through `resolveProjectProxy`; the configuration tests want
 * them without a file behind them.
 */
function settingsOf(
	simple: Partial<SentinelSimpleProxy> = {},
	overrides: Partial<SentinelProxySettings> = {},
): SentinelProxySettings {
	return {
		mode: "simple",
		simple: { type: "socks5", server: "", port: 0, username: "", password: "", tls: false, ...simple },
		nodes: [],
		nodeTag: "",
		image: DEFAULT_SINGBOX_IMAGE,
		testUrl: "https://www.gstatic.com/generate_204",
		routePrivateDirect: true,
		...overrides,
	};
}

/** A saved profile, as the 代理 page would create it. */
function addProfile(
	agentDir: string,
	input: {
		name?: string;
		mode?: "simple" | "subscription";
		simple?: Partial<SentinelSimpleProxy>;
		outbound?: string;
		subscriptionUrl?: string;
		routePrivateDirect?: boolean;
	} = {},
): { id: string; error?: string } {
	const saved = saveProxy(agentDir, {
		name: "香港节点",
		mode: "simple",
		subscriptionUrl: input.subscriptionUrl ?? "",
		subscriptionUserAgent: "",
		subscriptionIntervalHours: 0,
		nodeTag: "",
		simple: {
			type: "socks5",
			server: "1.2.3.4",
			port: 1080,
			username: "",
			password: "",
			tls: false,
			...input.simple,
		},
		routePrivateDirect: input.routePrivateDirect ?? true,
		...(input.mode ? { mode: input.mode } : {}),
		...(input.name ? { name: input.name } : {}),
	});
	if (!saved.proxy) throw new Error(saved.error ?? "代理未保存");
	return { id: saved.proxy.id, error: saved.error };
}

test("a typed proxy address keeps its scheme out of the server field", () => {
	const { agentDir } = setup();
	const { id } = addProfile(agentDir, { simple: { type: "socks5", server: "socks5://127.0.0.1", port: 7890 } });
	expect(readProxies(agentDir).proxies.find((entry) => entry.id === id)?.simple).toMatchObject({
		server: "127.0.0.1",
		port: 7890,
		type: "socks5",
	});
	// `host:port` written as one string fills the port field when it is empty.
	addProfile(agentDir, { name: "combined", simple: { type: "socks5", server: "1.2.3.4:1080", port: 0 } });
	expect(readProxies(agentDir).proxies.find((entry) => entry.name === "combined")?.simple).toMatchObject({
		server: "1.2.3.4",
		port: 1080,
	});
	// An explicit port wins over one baked into the string.
	addProfile(agentDir, { name: "both", simple: { type: "socks5", server: "1.2.3.4:1080", port: 9050 } });
	expect(readProxies(agentDir).proxies.find((entry) => entry.name === "both")?.simple).toMatchObject({
		server: "1.2.3.4:1080",
		port: 9050,
	});
	// Out-of-range and non-numeric ports become "not filled", never NaN.
	addProfile(agentDir, { name: "range", simple: { type: "socks5", server: "x", port: 70000 } });
	expect(readProxies(agentDir).proxies.find((entry) => entry.name === "range")?.simple.port).toBe(0);
	addProfile(agentDir, { name: "text", simple: { type: "socks5", server: "x", port: "abc" as unknown as number } });
	expect(readProxies(agentDir).proxies.find((entry) => entry.name === "text")?.simple.port).toBe(0);
});

test("profiles are stored in one private file, and an unknown mode is not a mode", () => {
	const { agentDir } = setup();
	expect(readProxies(agentDir).proxies).toEqual([]);
	expect(readProxies(agentDir).image).toBe(DEFAULT_SINGBOX_IMAGE);
	const { id } = addProfile(agentDir);
	expect(normalizeProxyMode("off")).toBe("off");
	// A profile exists to be used, so "off" is not one of its modes.
	addProfile(agentDir, { name: "odd", mode: "off" as unknown as "simple" });
	expect(readProxies(agentDir).proxies.find((entry) => entry.name === "odd")?.mode).toBe("simple");
	expect(readProxies(agentDir).defaultId).toBeNull();
	expect(setDefaultProxy(agentDir, id).proxies.defaultId).toBe(id);
	// A default that no longer exists is not a default.
	expect(deleteProxy(agentDir, id).proxies.defaultId).toBeNull();
});

test("names are unique, and a rename keeps the id so projects stay attached", () => {
	const { agentDir } = setup();
	const { id } = addProfile(agentDir);
	const clash = { type: "socks5" as const, server: "x", port: 1, username: "", password: "", tls: false };
	expect(
		saveProxy(agentDir, {
			name: "香港节点",
			mode: "simple",
			simple: clash,
			routePrivateDirect: true,
			subscriptionUrl: "",
			subscriptionUserAgent: "",
			subscriptionIntervalHours: 0,
			nodeTag: "",
		}).error,
	).toContain("同名");
	expect(
		saveProxy(agentDir, {
			id: "nope",
			name: "x",
			mode: "simple",
			simple: clash,
			routePrivateDirect: true,
			subscriptionUrl: "",
			subscriptionUserAgent: "",
			subscriptionIntervalHours: 0,
			nodeTag: "",
		}).error,
	).toContain("不存在");
	const renamed = saveProxy(agentDir, {
		id,
		name: "香港节点-2",
		mode: "simple",
		simple: { ...clash, server: "9.9.9.9", port: 1080 },
		routePrivateDirect: false,
		subscriptionUrl: "",
		subscriptionUserAgent: "",
		subscriptionIntervalHours: 0,
		nodeTag: "",
	});
	expect(renamed.proxy?.id).toBe(id);
	expect(renamed.proxy?.simple.server).toBe("9.9.9.9");
	expect(renamed.proxy?.routePrivateDirect).toBe(false);
});

test("a project resolves through its own choice, the default, or not at all", () => {
	const { agentDir } = setup();
	const first = addProfile(agentDir, { name: "一" }).id;
	addProfile(agentDir, { name: "二" });
	setProxyImage(agentDir, "example.com/sing-box:1");
	setDefaultProxy(agentDir, first);

	const byId = resolveProjectProxy(agentDir, first);
	expect(byId).toMatchObject({ mode: "simple", image: "example.com/sing-box:1" });
	// No choice of its own follows the default.
	expect(resolveProjectProxy(agentDir, undefined)).toEqual(byId);
	// An explicit "no proxy" is not the absence of a choice.
	expect(resolveProjectProxy(agentDir, null)).toBeNull();
	expect(proxyEnabled(resolveProjectProxy(agentDir, null))).toBe(false);
	// A dangling id is not a configuration anything can build.
	expect(resolveProjectProxy(agentDir, "deleted")).toBeNull();
	expect(setDefaultProxy(agentDir, "deleted").error).toContain("不存在");
});

test("simple mode becomes a socks or http outbound tagged proxy", () => {
	const socks = configOf(
		settingsOf({ type: "socks5", server: "127.0.0.1", port: 7890, username: "u", password: "p" }),
	);
	const outbounds = socks.outbounds as Array<Record<string, unknown>>;
	expect(outbounds[0]).toMatchObject({
		type: "socks",
		tag: "proxy",
		server: "127.0.0.1",
		server_port: 7890,
		version: "5",
		username: "u",
		password: "p",
	});
	// The console always adds the direct outbound the route rules point at.
	expect(outbounds[1]).toEqual({ type: "direct", tag: "direct" });

	const http = configOf(settingsOf({ type: "http", server: "127.0.0.1", port: 8080, tls: true }));
	expect((http.outbounds as Array<Record<string, unknown>>)[0]).toMatchObject({
		type: "http",
		tls: { enabled: true },
	});
});

test("an incomplete simple proxy is refused with the field it is missing", () => {
	expect(buildSingboxConfig(settingsOf()).error).toContain("地址");
	expect(buildSingboxConfig(settingsOf({ server: "1.2.3.4" })).error).toContain("端口");
});

test("a profile with no usable exit is refused instead of routing nowhere", () => {
	// `off` never reaches here in practice; the generator still has to answer.
	expect(buildSingboxConfig(settingsOf({}, { mode: "off" })).error).toContain("没有配置出口");
	// A stored profile from before the pasted-outbound mode was removed reads back
	// as a simple one with no address, which is a state the operator can fix.
	const legacy = JSON.parse('{"mode":"json","outbound":"{\\"type\\":\\"trojan\\"}"}') as {
		mode: string;
	};
	expect(normalizeProxyMode(legacy.mode)).toBe("off");
	expect(normalizeProxyMode("simple")).toBe("simple");
	expect(normalizeProxyMode("subscription")).toBe("subscription");
});

test("the route keeps DNS and private destinations off the tunnel", () => {
	const config = configOf(settingsOf({ server: "1.2.3.4", port: 1080 }));
	const rules = (config.route as { rules: Array<Record<string, unknown>> }).rules;
	// DNS first: the container's resolver lives in this namespace on Linux and on a
	// VM-local address on Docker Desktop, and sending either through the exit node
	// makes every name unresolvable.
	expect(rules[0]).toEqual({ action: "sniff" });
	expect(rules[1]).toEqual({ protocol: "dns", outbound: "direct" });
	expect(rules[2]).toEqual({ ip_is_private: true, outbound: "direct" });
	const tun = (config.inbounds as Array<Record<string, unknown>>)[0];
	expect(tun).toMatchObject({ type: "tun", auto_route: true, strict_route: false });
	// The tunnel address must not sit inside any Docker network pool.
	expect(tun.address).toEqual(["198.18.0.1/30"]);

	// Turning the private rule off is what makes a whole engagement take the proxy.
	const all = configOf(settingsOf({ server: "1.2.3.4", port: 1080 }, { routePrivateDirect: false }));
	expect((all.route as { rules: unknown[] }).rules).toHaveLength(2);
});

test("a subscription becomes a selector over every node, plus an automatic group", () => {
	const nodes = [
		{
			tag: "香港",
			name: "香港",
			protocol: "trojan",
			outbound: { type: "trojan", tag: "香港", server: "a", server_port: 1, password: "p" },
		},
		{
			tag: "日本",
			name: "日本",
			protocol: "ss",
			outbound: { type: "shadowsocks", tag: "日本", server: "b", server_port: 2 },
		},
	];
	const config = configOf(settingsOf({}, { mode: "subscription", nodes, nodeTag: "日本" }));
	const outbounds = config.outbounds as Array<Record<string, unknown>>;
	// Nodes, then the automatic group, then the selector that fronts them.
	expect(outbounds.map((entry) => entry.tag)).toEqual(["香港", "日本", "auto", "proxy", "direct"]);
	// `auto` is sing-box's own fastest-healthy pick, checked on a timer.
	expect(outbounds[2]).toMatchObject({
		type: "urltest",
		tag: "auto",
		outbounds: ["香港", "日本"],
		url: "https://www.gstatic.com/generate_204",
		interval: "3m",
	});
	// The route goes through the selector, which owns the choice of node.
	expect(outbounds[3]).toEqual({
		type: "selector",
		tag: "proxy",
		outbounds: ["auto", "香港", "日本"],
		default: "日本",
	});
	expect((config.route as Record<string, unknown>).final).toBe("proxy");

	// "Auto" is a choice like any other, not a separate mode.
	const automatic = configOf(settingsOf({}, { mode: "subscription", nodes, nodeTag: "auto" }));
	expect((automatic.outbounds as Array<Record<string, unknown>>)[3]).toMatchObject({ default: "auto" });
	// A chosen node that is no longer in the list falls back to the automatic group,
	// which is the only choice that cannot point at a node that is gone.
	const fallback = configOf(settingsOf({}, { mode: "subscription", nodes, nodeTag: "删掉的节点" }));
	expect((fallback.outbounds as Array<Record<string, unknown>>)[3]).toMatchObject({ default: "auto" });
});

test("a subscription with nothing in it is refused before a container is built", () => {
	expect(buildSingboxConfig(settingsOf({}, { mode: "subscription" })).error).toContain("没有可用节点");
	// Duplicate tags would make the selector ambiguous.
	const duplicated = [
		{ tag: "x", name: "x", protocol: "trojan", outbound: { type: "trojan", tag: "x", server: "a", server_port: 1 } },
		{ tag: "x", name: "x", protocol: "trojan", outbound: { type: "trojan", tag: "x", server: "b", server_port: 2 } },
	];
	expect(buildSingboxConfig(settingsOf({}, { mode: "subscription", nodes: duplicated })).error).toContain("重名");
	// A node may not shadow the tags the console generates.
	const shadow = [
		{
			tag: "direct",
			name: "direct",
			protocol: "trojan",
			outbound: { type: "trojan", tag: "direct", server: "a", server_port: 1 },
		},
	];
	expect(buildSingboxConfig(settingsOf({}, { mode: "subscription", nodes: shadow })).error).toContain("direct");
});

test("a project's pinned node overrides the profile's own, and falls back when it is gone", () => {
	const { agentDir } = setup();
	const { id } = addProfile(agentDir, { mode: "subscription", subscriptionUrl: "https://example.com/sub" });
	// Seed the cached nodes the way a read would have: the profile's own choice is
	// the first one, and the second is what a project can pin.
	const file = readProxies(agentDir);
	writeFileSync(
		proxiesPath(agentDir),
		JSON.stringify({
			...file,
			proxies: file.proxies.map((entry) => ({
				...entry,
				nodes: [
					{
						tag: "香港",
						name: "香港",
						protocol: "trojan",
						outbound: { type: "trojan", tag: "香港", server: "a", server_port: 1 },
					},
					{
						tag: "日本",
						name: "日本",
						protocol: "trojan",
						outbound: { type: "trojan", tag: "日本", server: "b", server_port: 2 },
					},
				],
				nodeTag: "香港",
			})),
		}),
		{ mode: 0o600 },
	);
	const project: SentinelProject = {
		id: "p1",
		name: "p",
		workDir: "/tmp/p1",
		container: "c",
		createdAt: new Date().toISOString(),
	};

	expect(projectProxySettings(agentDir, { ...project, proxyId: id })?.nodeTag).toBe("香港");
	expect(projectProxySettings(agentDir, { ...project, proxyId: id, proxyNode: "日本" })?.nodeTag).toBe("日本");
	// The provider dropped that node: the profile's choice is used instead of
	// failing to build a configuration.
	expect(projectProxySettings(agentDir, { ...project, proxyId: id, proxyNode: "已删除" })?.nodeTag).toBe("香港");
	// A pin on a profile that is not a subscription means nothing.
	expect(projectProxySettings(agentDir, { ...project, proxyId: id, proxyNode: "" })?.nodeTag).toBe("香港");
});

test("describeProxy never repeats the password", () => {
	const settings = settingsOf({ type: "http", server: "1.2.3.4", port: 8080, username: "u", password: "s3cret" });
	expect(describeProxy(settings)).toBe("HTTP 1.2.3.4:8080");
	expect(describeProxy(settings)).not.toContain("s3cret");
	// A project without a proxy is reported as off, not as a broken profile.
	expect(describeProxy(null)).toBe("关闭");
	// A subscription reports how many nodes it holds and which one is in use.
	expect(
		describeProxy(
			settingsOf(
				{},
				{
					mode: "subscription",
					nodes: [
						{ tag: "a", name: "香港", protocol: "trojan", outbound: {} },
						{ tag: "b", name: "日本", protocol: "trojan", outbound: {} },
					],
					nodeTag: "b",
				},
			),
		),
	).toContain("2 个节点");
	expect(describeProxy(settingsOf({}, { mode: "subscription" }))).toContain("未拉取");
});

test("a sidecar network keeps NET_RAW and grants nothing else", () => {
	const flags = sidecarNetworkFlags("sentinel-sb-abc").join(" ");
	expect(flags).toContain("--network container:sentinel-sb-abc");
	expect(flags).toContain("NET_RAW");
	// The tunnel interface belongs to the sidecar; NET_ADMIN here would only be a
	// way to reconfigure the namespace the project container shares.
	expect(flags).not.toContain("NET_ADMIN");
	// Docker rejects --add-host together with a container network mode.
	expect(flags).not.toContain("--add-host");
});

test("creating a proxied project starts the sidecar before the container that joins it", async () => {
	const { agentDir, logPath } = setup();
	// A default profile, so a new project with no choice of its own is proxied.
	const profile = addProfile(agentDir, { simple: { type: "socks5", server: "127.0.0.1", port: 7890 } }).id;
	setDefaultProxy(agentDir, profile);
	const added = await addProject(agentDir, { name: "demo" });
	expect(added.error).toBeUndefined();
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");

	const lines = calls(logPath);
	// The fake answers any inspect with "true", so the sidecar counts as running and
	// the ordering assertion is about the flags the project container is built with.
	const containerRun = lines.find((line) => line.startsWith("run") && line.includes(project.container));
	expect(containerRun).toContain(`--network container:${singboxContainerNameFor(project.id)}`);
	expect(containerRun).not.toContain("--network host");
	expect(containerRun).not.toContain("--add-host");
	expect(containerRun).toContain(`-v ${project.workDir}:/work`);
	// The generated configuration is on disk, ready for the sidecar to mount.
	expect(existsSync(join(agentDir, "proxy", `${project.id}.json`))).toBe(true);
});

test("a project can turn the proxy off without touching the default", async () => {
	const { agentDir, logPath } = setup();
	const profile = addProfile(agentDir, { simple: { type: "socks5", server: "127.0.0.1", port: 7890 } }).id;
	setDefaultProxy(agentDir, profile);
	await addProject(agentDir, { name: "demo" });
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");

	const saved = setProjectProxy(agentDir, project.id, null);
	expect(saved.error).toBeUndefined();
	expect(readProxies(agentDir).defaultId).toBe(profile);

	const recreated = await recreateProject(agentDir, project.id);
	expect(recreated.error).toBeUndefined();
	const containerRun = calls(logPath)
		.filter((line) => line.startsWith("run") && line.includes(project.container))
		.pop();
	expect(containerRun).toContain("--network host");
	expect(containerRun).not.toContain("container:");
});

test("rebuilding a proxied project replaces the sidecar first and removes it after the container", async () => {
	const { agentDir, logPath, stateDir } = setup();
	setDefaultProxy(agentDir, addProfile(agentDir, { simple: { type: "socks5", server: "127.0.0.1", port: 7890 } }).id);
	await addProject(agentDir, { name: "demo" });
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");
	const sidecar = singboxContainerNameFor(project.id);

	// Pretend the sidecar is gone, which is what a rebuild after a manual removal
	// looks like: the recreate path has to create it again before the container.
	writeFileSync(join(stateDir, sidecar), "removed");
	writeFileSync(join(stateDir, project.container), "removed");
	const before = calls(logPath).length;
	const recreated = await recreateProject(agentDir, project.id);
	expect(recreated.error).toBeUndefined();

	const lines = calls(logPath).slice(before);
	const removeContainer = lines.findIndex((line) => line.startsWith("rm") && line.includes(project.container));
	const removeSidecar = lines.findIndex((line) => line.startsWith("rm") && line.includes(sidecar));
	const runSidecar = lines.findIndex((line) => line.startsWith("run") && line.includes(sidecar));
	const runContainer = lines.findIndex((line) => line.startsWith("run") && line.includes(project.container));
	expect(removeContainer).toBeGreaterThanOrEqual(0);
	expect(removeSidecar).toBeGreaterThan(removeContainer);
	expect(runSidecar).toBeGreaterThan(removeSidecar);
	// The container can only join a namespace that is already up.
	expect(runContainer).toBeGreaterThan(runSidecar);
	const sidecarRun = lines[runSidecar];
	expect(sidecarRun).toContain("--cap-add NET_ADMIN");
	expect(sidecarRun).toContain(":/etc/sing-box/config.json:ro");
});

test("stopping a proxied project stops the container before the sidecar serving it", async () => {
	const { agentDir, logPath } = setup();
	setDefaultProxy(agentDir, addProfile(agentDir, { simple: { type: "socks5", server: "127.0.0.1", port: 7890 } }).id);
	await addProject(agentDir, { name: "demo" });
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");
	const sidecar = singboxContainerNameFor(project.id);

	const before = calls(logPath).length;
	const stopped = await stopProject(agentDir, project.id);
	expect(stopped.error).toBeUndefined();
	const lines = calls(logPath).slice(before);
	const stopContainer = lines.findIndex((line) => line.startsWith("stop") && line.includes(project.container));
	const stopSidecar = lines.findIndex((line) => line.startsWith("stop") && line.includes(sidecar));
	expect(stopContainer).toBeGreaterThanOrEqual(0);
	expect(stopSidecar).toBeGreaterThan(stopContainer);
});

test("a project with the proxy off never touches the sidecar", async () => {
	const { agentDir, logPath } = setup();
	await addProject(agentDir, { name: "demo" });
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");
	const sidecar = singboxContainerNameFor(project.id);
	expect(resolveProjectProxy(agentDir, project.proxyId)).toBeNull();
	expect(calls(logPath).some((line) => line.includes(sidecar))).toBe(false);
	// Starting it is a plain host-network start, with no sidecar call in between.
	const before = calls(logPath).length;
	await startProject(agentDir, project.id);
	expect(
		calls(logPath)
			.slice(before)
			.some((line) => line.includes(sidecar)),
	).toBe(false);
});

/**
 * Rewrite when the fake says a container last started. Both staleness checks are
 * orderings between timestamps, and the fake's own clock has one-second
 * resolution, so the tests place the values outright instead of sleeping.
 */
function setStartedAt(stateDir: string, container: string, value: string): void {
	mkdirSync(join(stateDir, ".meta"), { recursive: true });
	writeFileSync(join(stateDir, ".meta", `${container}.started`), value);
}

/** A project with the proxy on, a sidecar that exists, and known start times. */
async function proxiedProject(): Promise<{
	agentDir: string;
	logPath: string;
	stateDir: string;
	project: { id: string; container: string; workDir: string };
	sidecar: string;
}> {
	const { agentDir, logPath, stateDir } = setup();
	setDefaultProxy(agentDir, addProfile(agentDir, { simple: { type: "socks5", server: "127.0.0.1", port: 7890 } }).id);
	await addProject(agentDir, { name: "demo" });
	const project = listProjects(agentDir).projects[0];
	if (!project) throw new Error("项目未创建");
	const sidecar = singboxContainerNameFor(project.id);
	// The fake counts a container it has never seen as running, so the sidecar has
	// to be missing once for the console to create it for real (with the network
	// and start time the staleness checks read).
	writeFileSync(join(stateDir, sidecar), "removed");
	await startProject(agentDir, project.id);
	// Baseline: the sidecar started after the configuration was written and after
	// the container joined it, so neither check fires.
	setStartedAt(stateDir, sidecar, "2099-01-01T00:00:00Z");
	setStartedAt(stateDir, project.container, "2099-01-02T00:00:00Z");
	return { agentDir, logPath, stateDir, project, sidecar };
}

test("a container whose sidecar was restarted is rebuilt onto the new namespace", async () => {
	const { agentDir, logPath, stateDir, project, sidecar } = await proxiedProject();
	// The sidecar started after the container joined it: the namespace the container
	// is attached to is gone, and nothing inside the container shows it.
	setStartedAt(stateDir, sidecar, "2099-01-03T00:00:00Z");
	const before = calls(logPath).length;
	const started = await startProject(agentDir, project.id);
	expect(started.error).toBeUndefined();

	const lines = calls(logPath).slice(before);
	// The container is replaced — its own layer goes, /work does not — and the
	// sidecar is left alone because its configuration is not the problem.
	expect(lines.some((line) => line.startsWith("rm") && line.includes(project.container))).toBe(true);
	expect(lines.some((line) => line.startsWith("rm") && line.includes(sidecar))).toBe(false);
	const run = lines.filter((line) => line.startsWith("run") && line.includes(project.container)).pop();
	expect(run).toContain(`--network container:${sidecar}`);
});

test("a container that is gone is rebuilt together with a sidecar serving an older configuration", async () => {
	const { agentDir, logPath, stateDir, project, sidecar } = await proxiedProject();
	// The sidecar started before the configuration on disk was written, which is
	// what editing the profile plus a container that later disappeared looks like.
	setStartedAt(stateDir, sidecar, "2000-01-01T00:00:00Z");
	writeFileSync(join(stateDir, project.container), "removed");
	const before = calls(logPath).length;
	const started = await startProject(agentDir, project.id);
	expect(started.error).toBeUndefined();

	const lines = calls(logPath).slice(before);
	const removeSidecar = lines.findIndex((line) => line.startsWith("rm") && line.includes(sidecar));
	const runSidecar = lines.findIndex((line) => line.startsWith("run") && line.includes(sidecar));
	const runContainer = lines.findIndex((line) => line.startsWith("run") && line.includes(project.container));
	// Nothing is attached to the old sidecar any more, so it is recreated: a
	// restart is the only way it rereads its configuration.
	expect(removeSidecar).toBeGreaterThanOrEqual(0);
	expect(runSidecar).toBeGreaterThan(removeSidecar);
	expect(runContainer).toBeGreaterThan(runSidecar);
	// No container layer is thrown away here: there was no container.
	expect(lines.some((line) => line.startsWith("rm") && line.includes(project.container))).toBe(false);
});

test("a running container is left serving the configuration it started with", async () => {
	const { agentDir, logPath, stateDir, project, sidecar } = await proxiedProject();
	setStartedAt(stateDir, sidecar, "2000-01-01T00:00:00Z");
	setStartedAt(stateDir, project.container, "2099-01-01T00:00:00Z");
	const before = calls(logPath).length;
	const started = await startProject(agentDir, project.id);
	expect(started.error).toBeUndefined();
	// It still works, and rebuilding it would throw away its layer without being
	// asked; the environment page is what reports the drift.
	const lines = calls(logPath).slice(before);
	expect(lines.some((line) => line.startsWith("rm"))).toBe(false);
	expect(lines.some((line) => line.startsWith("run"))).toBe(false);
});
