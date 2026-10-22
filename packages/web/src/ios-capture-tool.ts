/**
 * tcpdump on an iPhone, driven over the reverse gateway.
 *
 * The flow mirrors the Android capture tools: start tcpdump on the device,
 * let the operator use the target app, then pull the pcap into
 * evidence/ios/captures/ and summarize it with tshark in the project
 * container. iOS differences are the binary path (rootless puts it under
 * /var/jb) and the interface names (en0 / pdp_ip0 instead of wlan0 / rmnet).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execInContainer } from "./docker.ts";
import { containerPath, type IosToolContext } from "./ios-tool.ts";
import { parseTsharkHttpJson } from "./pcap-http.ts";

/** Mounted and unmounted with the rest of the iOS tools. */
export const IOS_CAPTURE_TOOL_NAMES: readonly string[] = [
	"ios_capture_start",
	"ios_capture_status",
	"ios_capture_pull",
];

const DEVICE_PCAP = "/var/tmp/sentinel-capture.pcap";
const DEVICE_LOG = "/var/tmp/sentinel-capture.log";
const DEVICE_PID = "/var/tmp/sentinel-capture.pid";
/** tcpdump ships with the jailbreak, not with iOS; check every common prefix. */
const TCPDUMP_CANDIDATES = ["/var/jb/usr/bin/tcpdump", "/usr/bin/tcpdump", "/usr/local/bin/tcpdump"];

function failure(text: string): AgentToolResult<{ ok: boolean }> {
	return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
}

/** Single-quote a value for the device shell; the exec frame is a shell string. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function pickDevice(ctx: IosToolContext, device: string | undefined): { id: string; name: string } | string {
	const gateway = ctx.gateway();
	if (!gateway) return "设备网关未启动";
	const online = gateway.onlineDevices();
	if (online.length === 0) return "没有在线的 iOS 设备：先在越狱设备上打开 SentinelBridge 并等待反连成功";
	if (device?.trim()) {
		const needle = device.trim();
		const found =
			online.find((candidate) => candidate.id === needle) ?? online.find((candidate) => candidate.name === needle);
		if (!found) return `设备「${needle}」不在线`;
		return { id: found.id, name: found.name };
	}
	if (online.length > 1) return "多台设备在线，请用 device 参数指定";
	return { id: online[0]!.id, name: online[0]!.name };
}

function clip(text: string, max = 12_000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`;
}

/** Evidence directory for pcaps; kept apart from files/ and screenshots/. */
function captureDir(ctx: IosToolContext): string {
	const dir = join(ctx.workDir(), "evidence", "ios", "captures");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Same path rule as the other iOS tools: never write outside the project. */
function insideWorkDir(ctx: IosToolContext, path: string): string {
	const root = resolve(ctx.workDir());
	const target = resolve(root, path);
	if (target !== root && !target.startsWith(root + sep)) throw new Error(`路径必须位于工程目录内：${path}`);
	return target;
}

export function createIosCaptureTools(ctx: IosToolContext): ToolDefinition[] {
	const start = defineTool({
		name: "ios_capture_start",
		label: "Start a packet capture on the iPhone",
		defaultActive: false,
		description:
			"Start tcpdump on the jailbroken iPhone, writing /var/tmp/sentinel-capture.pcap. Capture covers the chosen interface; HTTPS bodies stay encrypted, so pair the pcap with ios_frida (ios_ssl_bypass + custom hooks) when you need plaintext. ios_capture_pull stops the capture, pulls the file into evidence/ios/captures/ and parses it with tshark. Requires the jailbreak's tcpdump package.",
		promptSnippet: "Start tcpdump on the iPhone",
		promptGuidelines: [
			"Default interface any works with the Procursus tcpdump; use en0 for Wi-Fi or pdp_ip0 for cellular when it does not",
			"A BPF filter (for example host api.example.com) keeps the pcap small and the analysis focused",
		],
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
			iface: Type.Optional(Type.String({ description: "网卡，默认 any；Wi-Fi 用 en0，蜂窝用 pdp_ip0" })),
			filter: Type.Optional(Type.String({ description: "BPF 过滤表达式，例如 host api.example.com" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const iface = (params.iface ?? "any").trim() || "any";
			const filter = params.filter?.trim() ? ` ${shellQuote(params.filter.trim())}` : "";
			const command = [
				'TD=""',
				`for p in ${TCPDUMP_CANDIDATES.join(" ")}`,
				"do",
				'  if [ -x "$p" ]; then TD="$p"; break; fi',
				"done",
				'if [ -z "$TD" ]; then echo NO_TCPDUMP; exit 3; fi',
				`if [ -f ${DEVICE_PID} ]; then kill "$(cat ${DEVICE_PID})" 2>/dev/null; rm -f ${DEVICE_PID}; fi`,
				"sleep 0.3",
				`nohup "$TD" -i ${shellQuote(iface)} -s0 -w ${DEVICE_PCAP}${filter} > ${DEVICE_LOG} 2>&1 & echo $! > ${DEVICE_PID}`,
				"sleep 1",
				`if [ -f ${DEVICE_PID} ] && kill -0 "$(cat ${DEVICE_PID})" 2>/dev/null; then echo "STARTED $TD"; else echo FAILED; tail -5 ${DEVICE_LOG} 2>/dev/null; fi`,
			].join("\n");
			const result = await gateway.request(
				picked.id,
				{ t: "exec", cmd: command, asRoot: false, timeoutMs: 20_000 },
				{ timeoutMs: 30_000 },
			);
			if (!result.ok) return failure(`启动失败：${result.error ?? "未知错误"}`);
			const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
			if (output.includes("NO_TCPDUMP")) {
				return failure(
					"设备上没有 tcpdump。请在 Sileo 安装 tcpdump 后重试（rootless 会装到 /var/jb/usr/bin/tcpdump）",
				);
			}
			if (!output.includes("STARTED")) return failure(`tcpdump 未启动：\n${output}`);
			return {
				content: [
					{
						type: "text",
						text: `已在 ${picked.name} 上开始抓包（接口 ${iface}${params.filter ? `，过滤 ${params.filter}` : ""}）。操作几步目标 App 后用 ios_capture_pull 停止并解析。\n${output}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const status = defineTool({
		name: "ios_capture_status",
		label: "Check the iPhone capture",
		defaultActive: false,
		description: "Whether tcpdump is running on the iPhone and how large the pcap has grown.",
		promptSnippet: "Check the running iPhone capture's size",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(
				picked.id,
				{
					t: "exec",
					cmd: `ls -l ${DEVICE_PCAP} 2>/dev/null || echo none; if [ -f ${DEVICE_PID} ] && kill -0 "$(cat ${DEVICE_PID})" 2>/dev/null; then echo running; else echo stopped; fi`,
					asRoot: false,
					timeoutMs: 15_000,
				},
				{ timeoutMs: 25_000 },
			);
			if (!result.ok) return failure(`查询失败：${result.error ?? "未知错误"}`);
			return {
				content: [{ type: "text", text: `${picked.name} 抓包状态：\n${result.stdout ?? ""}` }],
				details: { ok: true },
			};
		},
	});

	const pull = defineTool({
		name: "ios_capture_pull",
		label: "Stop the iPhone capture, pull the pcap and parse it",
		defaultActive: false,
		description:
			"Stop tcpdump on the iPhone, pull the pcap into evidence/ios/captures/ and parse it in the container with tshark: protocol statistics, plaintext HTTP request lines and DNS queries. The pcap path doubles as evidence. HTTPS shows only endpoints unless a frida hook decrypted the traffic.",
		promptSnippet: "Stop the iPhone capture, pull the pcap and summarize it",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
			localPath: Type.Optional(Type.String({ description: "工程内的目标路径；省略时存到 evidence/ios/captures/" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean; path?: string }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			await gateway.request(
				picked.id,
				{
					t: "exec",
					cmd: `if [ -f ${DEVICE_PID} ]; then kill "$(cat ${DEVICE_PID})" 2>/dev/null; rm -f ${DEVICE_PID}; fi; sleep 1`,
					asRoot: false,
					timeoutMs: 10_000,
				},
				{ timeoutMs: 20_000 },
			);
			const pulled = await gateway.request(
				picked.id,
				{ t: "pull", path: DEVICE_PCAP, maxBytes: 512 * 1024 * 1024 },
				{ timeoutMs: 300_000 },
			);
			if (!pulled.ok) return failure(`拉取失败：${pulled.error ?? "未知错误"}`);
			const bytes = pulled.bytes ?? Buffer.alloc(0);
			if (bytes.length === 0) return failure("pcap 为空：抓包期间可能没有流量，或 tcpdump 未真正启动");
			let target: string;
			try {
				target = params.localPath
					? insideWorkDir(ctx, params.localPath)
					: join(captureDir(ctx), `ios-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.pcap`);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, bytes);
			const cPath = containerPath(ctx, target);
			const parsed = await execInContainer(
				ctx.container(),
				[
					`f="$1"`,
					`echo '== 协议分布 =='; tshark -r "$f" -q -z io,phs 2>/dev/null | head -30`,
					`echo; echo '== 明文 HTTP 请求 =='; tshark -r "$f" -Y http.request -T fields -e frame.number -e ip.dst -e http.host -e http.request.method -e http.request.uri 2>/dev/null | head -60`,
					`echo; echo '== DNS 查询 =='; tshark -r "$f" -Y 'dns.flags.response==0' -T fields -e dns.qry.name 2>/dev/null | sort -u | head -40`,
					`echo; echo '== TLS SNI =='; tshark -r "$f" -Y 'tls.handshake.extensions_server_name' -T fields -e tls.handshake.extensions_server_name 2>/dev/null | sort -u | head -40`,
				].join("; "),
				[cPath],
				{ timeoutMs: 300_000 },
			);
			const summary = `${parsed.stdout}${parsed.stderr ? `\n${parsed.stderr}` : ""}`.trim() || "（tshark 无输出）";
			// The pcap is plaintext-only. Pulling the HTTP exchanges into the
			// evidence store makes them searchable and replayable; HTTPS still
			// needs ios_http_log, which sees NSURLSession before TLS.
			let storeLine = "未选择项目：pcap 已保存，但未写入 HTTP 证据库。";
			const project = ctx.project?.() ?? null;
			if (ctx.store && project) {
				const tshark = await execInContainer(
					ctx.container(),
					'tshark -r "$1" -Y http --no-duplicate-keys -T json',
					[cPath],
					{
						timeoutMs: 300_000,
					},
				);
				if (tshark.code === 0) {
					const entries = parseTsharkHttpJson(tshark.stdout);
					if (entries.length > 0) {
						const imported = ctx.store().importEntries(project.id, `ios_capture:${picked.name}`, entries);
						storeLine = `HTTP 证据入库 ${imported.imported} 条（项目 ${project.name}），可用 capture_search/capture_replay。`;
					} else {
						storeLine = "pcap 中没有明文 HTTP 请求（HTTPS 已加密）：用 ios_http_log 采集 NSURLSession 明文。";
					}
				} else {
					storeLine = `pcap 已保存，但 tshark 转 HTTP 失败：${(tshark.stderr || tshark.stdout).trim().slice(0, 500)}`;
				}
			}
			return {
				content: [
					{
						type: "text",
						text: `pcap 已保存：${target}（${bytes.length} 字节，容器内 ${relative(ctx.workDir(), target)}）\n${storeLine}\n\n${clip(summary)}`,
					},
				],
				details: { ok: true, path: target },
			};
		},
	});

	return [start, status, pull];
}
