import { apiRequest } from "./api";

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

export interface McpTool {
  name: string;
  title: string;
  description: string;
}

export interface McpInfo {
  endpoint: string;
  transport: string;
  protocolVersion: string;
  auth: string;
  token: string;
  tools: McpTool[];
  clientConfig: unknown;
  curlExample: string;
  renderReady: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function normalizeTool(value: unknown): McpTool | null {
  const tool = isRecord(value) ? value : {};
  const name = str(tool, "name");
  if (name === "") return null;
  return { name, title: str(tool, "title") || name, description: str(tool, "description") };
}

/** 读取 MCP 接入信息（端点、令牌、工具清单、客户端配置片段）。 */
export async function getMcpInfo(): Promise<McpInfo> {
  const payload = await apiRequest("/mcp", { timeoutMs: 8_000 });
  const source = isRecord(payload) ? payload : {};
  const tools = Array.isArray(source.tools) ? source.tools : [];
  return {
    endpoint: str(source, "endpoint"),
    transport: str(source, "transport") || "http",
    protocolVersion: str(source, "protocolVersion"),
    auth: str(source, "auth") || "bearer",
    token: str(source, "token"),
    tools: tools.map(normalizeTool).filter((tool): tool is McpTool => tool !== null),
    clientConfig: source.clientConfig ?? {},
    curlExample: str(source, "curlExample"),
    renderReady: source.renderReady === true,
  };
}

export interface McpHandshake {
  ok: boolean;
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  capabilities: string[];
  message: string;
}

/** 真的向 /mcp 发一次 initialize，验证 Agent 侧能否握手成功。 */
export async function testMcpHandshake(info: McpInfo): Promise<McpHandshake> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "replayd-settings", version: "1" } },
  });
  let response: Response;
  try {
    response = await fetch("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(info.token === "" ? {} : { Authorization: `Bearer ${info.token}` }),
      },
      body,
    });
  } catch {
    return { ok: false, serverName: "", serverVersion: "", protocolVersion: "", capabilities: [], message: "无法连接到 /mcp" };
  }
  if (!response.ok) {
    return {
      ok: false,
      serverName: "",
      serverVersion: "",
      protocolVersion: "",
      capabilities: [],
      message: `握手失败：HTTP ${response.status}${response.status === 401 ? "（令牌无效）" : ""}`,
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, serverName: "", serverVersion: "", protocolVersion: "", capabilities: [], message: "响应不是合法 JSON-RPC" };
  }
  const source = isRecord(payload) ? payload : {};
  if (isRecord(source.error)) {
    return { ok: false, serverName: "", serverVersion: "", protocolVersion: "", capabilities: [], message: `握手被拒绝：${str(source.error, "message")}` };
  }
  const result = isRecord(source.result) ? source.result : {};
  const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : {};
  const capabilities = isRecord(result.capabilities) ? Object.keys(result.capabilities) : [];
  return {
    ok: true,
    serverName: str(serverInfo, "name"),
    serverVersion: str(serverInfo, "version"),
    protocolVersion: str(result, "protocolVersion"),
    capabilities,
    message: "握手成功",
  };
}
