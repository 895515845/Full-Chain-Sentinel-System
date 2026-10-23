import { formatClock, formatVersion } from "../lib/format";
import type { HealthInfo, HealthState } from "../lib/types";

interface StatusPillProps {
  state: HealthState;
  info: HealthInfo | null;
  lastCheckedAt: number | null;
}

const STATE_STYLE: Record<HealthState, { dot: string; border: string; text: string }> = {
  checking: {
    dot: "bg-muted",
    border: "border-line",
    text: "text-muted",
  },
  online: {
    dot: "bg-accent",
    border: "border-accent/30",
    text: "text-accent",
  },
  offline: {
    dot: "bg-danger",
    border: "border-danger/30",
    text: "text-danger",
  },
};

/** 后端健康状态胶囊：每 10s 轮询 /api/health。 */
export default function StatusPill({ state, info, lastCheckedAt }: StatusPillProps) {
  const style = STATE_STYLE[state];
  const version = formatVersion(info?.version);
  const label =
    state === "online"
      ? version !== ""
        ? version
        : "后端已连接"
      : state === "offline"
        ? "后端未连接"
        : "检查中…";

  const lastChecked = formatClock(lastCheckedAt);
  const title =
    state === "online"
      ? `/api/health · 已连接${lastChecked === "" ? "" : ` · 最近检查 ${lastChecked}`}`
      : state === "offline"
        ? `/api/health 不可达${lastChecked === "" ? "" : ` · 最近检查 ${lastChecked}`} · 每 10 秒重试`
        : "/api/health · 正在检查";

  return (
    <span
      data-testid="health-pill"
      data-state={state}
      role="status"
      aria-live="polite"
      title={title}
      className={`inline-flex h-7 items-center gap-2 rounded-md border bg-bg px-2.5 font-mono text-[11px] ${style.border} ${style.text}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      <span className="sr-only">后端状态：</span>
      <span>{label}</span>
    </span>
  );
}
