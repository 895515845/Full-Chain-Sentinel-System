/** 后端 /api/health 的归一化视图。字段缺失时保持空字符串，由 UI 决定如何展示。 */
export interface HealthInfo {
  status: string;
  version: string;
  platform: string;
  dataDir: string;
  listen: string;
  proxyRunning: boolean;
  proxyAddr: string;
}

export type HealthState = "checking" | "online" | "offline";

export interface HealthSnapshot {
  state: HealthState;
  info: HealthInfo | null;
  lastCheckedAt: number | null;
}

/** 页面级 API 错误类型，避免把原始异常直接抛给 UI。 */
export type ApiErrorKind = "aborted" | "timeout" | "network" | "http" | "parse";
