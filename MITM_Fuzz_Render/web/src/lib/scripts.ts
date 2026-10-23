import { apiRequest } from "./api";

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

export interface ScriptHooks {
  onRequest: boolean;
  onResponse: boolean;
  onAssert: boolean;
}

export interface ScriptItem {
  id: string;
  name: string;
  lang: string;
  source: string;
  hooks: ScriptHooks;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ScriptLog {
  level: string;
  message: string;
}

export interface ScriptAssert {
  ok: boolean;
  message: string;
}

export interface ScriptOutput {
  request: { method: string; url: string; body: string };
  response?: { status: number; body: string };
  assert?: ScriptAssert;
  logs: ScriptLog[];
  error?: string;
  durationMs: number;
  hooksRun: string[];
}

export interface ScriptTestResult {
  request?: { raw: string; url: string };
  response?: { status: number; body: string };
  result?: unknown;
  script: ScriptOutput;
}

export interface ScriptRun {
  id: string;
  scriptId: string;
  flowId?: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  createdAt: number;
}

/* -------------------------------------------------------------------------- */
/* 归一化                                                                      */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string, def = ""): string {
  const value = source[key];
  return typeof value === "string" ? value : def;
}

function num(source: Record<string, unknown>, key: string, def = 0): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : def;
}

function normalizeHooks(value: unknown): ScriptHooks {
  const source = isRecord(value) ? value : {};
  return {
    onRequest: source.onRequest === true,
    onResponse: source.onResponse === true,
    onAssert: source.onAssert === true,
  };
}

function normalizeScript(value: unknown): ScriptItem {
  const source = isRecord(value) ? value : {};
  return {
    id: str(source, "id"),
    name: str(source, "name", "未命名脚本"),
    lang: str(source, "lang", "js"),
    source: str(source, "source"),
    hooks: normalizeHooks(source.hooks),
    enabled: source.enabled !== false,
    createdAt: num(source, "createdAt"),
    updatedAt: num(source, "updatedAt"),
  };
}

function normalizeOutput(value: unknown): ScriptOutput {
  const source = isRecord(value) ? value : {};
  const logsRaw = Array.isArray(source.logs) ? source.logs : [];
  const reqRaw = isRecord(source.request) ? source.request : {};
  const respRaw = isRecord(source.response) ? source.response : null;
  const assertRaw = isRecord(source.assert) ? source.assert : null;
  const hooksRaw = Array.isArray(source.hooksRun) ? source.hooksRun : [];
  return {
    request: {
      method: str(reqRaw, "method"),
      url: str(reqRaw, "url"),
      body: str(reqRaw, "body"),
    },
    ...(respRaw === null
      ? {}
      : { response: { status: num(respRaw, "status"), body: str(respRaw, "body") } }),
    ...(assertRaw === null
      ? {}
      : { assert: { ok: assertRaw.ok === true, message: str(assertRaw, "message") } }),
    logs: logsRaw.map((entry): ScriptLog => {
      const item = isRecord(entry) ? entry : {};
      return { level: str(item, "level", "info"), message: str(item, "message") };
    }),
    ...(str(source, "error") === "" ? {} : { error: str(source, "error") }),
    durationMs: num(source, "durationMs"),
    hooksRun: hooksRaw.filter((h): h is string => typeof h === "string"),
  };
}

/* -------------------------------------------------------------------------- */
/* 接口                                                                        */
/* -------------------------------------------------------------------------- */

export async function listScripts(): Promise<ScriptItem[]> {
  const payload = await apiRequest("/scripts");
  const source = isRecord(payload) ? payload : {};
  const items = Array.isArray(source.items) ? source.items : [];
  return items.map(normalizeScript).filter((item) => item.id !== "");
}

export async function createScript(
  name: string,
  source: string,
  hooks?: ScriptHooks,
): Promise<ScriptItem> {
  const payload = await apiRequest("/scripts", {
    method: "POST",
    body: { name, lang: "js", source, ...(hooks === undefined ? {} : { hooks }) },
  });
  return normalizeScript(payload);
}

export async function updateScript(
  id: string,
  patch: {
    name?: string;
    source?: string;
    hooks?: ScriptHooks;
    enabled?: boolean;
    updatedAt?: number;
  },
): Promise<ScriptItem> {
  const payload = await apiRequest(`/scripts/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: patch,
  });
  return normalizeScript(payload);
}

export async function deleteScript(id: string): Promise<void> {
  await apiRequest(`/scripts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 试跑：send=false 只跑钩子；send=true 完整发一次包。 */
export async function testScript(
  id: string,
  body: { raw?: string; target?: { scheme: string; host: string; port: number }; send?: boolean },
): Promise<ScriptTestResult> {
  const payload = await apiRequest(`/scripts/${encodeURIComponent(id)}/test`, {
    method: "POST",
    body,
    timeoutMs: 60_000,
  });
  const source = isRecord(payload) ? payload : {};
  const reqRaw = isRecord(source.request) ? source.request : null;
  const respRaw = isRecord(source.response) ? source.response : null;
  return {
    ...(reqRaw === null ? {} : { request: { raw: str(reqRaw, "raw"), url: str(reqRaw, "url") } }),
    ...(respRaw === null
      ? {}
      : { response: { status: num(respRaw, "status"), body: str(respRaw, "body") } }),
    ...(source.result === undefined ? {} : { result: source.result }),
    script: normalizeOutput(source.script),
  };
}

export async function listScriptRuns(id: string): Promise<ScriptRun[]> {
  const payload = await apiRequest(`/scripts/${encodeURIComponent(id)}/runs`);
  const source = isRecord(payload) ? payload : {};
  const items = Array.isArray(source.items) ? source.items : [];
  return items.map((entry): ScriptRun => {
    const item = isRecord(entry) ? entry : {};
    return {
      id: str(item, "id"),
      scriptId: str(item, "scriptId"),
      ...(str(item, "flowId") === "" ? {} : { flowId: str(item, "flowId") }),
      ok: item.ok === true,
      ...(str(item, "error") === "" ? {} : { error: str(item, "error") }),
      durationMs: num(item, "durationMs"),
      createdAt: num(item, "createdAt"),
    };
  });
}

/** 内置示例脚本（M3 交付的"开箱即用"模板）。 */
export const SCRIPT_SAMPLES: { key: string; label: string; source: string }[] = [
  {
    key: "hmac",
    label: "HMAC 签名（onRequest）",
    source: `// 给请求加 HMAC-SHA256 签名头
// ctx.vars 可在本次会话内共享状态；ctx.env 读取服务端环境变量
function onRequest(req, ctx) {
  var secret = ctx.vars.secret || "change-me";
  var ts = String(helpers.timestampSec());
  var sign = helpers.hmacSHA256Hex(secret, req.method + "\\n" + req.url + "\\n" + ts + "\\n" + req.body);
  req.headers.set("X-Timestamp", ts);
  req.headers.set("X-Sign", sign);
  ctx.log("signed", sign);
}
`,
  },
  {
    key: "decrypt",
    label: "AES 解密响应（onResponse）",
    source: `// 响应体是 AES-CBC 密文时，解密后写回 body 便于阅读
function onResponse(res, ctx) {
  var key = helpers.b64encode("0123456789abcdef"); // 换成真实密钥
  var iv = helpers.b64encode("abcdef1234567890");  // 换成真实 IV
  try {
    var plain = helpers.aesDecryptCBC(key, iv, res.body);
    ctx.log("decrypted", plain.length, "bytes");
    res.body = plain;
  } catch (e) {
    ctx.logError("解密失败：", String(e));
  }
}
`,
  },
  {
    key: "assert",
    label: "越权断言（onAssert）",
    source: `// 越权检测：普通用户 token 访问管理接口应当被拒绝
function onAssert(req, res, ctx) {
  ctx.log("status", res.status);
  assert(res.status === 403, "越权风险：期望 403，实际 " + res.status);
  return res.body.indexOf("unauthorized") >= 0;
}
`,
  },
];
