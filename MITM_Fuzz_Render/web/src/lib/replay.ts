import { ApiError, apiRequest } from "./api";

/* -------------------------------------------------------------------------- */
/* /api/replay                                                                 */
/* -------------------------------------------------------------------------- */

export interface ReplayTarget {
  scheme: "http" | "https";
  host: string;
  port: number;
}

export interface ReplayWarning {
  code: string;
  message: string;
}

export interface ReplayResponse {
  proto: string;
  status: number;
  reason: string;
  headers: { name: string; value: string }[];
  bodyText: string | null;
  bodyBase64: string | null;
  truncated: boolean;
  size: number;
}

export interface ReplayError {
  code: string;
  message: string;
  detail: string | null;
  retryable: boolean;
}

export interface ReplayScriptResult {
  logs: { level: string; message: string }[];
  assert?: { ok: boolean; message: string };
  error?: string;
  durationMs: number;
  hooksRun: string[];
}

export interface ReplayResult {
  flowId: string | null;
  script?: ReplayScriptResult;
  request: {
    raw: string;
    url: { scheme: string; host: string; port: number; path: string } | null;
    warnings: ReplayWarning[] | null;
  } | null;
  response: ReplayResponse | null;
  timings: {
    connectMs: number | null;
    tlsMs: number | null;
    ttfbMs: number | null;
    totalMs: number | null;
  } | null;
  error: ReplayError | null;
  durationMs: number | null;
}

export interface ReplayOptions {
  target: ReplayTarget | null;
  insecureTLS?: boolean;
  /** 挂载到本次发送的脚本（来自 tab 的 scriptId）。 */
  scriptId?: string;
  /**
   * 这次发送的 SOCKS5 出口（socks5://[user:password@]host:port）。
   *
   * 只作用于这一次发送的 TCP 连接：目标站只有经代理可达、或者域名只能由代理
   * 解析时用它。不是系统代理，也不影响界面本身怎么加载。
   */
  upstreamProxy?: string;
}

/**
 * textarea 的 value 取值会把 CRLF 规范化成 LF（HTML 规范），而后端截图接口
 * （/api/capture）正是通过 textarea 填包再点发送的。于是纯 LF 的报文会被当成
 * "报文本身"发出去：Node/nginx 这类严格解析的服务端直接回 400，看起来像目标有
 * 问题。整段没有任何 CR 时按 CRLF 发送；只要出现过 CR（手写的裸 CR、混合换行都
 * 算），就原样发出，字节保真留给真正在意它的人。
 */
export function normalizePacketLineEndings(raw: string): string {
  return raw.includes("\r") ? raw : raw.replace(/\n/g, "\r\n");
}

/** POST /api/replay：引擎错误也包装在 200 响应体内返回。 */
export async function sendReplay(raw: string, options: ReplayOptions): Promise<ReplayResult> {
  const proxy = options.upstreamProxy?.trim() ?? "";
  const body: Record<string, unknown> = {
    raw: normalizePacketLineEndings(raw),
    options: {
      insecureTLS: options.insecureTLS ?? false,
      ...(proxy === "" ? {} : { upstreamProxy: proxy }),
    },
    save: true,
  };
  if (options.target !== null) {
    body.target = options.target;
  }
  if (options.scriptId !== undefined && options.scriptId !== "") {
    body.scriptId = options.scriptId;
  }
  return (await apiRequest("/replay", {
    method: "POST",
    body,
    timeoutMs: 60_000,
  })) as ReplayResult;
}

/* -------------------------------------------------------------------------- */
/* /api/tabs                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReplayTab {
  id: string;
  name: string;
  rawRequest: string;
  scriptId: string;
  sortOrder: number;
  /** 请求/响应高亮（服务端保存，无头截图也能带上） */
  highlights?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTab(value: unknown): ReplayTab {
  const source = isRecord(value) ? value : {};
  return {
    id: typeof source.id === "string" ? source.id : "",
    name: typeof source.name === "string" ? source.name : "未命名",
    rawRequest: typeof source.rawRequest === "string" ? source.rawRequest : "",
    scriptId: typeof source.scriptId === "string" ? source.scriptId : "",
    sortOrder: typeof source.sortOrder === "number" ? source.sortOrder : 0,
    ...(source.highlights === undefined ? {} : { highlights: source.highlights }),
  };
}

export async function listTabs(): Promise<ReplayTab[]> {
  const payload = (await apiRequest("/tabs")) as unknown;
  const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
  return items.map(normalizeTab).filter((tab) => tab.id !== "");
}

export async function createTab(name: string, rawRequest: string): Promise<ReplayTab> {
  const payload = await apiRequest("/tabs", { method: "POST", body: { name, rawRequest } });
  return normalizeTab(payload);
}

export async function updateTab(
  id: string,
  patch: { name?: string; rawRequest?: string; scriptId?: string },
): Promise<ReplayTab> {
  const payload = await apiRequest(`/tabs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
  return normalizeTab(payload);
}

export async function deleteTab(id: string): Promise<void> {
  await apiRequest(`/tabs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* -------------------------------------------------------------------------- */
/* /api/flows                                                                  */
/* -------------------------------------------------------------------------- */

export interface FlowItem {
  id: string;
  ts: number;
  method: string;
  scheme: string;
  host: string;
  port: number;
  path: string;
  query: string;
  status: number;
  reqSize: number;
  respSize: number;
  durationMs: number;
  source: string;
  /** 取证抓取会被标记为 "evidence: <url> · <mode>" */
  note: string;
}

export interface FlowQuery {
  host?: string;
  method?: string;
  q?: string;
  limit?: number;
  /** keyset 游标：传入上一页返回的 nextCursor 即取更旧的一页 */
  cursor?: string;
}

export interface FlowPage {
  items: FlowItem[];
  nextCursor: string | null;
  /** 当前筛选条件下的记录总数（忽略游标） */
  total: number;
  hasMore: boolean;
}

export class FlowAuthError extends Error {
  constructor() {
    super("需要访问令牌，请用启动日志中的 URL 打开");
    this.name = "FlowAuthError";
  }
}

/** 读取一条 flow 的原始请求报文（用于"发送到 Repeater"）。 */
export async function getFlowRawRequest(id: string): Promise<string> {
  const payload = await apiRequest(`/flows/${encodeURIComponent(id)}?body=1`);
  const source = isRecord(payload) ? payload : {};
  const bodies = isRecord(source.bodies) ? source.bodies : {};
  const raw = bodies.reqRaw;
  return typeof raw === "string" ? raw : "";
}

export async function listFlows(query: FlowQuery): Promise<FlowPage> {
  const params = new URLSearchParams();
  if (query.host !== undefined && query.host.trim() !== "") {
    params.set("host", query.host.trim());
  }
  if (query.method !== undefined && query.method !== "" && query.method !== "ALL") {
    params.set("method", query.method);
  }
  if (query.q !== undefined && query.q.trim() !== "") {
    params.set("q", query.q.trim());
  }
  params.set("limit", String(query.limit ?? 50));
  if (query.cursor !== undefined && query.cursor !== "") {
    params.set("cursor", query.cursor);
  }

  let payload: unknown;
  try {
    payload = await apiRequest(`/flows?${params.toString()}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new FlowAuthError();
    }
    throw error;
  }

  const source = isRecord(payload) ? payload : {};
  const items = Array.isArray(source.items) ? source.items : [];
  return {
    items: items.map((entry: unknown): FlowItem => {
      const item = isRecord(entry) ? entry : {};
      return {
        id: typeof item.id === "string" ? item.id : "",
        ts: typeof item.ts === "number" ? item.ts : 0,
        method: typeof item.method === "string" ? item.method : "",
        scheme: typeof item.scheme === "string" ? item.scheme : "http",
        host: typeof item.host === "string" ? item.host : "",
        port: typeof item.port === "number" ? item.port : 0,
        path: typeof item.path === "string" ? item.path : "",
        query: typeof item.query === "string" ? item.query : "",
        status: typeof item.status === "number" ? item.status : 0,
        reqSize: typeof item.reqSize === "number" ? item.reqSize : 0,
        respSize: typeof item.respSize === "number" ? item.respSize : 0,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : 0,
        source: typeof item.source === "string" ? item.source : "",
        note: typeof item.note === "string" ? item.note : "",
      };
    }),
    nextCursor: typeof source.nextCursor === "string" ? source.nextCursor : null,
    total: typeof source.total === "number" ? source.total : 0,
    hasMore: source.hasMore === true,
  };
}
