# replayd

> 浏览器化的 HTTP/HTTPS 抓包与重放工作台。一个 Go 单二进制，跑在 Windows / Linux / macOS / Docker，UI 全在浏览器里。

**状态**：M0、M1（Repeater）、M2（MITM 代理抓包）、M3（JS 脚本钩子）已完成；下一步 M4（打磨与发布）。

---

## 为什么不是又一个 Postman

安全测试要的是**字节级保真**：

- `net/http` 会重排 header、补 `User-Agent`、自动解压、自动跟随重定向——这些"贴心"行为会让你测不到真实的边界。
- replayd 的引擎按你写的字节发：header 顺序、大小写、重复头、畸形 `Content-Length`、手工 chunked，全部原样上线。
- 同时保留 raw bytes 与解析视图，判断"服务端到底收到了什么"不靠猜。

详细规则见 [docs/SPEC-HTTP.md](docs/SPEC-HTTP.md)。

---

## 快速开始

### 从源码构建

```bash
# 依赖：Go 1.24+、Node 22+、pnpm 10+
make build     # 构建前端 + 内嵌进二进制
./bin/replayd   # 启动，终端会打印带 token 的访问地址
```

打开终端里打印的 `http://127.0.0.1:<端口>/?token=...` 即可。首次访问会用 token 换一个 HttpOnly 会话 cookie，之后直接访问同一地址即可。
未显式指定端口时，**每次启动都会在 7000–8000 里随机挑一个空闲端口**（显式 `-listen` 或 `REPLAYD_LISTEN` 优先；Docker 镜像内固定 `0.0.0.0:8899` 不受影响）。

```bash
./bin/replayd --help          # 全部参数
./bin/replayd -open           # 启动后自动打开浏览器
./bin/replayd -data-dir ./data -listen 127.0.0.1:9000
```

### 只跑后端（前端未构建时会显示构建指引页）

```bash
go run ./cmd/replayd -data-dir /tmp/replayd
curl -s http://127.0.0.1:<端口>/api/health | jq   # 端口见启动日志（7000-8000 随机）
```

### Docker

```bash
docker build -t replayd .
docker run --rm -p 8899:8899 -v replayd-data:/data \
  -e REPLAYD_TOKEN=$(openssl rand -hex 32) replayd
```

容器内默认监听 `0.0.0.0:8899`、数据在 `/data`、日志为 JSON。**暴露到网络前请务必设置 `REPLAYD_TOKEN`。**

---

## 功能

| 模块 | 状态 | 说明 |
|---|---|---|
| Repeater | ✅ | raw 编辑/发送（字节保真）、响应 Pretty/Raw/Hex/Headers、多 tab 自动保存 |
| 代理抓包 | ✅ | 本地 CA（下载/诊断/重建）、HTTPS MITM 解密、WebSocket 隧道、bypass、实时流 |
| 脚本钩子 | ✅ | JS（goja）`onRequest/onResponse/onAssert`，headers/body 双向读写、hmac/aes helpers、3s 超时中断、试跑与执行记录 |
| 历史检索 | ✅ | host/方法/关键字过滤、游标分页、实时流、一键发送到 Repeater |
| 导入 | ✅ | curl 命令 / HAR → 一键转为可编辑请求 |
| 时间取证 | ✅ | Repeater 三栏并排内嵌第三方时间源（北京时间）；能直嵌就直嵌，否则服务端快照，抓取动作记入历史 |
| 高亮标记 | ✅ | 请求包与响应包都可"选中即高亮"（黄/绿/红/蓝四色），存在服务端标签页上，无头截图也会带上 |
| Agent 渲染 | ✅ | 无头浏览器真实渲染 URL（JS 执行后），返回文本 + 无障碍树 + PNG 截图；REST 与 HTTP 型 MCP 双通道 |
| Agent 接口 | ✅ | UI 能力全部有等价 REST（replay/tabs/flows/import），`/api/openapi.json` 可机器读取 |

路线图与验收标准见 [docs/PLAN.md](docs/PLAN.md)。

---

## 架构

```
浏览器（含 headless agent）
   │ REST /api/*  +  WS /api/events（127.0.0.1 + token）
   ▼
replayd（单二进制）
   ├─ api        路由 / 鉴权 / SPA 静态资源
   ├─ store      SQLite 元数据 + 内容寻址 blob
   ├─ httpreplay raw HTTP 引擎（M1）
   ├─ proxy      MITM 与证书（M2）
   ├─ script     JS / Python 运行时（M3）
   └─ eventbus   WebSocket 事件广播
```

设计取舍、非功能指标与风险见 [docs/PLAN.md](docs/PLAN.md)；
接口与数据模型见 [docs/SPEC-API.md](docs/SPEC-API.md)；
界面与 Agent 友好约定见 [docs/SPEC-UI.md](docs/SPEC-UI.md)。

---

## 开发

```bash
make dev        # 构建 + 启动 + 开浏览器
make test       # Go 测试（CGO_ENABLED=0）
make lint       # vet + gofmt 校验
make dist       # 六平台交叉编译
make docker     # 构建镜像
```

前后端分离调试：

```bash
# 终端 1：后端（前端走 fallback 页，不影响 API）
go run ./cmd/replayd -data-dir /tmp/replayd -quiet

# 终端 2：Vite dev server（/api 已代理到 8899）
cd web && pnpm dev
```

## 安全模型

- 默认仅监听 `127.0.0.1`；监听其他地址时启动日志会给出显式告警。
- 控制台需要 token（自动生成并保存在数据目录，`0600`）；会话 cookie 为 `HttpOnly; SameSite=Strict`。
- 写请求校验 `Origin`，防止本机其他网页发起 CSRF。
- 日志不记录 `Authorization` / `Cookie`。
- 脚本（M3）是**受信代码**，不是安全沙箱；只运行你自己写的脚本。
- 本工具会主动发起任意请求（SSRF 是功能而非漏洞），请勿把控制台暴露到不可信网络。

## 平台

| 平台 | 说明 |
|---|---|
| macOS 12+ / Linux / Windows 10+ | 单二进制，无运行时依赖，`CGO_ENABLED=0` |
| Docker | linux/amd64、linux/arm64；healthcheck 内置 |
| Docker + VNC | M5 计划：镜像分层加 Xvfb + chromium kiosk + noVNC，业务代码零改动 |

## 许可证

MIT

## 给 Agent 用：界面自截图 + 无头渲染 + MCP

### 一张图交付"结果 + 北京时间"（`POST /api/capture`）

Agent 传给 replayd 一条原始请求，replayd 会在**自己的 Repeater 界面**里填包、发送、等取证面板加载，
然后把整个界面截成 PNG 返回 —— 左边请求、中间响应、右边北京时间，正好是裁判要的那张图。
同时返回从界面回读的状态行/响应头/水印文本，Agent 不看图也能判断结果。MCP 里对应工具 `capture_repeater`。

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"raw":"GET /admin HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n","host":"10.0.0.5","port":80,
       "evidenceMode":"direct","includeContent":true}' \
  http://127.0.0.1:8899/api/capture
```

高亮也可以让 Agent 自己打（按文本匹配，不需要偏移）：

```bash
  -d '{"raw":"GET /admin HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n","host":"10.0.0.5","port":80,
       "highlight":{"request":["Host:"],"response":["role=admin","token="],"color":"yellow"}}'
```
响应里给出 `highlightsApplied` / `highlightsMissing`；MCP 工具对应 `highlight_request` / `highlight_response` / `highlight_color`。

取证详情（来源/模式/抓取时间/flowId）在界面上收进面板头的 **ⓘ**；`/api/capture` 截图时会自动展开
（`evidenceDetails: false` 可关），因为无头截图无法体现"悬停展开"。

`evidenceMode`：`snapshot`（默认，服务端抓时间页后同源展示，必然画得出来）或 `direct`（真站点直嵌原站，默认多等 4s 绘制）。

Agent 自己没法「看」网页，所以由 replayd 用真实无头浏览器渲染，再把结果交回来。

### 浏览器从哪来

按优先级自动选择：`REPLAYD_CHROME_PATH` → 系统已装 Chrome/Chromium/Edge → 首次自动下载
`chromium-headless-shell`（默认先走 npmmirror 镜像，再回落 Google CDN；实测 ~100MB，镜像约 11s）。

```bash
curl -X POST -H "Authorization: Bearer $TOKEN"   http://127.0.0.1:8899/api/render/browser/install     # 需要时手动预热（异步，进度看返回的 jobId）
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8899/api/render/status
```

### REST：渲染一个页面

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'   -d '{"url":"https://example.com/","waitUntil":"networkidle","viaProxy":false}'   http://127.0.0.1:8899/api/render
```

返回 `text`（JS 执行后的可读文本）、`a11y`（无障碍树）、`screenshots.viewport/full`（PNG 产物，
用 `GET /api/artifacts/{id}` 取字节）、`timings`、`flowId`（已记入抓包历史）。

`viaProxy: true` 会让渲染流量走 replayd 自己的 MITM 代理 —— 于是页面子请求也被抓包，
且脚本改包对渲染生效（回环地址也已取消绕过）。

### MCP over HTTP

```
POST /mcp       # JSON-RPC 2.0，Bearer 鉴权；GET 返回 405（不提供 SSE）
```

工具：`render_url`、`render_status`、`replay_request`、`list_flows`、`get_flow`。
设置页有 **MCP 卡片**：直接给出端点、访问令牌（可显示/复制）、工具清单、可粘贴的客户端配置，
以及「测试握手」按钮（会真的发一次 `initialize` 验证连通性）。
`render_url` 会把截图作为 MCP `image` 内容块返回（base64 PNG），文本作为 `text` 内容块返回。

客户端配置示例：

```json
{
  "mcpServers": {
    "replayd": {
      "type": "http",
      "url": "http://127.0.0.1:8899/mcp",
      "headers": { "Authorization": "Bearer <启动时打印的令牌>" }
    }
  }
}
```

一次典型的 Agent 会话：`replay_request` 发包 → `render_url` 看渲染结果（改包是否生效）→
`list_flows` 回查证据链。
