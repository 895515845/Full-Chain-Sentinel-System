import type { ApiErrorKind, HealthInfo } from "./types";

export const API_BASE = "/api";

const DEFAULT_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 4_000;

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 归一化后的 API 错误：调用方只需区分 kind / status，不必解析原始异常。 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;

  constructor(
    kind: ApiErrorKind,
    message: string,
    status: number | null = null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * 以 `/api` 为基址的 JSON 请求。
 * - 超时与外部取消统一走 AbortSignal
 * - 非 2xx、非法 JSON、网络失败都收敛为 ApiError
 */
export async function apiRequest(
  path: string,
  options: ApiRequestOptions = {},
): Promise<unknown> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const externalSignal = options.signal;
  const controller = new AbortController();
  let timedOut = false;

  if (externalSignal?.aborted) {
    throw new ApiError("aborted", "请求已取消");
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const abortFromExternal = () => {
    controller.abort();
  };
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;

  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      credentials: "same-origin",
      signal: controller.signal,
    });

    if (!response.ok) {
      // 后端统一错误信封 { error: { code, message } }：优先展示服务端中文说明
      let detail = "";
      try {
        const text = await response.text();
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed) && isRecord(parsed.error)) {
          const message = parsed.error.message;
          if (typeof message === "string") detail = message;
        }
      } catch {
        // 响应体不是 JSON：保留默认文案
      }
      throw new ApiError(
        "http",
        detail !== "" ? detail : `后端返回 HTTP ${response.status}`,
        response.status,
      );
    }

    const text = await response.text();
    if (text.trim() === "") {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch (cause) {
      throw new ApiError("parse", "后端响应不是合法 JSON", response.status, cause);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (timedOut) {
      throw new ApiError("timeout", `请求超时（${timeoutMs}ms）`);
    }
    if (externalSignal?.aborted) {
      throw new ApiError("aborted", "请求已取消");
    }
    throw new ApiError("network", "无法连接到后端", null, error);
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

/* -------------------------------------------------------------------------- */
/* /api/health                                                                 */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function readBoolean(source: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (value === "true") {
      return true;
    }
  }
  return false;
}

/**
 * 兼容后端可能返回的 camelCase / snake_case / 嵌套结构。
 * 任何字段缺失都只产生空值，绝不抛异常。
 */
export function normalizeHealth(payload: unknown): HealthInfo {
  const top = isRecord(payload) ? payload : {};
  const data = isRecord(top.data) ? top.data : {};
  const root: Record<string, unknown> = { ...top, ...data };
  const server = isRecord(root.server) ? root.server : {};
  const proxy = isRecord(root.proxy) ? root.proxy : {};

  const os = readString(root, ["os"]);
  const arch = readString(root, ["arch"]);
  const platform =
    readString(root, ["platform"]) ||
    [os, arch].filter((part) => part !== "").join("/");

  return {
    status: readString(root, ["status", "state"]) || "unknown",
    version: readString(root, ["version"]),
    platform,
    dataDir: readString(root, ["dataDir", "data_dir", "dataPath", "data_path"]),
    listen:
      readString(root, ["listen", "addr", "address", "serverAddr", "server_addr"]) ||
      readString(server, ["listen", "addr", "address"]),
    proxyRunning:
      readBoolean(root, ["proxyRunning", "proxy_running"]) ||
      readBoolean(proxy, ["running", "enabled"]),
    proxyAddr:
      readString(root, ["proxyAddr", "proxy_addr"]) ||
      readString(proxy, ["addr", "listen", "address"]),
  };
}

export async function getHealth(signal?: AbortSignal): Promise<HealthInfo> {
  const payload = await apiRequest("/health", {
    timeoutMs: HEALTH_TIMEOUT_MS,
    signal,
  });
  return normalizeHealth(payload);
}
