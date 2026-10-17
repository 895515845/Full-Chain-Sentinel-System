/**
 * `sentinel-web plugin-host`: the operator-facing command.
 *
 * Two ways to run it, with the same binary and the same data layout:
 *
 *   sentinel-web plugin-host --local                 loopback only, discovered by the console
 *   sentinel-web plugin-host --listen 0.0.0.0:7800   a VPS the console dials out to
 *
 * The token is printed on every start because it is what the console's "add host"
 * form asks for. `--rotate-token` is the only way it changes: reusing the stored
 * token is what keeps a saved remote host working across restarts.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startPluginHost } from "./server.ts";
import { hostStatePath, readHostState, writeHostState } from "./store.ts";

const USAGE = `sentinel-web plugin-host - 社区插件主机

用法: sentinel-web plugin-host [选项]

选项:
  --local              只监听 127.0.0.1，控制台会自动发现（默认）
  --listen <地址:端口>  监听地址，例如 0.0.0.0:7800；非回环地址默认按远端 host 处理
  --mode <local|remote> 覆盖 locality 判定（默认按监听地址推断）
  --data-dir <目录>     数据目录（默认 ~/.sentinel/plugin-host）
  --tls-cert <pem>     直接提供 HTTPS 证书（与 --tls-key 成对；否则放在反向代理后面）
  --tls-key <pem>      HTTPS 私钥
  --rotate-token       重新生成 token，旧 token 立即失效
  --version            打印版本
  --help               打印本帮助

环境变量:
  SENTINEL_PLUGIN_HOST_DIR   数据目录
`;

function argValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
}

function defaultDataDir(): string {
	return process.env.SENTINEL_PLUGIN_HOST_DIR?.trim() || join(homedir(), ".sentinel", "plugin-host");
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function parseListen(value: string | undefined): { host: string; port: number } | null {
	if (!value) return null;
	const separator = value.lastIndexOf(":");
	if (separator <= 0) return null;
	const host = value.slice(0, separator).trim();
	const port = Number(value.slice(separator + 1));
	if (!host || !Number.isInteger(port) || port < 0 || port > 65535) return null;
	return { host, port };
}

/** A state file is only "running" if its pid is alive and its port answers. */
async function hostIsRunning(state: { pid: number; port: number }): Promise<boolean> {
	if (state.pid > 0) {
		try {
			process.kill(state.pid, 0);
		} catch {
			return false;
		}
	}
	try {
		const response = await fetch(`http://127.0.0.1:${state.port}/healthz`, {
			signal: AbortSignal.timeout(1000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

function newToken(): string {
	return `sph_${randomBytes(32).toString("base64url")}`;
}

/** Run the subcommand. Resolves with an exit code for the argument-handling paths only. */
export async function runPluginHostCli(argv: string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(USAGE);
		return 0;
	}
	if (argv.includes("--version")) {
		console.log("sentinel-web plugin-host 1");
		return 0;
	}

	const dataDir = argValue(argv, "--data-dir")?.trim() || defaultDataDir();
	const listenArg = argValue(argv, "--listen");
	const listen = parseListen(listenArg) ?? { host: "127.0.0.1", port: 0 };
	const modeArg = argValue(argv, "--mode");
	if (modeArg !== undefined && modeArg !== "local" && modeArg !== "remote") {
		console.error("--mode 只能是 local 或 remote");
		return 2;
	}
	const mode = modeArg ?? (isLoopback(listen.host) ? "local" : "remote");
	const tlsCertPath = argValue(argv, "--tls-cert");
	const tlsKeyPath = argValue(argv, "--tls-key");
	if ((tlsCertPath === undefined) !== (tlsKeyPath === undefined)) {
		console.error("--tls-cert 与 --tls-key 必须成对出现");
		return 2;
	}
	let tls: { cert: string; key: string } | undefined;
	if (tlsCertPath && tlsKeyPath) {
		try {
			tls = { cert: readFileSync(tlsCertPath, "utf-8"), key: readFileSync(tlsKeyPath, "utf-8") };
		} catch (error) {
			console.error(`读取证书失败：${error instanceof Error ? error.message : String(error)}`);
			return 2;
		}
	}
	if (tls && mode === "local") {
		// The console discovers a local host over http://127.0.0.1, and it does not
		// accept a self-signed certificate. Plain HTTP is correct for loopback.
		console.error("本地模式不支持 HTTPS：控制台按 http://127.0.0.1 自动发现。远端请用非回环地址或 --mode remote。");
		return 2;
	}
	if (listenArg !== undefined && !parseListen(listenArg)) {
		console.error("--listen 格式必须是 <地址>:<端口>，例如 0.0.0.0:7800");
		return 2;
	}

	mkdirSync(dataDir, { recursive: true });
	const previous = readHostState(dataDir);
	if (previous && (await hostIsRunning(previous))) {
		console.error(`已有一个 plugin-host 在该数据目录运行（pid ${previous.pid}, 端口 ${previous.port}）。`);
		console.error("先停止它，或用 --data-dir 换一个目录。");
		return 1;
	}
	const rotate = argv.includes("--rotate-token");
	const token = rotate || !previous ? newToken() : previous.token;

	const host = await startPluginHost({
		dataDir,
		token,
		mode,
		host: listen.host,
		port: listen.port,
		...(tls ? { tls } : {}),
	});
	writeHostState(dataDir, {
		version: 1,
		token,
		port: host.port,
		pid: process.pid,
		startedAt: Date.now(),
	});

	console.log(`plugin-host 已启动: ${host.url} (${mode})`);
	console.log(`token: ${token}`);
	console.log(`数据目录: ${dataDir}`);
	if (mode === "remote") {
		console.log("远端使用时在控制台「设置 → 插件主机」填入 HTTPS 地址与 token。");
		if (!isLoopback(listen.host)) {
			console.log(
				"注意：本进程只提供 HTTP，请放在 Caddy/nginx 的 HTTPS 反向代理后面；控制台会拒绝非回环的明文地址。",
			);
		}
	}

	let closing = false;
	const shutdown = (): void => {
		if (closing) return;
		closing = true;
		// Only remove the state file this process wrote; a rotated token belongs to the new run.
		try {
			const current = readHostState(dataDir);
			if (current?.pid === process.pid) rmSync(hostStatePath(dataDir), { force: true });
		} catch {
			// best effort
		}
		void host.close().finally(() => process.exit(0));
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	// Stay alive until a signal arrives.
	await new Promise<void>(() => {});
	return 0;
}
