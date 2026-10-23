/** 空值占位符，所有只读信息统一使用。 */
export const EMPTY_VALUE = "—";

export function displayValue(value: string | undefined): string {
  return value !== undefined && value.trim() !== "" ? value : EMPTY_VALUE;
}

export function formatVersion(version: string | undefined): string {
  if (version === undefined || version.trim() === "") {
    return "";
  }
  const trimmed = version.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function formatClock(timestamp: number | null): string {
  if (timestamp === null) {
    return "";
  }
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}
