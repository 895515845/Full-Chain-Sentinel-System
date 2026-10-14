/**
 * The agent's hands on the phone.
 *
 * Every tool goes through the reverse gateway; none of them talks to a device
 * directly. They are registered on every console session with
 * `defaultActive: false` and mounted only while the operator enabled the Droid
 * switch on the device page — an Android toolset in a Web-pentest session is
 * prompt noise, exactly the problem the modeling run tools solved.
 *
 * `droid_shell` is the dangerous one: on a rooted device it is a root shell. It
 * goes through the same approval chain as container bash (mode auto/review/ai),
 * so the judge sees "设备「X」" as the source and the audit trail lands in
 * gatekeeper.db like every other command.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execInContainer } from "./docker.ts";
import type { DroidGateway } from "./droid-gateway.ts";

/** Every tool name this plugin registers, for mount/unmount as one switch. */
export const DROID_TOOL_NAMES: readonly string[] = [
	"droid_devices",
	"droid_shell",
	"droid_file_pull",
	"droid_file_push",
	"droid_screencap",
	"droid_logcat",
	"droid_list_packages",
	"apk_decompile",
	"apk_manifest",
	"apk_search",
];

/** What the runtime provides; everything device-specific stays behind it. */
export interface DroidToolContext {
	gateway: () => DroidGateway | undefined;
	/** The device page's switch; false means the tools are not even mounted. */
	enabled: () => boolean;
	/** The active project's container, for the apk_* tools' jadx/apktool runs. */
	container: () => string;
	/** Host work directory; evidence files are saved under it. */
	workDir: () => string;
	/**
	 * The approval chain for device commands (mode auto/review/ai). Returns the
	 * command that may run (the approval card may edit it), or rejects with a
	 * Chinese reason when it must not.
	 */
	guard: (deviceName: string, command: string) => Promise<string>;
}

function failure(text: string): AgentToolResult<{ ok: boolean }> {
	return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
}

function truncate(text: string | undefined, max = 16_000): string {
	const value = text ?? "";
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n…[输出过长已截断，共 ${value.length} 字符]`;
}

/** Pick the device: the id when given, the only online device otherwise. */
function pickDevice(ctx: DroidToolContext, device: string | undefined): { id: string; name: string } | string {
	const gateway = ctx.gateway();
	if (!gateway) return "设备网关未启动";
	const online = gateway.onlineDevices();
	if (online.length === 0) return "没有在线的安卓设备：先在手机上打开 DroidBridge 并等待反连成功";
	if (device?.trim()) {
		const needle = device.trim();
		const found =
			online.find((candidate) => candidate.id === needle) ?? online.find((candidate) => candidate.name === needle);
		if (!found) {
			return `设备「${needle}」不在线。在线设备：${online.map((candidate) => `${candidate.name}(${candidate.id.slice(0, 8)})`).join("、")}`;
		}
		return { id: found.id, name: found.name };
	}
	if (online.length > 1) {
		return `多台设备在线，请用 device 参数指定：${online.map((candidate) => `${candidate.name}(${candidate.id.slice(0, 8)})`).join("、")}`;
	}
	return { id: online[0]!.id, name: online[0]!.name };
}

const deviceParam = Type.Optional(Type.String({ description: "目标设备：deviceId 或设备名；只有一台在线时可省略" }));

export function createDroidTools(ctx: DroidToolContext): ToolDefinition[] {
	const devices = defineTool({
		name: "droid_devices",
		label: "List Android devices",
		defaultActive: false,
		description:
			"List the Android devices connected through the reverse channel, online first: device id, name, model, Android version, root state, last seen. Use a device id or name from here in every other droid_* tool.",
		promptSnippet: "List the Android devices reachable over the reverse channel",
		parameters: Type.Object({}),
		async execute(): Promise<AgentToolResult<{ ok: boolean }>> {
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const online = gateway.onlineDevices();
			const all = ctx.enabled() ? online : online;
			if (all.length === 0) return failure("没有在线的安卓设备：在手机上打开 DroidBridge，等它反连成功后重试。");
			const lines = all.map(
				(device) =>
					`- ${device.name} [id: ${device.id}] · ${device.model} · Android ${device.androidVersion} (SDK ${device.sdkInt}) · ${device.rooted ? "已 root" : "未 root"} · ${device.online ? "在线" : "离线"}`,
			);
			return {
				content: [{ type: "text", text: `在线设备 ${all.length} 台：\n${lines.join("\n")}` }],
				details: { ok: true },
			};
		},
	});

	const shell = defineTool({
		name: "droid_shell",
		label: "Run a shell command on the device",
		defaultActive: false,
		description:
			"Run one shell command on a connected Android device and return its exit code, stdout and stderr. On a rooted device pass asRoot to run through su — that is a root shell, so treat the device like a live target: no destructive operations beyond the objective. Long output is truncated; redirect to a file and droid_file_pull it when you need everything.",
		promptSnippet: "Run a shell command on a connected Android device (root available with asRoot)",
		promptGuidelines: [
			"Prefer one focused command per call; quote paths that contain spaces",
			"asRoot runs through su — use it for package installs, /data access and frida-server, not by habit",
			"Output beyond 16k characters is truncated: write to a file under /data/local/tmp and pull it instead",
		],
		parameters: Type.Object({
			command: Type.String({
				description:
					"要在设备上执行的 shell 命令，例如 id / pm list packages -3 / getprop ro.build.version.release",
			}),
			device: deviceParam,
			asRoot: Type.Optional(Type.Boolean({ description: "true 时通过 su 以 root 执行（默认 false）" })),
			timeoutSecs: Type.Optional(Type.Number({ description: "超时秒数，默认 30，上限 600" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const timeoutMs = Math.min(Math.max(Math.round((params.timeoutSecs ?? 30) * 1000), 1000), 600_000);
			try {
				await ctx.guard(picked.name, params.command);
			} catch (error) {
				return failure(`命令未执行：${error instanceof Error ? error.message : String(error)}`);
			}
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(
				picked.id,
				{ t: "exec", cmd: params.command, asRoot: params.asRoot === true, timeoutMs },
				{ timeoutMs: timeoutMs + 10_000 },
			);
			if (!result.ok) return failure(`执行失败：${result.error ?? "未知错误"}`);
			const head = `设备 ${picked.name} · 退出码 ${result.code ?? -1}${params.asRoot === true ? "（root）" : ""}`;
			const body = [
				result.stdout ? `stdout:\n${truncate(result.stdout)}` : "stdout: (空)",
				result.stderr ? `stderr:\n${truncate(result.stderr)}` : null,
			]
				.filter(Boolean)
				.join("\n\n");
			return { content: [{ type: "text", text: `${head}\n\n${body}` }], details: { ok: true } };
		},
	});

	const filePull = defineTool({
		name: "droid_file_pull",
		label: "Pull a file from the device",
		defaultActive: false,
		description:
			"Copy a file from the connected Android device into the project work directory under evidence/droid/, and return that path. Use it for pulled APKs, databases, pcaps and anything else worth keeping as evidence. Refuses files larger than 256 MB.",
		promptSnippet: "Copy a file from the device into the work directory as evidence",
		parameters: Type.Object({
			path: Type.String({
				description: "设备上的文件绝对路径，例如 /data/app/…/base.apk 或 /data/local/tmp/capture.pcap",
			}),
			device: deviceParam,
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean; path?: string }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(
				picked.id,
				{ t: "pull", path: params.path, maxBytes: 256 * 1024 * 1024 },
				{
					timeoutMs: 120_000,
				},
			);
			if (!result.ok) return failure(`拉取失败：${result.error ?? "未知错误"}`);
			const bytes = result.bytes ?? Buffer.alloc(0);
			if (bytes.length === 0) return failure(`文件为空或不存在：${params.path}`);
			const dir = join(ctx.workDir(), "evidence", "droid");
			mkdirSync(dir, { recursive: true });
			const target = join(dir, `${Date.now()}-${basename(params.path)}`);
			writeFileSync(target, bytes);
			return {
				content: [
					{
						type: "text",
						text: `已拉取 ${picked.name}:${params.path} → ${target}（${bytes.length} 字节）。该路径在工作目录内，可直接作为漏洞证据引用。`,
					},
				],
				details: { ok: true, path: target },
			};
		},
	});

	const filePush = defineTool({
		name: "droid_file_push",
		label: "Push a work-directory file to the device",
		defaultActive: false,
		description:
			"Copy a file from the project work directory onto the device, for example a patched APK to install or a frida script to run. Refuses files larger than 256 MB.",
		promptSnippet: "Copy a work-directory file onto the device",
		parameters: Type.Object({
			path: Type.String({ description: "工作目录内的文件路径（/work 下），例如 /work/target-patched.apk" }),
			devicePath: Type.String({ description: "推送到设备上的目标绝对路径，例如 /data/local/tmp/target.apk" }),
			device: deviceParam,
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			let bytes: Buffer;
			try {
				bytes = readFileSync(join(ctx.workDir(), params.path.replace(/^\/work\/?/, "")));
			} catch (error) {
				return failure(`读取工作目录文件失败：${error instanceof Error ? error.message : String(error)}`);
			}
			if (bytes.length > 256 * 1024 * 1024) return failure("文件超过 256MB 上限");
			// One frame per ~4MB keeps base64 under the gateway's message cap.
			const result = await gateway.request(
				picked.id,
				{ t: "push", path: params.devicePath, b64: bytes.toString("base64") },
				{ timeoutMs: 180_000 },
			);
			if (!result.ok) return failure(`推送失败：${result.error ?? "未知错误"}`);
			return {
				content: [{ type: "text", text: `已推送到 ${picked.name}:${params.devicePath}（${bytes.length} 字节）` }],
				details: { ok: true },
			};
		},
	});

	const screencap = defineTool({
		name: "droid_screencap",
		label: "Take a device screenshot",
		defaultActive: false,
		description:
			"Capture the device screen as a PNG into the work directory under evidence/droid/ and return the path. Use it to record what an app showed at a moment, as vulnerability evidence or to see a UI flow.",
		promptSnippet: "Capture the device screen as evidence",
		parameters: Type.Object({ device: deviceParam }),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean; path?: string }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(picked.id, { t: "screencap" }, { timeoutMs: 30_000 });
			if (!result.ok) return failure(`截屏失败：${result.error ?? "未知错误"}`);
			const bytes = result.bytes ?? Buffer.alloc(0);
			if (bytes.length === 0) return failure("截屏内容为空（设备可能已锁屏）");
			const dir = join(ctx.workDir(), "evidence", "droid");
			mkdirSync(dir, { recursive: true });
			const target = join(dir, `screencap-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
			writeFileSync(target, bytes);
			return {
				content: [{ type: "text", text: `截屏已保存：${target}（${bytes.length} 字节）` }],
				details: { ok: true, path: target },
			};
		},
	});

	const logcat = defineTool({
		name: "droid_logcat",
		label: "Read device logcat",
		defaultActive: false,
		description:
			"Read the last N lines of the device log (logcat), optionally filtered by a tag or text. On a rooted device this is the whole system log — leaked secrets, stack traces and IPC between components show up here. Verbose output is truncated.",
		promptSnippet: "Read recent device logcat lines (filterable)",
		parameters: Type.Object({
			device: deviceParam,
			lines: Type.Optional(Type.Number({ description: "读取行数，默认 200，上限 2000" })),
			filter: Type.Optional(Type.String({ description: "过滤文本，例如包名或 tag" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(
				picked.id,
				{ t: "logcat", lines: Math.min(Math.max(params.lines ?? 200, 1), 2000), filter: params.filter },
				{ timeoutMs: 45_000 },
			);
			if (!result.ok) return failure(`读取失败：${result.error ?? "未知错误"}`);
			return {
				content: [
					{
						type: "text",
						text: `设备 ${picked.name} logcat（${params.filter ?? "无过滤"}）：\n${truncate(result.stdout)}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const packages = defineTool({
		name: "droid_list_packages",
		label: "List installed packages",
		defaultActive: false,
		description:
			"List installed packages on the device, third-party only by default. Use it to find the target app's package name before spawning Frida or pulling its APK.",
		promptSnippet: "List installed packages on the device",
		parameters: Type.Object({
			device: deviceParam,
			all: Type.Optional(Type.Boolean({ description: "true 时包含系统应用（默认只列第三方）" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(
				picked.id,
				{ t: "packages", thirdPartyOnly: params.all !== true },
				{
					timeoutMs: 30_000,
				},
			);
			if (!result.ok) return failure(`读取失败：${result.error ?? "未知错误"}`);
			return {
				content: [{ type: "text", text: `设备 ${picked.name} 已安装包：\n${truncate(result.stdout)}` }],
				details: { ok: true },
			};
		},
	});

	return [devices, shell, filePull, filePush, screencap, logcat, packages];
}

/** Container-side static analysis: the APK never leaves /work, the tools run next to it. */
export function createApkTools(ctx: DroidToolContext): ToolDefinition[] {
	const runJadxTool = (
		name: string,
		label: string,
		description: string,
		promptSnippet: string,
		script: (outDir: string, apkPath: string) => string,
		defaultTimeoutMs = 600_000,
	): ToolDefinition =>
		defineTool({
			name,
			label,
			defaultActive: false,
			description,
			promptSnippet,
			promptGuidelines: [
				"Decompiled output lands under /work/decompiled/<name>/ — search it with apk_search instead of re-decompiling",
			],
			parameters: Type.Object({
				apk: Type.String({ description: "APK 在工作目录内的路径，例如 /work/target.apk" }),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean; path?: string }>> {
				const apkPath = params.apk.replace(/^\/work\/?/, "");
				const hostApk = join(ctx.workDir(), apkPath);
				const outName = basename(apkPath).replace(/\.apk$/i, "");
				const outDir = `/work/decompiled/${outName}`;
				const result = await execInContainer(ctx.container(), script(outDir, `/work/${apkPath}`), [], {
					timeoutMs: defaultTimeoutMs,
				});
				if (result.code !== 0) {
					return failure(`反编译失败（退出码 ${result.code}）：${truncate(result.stderr || result.stdout, 4000)}`);
				}
				return {
					content: [
						{
							type: "text",
							text: `反编译完成：${hostApk} → ${outDir}（容器内路径，工作目录 decompiled/${outName}/）`,
						},
					],
					details: { ok: true, path: outDir },
				};
			},
		});

	const decompile = runJadxTool(
		"apk_decompile",
		"Decompile an APK",
		"Decompile an APK from the work directory with jadx (Java sources) and apktool (resources, decoded manifest) into /work/decompiled/<name>/. Large APKs take minutes; the command is safe to re-run.",
		"Decompile an APK into sources and resources for analysis",
		(outDir, apkPath) =>
			`set -e; rm -rf '${outDir}'; mkdir -p '${outDir}'; jadx -d '${outDir}/src' --no-res -j 4 '${apkPath}' 2>'${outDir}/jadx.err' || true; apktool d -f -o '${outDir}/res' '${apkPath}' > '${outDir}/apktool.log' 2>&1 || true; ls '${outDir}'`,
	);

	const manifest = defineTool({
		name: "apk_manifest",
		label: "Summarize an APK's manifest and attack surface",
		defaultActive: false,
		description:
			"Parse an APK's decoded manifest (run apk_decompile first) and summarize the client-side attack surface: package, version, permissions, exported components, deep links, debuggable/backup/cleartext flags and WebView hints. The output ends with the checklist of what to verify by hand.",
		promptSnippet: "Summarize an APK's manifest attack surface",
		parameters: Type.Object({
			apk: Type.String({ description: "APK 在工作目录内的路径；必须已经 apk_decompile 过" }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean; path?: string }>> {
			const outName = basename(params.apk).replace(/\.apk$/i, "");
			const dir = `/work/decompiled/${outName}`;
			const result = await execInContainer(
				ctx.container(),
				`set -e; f=$(find '${dir}/res' -name AndroidManifest.xml | head -1); [ -n "$f" ] || { echo '未找到 AndroidManifest.xml：请先 apk_decompile'; exit 1; }; python3 - "$f" <<'PYEOF'
import re, sys, xml.etree.ElementTree as ET
tree = ET.parse(sys.argv[1])
root = tree.getroot()
ns = "{http://schemas.android.com/apk/res/android}"
def attr(el, name): return el.get(ns + name, "")
print("package:", root.get("package"))
app = root.find("application")
print("versionName:", attr(app, "versionName") if app is not None else "")
print("debuggable:", attr(app, "debuggable") or "false")
print("backup:", attr(app, "allowBackup") or "true")
print("cleartextTraffic:", attr(app, "usesCleartextTraffic") or "false(默认，targetSdk>=28 为 false)")
print("networkSecurityConfig:", attr(app, "networkSecurityConfig") or "未配置")
print("\n== 权限 ==")
for u in root.findall("uses-permission"): print("-", attr(u, "name"))
print("\n== 导出组件 ==")
for kind in ("activity", "activity-alias", "service", "receiver", "provider"):
    for el in root.iter(kind):
        exported = attr(el, "exported")
        name = attr(el, "name")
        if exported == "true" or (exported == "" and any(i for i in el.findall("intent-filter"))):
            actions = [a.get(ns+"name") for a in el.findall("intent-filter/action")]
            datas = [(d.get(ns+"scheme",""), d.get(ns+"host","")) for d in el.findall("intent-filter/data")]
            print(f"- [{kind}] {name} actions={actions} data={datas}")
print("\n== WebView 提示（源码检索建议）==")
print("在反编译源码里检索 addJavascriptInterface / setJavaScriptEnabled / setAllowFileAccess / loadUrl")
PYEOF`,
				[],
				{ timeoutMs: 120_000 },
			);
			if (result.code !== 0) return failure(`解析失败：${truncate(result.stderr || result.stdout, 4000)}`);
			return {
				content: [
					{
						type: "text",
						text: `${truncate(result.stdout, 20_000)}\n\n检查清单：导出组件是否可被外部应用调用拉起敏感界面；debuggable/backup 是否关闭；cleartext 是否允许；WebView 的 JS 桥与 file 访问；硬编码密钥（apk_search 'password|secret|api[_-]?key'）。`,
					},
				],
				details: { ok: true, path: dir },
			};
		},
	});

	const search = defineTool({
		name: "apk_search",
		label: "Search decompiled APK sources",
		defaultActive: false,
		description:
			"Grep a decompiled APK tree (run apk_decompile first) for a POSIX extended regex, in sources, resources or both. Use it for hardcoded secrets, crypto constants, URLs and endpoints; matches are truncated per line.",
		promptSnippet: "Search decompiled APK code and resources for a regex",
		parameters: Type.Object({
			apk: Type.String({ description: "APK 在工作目录内的路径；必须已经 apk_decompile 过" }),
			pattern: Type.String({ description: "POSIX 扩展正则，例如 api[._-]?key|secret|https?://" }),
			scope: Type.Optional(
				Type.String({ description: "src（默认，只搜 Java/Kotlin 源码）、res（资源与 smali）或 all" }),
			),
			limit: Type.Optional(Type.Number({ description: "最多返回行数，默认 200" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const outName = basename(params.apk).replace(/\.apk$/i, "");
			const dir = `/work/decompiled/${outName}`;
			const scopeDir = params.scope === "res" ? `${dir}/res` : params.scope === "all" ? dir : `${dir}/src`;
			const limit = Math.min(Math.max(params.limit ?? 200, 1), 1000);
			const result = await execInContainer(
				ctx.container(),
				`[ -d '${scopeDir}' ] || { echo '目录不存在：请先 apk_decompile'; exit 1; }; grep -rInE --include='*.java' --include='*.kt' --include='*.xml' --include='*.smali' -- ${"'"}'${params.pattern.replace(/'/g, `'\\''`)}'${"'"}' ${scopeDir} 2>/dev/null | head -${limit}; echo "---"; grep -rIlE -- ${"'"}'${params.pattern.replace(/'/g, `'\\''`)}'${"'"}' ${scopeDir} 2>/dev/null | wc -l`,
				[],
				{ timeoutMs: 120_000 },
			);
			const text = result.stdout;
			return {
				content: [{ type: "text", text: `检索 ${scopeDir}（${params.pattern}）：\n${truncate(text, 20_000)}` }],
				details: { ok: true },
			};
		},
	});

	return [decompile, manifest, search];
}
