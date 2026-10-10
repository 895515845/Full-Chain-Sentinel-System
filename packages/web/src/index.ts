/**
 * ZGAgent web console entry point.
 *
 * Configuration via environment variables or CLI flags:
 *   ZG_PORT / --port     listen port (default 7777)
 *   ZG_HOST / --host     listen address (default 127.0.0.1)
 *   ZG_CWD               working directory for the agent (default: process.cwd())
 *   ZGAGENT_CODING_AGENT_DIR   agent config directory (default: ~/.zgagent/agent)
 *
 * Flags:
 *   --check      run the Docker environment check, print it, and exit non-zero when it fails
 *   --version    print the console version and the runtime it is running on
 *   --help       print this usage
 */

import { networkInterfaces } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WEB_CONSOLE_VERSION } from "./assets.ts";
import { checkEnvironment } from "./env-check.ts";
import type { ZGEnvReport } from "./protocol.ts";
import { startZGServer } from "./server.ts";

const USAGE = `zgagent-web ${WEB_CONSOLE_VERSION} - ZGAgent Web 控制台

用法: zgagent-web [选项]

选项:
  --port <端口>    监听端口（默认 7777，环境变量 ZG_PORT）
  --host <地址>    监听地址（默认 127.0.0.1，环境变量 ZG_HOST）
  --cwd <目录>     工作目录（默认当前目录，环境变量 ZG_CWD）
  --check          只运行 Docker 环境检查并打印结果，未通过时退出码为 1
  --version        打印版本与运行时
  --help           打印本帮助

环境变量:
  ZGAGENT_CODING_AGENT_DIR  配置目录（默认 ~/.zgagent/agent）
  ZG_PROJECTS_DIR           项目工作目录根（默认 ~/.zgagent/projects）

Docker 是硬依赖：所有工具调用都在项目容器内执行。控制台启动后会检查
Docker 守护进程、工具镜像和项目容器；未通过时对话被锁定，请在
「设置 → 环境」中查看原因并构建镜像。`;

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

/** One line per check result: failures and warnings, plus the overall verdict. */
function environmentLines(report: ZGEnvReport): string[] {
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

const port = Number(argValue("--port") ?? process.env.ZG_PORT ?? 7777);
const host = argValue("--host") ?? process.env.ZG_HOST ?? "127.0.0.1";
const cwd = argValue("--cwd") ?? process.env.ZG_CWD ?? process.cwd();

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(USAGE);
	process.exit(0);
}

if (process.argv.includes("--version")) {
	console.log(`zgagent-web ${WEB_CONSOLE_VERSION} (${runtimeLabel()})`);
	process.exit(0);
}

if (process.argv.includes("--check")) {
	const report = await checkEnvironment({ agentDir: getAgentDir(), url: `http://${host}:${port}` });
	for (const line of environmentLines(report)) console.log(line);
	process.exit(report.ok ? 0 : 1);
}

const { url, environment } = await startZGServer({ port, host, cwd, agentDir: getAgentDir() });

console.log(`ZGAgent Web 控制台已启动: ${url}`);
// A wildcard bind is reachable from other devices too; naming those addresses
// avoids guessing at one, which is what produces ERR_ADDRESS_INVALID in a
// browser when the guess is stale or is 0.0.0.0 itself.
if (host === "0.0.0.0" || host === "::" || host === "[::]") {
	const boundPort = new URL(url).port;
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family !== "IPv4" || address.internal) continue;
			console.log(`  局域网访问 (${name}): http://${address.address}:${boundPort}`);
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
