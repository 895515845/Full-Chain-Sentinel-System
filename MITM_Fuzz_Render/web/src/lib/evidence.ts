import { apiRequest } from "./api";

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

export interface EvidenceSource {
  key: string;
  label: string;
  url: string;
  note?: string;
}

export interface EvidenceResult {
  mode: "direct" | "snapshot" | "error";
  url: string;
  reason: string;
  status: number;
  contentType: string;
  size: number;
  fetchedAt: string;
  localTime: string;
  localZone: string;
  flowId: string;
  snapshotId: string;
  snapshotUrl: string;
  truncated: boolean;
  error: { code: string; message: string; retryable?: boolean } | null;
  timings: { connectMs: number; tlsMs: number; ttfbMs: number; totalMs: number };
}

/** 后端不可用时的兜底预设（与 /api/evidence/sources 保持一致）。 */
export const FALLBACK_SOURCES: EvidenceSource[] = [
  { key: "beijing-time", label: "beijing-time.org（北京时间）", url: "https://www.beijing-time.org/", note: "允许内嵌" },
  { key: "bjtime", label: "bjtime.cn（北京时间）", url: "https://bjtime.cn/", note: "允许内嵌" },
  { key: "timeis", label: "time.is/Beijing", url: "https://time.is/Beijing", note: "拒绝内嵌 → 快照" },
  { key: "ntsc", label: "国家授时中心 ntsc.ac.cn", url: "https://www.ntsc.ac.cn/", note: "拒绝内嵌 → 快照" },
  { key: "timeapi", label: "timeapi.io（Asia/Shanghai JSON）", url: "https://timeapi.io/api/Time/current/zone?timeZone=Asia/Shanghai", note: "JSON 文本" },
];

/* -------------------------------------------------------------------------- */
/* 归一化                                                                      */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function num(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeSource(value: unknown): EvidenceSource | null {
  const source = isRecord(value) ? value : {};
  const url = str(source, "url");
  if (url === "") return null;
  return {
    key: str(source, "key"),
    label: str(source, "label") || url,
    url,
    ...(str(source, "note") === "" ? {} : { note: str(source, "note") }),
  };
}

function normalizeResult(payload: unknown): EvidenceResult {
  const source = isRecord(payload) ? payload : {};
  const err = isRecord(source.error) ? source.error : null;
  const timings = isRecord(source.timings) ? source.timings : {};
  const mode = str(source, "mode");
  return {
    mode: mode === "direct" || mode === "snapshot" || mode === "error" ? mode : "error",
    url: str(source, "url"),
    reason: str(source, "reason"),
    status: num(source, "status"),
    contentType: str(source, "contentType"),
    size: num(source, "size"),
    fetchedAt: str(source, "fetchedAt"),
    localTime: str(source, "localTime"),
    localZone: str(source, "localZone"),
    flowId: str(source, "flowId"),
    snapshotId: str(source, "snapshotId"),
    snapshotUrl: str(source, "snapshotUrl"),
    truncated: source.truncated === true,
    error:
      err === null
        ? null
        : { code: str(err, "code"), message: str(err, "message"), retryable: err.retryable === true },
    timings: {
      connectMs: num(timings, "connectMs"),
      tlsMs: num(timings, "tlsMs"),
      ttfbMs: num(timings, "ttfbMs"),
      totalMs: num(timings, "totalMs"),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 接口                                                                        */
/* -------------------------------------------------------------------------- */

export async function listEvidenceSources(): Promise<EvidenceSource[]> {
  try {
    const payload = await apiRequest("/evidence/sources", { timeoutMs: 6_000 });
    const source = isRecord(payload) ? payload : {};
    const items = Array.isArray(source.items) ? source.items : [];
    const list = items
      .map(normalizeSource)
      .filter((item): item is EvidenceSource => item !== null);
    return list.length > 0 ? list : FALLBACK_SOURCES;
  } catch {
    return FALLBACK_SOURCES;
  }
}

export interface EvidenceOptions {
  mode?: "auto" | "direct" | "snapshot";
  allowScripts?: boolean;
  insecure?: boolean;
}

/** 抓取取证页面：auto 模式会返回 direct（前端直嵌原站）或 snapshot（同源快照）。 */
export async function fetchEvidence(
  url: string,
  options: EvidenceOptions = {},
): Promise<EvidenceResult> {
  const params = new URLSearchParams({ url });
  params.set("mode", options.mode ?? "auto");
  if (options.allowScripts === true) params.set("allowScripts", "1");
  if (options.insecure === true) params.set("insecure", "1");
  const payload = await apiRequest(`/evidence?${params.toString()}`, { timeoutMs: 60_000 });
  return normalizeResult(payload);
}

/** iframe 实际加载的地址：快照走同源端点，direct 直接用原站。 */
export function evidenceFrameSrc(result: EvidenceResult | null): string {
  if (result === null) return "";
  if (result.mode === "snapshot") return result.snapshotUrl;
  if (result.mode === "direct") return result.url;
  return "";
}
