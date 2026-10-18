/**
 * MemShellParty MCP adapter.
 *
 * MemShellParty is a Spring Boot web application that generates Java memory
 * shells. It has no MCP endpoint, so this adapter wraps its REST API and exposes
 * a streamable HTTP MCP server on the plugin port:
 *
 *   container :7801  MCP (this file) + /ui/ call history, /healthz
 *   container :18080 MemShellParty Spring Boot (loopback only)
 *
 * Generated payloads are written under the plugin's /artifacts directory and
 * only a summary is returned when the payload is larger than the inline budget;
 * a 40 KB Base64 blob is not useful in a model's context, and the operator can
 * pull it from the plugin page or the history UI.
 *
 * Every call is recorded in /data/history.json (passwords masked) so the
 * plugin's own frontend can show what was generated and when.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 7801);
const MSP_URL = (process.env.MSP_URL ?? "http://127.0.0.1:18080").replace(/\/+$/, "");
const ARTIFACTS_DIR = process.env.PLUGIN_ARTIFACTS_DIR ?? "/artifacts";
const DATA_DIR = process.env.PLUGIN_DATA_DIR ?? "/data";
const HISTORY_FILE = join(DATA_DIR, "history.json");
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");
const PROTOCOL_VERSION = "2025-03-26";
const MAX_HISTORY = 200;
const MAX_INLINE_CHARS = clampInt(process.env.PLUGIN_MAX_INLINE_CHARS, 20000, 1000, 200000);

const SHELL_TOOLS = ["Godzilla", "Behinder", "Command", "AntSword", "Suo5", "Suo5v2", "NeoreGeorg", "Proxy", "Custom"];
const PROBE_METHODS = ["DNSLog", "Sleep", "ResponseBody"];
const PROBE_CONTENTS = ["JDK", "Server", "OS", "Bytecode", "Filter", "Command", "BasicInfo", "ScriptEngine"];

function clampInt(value, fallback, min, max) {
	const parsed = typeof value === "string" ? Number(value) : value;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

function runId() {
	const now = new Date();
	const pad = (v) => String(v).padStart(2, "0");
	return `run-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

const SENSITIVE = /(pass|key|secret|token|base64)/i;

function summarizeArgs(args) {
	const out = {};
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "string") {
			out[key] = SENSITIVE.test(key) ? "***" : value.length > 200 ? `${value.slice(0, 200)}…` : value;
		} else {
			out[key] = value;
		}
	}
	return out;
}

function targetOf(tool, args) {
	if (tool === "generate_memshell") {
		return [args.server, args.shell_type, args.shell_tool, args.packer].filter(Boolean).join(" / ") || "内存马";
	}
	if (tool === "generate_probe") {
		return [args.probe_method, args.probe_content, args.packer].filter(Boolean).join(" / ") || "探测马";
	}
	if (tool === "parse_class_name") return "class 字节码";
	if (tool === "list_calls") return "调用历史";
	return "选项清单";
}

function loadHistory() {
	try {
		const raw = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
		return Array.isArray(raw.calls) ? raw.calls.slice(0, MAX_HISTORY) : [];
	} catch {
		return [];
	}
}

let history = loadHistory();

function saveHistory() {
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		writeFileSync(HISTORY_FILE, `${JSON.stringify({ calls: history }, null, 2)}\n`);
	} catch {
		// The history is a convenience; never fail a generation because it cannot be written.
	}
}

function pushHistory(entry) {
	history.unshift(entry);
	history = history.slice(0, MAX_HISTORY);
	saveHistory();
}

let ready = false;

async function checkReady() {
	try {
		const response = await fetch(`${MSP_URL}/api/version`, { signal: AbortSignal.timeout(2000) });
		ready = response.ok;
	} catch {
		ready = false;
	}
	return ready;
}

void checkReady();
setInterval(() => void checkReady(), 5000).unref();

async function upstream(method, path, { json, raw } = {}) {
	const headers = {};
	let body;
	if (json !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(json);
	} else if (raw !== undefined) {
		headers["content-type"] = "application/json";
		body = raw;
	}
	const response = await fetch(`${MSP_URL}${path}`, {
		method,
		headers,
		body,
		signal: AbortSignal.timeout(120000),
	});
	return { ok: response.ok, status: response.status, text: await response.text() };
}

function toolText(text, options = {}) {
	const result = { content: [{ type: "text", text }] };
	if (options.artifacts && options.artifacts.length > 0) result._meta = { artifacts: options.artifacts };
	if (options.isError) result.isError = true;
	return result;
}

function toolError(text) {
	return toolText(text, { isError: true });
}

function snippet(text, limit = 800) {
	const trimmed = String(text ?? "").trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit)}…（已截断）` : trimmed;
}

function upstreamFailure(prefix, result) {
	return toolError(`${prefix}（HTTP ${result.status}）：${snippet(result.text) || "上游没有返回内容"}`);
}

function safeFilePart(name) {
	return String(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "result";
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Write the raw response plus each string under allPackResults; returns relative artifact paths. */
function saveRun(rawText) {
	const id = runId();
	const dir = join(ARTIFACTS_DIR, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "result.json"), rawText);
	const payloads = {};
	const parsed = parseJson(rawText);
	const all = parsed?.allPackResults;
	if (all && typeof all === "object") {
		for (const [key, value] of Object.entries(all)) {
			if (typeof value === "string") payloads[key] = value;
		}
	}
	const artifacts = [`${id}/result.json`];
	for (const [key, value] of Object.entries(payloads)) {
		const file = `${safeFilePart(key)}.txt`;
		writeFileSync(join(dir, file), value);
		artifacts.push(`${id}/${file}`);
	}
	return { id, payloads, artifacts };
}

function renderRunSummary(title, meta, run) {
	const lines = [title, `运行 ID：${run.id}`, `参数：${meta}`];
	const entries = Object.entries(run.payloads);
	if (entries.length === 0) {
		lines.push("上游没有返回 allPackResults，完整响应已写入 result.json。");
		return lines.join("\n");
	}
	lines.push(`返回 ${entries.length} 个打包结果：`);
	for (const [key, value] of entries) {
		lines.push(`- ${key}：${value.length} 字符 → ${run.id}/${safeFilePart(key)}.txt`);
	}
	const inline = entries.map(([key, value]) => `--- ${key} ---\n${value}`).join("\n\n");
	if (inline.length <= MAX_INLINE_CHARS) {
		lines.push("", inline);
	} else {
		lines.push(
			"",
			`载荷共 ${inline.length} 字符，超过内联上限 ${MAX_INLINE_CHARS}；请到插件页「产物」拉取，或在调用历史里查看条目。`,
		);
	}
	return lines.join("\n");
}

async function listServers() {
	const [servers, packers, version] = await Promise.all([
		upstream("GET", "/api/config/servers"),
		upstream("GET", "/api/config/packers"),
		upstream("GET", "/api/version"),
	]);
	if (!servers.ok) return upstreamFailure("获取 servers 失败", servers);
	const payload = {
		servers: parseJson(servers.text) ?? servers.text,
		packers: packers.ok ? (parseJson(packers.text) ?? packers.text) : [],
		version: version.ok ? (parseJson(version.text) ?? version.text) : null,
		shellTools: SHELL_TOOLS,
		probeMethods: PROBE_METHODS,
		probeContents: PROBE_CONTENTS,
		hint: "先看 servers 里的 shellTypes 再选 shell_type；shellTool 密码参数：Godzilla→godzilla_pass/godzilla_key，Behinder→behinder_pass，AntSword→antsword_pass，Command→command_param_name/command_template，Custom→shell_class_base64。仅限授权测试。",
	};
	return toolText(JSON.stringify(payload, null, 2));
}

function buildMemshellBody(args) {
	const str = (key) => (typeof args[key] === "string" && args[key] !== "" ? args[key] : undefined);
	const bool = (key) => (typeof args[key] === "boolean" ? args[key] : undefined);
	const shellConfig = {
		server: args.server,
		shellType: args.shell_type,
		shellTool: args.shell_tool,
	};
	if (str("server_version")) shellConfig.serverVersion = str("server_version");
	if (typeof args.target_jre_version === "number" && args.target_jre_version > 0) {
		shellConfig.targetJreVersion = Math.round(args.target_jre_version);
	}
	for (const [source, target] of Object.entries({
		bypass_java_module: "byPassJavaModule",
		debug: "debug",
		shrink: "shrink",
		lambda_suffix: "lambdaSuffix",
		jakarta: "jakarta",
	})) {
		if (bool(source) !== undefined) shellConfig[target] = bool(source);
	}
	const toolConfig = {};
	for (const [target, source] of Object.entries({
		godzillaPass: "godzilla_pass",
		godzillaKey: "godzilla_key",
		behinderPass: "behinder_pass",
		antSwordPass: "antsword_pass",
		commandParamName: "command_param_name",
		commandTemplate: "command_template",
		encryptor: "encryptor",
		headerName: "header_name",
		headerValue: "header_value",
		shellClassName: "shell_class_name",
		shellClassBase64: "shell_class_base64",
	})) {
		if (str(source)) toolConfig[target] = str(source);
	}
	const injectorConfig = { urlPattern: str("url_pattern") ?? "/*" };
	return { shellConfig, shellToolConfig: toolConfig, injectorConfig, packer: args.packer };
}

async function generateMemshell(args) {
	for (const required of ["server", "shell_type", "shell_tool", "packer"]) {
		if (typeof args[required] !== "string" || args[required] === "") {
			return toolError(`缺少必填参数 ${required}`);
		}
	}
	const body = buildMemshellBody(args);
	const result = await upstream("POST", "/api/memshell/generate", { json: body });
	if (!result.ok) return upstreamFailure("生成失败（用 list_servers 确认参数取值）", result);
	const run = saveRun(result.text);
	const meta = `${args.server} / ${args.shell_type} / ${args.shell_tool} / ${args.packer}`;
	return toolText(renderRunSummary("MemShellParty 内存马生成完成", meta, run), { artifacts: run.artifacts });
}

async function generateProbe(args) {
	for (const required of ["probe_method", "probe_content", "packer"]) {
		if (typeof args[required] !== "string" || args[required] === "") {
			return toolError(`缺少必填参数 ${required}`);
		}
	}
	const str = (key) => (typeof args[key] === "string" && args[key] !== "" ? args[key] : undefined);
	const probeConfig = { probeMethod: args.probe_method, probeContent: args.probe_content };
	if (typeof args.target_jre_version === "number" && args.target_jre_version > 0) {
		probeConfig.targetJreVersion = Math.round(args.target_jre_version);
	}
	for (const [source, target] of Object.entries({
		bypass_java_module: "byPassJavaModule",
		static_initialize: "staticInitialize",
	})) {
		if (typeof args[source] === "boolean") probeConfig[target] = args[source];
	}
	const content = {};
	if (str("dnslog_host")) content.host = str("dnslog_host");
	if (typeof args.sleep_seconds === "number" && args.sleep_seconds > 0) {
		content.seconds = Math.round(args.sleep_seconds);
	}
	if (str("sleep_server")) content.server = str("sleep_server");
	if (str("command_template")) content.commandTemplate = str("command_template");
	const result = await upstream("POST", "/api/probe/generate", {
		json: { probeConfig, probeContentConfig: content, packer: args.packer },
	});
	if (!result.ok) return upstreamFailure("生成探测马失败（检查参数组合）", result);
	const run = saveRun(result.text);
	const meta = `${args.probe_method} / ${args.probe_content} / ${args.packer}`;
	return toolText(renderRunSummary("MemShellParty 探测马生成完成", meta, run), { artifacts: run.artifacts });
}

async function parseClassName(args) {
	if (typeof args.class_base64 !== "string" || args.class_base64 === "") {
		return toolError("缺少必填参数 class_base64");
	}
	const result = await upstream("POST", "/api/className", { raw: args.class_base64 });
	if (!result.ok) return upstreamFailure("解析 class 失败", result);
	return toolText(result.text);
}

async function listCalls(args) {
	const limit = clampInt(args.limit, 20, 1, MAX_HISTORY);
	return toolText(JSON.stringify({ calls: history.slice(0, limit), total: history.length }, null, 2));
}

const TOOLS = [
	{
		name: "list_servers",
		description:
			"列出 MemShellParty 支持的全部选项：中间件及其壳类型（shellTypes）、打包器（packers）、内存马工具、探测方式与探测项。生成载荷前先调用它确认参数取值。",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "generate_memshell",
		description:
			"生成 Java 内存马载荷（MemShellParty）。仅限已授权测试。返回各打包格式的载荷摘要与产物路径；大载荷不直接内联。",
		inputSchema: {
			type: "object",
			properties: {
				server: { type: "string", description: "目标中间件，如 Tomcat/Jetty/SpringWebMvc" },
				shell_type: { type: "string", description: "注入位置，如 Listener/Filter/Servlet" },
				shell_tool: { type: "string", enum: SHELL_TOOLS, description: "内存马功能" },
				packer: { type: "string", description: "打包格式，如 Base64/JSP/SpEL/AgentJar" },
				godzilla_pass: { type: "string", description: "哥斯拉连接密码" },
				godzilla_key: { type: "string", description: "哥斯拉密钥" },
				behinder_pass: { type: "string", description: "冰蝎连接密码" },
				antsword_pass: { type: "string", description: "蚁剑连接密码" },
				command_param_name: { type: "string", description: "Command 型的参数名" },
				command_template: { type: "string", description: "Command 型的回显模板" },
				encryptor: { type: "string", description: "Command 型加密器" },
				header_name: { type: "string", description: "访问校验头名" },
				header_value: { type: "string", description: "访问校验头值" },
				url_pattern: { type: "string", description: "注入访问地址匹配，默认 /*" },
				shell_class_name: { type: "string", description: "自定义类名" },
				shell_class_base64: { type: "string", description: "Custom 型的 class 字节码 base64" },
				server_version: { type: "string", description: "目标中间件版本，如 Tomcat9/SpringBoot3" },
				target_jre_version: { type: "number", description: "目标 class 版本：52=JDK8 61=JDK17" },
				bypass_java_module: { type: "boolean", description: "JDK9+ 绕过模块限制" },
				debug: { type: "boolean", description: "调试模式" },
				shrink: { type: "boolean", description: "缩小字节码" },
				lambda_suffix: { type: "boolean", description: "lambda 类名随机后缀" },
				jakarta: { type: "boolean", description: "使用 jakarta 命名空间" },
			},
			required: ["server", "shell_type", "shell_tool", "packer"],
		},
	},
	{
		name: "generate_probe",
		description: "生成探测马（DNSLog / Sleep / ResponseBody），用于判断目标中间件类型、JDK、OS 等。仅限已授权测试。",
		inputSchema: {
			type: "object",
			properties: {
				probe_method: { type: "string", enum: PROBE_METHODS, description: "判定方式" },
				probe_content: { type: "string", enum: PROBE_CONTENTS, description: "探测项" },
				packer: { type: "string", description: "打包格式" },
				dnslog_host: { type: "string", description: "DNSLog 回连域名" },
				sleep_seconds: { type: "number", description: "Sleep 秒数" },
				sleep_server: { type: "string", description: "Sleep 的服务标识" },
				command_template: { type: "string", description: "ResponseBody 的回显命令模板" },
				target_jre_version: { type: "number", description: "目标 class 版本" },
				bypass_java_module: { type: "boolean", description: "JDK9+ 绕过模块限制" },
				static_initialize: { type: "boolean", description: "静态代码块触发" },
			},
			required: ["probe_method", "probe_content", "packer"],
		},
	},
	{
		name: "parse_class_name",
		description: "解析 Java class 字节码（base64）的类名与父类信息，注入后排查用。",
		inputSchema: {
			type: "object",
			properties: { class_base64: { type: "string", description: "class 文件的 base64" } },
			required: ["class_base64"],
		},
	},
	{
		name: "list_calls",
		description: "列出本插件最近的生成记录（时间、工具、目标、结果、产物、耗时），供调用历史界面使用。",
		inputSchema: {
			type: "object",
			properties: { limit: { type: "number", description: "返回条数，1–200，默认 20" } },
		},
	},
];

function resultText(result) {
	return result.content?.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n") ?? "";
}

async function runTool(name, args) {
	const started = Date.now();
	const base = { at: Date.now(), tool: name, target: targetOf(name, args), args: summarizeArgs(args) };
	try {
		let result;
		if (name === "list_servers") result = await listServers();
		else if (name === "generate_memshell") result = await generateMemshell(args);
		else if (name === "generate_probe") result = await generateProbe(args);
		else if (name === "parse_class_name") result = await parseClassName(args);
		else if (name === "list_calls") result = await listCalls(args);
		else return toolError(`未知工具 ${name}`);
		const text = resultText(result);
		const artifacts = result._meta?.artifacts ?? [];
		// Prefer the artifact's run directory so the history row and the files on
		// disk share one id; non-generating tools get a fresh one.
		const id = artifacts.length > 0 ? String(artifacts[0]).split("/")[0] : runId();
		pushHistory({
			...base,
			id,
			ok: result.isError !== true,
			durationMs: Date.now() - started,
			resultSize: text.length,
			artifacts,
			...(result.isError ? { error: snippet(text, 300) } : {}),
		});
		return result;
	} catch (error) {
		const message = `上游不可达：${error instanceof Error ? error.message : String(error)}`;
		pushHistory({
			...base,
			ok: false,
			durationMs: Date.now() - started,
			resultSize: 0,
			artifacts: [],
			error: message,
		});
		return toolError(message);
	}
}

function rpcError(id, code, message) {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRpc(message) {
	if (!message || typeof message !== "object") return rpcError(null, -32600, "invalid request");
	const id = message.id;
	const method = message.method;
	if (method === "initialize") {
		const requested = message.params?.protocolVersion;
		return {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "sentinel-memshell-party", version: "0.1.0" },
			},
		};
	}
	if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
	if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
	if (method === "tools/call") {
		const name = String(message.params?.name ?? "");
		const args = message.params?.arguments ?? {};
		const result = await runTool(name, args);
		return { jsonrpc: "2.0", id, result };
	}
	if (method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [] } };
	if (method === "prompts/list") return { jsonrpc: "2.0", id, result: { prompts: [] } };
	if (id === undefined) return null;
	return rpcError(id, -32601, `method not found: ${String(method)}`);
}

const UI_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
};

function serveUi(path, response) {
	const relative = decodeURIComponent(path.slice("/ui/".length));
	if (!relative || relative.split("/").includes("..")) {
		response.writeHead(404).end();
		return;
	}
	const file = join(UI_DIR, relative);
	if (!file.startsWith(UI_DIR) || !existsSync(file) || !statSync(file).isFile()) {
		response.writeHead(404).end();
		return;
	}
	const body = readFileSync(file);
	response.writeHead(200, {
		"content-type": UI_TYPES[extname(relative)] ?? "application/octet-stream",
		"content-length": String(body.length),
		"cache-control": "no-store",
	});
	response.end(body);
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > 8 * 1024 * 1024) {
				reject(new Error("请求体过大"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		request.on("error", reject);
	});
}

const server = createServer(async (request, response) => {
	const url = request.url ?? "/";
	if (request.method === "GET" && url === "/healthz") {
		const ok = ready || (await checkReady());
		response.writeHead(ok ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: "MemShellParty 尚未就绪" }));
		return;
	}
	if (request.method === "GET" && url.startsWith("/ui/")) {
		serveUi(url.split("?")[0], response);
		return;
	}
	if (url !== "/mcp") {
		response.writeHead(404).end();
		return;
	}
	if (request.method !== "POST") {
		response.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ error: "this server has no server-initiated stream" }));
		return;
	}
	let payload;
	try {
		payload = JSON.parse(await readBody(request));
	} catch {
		response.writeHead(400).end();
		return;
	}
	const answers = [];
	if (Array.isArray(payload)) {
		for (const entry of payload) {
			const answer = await handleRpc(entry);
			if (answer) answers.push(answer);
		}
	} else {
		const answer = await handleRpc(payload);
		if (answer) answers.push(answer);
	}
	if (answers.length === 0) {
		response.writeHead(202).end();
		return;
	}
	const body = JSON.stringify(Array.isArray(payload) ? answers : answers[0]);
	response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
	response.end(body);
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`memshell-party MCP adapter listening on :${PORT} (upstream ${MSP_URL})`);
});
