import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import {
  evidenceFrameSrc,
  fetchEvidence,
  listEvidenceSources,
  type EvidenceResult,
  type EvidenceSource,
} from "../lib/evidence";

const URL_KEY = "replayd.evidenceUrl";
const AUTO_KEY = "replayd.evidenceAuto";

function readStored(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式下忽略
  }
}

function clockText(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** 取证面板：并排展示第三方时间源，作为攻防演练的时间证据。 */
export default function EvidencePanel({ onHide }: { onHide: () => void }) {
  const [sources, setSources] = useState<EvidenceSource[]>([]);
  const [url, setUrl] = useState(() => readStored(URL_KEY, "https://www.beijing-time.org/"));
  const [mode, setMode] = useState<"auto" | "direct" | "snapshot">("auto");
  const [allowScripts, setAllowScripts] = useState(true);
  const [autoSec, setAutoSec] = useState(() => Number(readStored(AUTO_KEY, "30")) || 0);
  const [result, setResult] = useState<EvidenceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameWaited, setFrameWaited] = useState(0);
  const [full, setFull] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    void listEvidenceSources().then(setSources);
  }, []);

  // 本机时间每秒走字：截图时与站点时间互相印证
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    store(URL_KEY, url);
  }, [url]);
  useEffect(() => {
    store(AUTO_KEY, String(autoSec));
  }, [autoSec]);

  const load = useCallback(
    async (target?: string) => {
      const wanted = (target ?? url).trim();
      if (wanted === "") {
        setError("请填写要取证的时间页地址");
        return;
      }
      setLoading(true);
      setError("");
      try {
        const res = await fetchEvidence(wanted, { mode, allowScripts });
        setResult(res);
        setReloadKey((key) => key + 1);
        if (res.mode === "error") {
          setError(res.error?.message ?? "抓取失败");
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "抓取失败");
      } finally {
        setLoading(false);
      }
    },
    [url, mode, allowScripts],
  );

  // 首次进入自动抓一次；模式/脚本开关变化时重抓
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, allowScripts]);

  // 自动刷新（让站点时钟保持走动）
  useEffect(() => {
    if (autoSec <= 0) return;
    const timer = window.setInterval(() => {
      void load();
    }, autoSec * 1000);
    return () => window.clearInterval(timer);
  }, [autoSec, load]);

  const frameSrc = evidenceFrameSrc(result);
  // 新的 iframe（新的 src/key）一出现就重置加载状态，加载完成由 onLoad 上报
  useEffect(() => {
    setFrameLoaded(false);
    setFrameWaited(0);
  }, [frameSrc, reloadKey]);

  // iframe 迟迟没加载完时，把等待秒数显示出来（配合下面的"疑似空白"提示）
  useEffect(() => {
    if (frameSrc === "" || frameLoaded) return;
    const timer = window.setInterval(() => setFrameWaited((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, [frameSrc, frameLoaded]);
  const modeLabel =
    result === null
      ? "未抓取"
      : result.mode === "direct"
        ? "实时内嵌 iframe（原站）"
        : result.mode === "snapshot"
          ? "服务端快照（已剥离脚本）"
          : "抓取失败";

  // ⓘ 的一行摘要：无头截图/接口回读都靠它（不依赖弹层是否展开）
  const summary = [
    `来源 ${result?.url ?? url}`,
    `模式 ${modeLabel}`,
    `抓取 ${result?.fetchedAt ?? "—"}`,
    `本机 ${clockText(clock)}`,
    ...(result?.flowId !== undefined && result.flowId !== "" ? [`已记入历史 ${result.flowId}`] : []),
    ...(result?.reason !== undefined && result.reason !== "" ? [`不可直嵌 ${result.reason}`] : []),
  ].join(" · ");

  useEffect(() => {
    if (!infoOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInfoOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [infoOpen]);

  return (
    <section
      data-testid="evidence-panel"
      aria-label="取证面板"
      className={
        full
          ? "fixed inset-0 z-40 flex flex-col bg-bg"
          : "relative flex min-w-[300px] flex-1 flex-col bg-panel/20"
      }
    >
      {/* 工具栏 */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <h2 className="text-[12px] font-medium text-ink">取证</h2>
        <span
          data-testid="evidence-mode"
          className={`badge ${result?.mode === "direct" ? "border-accent/40 text-accent" : ""}`}
        >
          {result?.mode === "direct" ? "实时内嵌" : result?.mode === "snapshot" ? "服务端快照" : "—"}
        </span>
        {result !== null ? (
          <span data-testid="evidence-fetched-badge" className="badge" title={result.fetchedAt}>
            抓取 {result.localTime || "—"}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="evidence-info"
            aria-expanded={infoOpen}
            aria-label="取证详情"
            title="来源 / 模式 / 抓取时间 / flowId"
            data-has-result={result !== null ? "1" : "0"}
            data-summary={summary}
            className={`btn h-6 w-6 px-0 text-[11px] ${infoOpen ? "border-accent/50 text-accent" : ""}`}
            onClick={() => setInfoOpen((value) => !value)}
          >
            i
          </button>
          <button
            type="button"
            data-testid="evidence-fullscreen"
            className="btn h-6 px-2 text-[11px]"
            onClick={() => setFull((v) => !v)}
            title={full ? "退出全屏" : "把时间页放大到整个窗口（便于截图）"}
          >
            {full ? "退出全屏" : "全屏取证"}
          </button>
          <button
            type="button"
            data-testid="evidence-hide"
            className="btn h-6 px-2 text-[11px]"
            onClick={onHide}
            title="隐藏取证面板（回到两栏）"
          >
            隐藏
          </button>
        </div>
      </header>

      {/* 地址与参数 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
        <select
          data-testid="evidence-preset"
          className="field h-6 max-w-[190px] text-[11px]"
          defaultValue=""
          onChange={(event) => {
            const picked = sources.find((item) => item.key === event.target.value);
            if (picked !== undefined) {
              setUrl(picked.url);
              void load(picked.url);
            }
            event.target.value = "";
          }}
        >
          <option value="">预设时间源…</option>
          {sources.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
              {item.note === undefined ? "" : ` · ${item.note}`}
            </option>
          ))}
        </select>
        <input
          data-testid="evidence-url"
          aria-label="取证页面地址"
          className="field h-6 min-w-[160px] flex-1 font-mono text-[11px]"
          value={url}
          spellCheck={false}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void load();
          }}
        />
        <button
          type="button"
          data-testid="evidence-refresh"
          className="btn btn-primary h-6 px-2 text-[11px]"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "抓取中…" : "刷新"}
        </button>
        <label className="flex items-center gap-1 text-[11px] text-muted">
          模式
          <select
            data-testid="evidence-mode-select"
            className="field h-6 text-[11px]"
            value={mode}
            onChange={(event) => {
              const next = event.target.value;
              setMode(next === "direct" ? "direct" : next === "snapshot" ? "snapshot" : "auto");
            }}
            title="自动：能内嵌就直嵌原站，否则转服务端快照；也可手动强制"
          >
            <option value="auto">自动</option>
            <option value="direct">强制直嵌</option>
            <option value="snapshot">强制快照</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-[11px] text-muted">
          自动
          <select
            data-testid="evidence-auto"
            className="field h-6 text-[11px]"
            value={String(autoSec)}
            onChange={(event) => setAutoSec(Number(event.target.value))}
          >
            <option value="0">关</option>
            <option value="30">30s</option>
            <option value="60">60s</option>
          </select>
        </label>
        <label
          className="flex items-center gap-1 text-[11px] text-muted"
          title="多数时间源用 JS 绘制时钟：关闭脚本时快照会是一张白页。脚本仍在 sandbox 中运行（不给 same-origin），拿不到本工具的会话"
        >
          <input
            type="checkbox"
            data-testid="evidence-allow-scripts"
            checked={allowScripts}
            onChange={(event) => setAllowScripts(event.target.checked)}
          />
          允许脚本
        </label>
      </div>

      {/*
        取证信息收进 ⓘ（方案 C）。
        隐藏的一段纯文本保留 data-testid="evidence-watermark"：截图端/无头渲染靠它判断
        "面板已拿到内容"，也方便不支持弹层的场合读取。
      */}
      <span data-testid="evidence-watermark" className="sr-only">
        {summary}
      </span>

      {infoOpen ? (
        <div
          data-testid="evidence-info-popover"
          className="absolute right-2 top-[72px] z-20 w-[420px] max-w-[calc(100%-16px)] rounded-md border border-line bg-bg/95 p-2 font-mono text-[10px] leading-5 text-muted shadow-xl backdrop-blur"
        >
          <dl className="flex flex-col gap-0.5">
            <div className="flex gap-2">
              <dt className="shrink-0">来源</dt>
              <dd className="min-w-0 break-all text-ink">{result?.url ?? url}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0">模式</dt>
              <dd className="text-ink">{modeLabel}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0">抓取</dt>
              <dd className="text-ink">{result?.fetchedAt ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0">本机</dt>
              <dd className="text-ink">{clockText(clock)}</dd>
            </div>
            {result?.flowId !== undefined && result.flowId !== "" ? (
              <div className="flex gap-2">
                <dt className="shrink-0">已记入历史</dt>
                <dd className="min-w-0 break-all text-ink">{result.flowId}</dd>
              </div>
            ) : null}
            {result?.reason !== undefined && result.reason !== "" ? (
              <div className="flex gap-2">
                <dt className="shrink-0">不可直嵌</dt>
                <dd className="text-yellow-400/90">{result.reason}</dd>
              </div>
            ) : null}
            {result?.truncated === true ? (
              <div className="flex gap-2">
                <dt className="shrink-0">提示</dt>
                <dd className="text-yellow-400/90">内容已截断</dd>
              </div>
            ) : null}
          </dl>
          <p className="mt-1 border-t border-line pt-1 text-[9.5px] text-muted/60">
            点 ⓘ 或按 Esc 收起；无头截图会默认展开这一层
          </p>
        </div>
      ) : null}

      {error !== "" ? (
        <p
          role="alert"
          data-testid="evidence-error"
          className="shrink-0 border-b border-line bg-danger/10 px-2 py-1.5 text-[11px] text-danger"
        >
          {error}
        </p>
      ) : null}

      {/* 内容 */}
      <div className="relative min-h-0 flex-1 bg-white">
        {frameSrc !== "" ? (
          <iframe
            key={`${result?.snapshotId ?? "direct"}-${reloadKey}`}
            data-testid="evidence-iframe"
            title="第三方时间源"
            src={frameSrc}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => setFrameLoaded(true)}
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-bg px-4 text-center">
            <p className="text-[11px] leading-relaxed text-muted">
              {loading ? "正在抓取时间页…" : "尚未抓取：点「刷新」或从「预设时间源」里选一个"}
            </p>
          </div>
        )}
        {frameSrc !== "" ? (
          <span
            data-testid="evidence-frame-badge"
            className={`absolute bottom-2 left-2 z-10 rounded px-2 py-0.5 font-mono text-[10px] ${
              frameLoaded ? "bg-black/60 text-accent" : "bg-black/70 text-yellow-400"
            }`}
          >
            {frameLoaded
              ? `已加载${result?.mode === "snapshot" ? "（快照）" : ""}`
              : frameWaited >= 6
                ? `等 ${frameWaited}s 仍未加载完 · 可试：允许脚本 / 换时间源 / 装 CA`
                : `加载中… ${frameWaited}s`}
          </span>
        ) : null}
        {frameSrc !== "" ? (
          <span
            data-testid="evidence-frame-state"
            data-state={frameLoaded ? "loaded" : "loading"}
            data-src={frameSrc}
            className="hidden"
          />
        ) : null}
        {loading && frameSrc !== "" ? (
          <span className="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 font-mono text-[10px] text-white">
            抓取中…
          </span>
        ) : null}
      </div>
    </section>
  );
}
