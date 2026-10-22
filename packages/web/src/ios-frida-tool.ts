/**
 * Frida, syslog and URL opening on an iPhone.
 *
 * The plumbing is the Android one: frida-server runs on the device, the
 * container's frida CLI reaches it through a loopback tunnel the gateway
 * bridges to the device's 127.0.0.1:27042. iOS differs in two places: the
 * binary path depends on the jailbreak form (rootless lives under /var/jb) and
 * the builtin scripts are Objective-C level, not Java.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execInContainer } from "./docker.ts";
import { iosBuiltinScriptNames, resolveIosBuiltinScript } from "./frida-scripts-ios.ts";
import { sectionOutput } from "./frida-tool.ts";
import type { IosDevice } from "./ios.ts";
import { parseHttpLogOutput, toHttpEntryInputs } from "./ios-http-log.ts";
import type { IosGatewayPort, IosToolContext } from "./ios-tool.ts";

/** Mounted and unmounted as one switch, next to IOS_TOOL_NAMES. */
export const IOS_FRIDA_TOOL_NAMES: readonly string[] = [
	"ios_frida_setup",
	"ios_frida_ps",
	"ios_frida",
	"ios_http_log",
	"ios_syslog",
	"ios_url_open",
];

const CONTAINER_HOST = "host.docker.internal";
const FRIDA_PORT = 27042;

function failure(text: string): AgentToolResult<{ ok: boolean }> {
	return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
}

/** Same picking rule as the iOS tools, but the caller needs the whole record. */
function pickDevice(ctx: IosToolContext, device: string | undefined): IosDevice | string {
	const gateway = ctx.gateway();
	if (!gateway) return "设备网关未启动";
	const online = gateway.onlineDevices();
	if (online.length === 0) return "没有在线的 iOS 设备：先在越狱设备上打开 SentinelBridge 并等待反连成功";
	if (device?.trim()) {
		const needle = device.trim();
		const found =
			online.find((candidate) => candidate.id === needle) ?? online.find((candidate) => candidate.name === needle);
		if (!found) return `设备「${needle}」不在线`;
		return found;
	}
	if (online.length > 1) return "多台设备在线，请用 device 参数指定";
	return online[0]!;
}

/** Where the official re.frida.server package installs frida-server. */
function deviceFridaPath(device: IosDevice): string {
	return device.jailbreakForm === "rootless" || device.jailbreakForm === "roothide"
		? "/var/jb/usr/sbin/frida-server"
		: "/usr/sbin/frida-server";
}

async function tunnelAddress(
	gateway: IosGatewayPort,
	deviceId: string,
): Promise<{ ok: true; address: string; port: number } | { ok: false; error: string }> {
	const opened = await gateway.openTunnel(deviceId, "127.0.0.1", FRIDA_PORT);
	if (!opened.ok || !opened.port) return { ok: false, error: opened.error ?? "隧道建立失败" };
	return { ok: true, address: `${CONTAINER_HOST}:${opened.port}`, port: opened.port };
}

async function inContainer(
	ctx: IosToolContext,
	command: string,
	timeoutMs: number,
): Promise<{ code: number; output: string }> {
	const result = await execInContainer(ctx.container(), command, [], { timeoutMs });
	return { code: result.code, output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}` };
}

/** Write builtin sources under /work/frida and resolve custom paths. */
function materializeScripts(
	ctx: IosToolContext,
	specs: string[],
): { paths: string[]; names: string[] } | { error: string } {
	const dir = join(ctx.workDir(), "frida");
	mkdirSync(dir, { recursive: true });
	const paths: string[] = [];
	const names: string[] = [];
	for (let index = 0; index < specs.length; index++) {
		const spec = specs[index]!.trim();
		const resolved = resolveIosBuiltinScript(spec);
		if ("error" in resolved) return { error: resolved.error };
		if ("name" in resolved) {
			const file = `ios-${resolved.name}-${index}.js`;
			writeFileSync(join(dir, file), resolved.source);
			paths.push(`/work/frida/${file}`);
			names.push(resolved.name);
		} else {
			const rel = resolved.path.replace(/^\/work\/?/, "");
			if (!existsSync(join(ctx.workDir(), rel))) {
				return {
					error: `脚本不存在：${resolved.path}。iOS 内建脚本：${iosBuiltinScriptNames().join("、")}；或给一个 /work 下的自定义脚本路径`,
				};
			}
			paths.push(`/work/${rel}`);
			names.push(basename(rel));
		}
	}
	return { paths, names };
}

/** One bounded frida run; shared by ios_frida, ios_syslog and ios_decrypt. */
export async function runFrida(
	ctx: IosToolContext,
	device: IosDevice,
	app: string,
	specs: string[],
	mode: "attach" | "spawn",
	seconds: number,
	options: { raw?: boolean } = {},
): Promise<{ ok: true; text: string; output: string } | { ok: false; error: string }> {
	const gateway = ctx.gateway();
	if (!gateway) return { ok: false, error: "设备网关未启动" };
	const tunnel = await tunnelAddress(gateway, device.id);
	if (!tunnel.ok) return { ok: false, error: `隧道建立失败：${tunnel.error}（先运行 ios_frida_setup）` };
	const materialized = materializeScripts(ctx, specs);
	if ("error" in materialized) return { ok: false, error: materialized.error };
	const scriptFlags = materialized.paths.map((path) => `-l ${path}`).join(" ");
	const target = /^\d+$/.test(app) ? `--pid ${app}` : mode === "spawn" ? `-f ${app}` : `-n "${app.replace(/"/g, "")}"`;
	// `-q` stops frida after loading the scripts, so timers and late requests
	// never run. Keep the interactive REPL alive by holding its stdin open with
	// a bounded sleep; the outer timeout is the hard stop.
	const command = `timeout ${seconds + 5} sh -c 'sleep ${seconds + 5} | frida -H ${tunnel.address} ${target} ${scriptFlags}' 2>&1`;
	const run = await inContainer(ctx, command, (seconds + 10) * 1000);
	const output = run.output.trim();
	if (run.code !== 0 && output.length === 0) return { ok: false, error: `frida 运行失败（退出码 ${run.code}）` };
	const head = `Frida ${mode === "spawn" ? "spawn" : "attach"} ${app} · ${seconds}s · ${device.name} · 脚本：${materialized.names.join("、")}`;
	const body = options.raw
		? output
		: sectionOutput(materialized.names, output) || "（无输出：脚本可能没有命中，先用 ios_class_dump 确认类名）";
	return { ok: true, text: `${head}\n\n${body}`, output };
}

export function createIosFridaTools(ctx: IosToolContext): ToolDefinition[] {
	const setup = defineTool({
		name: "ios_frida_setup",
		label: "Push and start frida-server on the iPhone",
		defaultActive: false,
		description:
			"Push frida-server to the jailbroken iPhone and start it, then verify the version through the tunnel. Expects the binary at /work/frida-server in the work directory; download the ios-arm64 or ios-arm64e build matching the container's frida version. The target path follows the jailbreak form (/var/jb/usr/bin for rootless, /usr/bin for rootful). Safe to re-run: it restarts the daemon.",
		promptSnippet: "Push and start frida-server on the iPhone",
		promptGuidelines: [
			"Check the container's frida version first (frida --version) and download the matching frida-server ios-arm64 build",
			"arm64e devices can run the arm64 build; pick arm64e only if the arm64 one crashes",
		],
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
			serverPath: Type.Optional(
				Type.String({ description: "工作目录内的 frida-server 路径，默认 /work/frida-server" }),
			),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			// The device may already run the official re.frida.server package: probe
			// through the tunnel before demanding a local binary to push.
			const existing = await tunnelAddress(gateway, picked.id);
			if (existing.ok) {
				const probe = await inContainer(ctx, `frida-ps -H ${existing.address} | head -3`, 20_000);
				if (probe.code === 0) {
					return {
						content: [
							{
								type: "text",
								text: `frida-server 已在 ${picked.name} 上运行（容器内 ${existing.address}），无需推送。\n${probe.output}`,
							},
						],
						details: { ok: true },
					};
				}
			}
			const hostPath = join(ctx.workDir(), (params.serverPath ?? "/work/frida-server").replace(/^\/work\/?/, ""));
			if (!existsSync(hostPath)) {
				return failure(
					`找不到 ${hostPath}。请在容器里下载与 frida 版本匹配的 ios-arm64 frida-server，例如：\n` +
						`  frida --version   # 先看容器内版本\n` +
						`  curl -L -o /work/frida-server "https://gh-proxy.com/https://github.com/frida/frida/releases/download/<版本>/frida-server-<版本>-ios-arm64"`,
				);
			}
			const remote = deviceFridaPath(picked);
			const push = await gateway.pushFile(picked.id, remote, readFileSync(hostPath), {
				mode: "0755",
				timeoutMs: 180_000,
			});
			if (!push.ok) return failure(`推送失败：${push.error ?? "未知错误"}`);
			const start = await gateway.request(
				picked.id,
				{
					t: "exec",
					cmd: `chmod 755 ${remote}; nohup ${remote} > /var/log/frida-server.log 2>&1 & sleep 2; (pgrep -f frida-server || ps -A | grep frida-server) | head -5; tail -5 /var/log/frida-server.log 2>/dev/null`,
					asRoot: false,
					timeoutMs: 30_000,
				},
				{ timeoutMs: 40_000 },
			);
			if (!start.ok) return failure(`启动失败：${start.error ?? "未知错误"}`);
			const tunnel = await tunnelAddress(gateway, picked.id);
			if (!tunnel.ok) return failure(`隧道建立失败：${tunnel.error}`);
			const version = await inContainer(ctx, `frida-ps -H ${tunnel.address} | head -5`, 30_000);
			if (version.code !== 0) {
				return failure(
					`frida-server 已启动但验证失败（${tunnel.address}）：${version.output.slice(0, 800)}\n设备输出：${start.stdout ?? ""}`,
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `frida-server 已在 ${picked.name} 上运行（${remote}）。容器内地址：${tunnel.address}（宿主机 127.0.0.1:${tunnel.port}）。\nfrida-ps 输出：\n${version.output}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const ps = defineTool({
		name: "ios_frida_ps",
		label: "List iOS processes via Frida",
		defaultActive: false,
		description:
			"List processes or applications on the iPhone through frida-ps over the tunnel. Run ios_frida_setup first. applications=true lists installed apps; their bundle identifiers are what ios_frida attaches to or spawns.",
		promptSnippet: "List iPhone processes and applications through Frida",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
			applications: Type.Optional(Type.Boolean({ description: "true 时列出应用，默认列出进程" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const tunnel = await tunnelAddress(gateway, picked.id);
			if (!tunnel.ok) return failure(`隧道建立失败：${tunnel.error}（先运行 ios_frida_setup）`);
			const flags = params.applications === true ? "-ai" : "";
			const result = await inContainer(ctx, `frida-ps -H ${tunnel.address} ${flags} | head -150`, 30_000);
			if (result.code !== 0) return failure(`frida-ps 失败：${result.output.slice(0, 800)}`);
			return { content: [{ type: "text", text: `设备 ${picked.name}：\n${result.output}` }], details: { ok: true } };
		},
	});

	const frida = defineTool({
		name: "ios_frida",
		label: "Run Frida scripts against an iOS app",
		defaultActive: false,
		description:
			"Run one or more Frida scripts against an iOS app for a bounded time and return each script's console output. Each entry is an iOS builtin name (ios_ssl_bypass / ios_jailbreak_bypass / ios_nslog / ios_class_dump), a builtin with parameters (ios_class_dump?class=MyClass), or a work-directory path to a custom JS file. Scripts run in one injection in the given order; put ios_jailbreak_bypass first when the app detects frida. attach targets a running app by name or pid; spawn starts it fresh.",
		promptSnippet: "Instrument an iOS app with Frida scripts and collect their output",
		promptGuidelines: [
			"Use ios_class_dump first to confirm class and method names before writing a custom hook",
			"Stack builtins (ios_jailbreak_bypass + ios_ssl_bypass + ios_nslog) instead of three separate runs",
			"Run for 10-60 seconds per call; long-lived hooks are better done in several bounded runs",
		],
		parameters: Type.Object({
			app: Type.String({ description: "应用：bundle id/进程名（attach）或 bundle id（spawn）" }),
			scripts: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 4,
				description: `脚本列表（1-4 个）：内建名（可带 ?参数=值）或 /work 下自定义脚本路径。iOS 内建：${iosBuiltinScriptNames().join("、")}`,
			}),
			mode: Type.Optional(
				Type.Union([Type.Literal("attach"), Type.Literal("spawn")], {
					description: "默认 attach（附加到运行中的应用）；spawn 重新拉起应用",
				}),
			),
			seconds: Type.Optional(Type.Number({ description: "运行秒数，默认 20，上限 300" })),
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const seconds = Math.min(Math.max(params.seconds ?? 20, 5), 300);
			const result = await runFrida(ctx, picked, params.app, params.scripts, params.mode ?? "attach", seconds);
			if (!result.ok) return failure(result.error);
			return { content: [{ type: "text", text: result.text }], details: { ok: true } };
		},
	});

	const httpLog = defineTool({
		name: "ios_http_log",
		label: "Capture plaintext HTTP from an iOS app",
		defaultActive: false,
		description:
			"Instrument NSURLSession/NSURLConnection for a bounded time and capture every request and response before TLS: method, URL, headers, body and status. The records are imported into the project's HTTP evidence store (capture_search/capture_get/capture_replay) under source ios_http_log:<app>. Works without a proxy or a trusted CA; apps using a custom HTTP stack (Flutter/Dart, some React Native builds) need a custom frida hook instead.",
		promptSnippet: "Capture plaintext HTTP requests from an iOS app into the evidence store",
		promptGuidelines: [
			"Attach while the app is already at the screen that triggers the API calls; spawn starts it fresh",
			"Use filter= or host= to keep a noisy app to one API, for example host=api.example.com",
			"Run for 30-120 seconds: the tool blocks until the window ends",
		],
		parameters: Type.Object({
			app: Type.String({ description: "应用：bundle id/进程名（attach）或 bundle id（spawn）" }),
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
			mode: Type.Optional(
				Type.Union([Type.Literal("attach"), Type.Literal("spawn")], {
					description: "默认 attach；spawn 重新拉起应用",
				}),
			),
			seconds: Type.Optional(Type.Number({ description: "采集秒数，默认 60，上限 300" })),
			filter: Type.Optional(Type.String({ description: "只保留 URL 含该子串的请求" })),
			host: Type.Optional(Type.String({ description: "只保留 host 含该子串的请求" })),
			persist: Type.Optional(Type.Boolean({ description: "是否写入项目 HTTP 证据库，默认 true" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const seconds = Math.min(Math.max(params.seconds ?? 60, 5), 300);
			const query: string[] = [];
			if (params.filter?.trim()) query.push(`filter=${encodeURIComponent(params.filter.trim())}`);
			if (params.host?.trim()) query.push(`host=${encodeURIComponent(params.host.trim())}`);
			const spec = query.length > 0 ? `ios_http_log?${query.join("&")}` : "ios_http_log";
			const result = await runFrida(ctx, picked, params.app, [spec], params.mode ?? "attach", seconds, {
				raw: true,
			});
			if (!result.ok) return failure(result.error);
			const records = parseHttpLogOutput(result.output);
			if (records.length === 0) {
				return failure(
					`没有捕获到明文 HTTP 请求（${seconds}s）。可能原因：App 不走 NSURLSession/NSURLConnection（Flutter、部分 React Native、自定义 BoringSSL）、请求在 attach 之前已发出、或 filter 太窄。frida 输出末尾：\n${result.text.slice(-1500)}`,
				);
			}
			let stored = 0;
			let storeNote = "";
			const project = ctx.project?.() ?? null;
			if (params.persist !== false && ctx.store && project) {
				const imported = ctx
					.store()
					.importEntries(project.id, `ios_http_log:${params.app}`, toHttpEntryInputs(records));
				stored = imported.imported;
				storeNote = `已入库 ${stored} 条（项目 ${project.name}），可用 capture_search 检索、capture_replay 重放。`;
			} else if (params.persist !== false) {
				storeNote = "未选择项目：本次只展示，不写入证据库。";
			}
			const hosts = [...new Set(records.map((record) => record.url.replace(/^[a-z]+:\/\/([^/]+).*/i, "$1")))].slice(
				0,
				8,
			);
			const lines = records
				.slice(0, 12)
				.map((record) => `- ${record.method} ${record.url}${record.status ? ` → ${record.status}` : ""}`);
			return {
				content: [
					{
						type: "text",
						text: `捕获 ${records.length} 条请求（${records.filter((record) => record.status !== null).length} 条有响应），host：${hosts.join("、") || "—"}\n${storeNote}\n${lines.join("\n")}${records.length > 12 ? `\n…其余 ${records.length - 12} 条已入库，用 capture_search 查` : ""}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const syslog = defineTool({
		name: "ios_syslog",
		label: "Collect iOS logs through Frida",
		defaultActive: false,
		description:
			"Collect logs by hooking NSLog and os_log with the ios_nslog builtin for a bounded time. Attach to the target app to see its logs, or to SpringBoard for system-wide noise. Format strings are printed; variadic arguments are not formatted (frida cannot safely replay varargs).",
		promptSnippet: "Collect iPhone logs through Frida",
		promptGuidelines: [
			"Filter with filter= to keep the output usable (for example filter=network)",
			"Attach to the target app for its own logs; SpringBoard sees more but noisier system logs",
		],
		parameters: Type.Object({
			app: Type.Optional(Type.String({ description: "目标应用或进程，默认 SpringBoard" })),
			filter: Type.Optional(Type.String({ description: "只保留包含该子串的日志" })),
			seconds: Type.Optional(Type.Number({ description: "采集秒数，默认 20，上限 300" })),
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const seconds = Math.min(Math.max(params.seconds ?? 20, 5), 300);
			const spec = params.filter?.trim()
				? `ios_nslog?filter=${encodeURIComponent(params.filter.trim())}`
				: "ios_nslog";
			const result = await runFrida(ctx, picked, params.app?.trim() || "SpringBoard", [spec], "attach", seconds);
			if (!result.ok) return failure(result.error);
			return { content: [{ type: "text", text: result.text }], details: { ok: true } };
		},
	});

	const urlOpen = defineTool({
		name: "ios_url_open",
		label: "Open a URL or scheme on the iPhone",
		defaultActive: false,
		description:
			"Open a URL on the device with uiopen (or open): deep links, custom schemes, app-to-app flows. This changes device state, so it goes through the approval chain.",
		promptSnippet: "Open a URL or deep link on the iPhone",
		promptGuidelines: ["Use it to test URL scheme handling and deep-link entry points found in the app's Info.plist"],
		parameters: Type.Object({
			url: Type.String({ description: "要打开的 URL，例如 myapp://path?x=1" }),
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			let command: string;
			try {
				command = await ctx.guard(picked.name, `uiopen '${params.url.replace(/'/g, "'\\''")}'`);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(
				picked.id,
				{ t: "exec", cmd: command, asRoot: false, timeoutMs: 15_000 },
				{ timeoutMs: 25_000 },
			);
			if (!result.ok || (result.code ?? 0) !== 0) {
				return failure(`打开失败：${result.error ?? result.stderr ?? `退出码 ${result.code}`}`);
			}
			return {
				content: [
					{
						type: "text",
						text: `已打开 ${params.url}（设备 ${picked.name}）${result.stdout?.trim() ? `\n${result.stdout.trim()}` : ""}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	return [setup, ps, frida, httpLog, syslog, urlOpen];
}
