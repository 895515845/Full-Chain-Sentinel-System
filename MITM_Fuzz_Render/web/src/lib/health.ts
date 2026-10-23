import { useEffect, useState } from "react";
import { getHealth } from "./api";
import type { HealthSnapshot } from "./types";

/** 顶部健康胶囊的轮询间隔。 */
export const HEALTH_POLL_INTERVAL_MS = 10_000;

/**
 * 轮询 `/api/health`。首次为 checking；成功后 online；失败后 offline。
 * 使用递归 setTimeout，保证 10s 间隔内不会叠加请求。
 */
export function useHealth(pollIntervalMs = HEALTH_POLL_INTERVAL_MS): HealthSnapshot {
  const [snapshot, setSnapshot] = useState<HealthSnapshot>({
    state: "checking",
    info: null,
    lastCheckedAt: null,
  });

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeController: AbortController | undefined;

    const scheduleNext = () => {
      if (disposed) {
        return;
      }
      timer = setTimeout(() => {
        void check();
      }, pollIntervalMs);
    };

    async function check(): Promise<void> {
      const controller = new AbortController();
      activeController = controller;

      try {
        const info = await getHealth(controller.signal);
        if (disposed) {
          return;
        }
        setSnapshot({ state: "online", info, lastCheckedAt: Date.now() });
      } catch {
        if (disposed) {
          return;
        }
        setSnapshot({ state: "offline", info: null, lastCheckedAt: Date.now() });
      }

      scheduleNext();
    }

    void check();

    return () => {
      disposed = true;
      activeController?.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [pollIntervalMs]);

  return snapshot;
}
