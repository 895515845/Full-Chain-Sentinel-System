/**
 * Frida over the reverse tunnel.
 *
 * frida-server runs on the rooted device; the agent's frida CLI runs in the
 * project container and reaches it through a loopback TCP tunnel the gateway
 * bridges into the device's 127.0.0.1:27042. The tools hide that plumbing: setup
 * pushes and starts frida-server, the other tools open the tunnel (reusing a live
 * one for the same port) and run the CLI inside the container.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execInContainer } from "./docker.ts";
import type { DroidToolContext } from "./droid-tool.ts";
import { builtinScriptNames, resolveBuiltinScript, scriptBanner } from "./frida-scripts.ts";

export const FRIDA_TOOL_NAMES: readonly string[] = [
	"droid_frida_setup",
	"droid_frida_ps",
	"droid_frida",
	"droid_unpack",
];
const DEVICE_FRIDA = "/data/local/tmp/frida-server";
const DEVICE_DUMP_DIR = "/data/local/tmp/sentinel-unpack";
const CONTAINER_HOST = "host.docker.internal";
/** Per-script output budget; the section is cut, the rest of the sections kept. */
const SCRIPT_OUTPUT_BUDGET = 6000;

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

/** Turn a scripts spec list into container paths, writing builtin sources to /work/frida. */
async function materializeScripts(
	ctx: DroidToolContext,
	specs: string[],
): Promise<{ paths: string[]; names: string[] } | { error: string }> {
	const dir = join(ctx.workDir(), "frida");
	mkdirSync(dir, { recursive: true });
	const paths: string[] = [];
	const names: string[] = [];
	for (let index = 0; index < specs.length; index++) {
		const spec = specs[index]!.trim();
		const resolved = resolveBuiltinScript(spec);
		if ("error" in resolved) return { error: resolved.error };
		if ("name" in resolved) {
			// Params make the same builtin resolve differently; index keeps runs apart.
			const file = `${resolved.name}-${index}.js`;
			writeFileSync(join(dir, file), resolved.source);
			paths.push(`/work/frida/${file}`);
			names.push(resolved.name);
		} else {
			const rel = resolved.path.replace(/^\/work\/?/, "");
			if (!existsSync(join(ctx.workDir(), rel))) {
				return {
					error: `脚本不存在：${resolved.path}。内建脚本：${builtinScriptNames().join("、")}；或给一个 /work 下的自定义脚本路径`,
				};
			}
			paths.push(`/work/${rel}`);
			names.push(basename(rel));
		}
	}
	return { paths, names };
}

/** Split combined frida output into per-script sections, each within its budget. */
export function sectionOutput(names: string[], output: string): string {
	const sections: string[] = [];
	const consumed = new Set<string>();
	let rest = output;
	for (const name of names) {
		const marker = `===== ${scriptBanner(name)}`;
		const at = rest.indexOf(marker);
		if (at < 0) continue;
		consumed.add(name);
		const next = rest.indexOf("===== sentinel:", at + marker.length);
		const body = (next < 0 ? rest.slice(at) : rest.slice(at, next)).trim();
		sections.push(
			body.length > SCRIPT_OUTPUT_BUDGET ? `${body.slice(0, SCRIPT_OUTPUT_BUDGET)}\n…[该脚本输出已截断]` : body,
		);
		if (next >= 0) rest = rest.slice(0, at) + rest.slice(next);
	}
	if (sections.length === 0) return output.slice(0, SCRIPT_OUTPUT_BUDGET * 2);
	const unmatched = output.length - sections.reduce((sum, s) => sum + s.length, 0);
	const lead = unmatched > 200 ? `${output.slice(0, Math.min(unmatched, 2000))}\n` : "";
	return lead + sections.join("\n\n");
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
		label: "Run Frida scripts against an app",
		defaultActive: false,
		description:
			"Run one or more Frida scripts against an app on the device for a bounded time and return each script's console output. Each entry is a builtin name (okhttp_log / ssl_pinning_bypass / root_detection_bypass / crypto_log / native_ssl_bypass / flutter_bypass / anti_frida_bypass), a builtin with parameters (crypto_log?alg=AES), or a work-directory path to a custom JS file. Scripts run in one injection in the given order; put anti_frida_bypass first when the app detects frida. attach mode targets a running app by name or pid; spawn mode starts it fresh. Each script's output is truncated at its own budget.",
		promptSnippet: "Instrument an app with Frida scripts and collect their output",
		promptGuidelines: [
			"Read the decompiled code (apk_decompile/apk_search) before hooking: hook names must match the target",
			"Stack builtin scripts (e.g. anti_frida_bypass + ssl_pinning_bypass + okhttp_log) instead of three separate runs",
			"Filter noisy builtins by parameter (okhttp_log?url=/api) instead of wading through truncated output",
			"Run for 10-60 seconds per call; long-lived hooks are better done in several bounded runs",
		],
		parameters: Type.Object({
			app: Type.String({ description: "应用：包名/应用名（attach）或进程名+pid（spawn 用包名）" }),
			scripts: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 4,
				description:
					"脚本列表（1-4 个）：内建名（可带 ?参数=值）、或 /work 下自定义脚本路径。多个脚本一次注入按顺序执行",
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
			const tunnel = await tunnelAddress(ctx, picked.id, 27042);
			if (!tunnel.ok) return failure(`隧道建立失败：${tunnel.error}（先运行 droid_frida_setup）`);

			const materialized = await materializeScripts(ctx, params.scripts);
			if ("error" in materialized) return failure(materialized.error);
			const scriptFlags = materialized.paths.map((path) => `-l '${path}'`).join(" ");

			const seconds = Math.min(Math.max(params.seconds ?? 20, 5), 300);
			const target = /^\d+$/.test(params.app)
				? `--pid ${params.app}`
				: params.mode === "spawn"
					? `-f ${params.app}`
					: `-n '${params.app.replace(/'/g, "")}'`;
			const run = await inContainer(
				ctx,
				`timeout ${seconds + 5} frida -H ${tunnel.address} ${target} ${scriptFlags} -q 2>&1`,
				(seconds + 10) * 1000,
			);
			const output = run.output.trim();
			if (run.code !== 0 && output.length === 0) {
				return failure(`frida 运行失败（退出码 ${run.code}）`);
			}
			const head = `Frida ${params.mode === "spawn" ? "spawn" : "attach"} ${params.app} · ${seconds}s · ${picked.name} · 脚本：${materialized.names.join("、")}`;
			return {
				content: [
					{
						type: "text",
						text: `${head}\n\n${sectionOutput(materialized.names, output) || "（无输出：脚本可能没有命中，检查 hook 的类名是否存在）"}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const unpack = defineTool({
		name: "droid_unpack",
		label: "Dump decrypted DEX files from a hardened app",
		defaultActive: false,
		description:
			"Memory-unpack a hardened APK: spawn the app with the dex_dump Frida script (FRIDA-DEXDump style), let the packer finish decrypting, scan process memory for dex magic and save the dumped DEX files into the work directory under evidence/unpack/<package>/. Requires a rooted device with frida-server running (droid_frida_setup first). Returns the saved dex paths; decompile them with apk_decompile afterwards. Note: extracted-code packers (nop method bodies) still dump empty methods — that needs a FART-class active-call dump, out of scope here.",
		promptSnippet: "Dump decrypted DEX from a hardened app into the work directory",
		promptGuidelines: [
			"Run apk_manifest first: if it reports a packer (加固), unpack before decompiling the base APK",
			"Give the app time to reach its main screen (more code loaded = more dex recovered); 30-60 seconds is a good default",
			"The dumped dex usually need jadx one by one; pick the largest ones first",
		],
		parameters: Type.Object({
			app: Type.String({ description: "目标应用包名（spawn 模式启动）" }),
			seconds: Type.Optional(Type.Number({ description: "等待收集秒数，默认 30，上限 120" })),
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean; path?: string }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const tunnel = await tunnelAddress(ctx, picked.id, 27042);
			if (!tunnel.ok) return failure(`隧道建立失败：${tunnel.error}（先运行 droid_frida_setup）`);

			const resolved = resolveBuiltinScript("dex_dump");
			if (!("name" in resolved)) return failure("内置 dex_dump 脚本缺失");
			const dir = join(ctx.workDir(), "frida");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "dex_dump.js"), resolved.source);

			const seconds = Math.min(Math.max(params.seconds ?? 30, 10), 120);
			// The dump script itself scans at ~0.5s and ~8s; give late loaders one more
			// pass by simply running longer.
			const run = await inContainer(
				ctx,
				`timeout ${seconds + 5} frida -H ${tunnel.address} -f '${params.app.replace(/'/g, "")}' -l '/work/frida/dex_dump.js' -q 2>&1`,
				(seconds + 10) * 1000,
			);
			const listing = await gateway.request(
				picked.id,
				{ t: "exec", cmd: `ls -la ${DEVICE_DUMP_DIR}/ 2>/dev/null | head -50`, asRoot: true, timeoutMs: 15_000 },
				{ timeoutMs: 25_000 },
			);
			const listed = listing.ok ? (listing.stdout ?? "") : "";
			if (!listing.ok || !/\.dex/.test(listed)) {
				return failure(
					`未 dump 到任何 dex。frida 输出：\n${run.output.trim().slice(0, 2000) || "（无输出）"}\n\n` +
						`排查：app 是否被杀（先跑 anti_frida_bypass）；壳是否把解密 dex 放到只执行内存（该工具覆盖不了）`,
				);
			}
			const count = (listed.match(/\.dex/g) ?? []).length;
			const pack = params.app.replace(/[^A-Za-z0-9._-]/g, "");
			const deviceTar = `/data/local/tmp/sentinel-unpack-${pack}.tar`;
			const tar = await gateway.request(
				picked.id,
				{
					t: "exec",
					cmd: `rm -f ${deviceTar}; tar cf ${deviceTar} -C ${DEVICE_DUMP_DIR} . && echo done`,
					asRoot: true,
					timeoutMs: 60_000,
				},
				{ timeoutMs: 70_000 },
			);
			if (!tar.ok) return failure(`打包失败：${tar.error ?? "未知错误"}`);

			// Pull the tar into the work directory, then untar in the container so the
			// dex files land under evidence/unpack/<package>/ as ordinary files.
			const hostTar = join(ctx.workDir(), "evidence", "unpack", `${pack}.tar`);
			mkdirSync(join(ctx.workDir(), "evidence", "unpack"), { recursive: true });
			const fd = openSync(hostTar, "w");
			let written = 0;
			const pull = await gateway
				.request(
					picked.id,
					{ t: "pull", path: deviceTar, maxBytes: 256 * 1024 * 1024 },
					{
						timeoutMs: 120_000,
						onData: (chunk) => {
							writeSync(fd, chunk);
							written += chunk.length;
						},
					},
				)
				.finally(() => closeSync(fd));
			if (!pull.ok || written === 0) {
				rmSync(hostTar, { force: true });
				return failure(`拉取失败：${pull.ok ? "tar 为空" : (pull.error ?? "未知错误")}`);
			}
			const outDir = `/work/evidence/unpack/${pack}`;
			const extract = await execInContainer(
				ctx.container(),
				`rm -rf '${outDir}' && mkdir -p '${outDir}' && tar xf '/work/evidence/unpack/${pack}.tar' -C '${outDir}' && ls -la '${outDir}' | head -40`,
				[],
				{ timeoutMs: 120_000 },
			);
			if (extract.code !== 0) return failure(`解包失败：${(extract.stderr || extract.stdout).slice(0, 1000)}`);
			return {
				content: [
					{
						type: "text",
						text:
							`脱壳完成：${picked.name} 上的 ${params.app}，dump 到 ${count} 个 dex，已解包到 ${outDir}（工作目录 evidence/unpack/${pack}/）。\n` +
							`设备侧清单：\n${listed}\n下一步：apk_decompile 最大的几个 dex（apk 参数直接给 dex 路径也可以用 jadx）。`,
					},
				],
				details: { ok: true, path: outDir },
			};
		},
	});

	return [setup, fridaPs, frida, unpack];
}
