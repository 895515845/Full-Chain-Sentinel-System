import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import {
  createScript,
  deleteScript,
  listScriptRuns,
  listScripts,
  SCRIPT_SAMPLES,
  testScript,
  updateScript,
  type ScriptHooks,
  type ScriptItem,
  type ScriptLog,
  type ScriptRun,
  type ScriptTestResult,
} from "../lib/scripts";

const SAMPLE_REQUEST = `GET /admin/users HTTP/1.1
Host: example.test
Authorization: Bearer user-token

`;

interface Draft {
  id: string | null;
  name: string;
  source: string;
  hooks: ScriptHooks;
  enabled: boolean;
  updatedAt: number;
}

function emptyDraft(): Draft {
  return {
    id: null,
    name: "新脚本",
    source: `function onRequest(req, ctx) {\n  ctx.log("hello", req.method, req.url);\n}\n`,
    hooks: { onRequest: true, onResponse: true, onAssert: true },
    enabled: true,
    updatedAt: 0,
  };
}

function toDraft(item: ScriptItem): Draft {
  return {
    id: item.id,
    name: item.name,
    source: item.source,
    hooks: item.hooks,
    enabled: item.enabled,
    updatedAt: item.updatedAt,
  };
}

function formatTime(ts: number): string {
  if (ts <= 0) return "—";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 脚本工作台：列表 + 编辑器 + 钩子开关 + 试跑 + 日志（M3）。 */
export default function ScriptsPage() {
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testResult, setTestResult] = useState<ScriptTestResult | null>(null);
  const [runs, setRuns] = useState<ScriptRun[]>([]);
  const [testRequest, setTestRequest] = useState(SAMPLE_REQUEST);

  const loadList = useCallback(async (selectId?: string) => {
    try {
      const items = await listScripts();
      setScripts(items);
      if (items.length === 0) {
        setDraft(emptyDraft());
        setRuns([]);
        return;
      }
      const picked = items.find((item) => item.id === selectId) ?? items[0];
      if (picked !== undefined) {
        setDraft(toDraft(picked));
        void listScriptRuns(picked.id)
          .then(setRuns)
          .catch(() => setRuns([]));
      }
    } catch (err) {
      setError(err instanceof ApiError ? `加载脚本失败：${err.message}` : "加载脚本失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (draft.id === null) {
        const created = await createScript(draft.name, draft.source, draft.hooks);
        setNotice("已创建");
        await loadList(created.id);
      } else {
        const updated = await updateScript(draft.id, {
          name: draft.name,
          source: draft.source,
          hooks: draft.hooks,
          enabled: draft.enabled,
          updatedAt: draft.updatedAt,
        });
        setDraft(toDraft(updated));
        setScripts((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        setNotice("已保存");
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("脚本已被其他窗口修改：请在左侧重新选择该脚本再编辑");
      } else {
        setError(err instanceof ApiError ? `保存失败：${err.message}` : "保存失败");
      }
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (draft.id === null) {
      setError("请先保存脚本再试跑");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setTestResult(null);
    try {
      const result = await testScript(draft.id, { raw: testRequest });
      setTestResult(result);
      void listScriptRuns(draft.id)
        .then(setRuns)
        .catch(() => setRuns([]));
    } catch (err) {
      setError(err instanceof ApiError ? `试跑失败：${err.message}` : "试跑失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (draft.id === null) return;
    setBusy(true);
    setError("");
    try {
      await deleteScript(draft.id);
      setDraft(emptyDraft());
      setTestResult(null);
      setNotice("已删除");
      await loadList("");
    } catch (err) {
      setError(err instanceof ApiError ? `删除失败：${err.message}` : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const result = testResult?.script ?? null;

  return (
    <section data-testid="page-scripts" className="flex h-full min-h-0">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-line bg-panel/40">
        <header className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
          <h2 className="text-[12px] font-medium text-ink">脚本</h2>
          <button
            type="button"
            data-testid="scripts-new"
            className="btn h-6 px-2 text-[11px]"
            onClick={() => {
              setDraft(emptyDraft());
              setTestResult(null);
              setRuns([]);
              setNotice("新建脚本：填写后点保存");
            }}
          >
            新建
          </button>
        </header>

        <div data-testid="scripts-list" className="min-h-0 flex-1 overflow-auto p-2">
          {loading ? (
            <p className="px-2 py-3 text-[11px] text-muted">加载中…</p>
          ) : scripts.length === 0 ? (
            <p
              data-testid="scripts-empty"
              className="px-2 py-3 text-[11px] leading-relaxed text-muted"
            >
              暂无脚本。点「新建」或从上方示例开始。
              <br />
              支持 JavaScript 钩子 onRequest / onResponse / onAssert。
            </p>
          ) : (
            <ul className="space-y-1">
              {scripts.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid={`scripts-item-${item.id}`}
                    aria-current={item.id === draft.id}
                    className={`w-full rounded border px-2 py-1.5 text-left ${
                      item.id === draft.id
                        ? "border-line bg-[#16202c] text-ink"
                        : "border-transparent text-muted hover:bg-[#0f1620] hover:text-ink"
                    }`}
                    onClick={() => {
                      setDraft(toDraft(item));
                      setTestResult(null);
                      setError("");
                      void listScriptRuns(item.id)
                        .then(setRuns)
                        .catch(() => setRuns([]));
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[12px]">{item.name}</span>
                      {item.enabled ? null : <span className="badge">停用</span>}
                    </span>
                    <span className="mt-0.5 flex gap-1 font-mono text-[9px] text-muted/60">
                      {item.hooks.onRequest ? <span>req</span> : null}
                      {item.hooks.onResponse ? <span>res</span> : null}
                      {item.hooks.onAssert ? <span>assert</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
          <input
            data-testid="scripts-name"
            className="field h-6 w-[200px] text-[12px]"
            value={draft.name}
            placeholder="脚本名称"
            onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
          />

          <label className="flex items-center gap-1 font-mono text-[11px] text-muted">
            <input
              type="checkbox"
              data-testid="scripts-hook-onRequest"
              checked={draft.hooks.onRequest}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  hooks: { ...prev.hooks, onRequest: event.target.checked },
                }))
              }
            />
            onRequest
          </label>
          <label className="flex items-center gap-1 font-mono text-[11px] text-muted">
            <input
              type="checkbox"
              data-testid="scripts-hook-onResponse"
              checked={draft.hooks.onResponse}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  hooks: { ...prev.hooks, onResponse: event.target.checked },
                }))
              }
            />
            onResponse
          </label>
          <label className="flex items-center gap-1 font-mono text-[11px] text-muted">
            <input
              type="checkbox"
              data-testid="scripts-hook-onAssert"
              checked={draft.hooks.onAssert}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  hooks: { ...prev.hooks, onAssert: event.target.checked },
                }))
              }
            />
            onAssert
          </label>

          <label className="ml-auto flex items-center gap-1 font-mono text-[11px] text-muted">
            <input
              type="checkbox"
              data-testid="scripts-enabled"
              checked={draft.enabled}
              onChange={(event) => setDraft((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            启用
          </label>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
            <select
              data-testid="scripts-sample"
              className="field h-6 text-[11px]"
              defaultValue=""
              onChange={(event) => {
                const sample = SCRIPT_SAMPLES.find((item) => item.key === event.target.value);
                if (sample !== undefined) {
                  setDraft((prev) => ({ ...prev, source: sample.source }));
                  setNotice(`已插入示例：${sample.label}`);
                }
                event.target.value = "";
              }}
            >
              <option value="">插入示例…</option>
              {SCRIPT_SAMPLES.map((sample) => (
                <option key={sample.key} value={sample.key}>
                  {sample.label}
                </option>
              ))}
            </select>
            <span className="truncate font-mono text-[10px] text-muted/50">
              req.headers.get/set/add/remove/all · ctx.vars/env/log · helpers.* · assert()
            </span>
            <button
              type="button"
              data-testid="scripts-save"
              className="btn btn-primary ml-auto h-6 px-3 text-[11px]"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "处理中…" : "保存"}
            </button>
            <button
              type="button"
              data-testid="scripts-run"
              className="btn h-6 px-3 text-[11px]"
              disabled={busy || draft.id === null}
              onClick={() => void runTest()}
            >
              试跑
            </button>
            <button
              type="button"
              data-testid="scripts-delete"
              className="btn h-6 px-2 text-[11px] text-danger"
              disabled={busy || draft.id === null}
              onClick={() => void remove()}
            >
              删除
            </button>
          </div>

          <textarea
            data-testid="scripts-editor"
            aria-label="脚本源码"
            spellCheck={false}
            value={draft.source}
            onChange={(event) => setDraft((prev) => ({ ...prev, source: event.target.value }))}
            className="min-h-0 flex-1 resize-none bg-bg px-3 py-3 font-mono text-[12px] leading-6 text-ink outline-none"
          />
        </div>

        <div className="flex h-[210px] shrink-0 flex-col border-t border-line bg-panel/30">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
            <h3 className="text-[11px] font-medium text-ink">试跑</h3>
            <input
              data-testid="scripts-test-request"
              aria-label="试跑用请求行"
              className="field h-6 flex-1 font-mono text-[11px]"
              value={testRequest.split("\n")[0] ?? ""}
              onChange={(event) =>
                setTestRequest(
                  `${event.target.value}\nHost: example.test\nAuthorization: Bearer user-token\n\n`,
                )
              }
            />
            {result !== null ? (
              <>
                <span data-testid="scripts-duration" className="font-mono text-[10px] text-muted/60">
                  {result.durationMs} ms · {result.hooksRun.join(",") || "无钩子执行"}
                </span>
                {result.assert !== undefined ? (
                  <span
                    data-testid="scripts-assert"
                    className={`font-mono text-[11px] ${
                      result.assert.ok ? "text-accent" : "text-danger"
                    }`}
                  >
                    {result.assert.ok ? "断言通过" : `断言失败：${result.assert.message}`}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {error !== "" ? (
              <p role="alert" data-testid="scripts-error" className="mb-2 text-[11px] text-danger">
                {error}
              </p>
            ) : null}
            {notice !== "" ? (
              <p data-testid="scripts-notice" className="mb-2 text-[11px] text-accent">
                {notice}
              </p>
            ) : null}
            {result?.error !== undefined ? (
              <p className="mb-2 font-mono text-[11px] text-danger">脚本错误：{result.error}</p>
            ) : null}

            <ul data-testid="scripts-logs" className="space-y-0.5 font-mono text-[11px]">
              {(result?.logs ?? []).map((log: ScriptLog, index: number) => (
                <li
                  key={`${index}-${log.message}`}
                  className={log.level === "error" ? "text-danger" : "text-muted"}
                >
                  [{index + 1}] {log.message}
                </li>
              ))}
              {result !== null && result.logs.length === 0 ? (
                <li className="text-muted/50">（脚本没有输出日志）</li>
              ) : null}
              {result === null && error === "" && notice === "" ? (
                <li className="text-muted/50">
                  点「试跑」用上面的请求跑一遍钩子（本地执行，不联网）
                </li>
              ) : null}
            </ul>

            {runs.length > 0 ? (
              <div data-testid="scripts-runs" className="mt-3 border-t border-line pt-2">
                <p className="mb-1 text-[10px] text-muted/60">最近执行</p>
                <ul className="space-y-0.5 font-mono text-[10px] text-muted">
                  {runs.slice(0, 5).map((run: ScriptRun) => (
                    <li key={run.id} className={run.ok ? "" : "text-danger"}>
                      {formatTime(run.createdAt)} · {run.ok ? "ok" : "fail"} · {run.durationMs} ms
                      {run.error !== undefined ? ` · ${run.error}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
