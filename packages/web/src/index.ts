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
 *   --no-tls     serve plain HTTP instead of HTTPS (self-signed by default)
 *   --tls-cert <p> / --tls-key <p>  use an operator-provided certificate pair
 *   --tls-regen  re-sign the self-signed certificate (after the host changed networks)
 *   --version    print the console version and the runtime it is running on
 *   --help       print this usage
 */

import { networkInterfaces } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WEB_CONSOLE_VERSION } from "./assets.ts";
import { checkEnvironment } from "./env-check.ts";
import { GATE_TOKEN_MAX_CHARS, GATE_TOKEN_MIN_CHARS, isGateToken } from "./gate.ts";
import { runPluginHostCli } from "./plugin-host/index.ts";
import type { SentinelEnvReport } from "./protocol.ts";
import { startSentinelServer } from "./server.ts";
import { ensureTlsCertificate, storedNamesCoverCurrentIps, tlsCertPath } from "./tls.ts";

// `plugin-host` is a second program behind the same binary: run it before the console's
// own argument handling so its flags are never read as console flags.
if (process.argv[2] === "plugin-host") {
	process.exit(await runPluginHostCli(process.argv.slice(3)));
}

const USAGE = `sentinel-web ${WEB_CONSOLE_VERSION} - 全链哨兵 Web 控制台

用法: sentinel-web [选项]
      sentinel-web plugin-host [选项]   启动社区插件主机（见 plugin-host --help）

选项:
  --port <端口>    监听端口（默认 7777，环境变量 SENTINEL_PORT）
  --host <地址>    监听地址（默认 0.0.0.0，即所有网卡；环境变量 SENTINEL_HOST）
  --gate-token <串>  固定入口串（默认每次启动随机生成，环境变量 SENTINEL_GATE_TOKEN）
  --no-gate        关闭随机入口，直接以 / 提供服务
  --no-consent     关闭首次进入的授权承诺（默认开启，勾选后才可用）
  --no-tls         关闭 HTTPS，退回明文 HTTP（默认自签 HTTPS）
  --tls-cert <p>   使用指定证书（与 --tls-key 成对，优先于自动生成）
  --tls-key <p>    使用指定私钥（与 --tls-cert 成对）
  --tls-regen      重新生成自签证书（本机 IP 变化、浏览器报域名不匹配时用）
  --cwd <目录>     工作目录（默认当前目录，环境变量 SENTINEL_CWD）
  --check          只运行 Docker 环境检查并打印结果，未通过时退出码为 1
  --version        打印版本与运行时
  --help           打印本帮助

环境变量:
  SENTINEL_CODING_AGENT_DIR  配置目录（默认 ~/.sentinel/agent）
  SENTINEL_PROJECTS_DIR           项目工作目录根（默认 ~/.sentinel/projects）

默认监听 0.0.0.0，在服务器上直接跑起来就能从外部访问。为了不让 FOFA 这类
引擎扫到并收录，启动时会生成一个随机入口串：日志里打印的
https://<地址>:<端口>/<入口串> 是唯一入口，打开它会给浏览器种一个 cookie 再
跳回 /，其余任何不带这个 cookie 的请求（含 /、静态资源、API、WebSocket）
一律回一个普通的 404。入口串每次启动都变（--gate-token 或 SENTINEL_GATE_TOKEN 可
固定），密码登录照旧生效。

默认使用 HTTPS：首次启动用本机 openssl 生成一张自签证书（存于配置目录
tls/，SAN 覆盖 localhost 与当前所有网卡 IP），之后复用。浏览器首次访问会
提示“不受信任”，选择“继续前往”即可；也可把 tls/cert.pem 导入系统信任。
换网络后局域网 IP 变了、浏览器报证书域名不匹配时，用 --tls-regen 重签；
--tls-cert/--tls-key 可换成自己的证书；--no-tls 退回明文 HTTP。

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
const noTls = process.argv.includes("--no-tls") || process.env.SENTINEL_TLS === "0";
const tlsCertArg = argValue("--tls-cert");
const tlsKeyArg = argValue("--tls-key");
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
	const report = await checkEnvironment({
		agentDir: getAgentDir(),
		url: `${noTls ? "http" : "https"}://${host}:${port}`,
	});
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

// HTTPS by default. A stored pair is reused; --tls-regen or a network change
// (an interface address the certificate does not cover) re-signs it. When
// generation is impossible (no openssl) the console still starts, on HTTP, with
// a loud warning: refusing to start would brick every existing deployment on
// machines that simply lack openssl.
let tls: { cert: string; key: string } | undefined;
let tlsNote = "";
if (!noTls) {
	const agentDir = getAgentDir();
	try {
		const regenerate =
			process.argv.includes("--tls-regen") || (!tlsCertArg && !tlsKeyArg && !storedNamesCoverCurrentIps(agentDir));
		const certificate = await ensureTlsCertificate(agentDir, {
			...(tlsCertArg || tlsKeyArg ? { certPath: tlsCertArg, keyPath: tlsKeyArg } : {}),
			regenerate,
		});
		tls = { cert: certificate.cert, key: certificate.key };
		if (certificate.source === "generated") {
			tlsNote = `已生成新的自签证书（SAN：${certificate.names.join("、")}）：${tlsCertPath(agentDir)}`;
		} else if (regenerate) {
			tlsNote = `已重签自签证书（SAN：${certificate.names.join("、")}）：${tlsCertPath(agentDir)}`;
		} else {
			tlsNote = `使用已保存的自签证书：${tlsCertPath(agentDir)}`;
		}
	} catch (error) {
		console.error(`[sentinel] 自签 HTTPS 不可用：${error instanceof Error ? error.message : String(error)}`);
		console.error("[sentinel] 已回退到明文 HTTP 继续启动。安装 openssl 或用 --tls-cert/--tls-key 提供证书后重启。");
	}
}

const { url, environment } = await startSentinelServer({
	port,
	host,
	cwd,
	agentDir: getAgentDir(),
	gate: !noGate,
	consent: !noConsent,
	...(gateToken ? { gateToken } : {}),
	...(tls ? { tls } : {}),
});

console.log(`全链哨兵 Web 控制台已启动: ${url}`);
if (tls) {
	console.log(`  ${tlsNote}`);
	console.log("  浏览器首次访问会提示证书不受信任（自签），选择“高级 → 继续前往”，或把上面的 cert.pem 导入系统信任。");
}
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
			console.log(`  局域网访问 (${name}): ${bound.protocol}//${address.address}:${bound.port}${bound.pathname}`);
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
