import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { ApiError } from "../lib/api";
import { subscribe } from "../lib/events";
import { displayValue, formatVersion } from "../lib/format";
import { getMcpInfo, testMcpHandshake, type McpHandshake, type McpInfo } from "../lib/mcp";
import {
  caDownloadUrl,
  diagnoseProxy,
  getProxyStatus,
  regenerateCA,
  setInsecureUpstream,
  startProxy,
  stopProxy,
  type DiagnoseResult,
  type ProxyStatus,
} from "../lib/proxy";
import type { HealthSnapshot } from "../lib/types";

const LISTEN_KEY = "replayd.proxyListen";

/** 令牌只显示首尾，避免截图/共享屏幕时泄露。 */
function maskToken(token: string): string {
  if (token.length <= 12) return token === "" ? "—" : token;
  return `${token.slice(0, 6)}…${token.slice(-6)}（共 ${token.length} 字符）`;
}

interface InfoCardProps {
  title: string;
  caption: string;
  testId?: string;
  children: ReactNode;
}

function InfoCard({ title, caption, testId, children }: InfoCardProps) {
  return (
    <section data-testid={testId} className="panel flex flex-col">
      <header className="border-b border-line px-4 py-2.5">
        <h2 className="text-[12px] font-medium text-ink">{title}</h2>
        <p className="mt-0.5 text-[10px] text-muted/60">{caption}</p>
      </header>
      <div className="flex-1">{children}</div>
    </section>
  );
}

interface InfoRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function InfoRow({ label, value, mono = false }: InfoRowProps) {
  return (
    <div className="flex items-start justify-between gap-6 border-t border-line px-4 py-2.5 first:border-t-0">
      <dt className="shrink-0 text-[11px] text-muted">{label}</dt>
      <dd
        className={`min-w-0 break-all text-right text-[12px] text-ink ${mono ? "font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

function readStoredListen(): string {
  try {
    return window.localStorage.getItem(LISTEN_KEY) ?? "127.0.0.1:8898";
  } catch {
    return "127.0.0.1:8898";
  }
}

/** 运行设置：服务信息（只读）+ 代理控制 + CA 管理（M2）。 */
export default function SettingsPage() {
  const health = useOutletContext<HealthSnapshot | null>();
  const info = health?.info ?? null;
  const navigate = useNavigate();

  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [listen, setListen] = useState(readStoredListen);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);

  // ---- MCP（Agent 接入）----
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const [mcpError, setMcpError] = useState("");
  const [mcpLoading, setMcpLoading] = useState(true);
  const [showToken, setShowToken] = useState(false);
  const [handshake, setHandshake] = useState<McpHandshake | null>(null);
  const [handshaking, setHandshaking] = useState(false);
  const [copiedField, setCopiedField] = useState("");

  const loadMcp = useCallback(async () => {
    setMcpLoading(true);
    setMcpError("");
    try {
      setMcp(await getMcpInfo());
    } catch (error) {
      setMcpError(error instanceof ApiError ? error.message : "无法读取 MCP 信息");
    } finally {
      setMcpLoading(false);
    }
  }, []);

  const copyText = useCallback(async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(label);
      window.setTimeout(() => setCopiedField(""), 1500);
    } catch {
      setCopiedField("复制失败，请手动选中");
    }
  }, []);

  const runHandshake = useCallback(async () => {
    if (mcp === null) return;
    setHandshaking(true);
    try {
      setHandshake(await testMcpHandshake(mcp));
    } finally {
      setHandshaking(false);
    }
  }, [mcp]);

  const apply = useCallback((next: ProxyStatus) => {
    setStatus(next);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await getProxyStatus());
    } catch {
      // 后端暂时不可用时保留上一次状态，不弹错误（NavRail 会显示离线）
    }
  }, [apply]);

  useEffect(() => {
    void load();
    void loadMcp();
    const subscription = subscribe((event) => {
      if (event.type === "proxy.status") {
        void load();
      }
    });
    return () => subscription.close();
  }, [load, loadMcp]);

  const run = useCallback(
    async (action: () => Promise<ProxyStatus>) => {
      setBusy(true);
      setErrorText("");
      try {
        apply(await action());
      } catch (error) {
        setErrorText(error instanceof ApiError ? error.message : "操作失败，请稍后重试");
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  const running = status?.running ?? false;

  const onStart = () => {
    try {
      window.localStorage.setItem(LISTEN_KEY, listen);
    } catch {
      // 隐私模式下 localStorage 可能不可用，忽略
    }
    void run(() => startProxy(listen));
  };

  const onCopyFingerprint = () => {
    const value = status?.caFingerprint ?? "";
    if (value === "") return;
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2_000);
      })
      .catch(() => setErrorText("复制失败，请手动选择文本"));
  };

  const onDiagnose = async () => {
    setDiagnosing(true);
    setErrorText("");
    try {
      setDiagnose(await diagnoseProxy());
    } catch (error) {
      setErrorText(error instanceof ApiError ? error.message : "诊断失败");
    } finally {
      setDiagnosing(false);
    }
  };

  return (
    <section data-testid="page-settings" className="h-full overflow-auto">
      <div className="p-5">
        <div className="mb-4 flex items-center justify-between gap-4">
          <p className="text-[12px] text-muted">
            服务信息来自
            <code className="mx-1 rounded border border-line bg-bg px-1 py-0.5 font-mono text-[11px] text-accent/90">
              /api/health
            </code>
            ；代理与 CA 状态与服务端实时同步。
          </p>
          <button
            type="button"
            data-testid="settings-to-repeater"
            className="btn"
            onClick={() => navigate("/repeater")}
          >
            去 Repeater 发包
          </button>
        </div>

        {errorText !== "" ? (
          <p
            role="alert"
            data-testid="settings-error"
            className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            {errorText}
          </p>
        ) : null}

        <div data-testid="settings-info" className="grid grid-cols-2 gap-4">
          <InfoCard title="服务" caption="来源：/api/health" testId="settings-service">
            <dl>
              <InfoRow label="服务地址" value={displayValue(info?.listen)} mono />
              <InfoRow
                label="版本"
                value={info?.version ? formatVersion(info.version) : "—"}
                mono
              />
              <InfoRow label="运行平台" value={displayValue(info?.platform)} mono />
              <InfoRow label="数据目录" value={displayValue(info?.dataDir)} mono />
            </dl>
          </InfoCard>

          {/* ---------------------------------------------------------- 代理 */}
          <InfoCard title="代理" caption="MITM 抓包：装好 CA 后即可解密 HTTPS" testId="settings-proxy-card">
            <div className="space-y-3 p-4">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${running ? "bg-accent" : "bg-danger"}`}
                />
                <span data-testid="proxy-state" className="text-[12px] text-ink">
                  {running ? "运行中" : "未启动"}
                </span>
                <span className="ml-auto font-mono text-[11px] text-muted">
                  {status?.listen ?? "—"}
                </span>
              </div>

              <label className="block">
                <span className="text-[11px] text-muted">监听地址</span>
                <input
                  data-testid="proxy-listen"
                  className="field mt-1 w-full font-mono"
                  value={listen}
                  spellCheck={false}
                  disabled={running || busy}
                  onChange={(event) => setListen(event.target.value)}
                />
              </label>

              <div className="flex items-center gap-2">
                {running ? (
                  <button
                    type="button"
                    data-testid="proxy-stop"
                    className="btn"
                    disabled={busy}
                    onClick={() => void run(stopProxy)}
                  >
                    {busy ? "处理中…" : "停止代理"}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="proxy-start"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={onStart}
                  >
                    {busy ? "处理中…" : "启动代理"}
                  </button>
                )}
                <span className="font-mono text-[10px] text-muted/60">
                  已捕获 {status?.captured ?? 0} 条
                </span>
              </div>

              <label className="flex items-start gap-2 border-t border-line pt-3">
                <input
                  type="checkbox"
                  data-testid="proxy-insecure"
                  className="mt-0.5"
                  checked={status?.insecureUpstream ?? false}
                  disabled={busy}
                  onChange={(event) => void run(() => setInsecureUpstream(event.target.checked))}
                />
                <span className="text-[11px] leading-relaxed text-muted">
                  忽略上游证书校验（自签靶场用；开启后无法发现上游证书问题）
                </span>
              </label>
            </div>
          </InfoCard>

          {/* ---------------------------------------------------------- CA */}
          <InfoCard title="CA 证书" caption="HTTPS 解密所需的本地根证书" testId="settings-ca-card">
            <div className="space-y-3 p-4">
              <div>
                <p className="text-[11px] text-muted">SHA-256 指纹</p>
                <div className="mt-1 flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all rounded border border-line bg-bg px-2 py-1 font-mono text-[10px] leading-relaxed text-ink">
                    {status?.caFingerprint !== "" && status !== null
                      ? status.caFingerprint
                      : "—"}
                  </code>
                  <button
                    type="button"
                    data-testid="ca-copy-fingerprint"
                    className="btn shrink-0"
                    onClick={onCopyFingerprint}
                  >
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
              </div>

              <dl className="rounded border border-line">
                <InfoRow label="主题" value={displayValue(status?.caSubject)} mono />
                <InfoRow label="有效期至" value={displayValue(status?.caNotAfter)} mono />
              </dl>

              <div className="flex flex-wrap items-center gap-2">
                <a
                  data-testid="ca-download-pem"
                  className="btn"
                  href={caDownloadUrl("pem")}
                  download
                >
                  ca.pem
                </a>
                <a
                  data-testid="ca-download-crt"
                  className="btn"
                  href={caDownloadUrl("crt")}
                  download
                >
                  ca.crt
                </a>
                <a
                  data-testid="ca-download-mobileconfig"
                  className="btn"
                  href={caDownloadUrl("mobileconfig")}
                  download
                >
                  iOS 描述文件
                </a>
              </div>
              <p className="text-[10px] leading-relaxed text-muted/60">
                Windows 用 ca.crt（certutil -addstore -f ROOT）、macOS/Linux 用 ca.pem、
                iOS 用描述文件并在「证书信任设置」中开启完全信任。
              </p>

              <div className="border-t border-line pt-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="ca-diagnose"
                    className="btn"
                    disabled={diagnosing}
                    onClick={() => void onDiagnose()}
                  >
                    {diagnosing ? "检测中…" : "检测本机是否已信任"}
                  </button>
                  {diagnose !== null ? (
                    <span
                      data-testid="ca-diagnose-result"
                      className={`font-mono text-[11px] ${diagnose.trusted ? "text-accent" : "text-yellow-400"}`}
                    >
                      {diagnose.trusted ? "本机已信任" : "尚未信任"}
                    </span>
                  ) : null}
                </div>

                {diagnose !== null ? (
                  <div className="mt-2 space-y-2">
                    <p className="text-[11px] leading-relaxed text-muted">{diagnose.probe}</p>
                    <ul
                      data-testid="ca-instructions"
                      className="space-y-1 rounded border border-line bg-bg p-2"
                    >
                      {diagnose.instructions.map((line) => (
                        <li key={line} className="font-mono text-[10px] leading-relaxed text-muted">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className="border-t border-line pt-3">
                {confirmRegen ? (
                  <div
                    data-testid="ca-regenerate-confirm-bar"
                    className="rounded border border-danger/40 bg-danger/10 p-2"
                  >
                    <p className="text-[11px] text-danger">
                      重建后已安装的证书将全部失效，需要重新安装。
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        data-testid="ca-regenerate-confirm"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setConfirmRegen(false);
                          void run(regenerateCA);
                        }}
                      >
                        确认重建
                      </button>
                      <button
                        type="button"
                        data-testid="ca-regenerate-cancel"
                        className="btn"
                        onClick={() => setConfirmRegen(false)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid="ca-regenerate"
                    className="btn text-danger"
                    disabled={busy}
                    onClick={() => setConfirmRegen(true)}
                  >
                    重建 CA
                  </button>
                )}
              </div>
            </div>
          </InfoCard>

          <InfoCard title="MCP" caption="Agent 接入：HTTP + JSON-RPC 2.0（Bearer 鉴权）" testId="settings-mcp-card">
            <div className="px-4 py-3">
              {mcpError !== "" ? (
                <p role="alert" data-testid="mcp-error" className="text-[11px] text-danger">
                  {mcpError}
                </p>
              ) : null}
              {mcpLoading && mcp === null ? (
                <p className="text-[11px] text-muted">读取中…</p>
              ) : null}
              {mcp !== null ? (
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-[11px] text-muted">MCP 端点（Agent 填这个地址）</p>
                    <div className="mt-1 flex items-center gap-2">
                      <code data-testid="mcp-endpoint" className="min-w-0 flex-1 truncate rounded border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink">
                        {mcp.endpoint}
                      </code>
                      <button
                        type="button"
                        data-testid="mcp-copy-endpoint"
                        className="btn h-6 px-2 text-[11px]"
                        onClick={() => void copyText("endpoint", mcp.endpoint)}
                      >
                        {copiedField === "endpoint" ? "已复制" : "复制"}
                      </button>
                    </div>
                  </div>

                  <div>
                    <p className="text-[11px] text-muted">访问令牌（Authorization: Bearer）</p>
                    <div className="mt-1 flex items-center gap-2">
                      <code data-testid="mcp-token" className="min-w-0 flex-1 truncate rounded border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink">
                        {showToken ? mcp.token : maskToken(mcp.token)}
                      </code>
                      <button
                        type="button"
                        data-testid="mcp-toggle-token"
                        className="btn h-6 px-2 text-[11px]"
                        onClick={() => setShowToken((value) => !value)}
                      >
                        {showToken ? "隐藏" : "显示"}
                      </button>
                      <button
                        type="button"
                        data-testid="mcp-copy-token"
                        className="btn h-6 px-2 text-[11px]"
                        onClick={() => void copyText("token", mcp.token)}
                      >
                        {copiedField === "token" ? "已复制" : "复制"}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-muted">
                    <span>传输 {mcp.transport}</span>
                    <span>协议 {mcp.protocolVersion || "—"}</span>
                    <span>鉴权 {mcp.auth}</span>
                    <span>渲染能力 {mcp.renderReady ? "可用" : "未启用"}</span>
                  </div>

                  <div>
                    <p className="text-[11px] text-muted">可用工具（{mcp.tools.length} 个）</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {mcp.tools.map((tool) => (
                        <span
                          key={tool.name}
                          data-testid={`mcp-tool-${tool.name}`}
                          className="badge font-mono"
                          title={tool.description}
                        >
                          {tool.name}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] text-muted">客户端配置（可直接粘进 Agent 的 MCP 配置）</p>
                      <button
                        type="button"
                        data-testid="mcp-copy-config"
                        className="btn ml-auto h-6 px-2 text-[11px]"
                        onClick={() => void copyText("config", JSON.stringify(mcp.clientConfig, null, 2))}
                      >
                        {copiedField === "config" ? "已复制" : "复制配置"}
                      </button>
                    </div>
                    <pre
                      data-testid="mcp-config"
                      className="mt-1 max-h-[180px] overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-bg px-2 py-1.5 font-mono text-[10px] leading-4 text-muted"
                    >
                      {JSON.stringify(mcp.clientConfig, null, 2)}
                    </pre>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid="mcp-handshake"
                      className="btn"
                      disabled={handshaking}
                      onClick={() => void runHandshake()}
                    >
                      {handshaking ? "握手中…" : "测试握手"}
                    </button>
                    <button
                      type="button"
                      data-testid="mcp-reload"
                      className="btn"
                      disabled={mcpLoading}
                      onClick={() => void loadMcp()}
                    >
                      重新读取
                    </button>
                    {handshake !== null ? (
                      <span
                        data-testid="mcp-handshake-result"
                        className={`font-mono text-[11px] ${handshake.ok ? "text-accent" : "text-danger"}`}
                      >
                        {handshake.ok
                          ? `✓ ${handshake.message}：${handshake.serverName} ${handshake.serverVersion} · 协议 ${handshake.protocolVersion} · 能力 ${handshake.capabilities.join("/")}`
                          : `✗ ${handshake.message}`}
                      </span>
                    ) : null}
                  </div>

                  <details>
                    <summary className="cursor-pointer text-[11px] text-muted">curl 手动验证示例</summary>
                    <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-bg px-2 py-1.5 font-mono text-[10px] leading-4 text-muted">
                      {mcp.curlExample}
                    </pre>
                  </details>
                </div>
              ) : null}
            </div>
          </InfoCard>

          <InfoCard title="主题" caption="界面外观" testId="settings-theme">
            <div className="p-4">
              <p className="text-[13px] text-ink">暗色（唯一主题）</p>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                固定暗色，不提供主题切换。
              </p>
            </div>
          </InfoCard>
        </div>

        <p className="mt-4 font-mono text-[10px] text-muted/50">
          replayd M2/M3 · 代理抓包、CA 管理、脚本运行时、时间取证与 Agent 无头渲染均已可用
        </p>
      </div>
    </section>
  );
}
