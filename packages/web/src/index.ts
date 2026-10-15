/**
 * Full Chain Sentinel web console entry point.
 *
 * Configuration via environment variables or CLI flags:
 *   SENTINEL_PORT / --port     listen port (default 7777)
 *   SENTINEL_HOST / --host     listen address (default 0.0.0.0, every interface)
 *   SENTINEL_GATE_TOKEN / --gate-token   fixed entry token (default: random per start)
 *   SENTINEL_CWD               working directory for the agent (default: process.cwd())
 *   SENTINEL_CODING_AGENT_DIR   agent config directory (default: ~/.sentinel/agent)
 *
 * Flags:
 *   --check      run the Docker environment check, print it, and exit non-zero when it fails
 *   --no-gate    serve the console at / and skip the secret entry URL
 *   --no-consent skip the first-visit authorization promise
 *   --version    print the console version and the runtime it is running on
 *   --help       print this usage
 */

import { networkInterfaces } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WEB_CONSOLE_VERSION } from "./assets.ts";
import { checkEnvironment } from "./env-check.ts";
import { GATE_TOKEN_MAX_CHARS, GATE_TOKEN_MIN_CHARS, isGateToken } from "./gate.ts";
import type { SentinelEnvReport } from "./protocol.ts";
import { startSentinelServer } from "./server.ts";

const USAGE = `sentinel-web ${WEB_CONSOLE_VERSION} - 全链哨兵 Web 控制台

用法: sentinel-web [选项]

选项:
  --port <端口>    监听端口（默认 7777，环境变量 SENTINEL_PORT）
  --host <地址>    监听地址（默认 0.0.0.0，即所有网卡；环境变量 SENTINEL_HOST）
  --gate-token <串>  固定入口串（默认每次启动随机生成，环境变量 SENTINEL_GATE_TOKEN）
  --no-gate        关闭随机入口，直接以 / 提供服务
  --no-consent     关闭首次进入的授权承诺（默认开启，勾选后才可用）
  --cwd <目录>     工作目录（默认当前目录，环境变量 SENTINEL_CWD）
  --check          只运行 Docker 环境检查并打印结果，未通过时退出码为 1
  --version        打印版本与运行时
  --help           打印本帮助

环境变量:
  SENTINEL_CODING_AGENT_DIR  配置目录（默认 ~/.sentinel/agent）
  SENTINEL_PROJECTS_DIR           项目工作目录根（默认 ~/.sentinel/projects）

默认监听 0.0.0.0，在服务器上直接跑起来就能从外部访问。为了不让 FOFA 这类
引擎扫到并收录，启动时会生成一个随机入口串：日志里打印的
http://<地址>:<端口>/<入口串> 是唯一入口，打开它会给浏览器种一个 cookie 再
跳回 /，其余任何不带这个 cookie 的请求（含 /、静态资源、API、WebSocket）
一律回一个普通的 404。入口串每次启动都变（--gate-token 或 SENTINEL_GATE_TOKEN 可
固定），密码登录照旧生效。

Docker 是硬依赖：所有工具调用都在项目容器内执行。控制台启动后会检查
Docker 守护进程、工具镜像和项目容器；未通过时对话被锁定，请在
「设置 → 环境」中查看原因并构建镜像。`;

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

/** One line per check result: failures and warnings, plus the overall verdict. */
function environmentLines(report: SentinelEnvReport): string[] {
	const failures = report.items.filter((entry) => entry.status === "fail");
	const warnings = report.items.filter((entry) => entry.status === "warn");
	const lines = [
		report.ok
			? `Docker 环境检查通过（${report.items.length} 项）`
			: `Docker 环境检查未通过（${failures.length} 项失败）`,
	];
	for (const entry of failures) {
		lines.push(`  [失败] ${entry.label}: ${entry.detail}`);
		if (entry.hint) lines.push(`         ${entry.hint}`);
	}
	for (const entry of warnings) lines.push(`  [警告] ${entry.label}: ${entry.detail}`);
	return lines;
}

function runtimeLabel(): string {
	const bun = process.versions.bun;
	return bun ? `Bun ${bun}` : `Node ${process.versions.node}`;
}

const port = Number(argValue("--port") ?? process.env.SENTINEL_PORT ?? 7777);
const host = argValue("--host") ?? process.env.SENTINEL_HOST ?? "0.0.0.0";
const cwd = argValue("--cwd") ?? process.env.SENTINEL_CWD ?? process.cwd();
const noGate = process.argv.includes("--no-gate");
const noConsent = process.argv.includes("--no-consent");
const gateToken = argValue("--gate-token") ?? process.env.SENTINEL_GATE_TOKEN;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(USAGE);
	process.exit(0);
}

if (process.argv.includes("--version")) {
	console.log(`sentinel-web ${WEB_CONSOLE_VERSION} (${runtimeLabel()})`);
	process.exit(0);
}

if (process.argv.includes("--check")) {
	const report = await checkEnvironment({ agentDir: getAgentDir(), url: `http://${host}:${port}` });
	for (const line of environmentLines(report)) console.log(line);
	process.exit(report.ok ? 0 : 1);
}

// A hand-written entry token is checked before the console starts: a token with a
// slash or a space in it would silently produce an entry URL that cannot be opened.
if (gateToken && !isGateToken(gateToken)) {
	console.error(
		`--gate-token 只能用 ${GATE_TOKEN_MIN_CHARS}-${GATE_TOKEN_MAX_CHARS} 位的字母、数字、下划线和短横线。`,
	);
	process.exit(1);
}

const { url, environment } = await startSentinelServer({
	port,
	host,
	cwd,
	agentDir: getAgentDir(),
	gate: !noGate,
	consent: !noConsent,
	...(gateToken ? { gateToken } : {}),
});

console.log(`全链哨兵 Web 控制台已启动: ${url}`);
if (!noGate) {
	console.log("  上面这条是入口地址（每次启动随机生成，重启后旧地址失效）；不带入口访问任何路径都返回 404。");
}
// A wildcard bind is reachable from other devices too; naming those addresses
// avoids guessing at one, which is what produces ERR_ADDRESS_INVALID in a
// browser when the guess is stale or is 0.0.0.0 itself.
if (host === "0.0.0.0" || host === "::" || host === "[::]") {
	const bound = new URL(url);
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family !== "IPv4" || address.internal) continue;
			console.log(`  局域网访问 (${name}): http://${address.address}:${bound.port}${bound.pathname}`);
		}
	}
}
console.log(`工作目录: ${cwd}`);
console.log("按 Ctrl+C 停止。");

const report = await environment;
for (const line of environmentLines(report)) console.log(line);
if (!report.ok) {
	console.log(`Docker 环境不可用，对话已锁定。打开 ${url} 的「设置 → 环境」查看原因并构建镜像。`);
}
