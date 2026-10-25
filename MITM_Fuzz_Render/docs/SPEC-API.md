# SPEC · HTTP API 与数据模型

> 归属模块：`internal/api`（路由/鉴权）、`internal/store`（SQLite）
> 状态：v1.0。M0 只实现标注 `[M0]` 的端点，其余为 M1–M3 契约。

---

## 1. 通用约定

| 项 | 约定 |
|---|---|
| Base | `/api`（破坏性变更才升 `/api/v2`） |
| 编码 | JSON（`application/json; charset=utf-8`），请求体上限 32MB（重放/导入另计） |
| 时间 | 输出 RFC3339 带毫秒 + 本地时区；**入库一律 Unix 毫秒**（可排序） |
| ID | ULID 文本，带资源前缀：`flw_` `tab_` `scr_` `prj_` `run_` |
| 字段命名 | JSON camelCase，Go 侧 PascalCase + tag |
| 空值 | 可选字段缺失即 `null` 或省略，不返回空字符串占位 |
| 版本 | `GET /api/health` 返回 `version` / `commit` / `buildTime` |

### 1.1 错误信封

```json
{ "error": { "code": "not_found", "message": "flow 不存在", "detail": "flw_01J..." } }
```

| code | HTTP | 场景 |
|---|---|---|
| `bad_request` | 400 | 参数/JSON 非法、raw 请求无法解析且非 raw 模式 |
| `unauthorized` | 401 | 无有效会话/token |
| `forbidden` | 403 | CSRF 校验失败、受限操作 |
| `not_found` | 404 | 资源不存在 |
| `conflict` | 409 | 名称重复、并发写冲突 |
| `too_large` | 413 | 超过大小上限 |
| `rate_limited` | 429 | 登录暴力尝试等 |
| `unsupported` | 422 | 语义不支持（如脚本语言未知） |
| `proxy_not_running` | 409 | 依赖代理已启动的操作 |
| `internal` | 500 | 兜底，附 `detail`（仅本地模式暴露堆栈摘要） |

### 1.2 分页

`GET /api/flows?limit=50&cursor=<opaque>` → `{ "items": [...], "nextCursor": "..." | null }`。
游标为 `{ts,id}` 的 base64 编码，服务端按 `(ts, id) < cursor` 倒序取，**不用 OFFSET**（大数据量下稳定）。

### 1.3 鉴权

- 启动时生成 32 字节随机 token：环境变量 `REPLAYD_TOKEN` 优先，否则读/写 `<dataDir>/token`（0600）。
- 会话 cookie：`replayd_session`，值为 `hex(HMAC-SHA256(token, "replayd/session/v1"))`，`HttpOnly; SameSite=Strict; Path=/`，有效期 30 天。
- 也支持 `Authorization: Bearer <token>`（给 CLI / Agent 用）。
- 首次接入：访问 `/?token=<token>` → 设 cookie → 302 到 `/`；或 `POST /api/session {token}`。
- CSRF：带 cookie 的**非 GET** 请求，`Origin` 必须存在且 host 与请求 host 一致（含端口），否则 403 `forbidden`。
- `/api/health`、`/api/openapi.json`、静态资源**不需要**鉴权（容器健康检查、规格获取）。
- 登录端点限速：每 IP 每分钟 10 次失败。

---

## 2. 端点

### 2.1 系统

#### `GET /api/health` `[M0]`

```json
{
  "status": "ok",
  "version": "0.1.0-dev",
  "commit": "none",
  "buildTime": "2026-10-22T15:10:00+08:00",
  "os": "darwin", "arch": "arm64",
  "listen": "127.0.0.1:8899",
  "dataDir": "/Users/x/.replayd",
  "uptimeMs": 12345,
  "authRequired": true,
  "proxy": { "running": false, "listen": "", "caReady": false }
}
```

#### `GET /api/openapi.json` `[M0]`

返回 OpenAPI 3.1 文档（前端/Agent/CLI 共用）。源码在 `internal/api/openapi.json`，`go:embed` 打包。

#### `GET /api/session` `[M0]` / `POST /api/session` `[M0]` / `DELETE /api/session` `[M0]`

```json
// GET → 200
{ "authenticated": true, "via": "cookie" }
// POST body
{ "token": "..." }   // → 204 + Set-Cookie；错误 token → 401
```

### 2.2 抓包历史

#### `GET /api/flows`

Query：`host` `method` `status` `q`（host/path 子串）、`from` `to`（Unix ms）、`source=proxy|replay`、`limit`（默认 50，最大 500）、`cursor`。

```json
{
  "items": [{
    "id": "flw_01J...", "source": "proxy",
    "ts": "2026-10-22T15:01:02.123+08:00", "durationMs": 87,
    "method": "POST", "scheme": "https", "host": "example.com", "port": 443,
    "path": "/api/login", "httpVersion": "HTTP/1.1",
    "status": 200, "reqSize": 412, "respSize": 1830,
    "error": null, "tags": ["auth"]
  }],
  "nextCursor": null
}
```

#### `GET /api/flows/{id}`

`?body=1` 时内联 body（默认只给元数据 + `bodies: {req: {...meta}, resp: {...meta}}`）；`?raw=1` 返回 `text/plain` 原始字节（下载用）。

#### `DELETE /api/flows/{id}` / `POST /api/flows/bulk-delete` `{ "ids": [...] }`

#### `POST /api/flows/{id}/replay` `[M1]`

用历史 flow 的 raw 请求重新发送 → 返回新 flow（`201`）。

### 2.3 重放

#### `POST /api/replay` `[M1]`

```json
{
  "raw": "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n",
  "target": { "scheme": "https", "host": "example.com", "port": 443 },
  "options": {
    "followRedirects": false,
    "verifyTLS": true,
    "sni": null,
    "tlsMin": "1.2",
    "timeoutMs": { "connect": 10000, "header": 30000, "total": 120000 },
    "upstreamProxy": null,
    "scriptId": null
  },
  "save": true
}
```

响应 `200`：

```json
{
  "flowId": "flw_01J...",
  "request": { "raw": "...", "warnings": [{ "code": "cl_mismatch", "message": "..." }] },
  "response": {
    "status": 200, "reason": "OK", "httpVersion": "HTTP/1.1",
    "headers": [{ "n": "Content-Type", "v": "text/html" }],
    "bodyText": "<!doctype html>...", "bodyEncoding": "utf-8",
    "rawBase64": "...", "truncated": false
  },
  "timings": { "dnsMs": 3, "connectMs": 12, "tlsMs": 24, "ttfbMs": 61, "totalMs": 87 },
  "error": null
}
```

- 引擎错误（DNS/TLS/超时）仍返回 **200** + `error` 字段（请求本身已执行完，属于"结果"而非"接口失败"）；只有参数错误才 4xx。
- 大响应：`bodyText` 只给前 2MB，完整内容通过 `flowId` 取 `?raw=1`。

### 2.4 代理

| 端点 | 说明 |
|---|---|
| `GET /api/proxy` `[M0 仅状态占位]` | `{running, listen, caReady, capturedCount}` |
| `POST /api/proxy/start` `[M2]` | `{listen?: "127.0.0.1:8898"}` |
| `POST /api/proxy/stop` `[M2]` | |
| `GET /api/proxy/ca.pem` / `ca.crt` / `ca.mobileconfig` `[M2]` | 下载 CA |
| `POST /api/proxy/ca/regenerate` `[M2]` | 需 `{"confirm": true}` |
| `GET /api/proxy/diagnose?host=example.com` `[M2]` | 主动探测：用我们的 CA 发起 TLS，返回客户端是否信任 |

### 2.5 Repeater Tab / 脚本

| 端点 | 说明 |
|---|---|
| `GET/POST /api/tabs`，`GET/PATCH/DELETE /api/tabs/{id}` | Repeater 标签持久化；`PATCH {rawRequest, name, scriptId}` |
| `GET/POST /api/scripts`，`GET/PUT/DELETE /api/scripts/{id}` | 脚本 CRUD；`PUT` 带 `If-Unmodified-Since` 级乐观锁（`updatedAt`） |
| `POST /api/scripts/{id}/test` `[M3]` | `{flowId?}` → `{ok, logs, error, durationMs}` |
| `GET /api/scripts/{id}/runs` | 最近 50 次执行记录 |

### 2.6 时间取证（M2 之后的取证能力）

| 端点 | 说明 |
|---|---|
| `GET /api/evidence?url=&mode=auto\|direct\|snapshot&allowScripts=&insecure=&record=` | 抓取第三方页面作为时间证据。`auto`（默认）判定 `X-Frame-Options`/`CSP frame-ancestors`：允许内嵌返回 `mode=direct`（前端用真实 iframe 直指原站），否则服务端抓取并改写成同源快照，返回 `snapshotUrl`。响应含 `fetchedAt/localTime/flowId/timings`；`error` 非空时 `mode=error`。 |
| `GET /api/evidence/sources` | 预设时间源列表（beijing-time.org、bjtime.cn、time.is、ntsc.ac.cn、timeapi.io） |
| `GET /api/evidence/snapshot/{id}` | 读取快照（同源，供 iframe 加载）。已剥离 `<script>`/内联 `on*`/`javascript:`、移除 meta CSP/XFO、注入 `<base>` 指向原站目录；响应头带 `X-Replayd-Mode/Source/Fetched-At`。默认 TTL 10 分钟、LRU 16 项。 |

**证据链**：每次抓取都会写入一条 flow（`note = "evidence: <url> · <mode>"`）并广播 `flow.new`，因此历史里能回看"何时访问了哪个时间源"。

### 2.7 无头渲染与产物（Agent 调用）

| 端点 | 说明 |
|---|---|
| `POST /api/render` | 用无头浏览器渲染 URL。入参：`url`、`width/height`、`fullPage`、`waitUntil`(load\|networkidle)、`timeoutMs`、`textLimit`、`scale`、`noScreenshot`、`noA11y`、`viaProxy`、`proxyUrl`、`async`、`record`。返回 `text`（JS 执行后文本）、`a11y`、`screenshots.{viewport,full}`、`timings`、`flowId`。参数错误 400；`async=true` → 202 + `jobId`。 |
| `GET /api/render/status` | 浏览器可用性/来源/路径/版本、活跃任务数、产物统计；不可用时给 `hint` |
| `GET /api/render/jobs` `GET /api/render/jobs/{id}` | 渲染与安装任务（内存保留最近 100 个）；安装任务的下载进度在 `progress` |
| `POST /api/render/browser/install` | 下载 chromium-headless-shell（异步） |
| `GET /api/artifacts` `GET /api/artifacts/{id}` `DELETE /api/artifacts/{id}` | 产物列表/下载/删除。**产物默认永久保留**，仅提供手动删除 |
| `POST /mcp` | MCP over HTTP（JSON-RPC 2.0）：`initialize` / `notifications/*` / `ping` / `tools/list` / `tools/call`，支持批量数组；`GET /mcp` → 405 |
| `GET /api/mcp` | 设置页用的 MCP 接入信息：端点、令牌（需鉴权）、工具清单、客户端配置片段、curl 示例 |

**MCP 工具**：`render_url`（返回 text + image 内容块）、`render_status`、`replay_request`、`list_flows`、`get_flow`。

**渲染语义**：每个任务一个独立 BrowserContext（隔离 cookie/缓存）；`viaProxy` 时上下文设置 `proxyServer`
并加 `proxyBypassList=<-loopback>`（取消 Chrome 对回环地址的默认绕过）；渲染动作写一条 flow
（`note = "render: <url>"`，`respBody` = 渲染后文本）；引擎失败以 200 + `error` 表达，参数错误才 4xx。

### 2.8 界面自截图（Agent 产出证据图）

| 端点 | 说明 |
|---|---|
| `POST /api/capture` | 无头浏览器打开**本工具的 Repeater 页**（`?token=` 自动登录），按 `raw` 填包 → 点发送 → 等响应与取证面板 → **整窗截图**。返回 `statusLine`/`responseHeaders`/`evidenceWatermark`（从界面回读的文本）+ `screenshots.viewport`（PNG 产物）+ `timings` + `flowId`。`evidenceMode` 默认 `snapshot`（同源快照必然画得出来），可选 `direct`（真站点直嵌，首屏约 1–3s，默认多等 4s 绘制）；`send=false` 则只截图不代发。  `upstreamProxy`（可选）指定这次发送的 SOCKS5 出口（`socks5://[user:password@]host:port`，仅 socks5，其它协议 400）：它被填进界面的「上游代理」框，随发送一起交给引擎，因此截图里能看到出口；地址是容器视角（host 网络下 127.0.0.1 是宿主机，bridge 下用 host.docker.internal）。 |

取证详情（来源/模式/抓取时间/flowId）在界面上**收进面板头的 ⓘ**；截图时由 `evidenceDetails`（默认 `true`）自动展开，
因为无头截图无法体现"悬停/点击展开"。`evidenceWatermark` 字段改为从 ⓘ 的 `data-summary` 回读，仍是一行完整摘要。

与 `POST /api/render` 的区别：`render` 渲染的是**目标网站内容**（看改包效果、内嵌时间源）；`capture` 截的是**replayd 自己的界面**（请求 + 响应 + 取证三栏一图），用于给裁判/报告留证。

**目标可以只写在报文里**：`scheme`/`host`/`port` 三个字段都是可选的，缺省时按 `httpreplay.TargetFromRaw` 从报文推断——absolute-form
请求行（`GET http://h/p`）或 `CONNECT` 以请求行为准，origin-form 读 `Host` 头（带端口就用，443 视为 https，其余视为 http）。
这条规则对 `/api/replay` 同样生效：Agent 通常只丢一个数据包过来，没有单独的目标字段。
两者都推不出来（既无绝对地址也无 `Host` 头）时才报 `bad_request`。

**报文的换行**：`/api/capture` 是驱动界面里的 textarea 填包再点发送，而 textarea 的 value 取值会把 CRLF 规范化成 LF（HTML 规范）。
因此前端发送前会把**整段没有任何 CR** 的报文按 CRLF 发出（`normalizePacketLineEndings`）：纯 LF 的报文若原样上线，
Node/nginx 这类严格解析的服务端会直接回 400，看起来像目标有问题。只要报文里出现过 CR（裸 CR、混合换行），一律原样发出，
字节保真不打折；`/api/replay` 始终按调用方给的字节发送。

**Agent 高亮**：`highlight` 参数支持**按文本匹配**打高亮，调用方不需要知道字符偏移：
```json
{"highlight": {"request": ["Host:", "uid=10100"], "response": ["role=admin", "token="], "color": "yellow"}}
```
实现方式是在页面内驱动真实交互（请求侧设选区→点色点；响应侧构造 Range→点色点），因此高亮会走前端既有逻辑存到标签页上。
响应里返回 `highlightsApplied` / `highlightsMissing`（没找到的片段会明确列出，不静默失败）。

MCP 对应工具：`capture_repeater`（返回文本摘要 + `image` 内容块；高亮参数 `highlight_request` / `highlight_response` / `highlight_color`）。

### 2.9 分页与 MCP 接入信息

- `GET /api/flows`：keyset 分页。参数 `limit`（默认 50，上限 500）、`cursor`（上一页返回的 `nextCursor`）。
  响应 `{items, nextCursor, total, hasMore}`；`total` 为**当前筛选条件下的总数**（忽略游标），前端据此显示"共 N 条 / 第 X 页"。
  前端用「游标栈」实现《上一页》：每前进一页把游标压栈，后退即弹栈重取，因此不需要反向游标。
- 非最新页收到实时抓包时不插入列表，而是累计为「↑ N 条新记录」提示，避免翻页时列表跳动。
- `GET /api/mcp`：MCP 接入信息（端点、令牌、工具清单、客户端配置片段），供设置页展示与一键复制。

### 2.10 导入导出

| 端点 | 说明 |
|---|---|
| `POST /api/import` `[M1]` | `{format: "har"|"curl"|"raw", content}` → 创建 tabs/flows |
| `GET /api/flows/{id}/export?format=har|curl|raw` | 单条导出 |

### 2.7 WebSocket `/api/events` `[M0 心跳]`

握手鉴权：cookie 或 `?token=`。服务端主动推送，客户端只发 `{"type":"ping"}`。

```json
{ "type": "hello", "seq": 1, "ts": "2026-10-22T15:10:00.000+08:00", "data": { "serverTime": "..." } }
{ "type": "flow.new", "seq": 2, "ts": "...", "data": { "id": "flw_...", "host": "a.com", "method": "GET", "status": 200 } }
{ "type": "proxy.status", "data": { "running": true, "listen": "127.0.0.1:8898" } }
{ "type": "replay.progress", "data": { "requestId": "tmp_...", "phase": "tls" } }
{ "type": "script.log", "data": { "level": "info", "message": "signed ok" } }
```

事件类型白名单：`hello` `ping` `flow.new` `flow.update` `flow.deleted` `proxy.status` `replay.progress` `script.log` `error`。未知类型客户端必须忽略（前向兼容）。

---

## 3. 数据模型（SQLite）

### 3.1 设计取舍

- **元数据与 body 分离**：主体存内容寻址 blob（文件系统），SQLite 只存 `sha256` + 大小。好处：去重（同一 GET 响应重复抓 100 次只存一份）、大包不撑爆 DB、备份/清理简单。
- 时间统一 `INTEGER` Unix 毫秒，索引即排序。
- 头统一 `TEXT` 存 JSON 数组 `[{"n":"Host","v":"a.com"}]`（保序、可重复）。
- 单库单写者：SQLite WAL + `busy_timeout=5000`，写入串行化在 store 层用单 goroutine 队列。
- 保留策略：默认保留 30 天或 5 万条（先到者为准），后台每小时清理一次；blob 引用计数归零后延迟 1 小时删除（防抖）。

### 3.2 DDL

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  refcount   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE flows (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK (source IN ('replay','proxy')),
  ts             INTEGER NOT NULL,
  duration_ms    INTEGER,
  method         TEXT NOT NULL,
  scheme         TEXT NOT NULL,
  host           TEXT NOT NULL,
  port           INTEGER NOT NULL,
  path           TEXT NOT NULL,
  query          TEXT,
  http_version   TEXT,
  req_headers    TEXT NOT NULL,
  req_body_sha   TEXT REFERENCES blobs(sha256),
  req_size       INTEGER NOT NULL DEFAULT 0,
  req_raw_sha    TEXT REFERENCES blobs(sha256),
  status         INTEGER,
  resp_headers   TEXT,
  resp_body_sha  TEXT REFERENCES blobs(sha256),
  resp_size      INTEGER,
  resp_raw_sha   TEXT REFERENCES blobs(sha256),
  tls            TEXT,
  timings        TEXT,
  error          TEXT,
  tags           TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_flows_ts        ON flows(ts DESC, id DESC);
CREATE INDEX idx_flows_host_ts   ON flows(host, ts DESC);
CREATE INDEX idx_flows_status    ON flows(status) WHERE status IS NOT NULL;
CREATE INDEX idx_flows_source_ts ON flows(source, ts DESC);

CREATE TABLE tabs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  raw_request TEXT NOT NULL DEFAULT '',
  script_id   TEXT REFERENCES scripts(id) ON DELETE SET NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_tabs_project ON tabs(project_id, sort_order);

CREATE TABLE scripts (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  lang       TEXT NOT NULL CHECK (lang IN ('js','py')),
  source     TEXT NOT NULL DEFAULT '',
  hooks      TEXT NOT NULL DEFAULT '{"onRequest":false,"onResponse":false,"onAssert":false}',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE script_runs (
  id          TEXT PRIMARY KEY,
  script_id   TEXT REFERENCES scripts(id) ON DELETE CASCADE,
  flow_id     TEXT REFERENCES flows(id) ON DELETE SET NULL,
  ok          INTEGER NOT NULL,
  logs        TEXT,
  error       TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_script_runs_script ON script_runs(script_id, created_at DESC);

CREATE TABLE settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
```

### 3.3 迁移策略

- `migrations/0001_init.sql` 起，`embed.FS` 打包；启动时按版本号顺序在**单事务**内应用。
- 每个迁移文件不可变；改结构必须新增文件。
- 启动时校验 `schema_migrations` 最高版本 > 代码已知版本 → 拒绝启动（防降级损坏）。

### 3.4 blob 目录

```
<dataDir>/
├─ replayd.db        (+ -wal / -shm)
├─ token
├─ blobs/ab/cd/abcdef...   # sha256 前 4 位分两级目录
├─ ca/  (M2)
└─ logs/replayd-YYYYMMDD.log
```
