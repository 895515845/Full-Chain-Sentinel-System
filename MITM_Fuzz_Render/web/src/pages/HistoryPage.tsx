import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import EmptyState from "../components/EmptyState";
import { ApiError } from "../lib/api";
import { subscribe } from "../lib/events";
import {
  createTab,
  FlowAuthError,
  getFlowRawRequest,
  listFlows,
  type FlowItem,
} from "../lib/replay";

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M13 8a5 5 0 1 1-1.45-3.52M13 2.5v3.1H9.9" />
    </svg>
  );
}

function formatTime(ts: number): string {
  if (ts <= 0) return "—";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function methodColor(method: string): string {
  switch (method) {
    case "GET":
      return "text-accent";
    case "POST":
      return "text-blue-400";
    case "PUT":
    case "PATCH":
      return "text-yellow-400";
    case "DELETE":
      return "text-danger";
    default:
      return "text-muted";
  }
}

function statusColor(status: number): string {
  if (status >= 500) return "text-danger";
  if (status >= 400) return "text-yellow-400";
  if (status >= 300) return "text-blue-400";
  if (status >= 200) return "text-accent";
  return "text-muted";
}

function flowUrl(flow: FlowItem): string {
  const portPart = flow.port > 0 ? `:${flow.port}` : "";
  const queryPart = flow.query !== "" ? `?${flow.query}` : "";
  return `${flow.scheme}://${flow.host}${portPart}${flow.path}${queryPart}`;
}

type LoadState = "loading" | "ready" | "auth" | "error";

/** 抓包历史：真实 /api/flows 数据 + 筛选 + 刷新。 */
export default function HistoryPage() {
  const [method, setMethod] = useState("ALL");
  const [host, setHost] = useState("");
  const [search, setSearch] = useState("");
  const [flows, setFlows] = useState<FlowItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const navigate = useNavigate();

  // ---- 分页（keyset 游标 + 游标栈，支持"上一页"）----
  const [pageSize, setPageSize] = useState(() => {
    const stored = Number(window.localStorage.getItem("replayd.historyPageSize") ?? "50");
    return [25, 50, 100, 200].includes(stored) ? stored : 50;
  });
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [nextCursor, setNextCursor] = useState("");
  const [total, setTotal] = useState(0);
  const [pendingNew, setPendingNew] = useState(0);
  const pageIndex = cursors.length - 1;

  // 最新筛选条件（供 WS 回调使用，避免反复重建订阅）
  const filterRef = useRef({ host, method, search });
  filterRef.current = { host, method, search };

  // 只在最新一页时把新抓包直接插到顶部；否则累计提示，避免翻页时列表跳动
  const atNewestRef = useRef(true);
  atNewestRef.current = pageIndex === 0;

  const fetchPage = useCallback(
    async (cursor: string | undefined) => {
      setRefreshing(true);
      try {
        const page = await listFlows({
          host,
          method,
          q: search,
          limit: pageSize,
          ...(cursor === undefined ? {} : { cursor }),
        });
        setFlows(page.items);
        setNextCursor(page.nextCursor ?? "");
        setTotal(page.total);
        setState("ready");
      } catch (error) {
        if (error instanceof FlowAuthError) {
          setState("auth");
        } else {
          setState("error");
          setErrorMessage(error instanceof ApiError ? error.message : "无法连接到后端");
        }
      } finally {
        setRefreshing(false);
      }
    },
    [host, method, search, pageSize],
  );

  /** 回到最新一页（也是刷新按钮的行为）。 */
  const load = useCallback(async () => {
    setCursors([undefined]);
    setPendingNew(0);
    await fetchPage(undefined);
  }, [fetchPage]);

  const goNext = useCallback(async () => {
    if (nextCursor === "") return;
    const next = [...cursors, nextCursor];
    setCursors(next);
    await fetchPage(nextCursor);
  }, [cursors, nextCursor, fetchPage]);

  const goPrev = useCallback(async () => {
    if (cursors.length <= 1) return;
    const trimmed = cursors.slice(0, -1);
    setCursors(trimmed);
    await fetchPage(trimmed[trimmed.length - 1]);
  }, [cursors, fetchPage]);

  useEffect(() => {
    void load();
    // 挂载时拉取；筛选条件或每页条数变化时回到最新一页
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, method, search, pageSize]);

  useEffect(() => {
    try {
      window.localStorage.setItem("replayd.historyPageSize", String(pageSize));
    } catch {
      // 隐私模式忽略
    }
  }, [pageSize]);

  // 键盘翻页：← 上一页 / → 下一页（输入框内不生效）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (event.key === "ArrowRight" && nextCursor !== "") void goNext();
      else if (event.key === "ArrowLeft" && cursors.length > 1) void goPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, nextCursor, cursors.length]);

  // 实时抓包流：proxy 抓到的请求逐条插入顶部
  useEffect(() => {
    const subscription = subscribe((event) => {
      if (event.type === "hello" || event.type === "ping") {
        setLive(true);
        return;
      }
      if (event.type !== "flow.new") return;
      const data = event.data;
      if (typeof data !== "object" || data === null) return;
      const item = data as Record<string, unknown>;
      if (typeof item.id !== "string" || item.id === "") return;

      const { host: fHost, method: fMethod, search: fSearch } = filterRef.current;
      const host = typeof item.host === "string" ? item.host : "";
      const method = typeof item.method === "string" ? item.method : "";
      const path = typeof item.path === "string" ? item.path : "";
      if (fHost.trim() !== "" && host !== fHost.trim()) return;
      if (fMethod !== "" && fMethod !== "ALL" && method !== fMethod) return;
      if (fSearch.trim() !== "" && !`${host}${path}`.includes(fSearch.trim())) return;

      const flow: FlowItem = {
        id: item.id,
        ts: typeof item.ts === "number" ? item.ts : Date.now(),
        method,
        scheme: typeof item.scheme === "string" ? item.scheme : "http",
        host,
        port: typeof item.port === "number" ? item.port : 0,
        path,
        query: "",
        status: typeof item.status === "number" ? item.status : 0,
        reqSize: 0,
        respSize: 0,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : 0,
        source: typeof item.source === "string" ? item.source : "proxy",
        note:
          item.evidence === true
            ? "evidence: (实时)"
            : item.render === true
              ? "render: (实时)"
              : "",
      };
      if (!atNewestRef.current) {
        setPendingNew((count) => count + 1);
        return;
      }
      setPendingNew(0);
      setTotal((prev) => prev + 1);
      setFlows((prev) => (prev.some((entry) => entry.id === flow.id) ? prev : [flow, ...prev]));
    });

    // 连接状态无法直接感知时，用 hello 事件确认已连通
    const timer = window.setTimeout(() => setLive(true), 1_200);
    return () => {
      window.clearTimeout(timer);
      subscription.close();
    };
  }, []);

  /** 把历史记录发到 Repeater：取 raw 请求 → 建 tab → 跳转选中。 */
  const sendToRepeater = useCallback(
    async (flow: FlowItem) => {
      setSendingId(flow.id);
      setNotice("");
      try {
        const raw = await getFlowRawRequest(flow.id);
        if (raw.trim() === "") {
          setNotice("该记录没有可用的原始请求（隧道/WebSocket 记录不支持重放）");
          return;
        }
        const name = `${flow.method} ${flow.host}${flow.path}`.slice(0, 60);
        const tab = await createTab(name, raw);
        navigate(`/repeater?tab=${encodeURIComponent(tab.id)}`);
      } catch (error) {
        setNotice(error instanceof ApiError ? `发送失败：${error.message}` : "发送失败");
      } finally {
        setSendingId(null);
      }
    },
    [navigate],
  );



  return (
    <section data-testid="page-history" className="flex h-full min-h-0 flex-col">
      <div
        role="group"
        aria-label="抓包历史筛选"
        data-testid="history-toolbar"
        className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel/60 px-5"
      >
        <label htmlFor="history-method" className="sr-only">
          按请求方法筛选
        </label>
        <select
          id="history-method"
          data-testid="history-method"
          className="field w-[104px] font-mono"
          value={method}
          onChange={(event) => setMethod(event.target.value)}
        >
          <option value="ALL">全部方法</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="DELETE">DELETE</option>
        </select>

        <label htmlFor="history-host" className="sr-only">
          按主机筛选
        </label>
        <input
          id="history-host"
          data-testid="history-host"
          type="text"
          className="field w-[208px] font-mono"
          placeholder="Host，例如 example.com"
          value={host}
          onChange={(event) => setHost(event.target.value)}
        />

        <div className="relative w-[268px]">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted/50">
            <SearchIcon />
          </span>
          <label htmlFor="history-search" className="sr-only">
            搜索抓包记录
          </label>
          <input
            id="history-search"
            data-testid="history-search"
            type="search"
            className="field w-full pl-7"
            placeholder="搜索 URL / 路径 / 关键字"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span
            data-testid="history-live"
            data-state={live ? "live" : "offline"}
            className="flex items-center gap-1 font-mono text-[10px] text-muted/60"
            title={live ? "事件流已连接，新抓包会实时出现" : "事件流未连接，点击刷新可手动拉取"}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${live ? "bg-accent" : "bg-muted/40"}`}
            />
            {live ? "实时" : "离线"}
          </span>
          <span data-testid="history-total" className="font-mono text-[10px] text-muted/60">
            共 {total} 条
          </span>
          <button
            type="button"
            data-testid="history-refresh"
            className="btn"
            disabled={refreshing}
            onClick={() => void load()}
          >
            <RefreshIcon />
            {refreshing ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {notice !== "" ? (
        <p
          role="status"
          data-testid="history-notice"
          className="shrink-0 border-b border-line bg-yellow-500/10 px-5 py-2 text-[11px] text-yellow-400"
        >
          {notice}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-5">
        {state === "auth" ? (
          <div
            role="alert"
            data-testid="history-auth-required"
            className="flex flex-1 items-center justify-center"
          >
            <div className="w-full max-w-[520px] rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-5 py-6 text-center">
              <p className="text-[13px] font-medium text-yellow-400">需要访问令牌</p>
              <p className="mt-2 text-[12px] leading-relaxed text-ink">
                需要访问令牌，请用启动日志中的 URL 打开
              </p>
            </div>
          </div>
        ) : state === "error" ? (
          <div
            role="alert"
            data-testid="history-error"
            className="flex flex-1 flex-col items-center justify-center gap-3"
          >
            <p className="text-[13px] text-danger">加载抓包记录失败：{errorMessage}</p>
            <button
              type="button"
              data-testid="history-retry"
              className="btn"
              onClick={() => void load()}
            >
              重试
            </button>
          </div>
        ) : flows.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-6">
            <div className="w-full max-w-[720px]">
              <EmptyState
                testId="history-empty"
                title={state === "loading" ? "正在加载抓包记录…" : "暂无抓包"}
                description={
                  state === "loading"
                    ? "正在从后端拉取记录"
                    : "启动代理后，浏览器访问的 HTTP/HTTPS 请求会实时出现在这里"
                }
                hint="记录包含：方法 · 主机 · 路径 · 状态码 · 长度 · 耗时"
              />
            </div>
          </div>
        ) : (
          <table
            data-testid="history-table"
            className="w-full border-separate border-spacing-0 text-left"
          >
            <thead>
              <tr className="font-mono text-[10px] uppercase tracking-wider text-muted/60">
                <th scope="col" className="sticky top-0 border-b border-line bg-bg px-2 py-2">
                  时间
                </th>
                <th scope="col" className="sticky top-0 border-b border-line bg-bg px-2 py-2">
                  方法
                </th>
                <th scope="col" className="sticky top-0 border-b border-line bg-bg px-2 py-2">
                  URL
                </th>
                <th scope="col" className="sticky top-0 border-b border-line bg-bg px-2 py-2">
                  状态
                </th>
                <th
                  scope="col"
                  className="sticky top-0 border-b border-line bg-bg px-2 py-2 text-right"
                >
                  响应大小
                </th>
                <th
                  scope="col"
                  className="sticky top-0 border-b border-line bg-bg px-2 py-2 text-right"
                >
                  耗时
                </th>
                <th scope="col" className="sticky top-0 border-b border-line bg-bg px-2 py-2">
                  来源
                </th>
                <th scope="col" className="sticky top-0 border-b border-line bg-bg px-2 py-2 text-right">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="font-mono text-[11px]">
              {flows.map((flow) => (
                <tr
                  key={flow.id}
                  data-testid="flow-row"
                  className="hover:bg-panel/60"
                >
                  <td className="border-b border-line/60 px-2 py-1.5 text-muted">
                    {formatTime(flow.ts)}
                  </td>
                  <td
                    className={`border-b border-line/60 px-2 py-1.5 font-medium ${methodColor(flow.method)}`}
                  >
                    {flow.method}
                  </td>
                  <td className="max-w-[480px] truncate border-b border-line/60 px-2 py-1.5 text-ink">
                    {flowUrl(flow)}
                  </td>
                  <td className={`border-b border-line/60 px-2 py-1.5 ${statusColor(flow.status)}`}>
                    {flow.status > 0 ? flow.status : "—"}
                  </td>
                  <td className="border-b border-line/60 px-2 py-1.5 text-right text-muted">
                    {formatBytes(flow.respSize)}
                  </td>
                  <td className="border-b border-line/60 px-2 py-1.5 text-right text-muted">
                    {flow.durationMs} ms
                  </td>
                  <td className="border-b border-line/60 px-2 py-1.5">
                    {flow.method === "CONNECT" ? (
                      <span className="badge" title="bypass 隧道：未解密">
                        隧道
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        {flow.note.startsWith("evidence:") ? (
                          <span className="badge border-accent/40 text-accent" title={flow.note}>
                            取证
                          </span>
                        ) : null}
                        {flow.note.startsWith("render:") ? (
                          <span className="badge border-blue-400/40 text-blue-400" title={flow.note}>
                            渲染
                          </span>
                        ) : null}
                        <span className={flow.source === "proxy" ? "text-blue-400" : "text-muted"}>
                          {flow.source === "proxy" ? "proxy" : "replay"}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="border-b border-line/60 px-2 py-1.5 text-right">
                    <button
                      type="button"
                      data-testid={`flow-to-repeater-${flow.id}`}
                      className="btn"
                      disabled={sendingId === flow.id || flow.method === "CONNECT"}
                      title={
                        flow.method === "CONNECT"
                          ? "隧道记录没有可重放的原始请求"
                          : "取原始请求并新建 Repeater 标签"
                      }
                      onClick={() => void sendToRepeater(flow)}
                    >
                      {sendingId === flow.id ? "发送中…" : "发送到 Repeater"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div
        role="group"
        aria-label="历史分页"
        data-testid="history-pager"
        className="flex h-11 shrink-0 items-center gap-3 border-t border-line bg-panel/60 px-5 font-mono text-[11px] text-muted"
      >
        <span data-testid="history-page-info">
          第 {pageIndex + 1} 页 · 每页 {pageSize} 条 · 共 {total} 条
        </span>
        {pendingNew > 0 ? (
          <button
            type="button"
            data-testid="history-new-pill"
            className="btn h-6 border-accent/40 px-2 text-[11px] text-accent"
            onClick={() => void load()}
            title="你正在查看较早的记录，点击回到最新"
          >
            ↑ {pendingNew} 条新记录
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1" htmlFor="history-page-size">
            每页
            <select
              id="history-page-size"
              data-testid="history-page-size"
              className="field h-6 font-mono text-[11px]"
              value={String(pageSize)}
              onChange={(event) => setPageSize(Number(event.target.value))}
            >
              {[25, 50, 100, 200].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="history-first"
            className="btn h-6 px-2 text-[11px]"
            disabled={pageIndex === 0 || refreshing}
            onClick={() => void load()}
          >
            « 最新
          </button>
          <button
            type="button"
            data-testid="history-prev"
            className="btn h-6 px-2 text-[11px]"
            disabled={pageIndex === 0 || refreshing}
            onClick={() => void goPrev()}
          >
            ‹ 上一页
          </button>
          <button
            type="button"
            data-testid="history-next"
            className="btn h-6 px-2 text-[11px]"
            disabled={nextCursor === "" || refreshing}
            onClick={() => void goNext()}
          >
            下一页 ›
          </button>
        </div>
      </div>
    </section>
  );
}
