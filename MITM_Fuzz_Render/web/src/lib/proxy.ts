import { apiRequest } from "./api";

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

export interface ProxyStatus {
  running: boolean;
  listen: string;
  caReady: boolean;
  captured: number;
  bypass: string[];
  insecureUpstream: boolean;
  caFingerprint: string;
  caSubject: string;
  caNotAfter: string;
}

export interface DiagnoseResult {
  trusted: boolean;
  probe: string;
  fingerprint: string;
  subject: string;
  notAfter: string;
  instructions: string[];
}

/* -------------------------------------------------------------------------- */
/* 归一化：字段缺失一律降级为空值，绝不抛异常                                   */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function bool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

function num(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strList(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeStatus(payload: unknown): ProxyStatus {
  const source = isRecord(payload) ? payload : {};
  return {
    running: bool(source, "running"),
    listen: str(source, "listen"),
    caReady: bool(source, "caReady"),
    captured: num(source, "captured"),
    bypass: strList(source, "bypass"),
    insecureUpstream: bool(source, "insecureUpstream"),
    caFingerprint: str(source, "caFingerprint"),
    caSubject: str(source, "caSubject"),
    caNotAfter: str(source, "caNotAfter"),
  };
}

/* -------------------------------------------------------------------------- */
/* 接口                                                                        */
/* -------------------------------------------------------------------------- */

export async function getProxyStatus(): Promise<ProxyStatus> {
  return normalizeStatus(await apiRequest("/proxy", { timeoutMs: 8_000 }));
}

export async function startProxy(listen: string): Promise<ProxyStatus> {
  const body = listen.trim() === "" ? {} : { listen: listen.trim() };
  return normalizeStatus(await apiRequest("/proxy/start", { method: "POST", body, timeoutMs: 10_000 }));
}

export async function stopProxy(): Promise<ProxyStatus> {
  return normalizeStatus(await apiRequest("/proxy/stop", { method: "POST", timeoutMs: 10_000 }));
}

export async function setInsecureUpstream(on: boolean): Promise<ProxyStatus> {
  return normalizeStatus(
    await apiRequest("/proxy/insecure", { method: "POST", body: { on }, timeoutMs: 10_000 }),
  );
}

export async function setBypass(host: string, on: boolean): Promise<ProxyStatus> {
  return normalizeStatus(
    await apiRequest("/proxy/bypass", { method: "POST", body: { host, on }, timeoutMs: 10_000 }),
  );
}

export async function regenerateCA(): Promise<ProxyStatus> {
  return normalizeStatus(
    await apiRequest("/proxy/ca/regenerate", {
      method: "POST",
      body: { confirm: true },
      timeoutMs: 15_000,
    }),
  );
}

export async function diagnoseProxy(): Promise<DiagnoseResult> {
  const payload = await apiRequest("/proxy/diagnose", { timeoutMs: 12_000 });
  const source = isRecord(payload) ? payload : {};
  return {
    trusted: bool(source, "trusted"),
    probe: str(source, "probe"),
    fingerprint: str(source, "fingerprint"),
    subject: str(source, "subject"),
    notAfter: str(source, "notAfter"),
    instructions: strList(source, "instructions"),
  };
}

export type CAFormat = "pem" | "crt" | "mobileconfig";

/** CA 下载地址（同源，鉴权走 cookie，可直接用于 <a href download>）。 */
export function caDownloadUrl(format: CAFormat): string {
  return `/api/proxy/ca.${format}`;
}
