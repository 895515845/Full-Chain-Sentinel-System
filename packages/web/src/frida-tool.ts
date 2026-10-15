/**
 * Frida over the reverse tunnel.
 *
 * frida-server runs on the rooted device; the agent's frida CLI runs in the
 * project container and reaches it through a loopback TCP tunnel the gateway
 * bridges into the device's 127.0.0.1:27042. The tools hide that plumbing: setup
 * pushes and starts frida-server, the other tools open the tunnel (reusing a live
 * one for the same port) and run the CLI inside the container.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execInContainer } from "./docker.ts";
import type { DroidToolContext } from "./droid-tool.ts";
import { builtinScript, builtinScriptNames } from "./frida-scripts.ts";

export const FRIDA_TOOL_NAMES: readonly string[] = ["droid_frida_setup", "droid_frida_ps", "droid_frida"];
const DEVICE_FRIDA = "/data/local/tmp/frida-server";
const CONTAINER_HOST = "host.docker.internal";

function failure(text: string): AgentToolResult<{ ok: boolean }> {
	return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
}

/** Same device picking rule as the droid tools; kept local to avoid a cycle. */
function pickDevice(ctx: DroidToolContext, device: string | undefined): { id: string; name: string } | string {
	const gateway = ctx.gateway();
	if (!gateway) return "设备网关未启动";
	const online = gateway.onlineDevices();
	if (online.length === 0) return "没有在线的安卓设备：先在手机上打开 DroidBridge 并等待反连成功";
	if (device?.trim()) {
		const needle = device.trim();
		const found =
			online.find((candidate) => candidate.id === needle) ?? online.find((candidate) => candidate.name === needle);
		if (!found) return `设备「${needle}」不在线`;
		return { id: found.id, name: found.name };
	}
	if (online.length > 1) return `多台设备在线，请用 device 参数指定`;
	return { id: online[0]!.id, name: online[0]!.name };
}

/** Open (or reuse) the tunnel for a device port, returning the container-reachable address. */
async function tunnelAddress(
	ctx: DroidToolContext,
	deviceId: string,
	targetPort: number,
): Promise<{ ok: true; address: string; port: number } | { ok: false; error: string }> {
	const gateway = ctx.gateway();
	if (!gateway) return { ok: false, error: "设备网关未启动" };
	const opened = await gateway.openTunnel(deviceId, "127.0.0.1", targetPort);
	if (!opened.ok || !opened.port) return { ok: false, error: opened.error ?? "隧道建立失败" };
	return { ok: true, address: `${CONTAINER_HOST}:${opened.port}`, port: opened.port };
}

/** Run a command inside the project container and return (code, stdout+stderr). */
async function inContainer(
	ctx: DroidToolContext,
	command: string,
	timeoutMs: number,
): Promise<{ code: number; output: string }> {
	const result = await execInContainer(ctx.container(), command, [], { timeoutMs });
	return { code: result.code, output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}` };
}

export function createFridaTools(ctx: DroidToolContext): ToolDefinition[] {
	const setup = defineTool({
		name: "droid_frida_setup",
		label: "Push and start frida-server",
		defaultActive: false,
		description:
			"Push frida-server to the device and start it as root, then verify the version through the tunnel. Expects the frida-server binary at /work/frida-server in the work directory (download the android-arm64 build matching the container's frida version; the error names both when missing). Safe to re-run: it restarts the daemon.",
		promptSnippet: "Push and start frida-server on the device, verified through the tunnel",
		promptGuidelines: [
			"Check the container's frida version first (frida --version) and download the matching frida-server android-arm64 build",
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
			const hostPath = join(ctx.workDir(), (params.serverPath ?? "/work/frida-server").replace(/^\/work\/?/, ""));
			if (!existsSync(hostPath)) {
				return failure(
					`找不到 ${hostPath}。请在容器里下载与 frida 版本匹配的 android-arm64 frida-server，例如：\n` +
						`  frida --version   # 先看容器内版本\n` +
						`  curl -L -o /work/frida-server "https://gh-proxy.com/https://github.com/frida/frida/releases/download/<版本>/frida-server-<版本>-android-arm64"`,
				);
			}
			// 59MB 走分片：整份 base64 塞进一帧会把手机上的 APP 撑到 OOM（见 pushFile）。
			const push = await gateway.pushFile(picked.id, DEVICE_FRIDA, readFileSync(hostPath), {
				mode: "0755",
				timeoutMs: 120_000,
			});
			if (!push.ok) return failure(`推送失败：${push.error ?? "未知错误"}`);
			const start = await gateway.request(picked.id, {
				t: "exec",
				cmd: `chmod 755 ${DEVICE_FRIDA}; su -c "nohup ${DEVICE_FRIDA} > /dev/null 2>&1 &"; sleep 1; su -c "netstat -tlnp 2>/dev/null | grep 27042 || ps -A | grep frida"`,
				asRoot: false,
				timeoutMs: 20_000,
			});
			if (!start.ok) return failure(`启动失败：${start.error ?? "未知错误"}`);
			const tunnel = await tunnelAddress(ctx, picked.id, 27042);
			if (!tunnel.ok) return failure(`隧道建立失败：${tunnel.error}`);
			const version = await inContainer(ctx, `frida-ps -H ${tunnel.address} | head -5`, 30_000);
			if (version.code !== 0) {
				return failure(`frida-server 已启动但验证失败（${tunnel.address}）：${version.output.slice(0, 800)}`);
			}
			return {
				content: [
					{
						type: "text",
						text: `frida-server 已在 ${picked.name} 上运行。容器内地址：${tunnel.address}（宿主机 127.0.0.1:${tunnel.port}）。\nfrida-ps 输出：\n${version.output}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const fridaPs = defineTool({
		name: "droid_frida_ps",
		label: "List processes via Frida",
		defaultActive: false,
		description:
			"List processes/applications on the device through frida-ps over the tunnel. Run droid_frida_setup first. applications=true lists installed apps (their identifiers are what droid_frida spawns/attaches to).",
		promptSnippet: "List device processes and applications through Frida",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
			applications: Type.Optional(Type.Boolean({ description: "true 时列出应用（-aiai），默认列出进程" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const tunnel = await tunnelAddress(ctx, picked.id, 27042);
			if (!tunnel.ok) return failure(`隧道建立失败：${tunnel.error}（先运行 droid_frida_setup）`);
			const flags = params.applications === true ? "-aiai" : "-ai";
			const version = await inContainer(ctx, `frida-ps -H ${tunnel.address} ${flags} | head -120`, 30_000);
			if (version.code !== 0) return failure(`frida-ps 失败：${version.output.slice(0, 800)}`);
			return {
				content: [{ type: "text", text: `设备 ${picked.name}：\n${version.output}` }],
				details: { ok: true },
			};
		},
	});

	const frida = defineTool({
		name: "droid_frida",
		label: "Run a Frida script against an app",
		defaultActive: false,
		description:
			"Run a Frida script against an app on the device for a bounded time and return its console output. script accepts a builtin name (okhttp_log / ssl_pinning_bypass / root_detection_bypass / crypto_log) or a work-directory path to a custom JS file. attach mode targets a running app by name or pid; spawn mode starts it fresh (use with -f style apps like com.example.app). Output beyond 16k characters is truncated.",
		promptSnippet: "Instrument an app with a Frida script and collect its output",
		promptGuidelines: [
			"Read the decompiled code (apk_decompile/apk_search) before hooking: hook names must match the target",
			"Prefer builtin scripts first; write a custom JS to /work when the target needs specific hooks",
			"Run for 10-60 seconds per call; long-lived hooks are better done in several bounded runs",
		],
		parameters: Type.Object({
			app: Type.String({ description: "应用：包名/应用名（attach）或进程名+pid（spawn 用包名）" }),
			script: Type.String({ description: "内建脚本名或工作目录内的自定义脚本路径（/work/…）" }),
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
			const tunnel = await tunnelAddress(ctx, picked.id, 27042);
			if (!tunnel.ok) return failure(`隧道建立失败：${tunnel.error}（先运行 droid_frida_setup）`);

			let scriptPath: string;
			const builtin = builtinScript(params.script);
			if (builtin) {
				const dir = join(ctx.workDir(), "frida");
				mkdirSync(dir, { recursive: true });
				scriptPath = `/work/frida/${builtin.name}.js`;
				writeFileSync(join(dir, builtin.name + ".js"), builtin.source);
			} else {
				const hostPath = join(ctx.workDir(), params.script.replace(/^\/work\/?/, ""));
				if (!existsSync(hostPath)) {
					return failure(
						`脚本不存在：${params.script}。内建脚本：${builtinScriptNames().join("、")}；或给一个 /work 下的自定义脚本路径`,
					);
				}
				scriptPath = `/work/${params.script.replace(/^\/work\/?/, "")}`;
			}
			// The script may reference its own filename in logs; keep the basename stable.
			void basename(scriptPath);

			const seconds = Math.min(Math.max(params.seconds ?? 20, 5), 300);
			const target = /^\d+$/.test(params.app)
				? `--pid ${params.app}`
				: params.mode === "spawn"
					? `-f ${params.app}`
					: `-n '${params.app.replace(/'/g, "")}'`;
			const run = await inContainer(
				ctx,
				`timeout ${seconds + 5} frida -H ${tunnel.address} ${target} -l '${scriptPath}' -q 2>&1 | head -400`,
				(seconds + 10) * 1000,
			);
			const output = run.output.trim();
			if (run.code !== 0 && output.length === 0) {
				return failure(`frida 运行失败（退出码 ${run.code}）`);
			}
			const head = `Frida ${params.mode === "spawn" ? "spawn" : "attach"} ${params.app} · ${seconds}s · ${picked.name}`;
			return {
				content: [
					{
						type: "text",
						text: `${head}\n\n${output.slice(0, 16_000) || "（无输出：脚本可能没有命中，检查 hook 的类名是否存在）"}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	return [setup, fridaPs, frida];
}
