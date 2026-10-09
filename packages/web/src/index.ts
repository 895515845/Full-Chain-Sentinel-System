/**
 * ZGAgent web console entry point.
 *
 * Configuration via environment variables or CLI flags:
 *   ZG_PORT / --port     listen port (default 7777)
 *   ZG_HOST / --host     listen address (default 127.0.0.1)
 *   ZG_CWD               working directory for the agent (default: process.cwd())
 *   ZGAGENT_CODING_AGENT_DIR   agent config directory (default: ~/.zgagent/agent)
 */

import { startZGServer } from "./server.ts";

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(argValue("--port") ?? process.env.ZG_PORT ?? 7777);
const host = argValue("--host") ?? process.env.ZG_HOST ?? "127.0.0.1";
const cwd = argValue("--cwd") ?? process.env.ZG_CWD ?? process.cwd();

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const { url } = await startZGServer({ port, host, cwd, agentDir: getAgentDir() });

console.log(`ZGAgent Web 控制台已启动: ${url}`);
console.log(`工作目录: ${cwd}`);
console.log("按 Ctrl+C 停止。");
