/**
 * /api/events 的 WebSocket 订阅封装。
 *
 * - 断线后按 3s 退避自动重连；
 * - 未知事件类型交给调用方忽略（前向兼容）；
 * - close() 后不再重连，且清理定时器（组件卸载必须调用，避免重复订阅）。
 */

export interface ServerEvent {
  type: string;
  seq: number;
  ts: string;
  data: unknown;
}

export interface EventSubscription {
  close(): void;
}

type Handler = (event: ServerEvent) => void;

const RECONNECT_MS = 3_000;

function eventsUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/events`;
}

export function subscribe(handler: Handler): EventSubscription {
  let socket: WebSocket | null = null;
  let timer: number | null = null;
  let closed = false;

  const schedule = (): void => {
    if (closed || timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      open();
    }, RECONNECT_MS);
  };

  function open(): void {
    if (closed) return;
    try {
      socket = new WebSocket(eventsUrl());
    } catch {
      schedule();
      return;
    }
    socket.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (raw === "") return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { type?: unknown }).type === "string"
        ) {
          handler(parsed as ServerEvent);
        }
      } catch {
        // 非 JSON 帧直接忽略
      }
    };
    socket.onclose = () => {
      socket = null;
      schedule();
    };
    socket.onerror = () => {
      socket?.close();
    };
  }

  open();

  return {
    close() {
      closed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}
