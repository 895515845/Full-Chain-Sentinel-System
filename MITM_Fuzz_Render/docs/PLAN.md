# Web 发包重放工具 — 项目计划 v1.0

> 状态：**M0、M1、M2、M3 已完成并通过验收**（2026-10-22），另交付「北京时间取证面板」（方案 C 三栏并排）与「Agent 无头渲染 + MCP」（§8.7）；下一步 M3.5（Python 脚本）或 M4（打磨发布）。
> 工作目录：`/Users/chinaran404/code_dev/ai/fuzz`
> 命名：服务进程 `replayd`，命令行 `replayctl`

---

## 0. 文档索引

| 文档 | 内容 | 读者 |
|---|---|---|
| [PLAN.md](PLAN.md) | 目标、架构、里程碑、非功能需求、风险 | 所有人 |
| [SPEC-HTTP.md](SPEC-HTTP.md) | raw 引擎的解析/发送/响应规则、错误码、保真度测试矩阵 | 引擎实现者 |
| [SPEC-API.md](SPEC-API.md) | REST/WS 契约、错误信封、鉴权、SQLite DDL、blob 布局 | 后端 / CLI / Agent |
| [SPEC-UI.md](SPEC-UI.md) | 布局、页面、组件、testid、Agent 友好硬性要求、性能预算 | 前端 / 测试 |

> 规格是**实现依据**，不是宣传材料：改行为先改规格，再改代码，同一次提交。

---

## 1. 目标与非目标

一句话：**浏览器化的 HTTP/HTTPS 抓包 + 重放工作台**。一个 Go 单二进制跑在 Windows / Linux / macOS / Docker，UI 全在浏览器里，天然可被无头浏览器（Agent）驱动。

| 能力 | 本期 | 说明 |
|---|---|---|
| HTTP/HTTPS 请求构造与重放（Burp Repeater 式） | ✅ 核心 | raw 字节保真，见 SPEC-HTTP |
| MITM 代理抓包 + 历史重放 | ✅ 核心 | 本地 CA + 动态证书 |
| 脚本钩子（JS / Python）改包、断言 | ✅ 核心 | JS 在 M3，Python 在 M3.5 |
| 桌面壳（Electron / Tauri） | ❌ | Web 优先；将来加壳不改核心 |
| Docker + VNC 镜像 | ⏸ 推迟 | 架构不引入 GUI 依赖，届时只是镜像分层 |
| 原始 TCP/UDP 报文、Intruder 批量 Fuzz、多人协作 | ⏸ | 数据模型预留，不实现 |

**三个"不做"的理由**：桌面壳会让三平台打包成本翻倍且与 Web UI 重复；VNC 只是"怎么打开网页"的分发问题；批量 Fuzz 需要完全不同的任务模型，早做会污染 Repeater 的数据结构。

---

## 2. 技术决策

| 领域 | 选择 | 理由 | 备选 |
|---|---|---|---|
| 后端 | **Go 1.24**，单二进制 + `go:embed` | 交叉编译极简、无运行时依赖、MITM/TLS 生态成熟 | Rust（性能更好，MITM + 脚本引擎成本高） |
| HTTP 引擎 | **自研 raw socket HTTP/1.1 客户端** | 发包要"字节级保真"，`net/http` 会规范化、加头、自动解压，天然不适合 | `net/http`（仅用于代理转发侧） |
| MITM 证书 | ECDSA P-256 Root CA（10 年）+ per-host leaf（LRU 1000） | 签发快、兼容好 | RSA 2048（体积大、慢） |
| MITM 协议 | v1 强制 ALPN `http/1.1`；h2 在 M5 | h2 MITM 复杂度高，先保主流程 | 直接上 h2 |
| 脚本 | JS 用 **goja**；Python 用 **JSONL 子进程** | 无 cgo、超时可控、跨平台 | 内嵌 CPython（cgo，打包灾难） |
| 存储 | **SQLite**（`modernc.org/sqlite`，纯 Go）+ 内容寻址 blob | 无 cgo、单文件、WAL 并发读 | 纯文件 / Badger |
| 前端 | React 19 + TS + Vite + Tailwind 4 + CodeMirror 6 | 轻、headless 友好、构建产物可 embed | Monaco（重） |
| 实时 | WebSocket `/api/events` | 抓包流、脚本日志、重放进度 | SSE |
| 鉴权 | 启动生成 token → HttpOnly cookie / Bearer | 本机防 CSRF，Docker 可注入 | 无鉴权 |
| 发布 | GoReleaser：6 平台 + Docker | 一条命令全出 | 手工脚本 |

**关键取舍：不用 `net/http` 做重放。** 这是本产品与"Postman 类工具"的分水岭：Postman 会重排头、补 `User-Agent`、自动解压；安全测试需要的是"我写的就是线上发的"。

---

## 3. 架构

```
┌──────────── Browser（Chrome / Safari / Firefox / headless agent）──────────────┐
│  React SPA（构建产物 embed 进二进制）                                          │
│  History │ Repeater │ Scripts │ Settings │ CA 引导                             │
└───────────▲──────────────────────────────▲────────────────────────────────────┘
            │ REST /api/*                  │ WS /api/events
            │ 127.0.0.1 + token            │
┌───────────┴──────────────────────────────┴────────────────────────────────────┐
│                       replayd（单个 Go 二进制）                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │
│  │ API/静态 │ │ EventHub │ │ Repeater │ │ MITM     │ │ Script Runtime     │   │
│  │  (chi)   │ │  (WS)    │ │ Engine   │ │ Proxy    │ │ goja │ py sidecar  │   │
│  └────┬─────┘ └────▲─────┘ └────┬─────┘ └────┬─────┘ └──────────▲─────────┘   │
│       │            │            │            │                  │             │
│  ┌────▼────────────┴────────────▼────────────▼──────────────────┴──────────┐  │
│  │ Store：SQLite（元数据 + 索引）· blobs/（内容寻址）· config/flags          │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
└──────────┬────────────────────────────────────────────────────────────────────┘
           │ :8899 控制台/UI        :8898 代理（CONNECT + MITM）
           ▼
   上游：直连 / HTTP 代理 / SOCKS5 · 目标（自定义 SNI、ALPN、跳过校验）
```

### 3.1 并发模型

- 每个 TCP 连接一个 goroutine；MITM 内部读/写各一个（`io.Copy` 双向）。
- 落库**不在**转发路径上同步等待：先写 blob（流式），再发一条到 store 的单写者 channel（容量 1024，满则丢弃并计数 + 告警事件，绝不阻塞转发）。
- WS Hub 每连接一个 256 缓冲 channel，溢出即断开慢客户端（防止前端卡顿拖垮服务）。

### 3.2 生命周期

`启动 → 读配置/生成 token → 开库迁移 → 起 API → (M2) 起代理 → 打印带 token 的 URL → 等待信号 → 优雅关闭（10s）`。
关闭顺序反过来：停代理 → 停止接受新请求 → 等待在途（≤5s）→ 关 WS → 关库。

---

## 4. 核心模块

### 4.1 Raw HTTP 引擎

详见 [SPEC-HTTP.md](SPEC-HTTP.md)。要点：保序重复头、原样 body、不自动行为、raw 与视图分离、统一错误码、15 条保真度测试。

### 4.2 MITM 代理

- CA 首次启动生成（ECDSA P-256，10 年），私钥 0600；导出 `.pem` / `.crt` / `.mobileconfig`。
- per-host leaf 证书，SAN=host，LRU 1000；**不要在握手路径上做磁盘 IO**。
- `CONNECT` → 200 → TLS（ALPN h1.1）→ h1.1 服务 → 上游；WebSocket Upgrade 后双向透传。
- 非 HTTP 隧道：blind tunnel，flow 标 `tunnel`。
- 客户端拒绝证书 / pinning：`/api/proxy/diagnose` 主动探测 + per-host bypass 规则。
- 上游校验失败时给"继续但不校验"选项，不静默降级。

### 4.3 Repeater

多 tab、草稿自动保存、raw⇄结构化、挂脚本、`⌘↵` 发送、可取消、响应多视图（Pretty/Raw/Hex/Headers/Timings）、两版 diff、错误卡片带解决建议。

### 4.4 脚本运行时

钩子 `onRequest(req, ctx)` / `onResponse(res, ctx)` / `onAssert(res, ctx)`。
JS：goja + 3s 超时中断 + helpers（b64/hex/hmac/sha256/urlencode/jsonPath），无文件/网络 IO。
Python：`python3 -u runner.py` + JSONL，超时 kill 重启，stderr 进日志。
示例：HMAC 签名、JWT 刷新、AES 解密、越权断言。

### 4.5 存储

详见 [SPEC-API.md §3](SPEC-API.md)。要点：元数据与 body 分离、内容寻址去重、单写者队列、保留 30 天 / 5 万条、blob 引用计数延迟回收。

### 4.6 API

详见 [SPEC-API.md §2](SPEC-API.md)。要点：统一错误信封、游标分页、cookie+Bearer 双鉴权、Origin 校验防 CSRF、`/api/health` 免鉴权。

---

## 5. UI

详见 [SPEC-UI.md](SPEC-UI.md)。四个页面（History / Repeater / Scripts / Settings），暗色高密度，零 canvas，稳定 testid，状态可深链。M0 只需布局 + 空态 + 健康状态。

---

## 6. 平台兼容矩阵

| 平台 | 产物 | 说明 |
|---|---|---|
| Windows 10/11 | `replayd_windows_{amd64,arm64}.exe` | 装 CA 需管理员；默认只监听回环 |
| macOS 12+ | `replayd_darwin_{amd64,arm64}` | `--open` 自动开浏览器 |
| Linux | `replayd_linux_{amd64,arm64}` | 附 systemd unit；无 cgo |
| Docker | `ghcr.io/chinaran404/replayd:{tag}` | 非 root、`/data` 卷、`REPLAYD_TOKEN`、HEALTHCHECK |

**硬约束**：全链路禁止 cgo（`CGO_ENABLED=0`），保证交叉编译与静态链接；`go test` 也在 `CGO_ENABLED=0` 下跑通。

**Docker + VNC（M5）**：`base`（二进制）与 `full`（+ Xvfb + chromium kiosk + x11vnc + noVNC）两层，对外 6080；不碰业务代码。

---

## 7. 非功能需求

| 维度 | 指标 | 验证方式 |
|---|---|---|
| 启动时间 | 冷启动 < 300ms（无历史数据） | 基准测试 |
| 落库 | 单 flow < 15ms（本地 SSD，含 blob 写） | 压测脚本 |
| 抓包吞吐 | 单核 ≥ 300 req/s 简单 GET（含落库） | 基准测试 |
| 列表性能 | 5 万条 flow 分页查询 P99 < 30ms | 索引 + EXPLAIN 检查 |
| 内存 | 空闲 < 80MB；1 万条 flow 浏览 < 200MB | pprof |
| 大包 | 64MB 响应不 OOM（流式落盘） | 集成测试 |
| 安全 | 默认仅回环；token 常量时间比较；日志不落 Authorization/Cookie | 代码审查 + 单测 |
| 可观测 | 结构化日志（slog JSON）、`/api/health` 含版本与构建信息 | 人工 |
| 可维护 | `go vet` + `golangci-lint` 零告警；`gofmt` 强制 | CI |
| 可测试 | 核心包行覆盖 ≥ 70%；e2e 冒烟全绿 | CI |

---

## 8. 里程碑

| # | 目标 | 交付物 | 验收标准 | 预估 |
|---|---|---|---|---|
| **M0** ✅ | 骨架跑通 | 见 §8.1 | 一条命令起服务；6 平台产物；`/api/health` 200；UI 四页面可导航 | 2 天 |
| **M1** ✅ | Repeater MVP | raw 引擎、响应多视图、tab 持久化、真实历史列表、curl/HAR 导入（CodeMirror 编辑器顺延至 M4 打磨） | 见 §8.3 | 4 天 |
| **M2** ✅ | MITM 抓包 | CA 生命周期（生成/下载/诊断/重建）、CONNECT MITM、动态证书 LRU、WS 隧道、bypass、实时 flows、发送到 Repeater | 见 §8.4 | 5 天 |
| **M3** | 脚本（JS） | goja + 三钩子 + helpers + 超时中断、编辑器与试跑、示例 | 死循环 3s 被中断且有报错；脚本异常不拖垮主流程 | 3 天 |
| **M3.5** | 脚本（Python） | JSONL sidecar、解释器探测、超时回收、AES 示例 | 超时进程被回收；stderr 进日志；与 JS 等价 | 2 天 |
| **M4** | 打磨交付 | diff、深链、Playwright e2e、OpenAPI + `replayctl`、GoReleaser、文档 | e2e 全绿；三平台各跑通一次真实抓包 | 3 天 |
| M5 | 增强（可选） | h2 MITM、uTLS 指纹、Intruder、VNC 镜像 | — | — |

合计 **≈ 19 人日**。关键路径：**M1 的 raw 引擎 → M2 的证书链路**，这两块决定产品是否"够狠"。

### 8.1 M0 任务清单（已完成）

| # | 任务 | 产物 | 状态 |
|---|---|---|---|
| 1 | 规格文档 | `docs/PLAN.md` + `SPEC-HTTP/API/UI` | ✅ |
| 2 | 仓库骨架 | `git`、`go.mod`、`.gitignore`、`README.md`、`LICENSE` | ✅ |
| 3 | 配置层 | `internal/config`：flag/env/默认值/token 生成，6 组单测 | ✅ |
| 4 | 存储层 | `internal/store`：嵌入式迁移、WAL、单写者、blob 去重，7 组单测 | ✅ |
| 5 | API 层 | `internal/api`：chi 路由、Bearer/Cookie 鉴权、Origin 校验、health/session/flows、SPA 托管 | ✅ |
| 6 | 事件层 | `internal/eventbus` + `/api/events`（hello + 心跳 + 广播） | ✅ |
| 7 | 前端骨架 | `web/`：四页面、健康轮询、错误兜底、关键 testid 全覆盖 | ✅ |
| 8 | 工程化 | `Makefile`、`Dockerfile`、CI（六平台 + 冒烟）、`.goreleaser.yaml` | ✅ |
| 9 | 验证 | 见 §8.2 | ✅ |

### 8.2 M0 验收记录（2026-10-22）

| 项 | 方式 | 结果 |
|---|---|---|
| 编译 | `go build ./...` / `go vet ./...` | 通过，零告警 |
| 单测 | `CGO_ENABLED=1 go test -race ./...` | 5 个包全绿 |
| 交叉编译 | `make dist` | 6 个产物（linux/darwin/windows × amd64/arm64），10–11MB |
| 内嵌前端 | `go build -tags embedui` | 单文件 10MB，含 UI 资源 |
| 启动 | `./bin/replayd -data-dir /tmp/replayd-m0` | 打印带 token 的访问地址；token 文件 0600 |
| 健康检查 | `GET /api/health` | 200，`status=ok`，含版本/平台/数据目录/flow 数 |
| 鉴权 | 无凭证 `GET /api/flows` | 401 `unauthorized` |
| 首访引导 | `GET /?token=…` | 302 到 `/` 并下发 HttpOnly cookie |
| CSRF | 带 cookie + 异源 `Origin` 的 DELETE | 403 |
| Bearer | `Authorization: Bearer <token>` | 200 |
| SPA 深链 | `GET /history` | 200 `text/html`（非 404） |
| UI 渲染 | headless Chrome `--dump-dom` | 显示 `online v0.1.0-m0`、空态文案、`nav-*`/`page-*` 等 testid 齐备 |
| Docker | `docker build` + 运行 + `curl /api/health` | 成功；镜像 20.5MB；容器内 200，UI 可访问 |

---

---

## 9. 目录结构

```
fuzz/
├─ cmd/replayd/main.go          # 服务入口（M4 加 cmd/replayctl）
├─ internal/
│  ├─ config/                   # flags + env + 默认值 + token
│  ├─ store/                    # SQLite + blobs + migrations/*.sql
│  ├─ httpreplay/               # raw 解析/发送/响应（M1）
│  ├─ proxy/                    # MITM、CA、隧道（M2）
│  ├─ script/                   # goja + python sidecar（M3）
│  ├─ api/                      # 路由、中间件、WS、embed dist
│  └─ eventbus/                 # 事件总线
├─ web/                         # Vite + React（build → ../internal/api/dist）
│  ├─ src/{components,pages,lib}/
│  └─ e2e/                      # Playwright（M4）
├─ scripts/examples/            # 示例脚本（M3）
├─ docs/                        # PLAN / SPEC-* / CA-INSTALL
├─ .github/workflows/ci.yml
├─ Dockerfile · .goreleaser.yaml · Makefile
```

---

## 10. 测试策略

| 层 | 内容 | 门禁 |
|---|---|---|
| 单测 | 解析器畸形报文（表驱动 15+ 例）、证书签发、脚本超时、blob 寻址、配置优先级 | `go test ./...` 全绿，覆盖 ≥70% |
| 集成 | `httptest` 起真服务 + 真代理走 CONNECT+TLS 全链路 | CI |
| e2e | Playwright headless：抓包→重放→改包→脚本→断言 | CI（M1 起） |
| 契约 | `openapi.json` 与实际路由一致性（测试里比对路由表与 spec paths） | CI |
| 性能 | 落库、吞吐、5 万条分页 | 手动/夜间 |

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| CA 装不上 → 用户以为工具坏了 | 高 | `/api/proxy/diagnose` 主动探测 + 逐系统安装命令 + 一键复制；UI 明确"证书未被信任"而非"请求失败" |
| HTTP/2 / HTTP/3 站点 | 中 | v1 只 offer h1.1（浏览器自动回退）；h3 直接隧道；M5 补 h2 |
| 证书 pinning | 中 | 明确报错 + per-host bypass（隧道透传） |
| 大响应 OOM | 中 | 流式落盘 + 2MB 预览 + 上限 64MB + `too_large` |
| 脚本被当成安全边界 | 中 | 文档明示"脚本是受信代码"；goja 无 IO + 超时；Python 可执行任意代码需用户自担 |
| Agent 驱动 UI 不稳 | 中 | testid + 语义 DOM + 深链 + CI 真跑 Playwright + CLI/OpenAPI 兜底 |
| 代理被局域网滥用 | 中 | 默认回环 + token + 显式 `--proxy-listen 0.0.0.0` 告警 |
| SQLite 写放大 | 低 | 单写者 + WAL + 批量事务 + 定期 checkpoint |

---

## 12. 交付流程

- 分支：`main` 保护；功能分支 `feat/m1-raw-engine`；提交信息 `feat(engine): ...` / `fix(api): ...`。
- 版本：`0.1.0-m0` → `0.1.0` (M1) → `0.2.0` (M2) → `0.3.0` (M3)；`-dev` 标记 nightly。
- 构建信息通过 `-ldflags "-X main.version=... -X main.commit=... -X main.buildTime=..."` 注入。

---

## 13. 已定 / 待定

**已定**：Go 后端；纯 Web 形态；`replayd`/`replayctl`；JS 先行、Python 后补；单用户本地工具（127.0.0.1 + token）；禁用 cgo。

**待定（不阻塞 M0）**：

1. 上游代理 / SOCKS5：默认 M1 留接口、M2 补齐 —— 可提前。
2. 响应 diff：暂列 M4（约 0.5 天）。
3. 亮色主题：暂不做。

---

## 14. 决策记录（ADR 摘要）

| 日期 | 决策 | 理由 | 代价 |
|---|---|---|---|
| 2026-10-22 | Web 优先，不做桌面壳 | 一套 UI 覆盖四平台；Agent 友好；VNC 退化为打包问题 | 无系统级集成（托盘、全局快捷键） |
| 2026-10-22 | 自研 raw HTTP 客户端 | 保真是核心卖点；`net/http` 不可控 | M1 工时增加约 1.5 天，需自测协议边界 |
| 2026-10-22 | SQLite + blob 分离 | 去重、大包不撑爆 DB、备份简单 | 引入引用计数与 GC |
| 2026-10-22 | 单用户本地工具 | 目标场景是个人渗透测试 | 无多人协作；后续要加需引入账号体系 |
| 2026-10-22 | 禁用 cgo | 交叉编译与静态链接，Docker 用 scratch/distroless | 不能用 sqlite3 cgo 驱动，改用 modernc（性能略低但可接受） |

### 8.3 M1 验收记录（2026-10-22）

| 项 | 方式 | 结果 |
|---|---|---|
| 解析保真 | 表驱动单测：保序/大小写/重复头/裸 LF/obs-fold/畸形行/CL 不一致/手工 chunked/绝对形式/CONNECT | 全过 |
| 发送保真 | 本地裸 TCP 服务断言线上字节 == 原文（含仅补 Host/Connection 场景） | 全过 |
| 响应解析 | chunked（含 trailer）、gzip 不解压、CL 截断、1xx 跳过、64MB 限流、EOF body | 全过 |
| 错误码 | conn_refused / header_timeout / tls_cert（自签）/ tls_handshake（明文打 TLS 端口） | 全过 |
| 上游代理 | http 代理绝对形式请求行断言；SOCKS5 走 x/net（未做集成测试，M2 补） | 通过/待补 |
| 重放 API | e2e：`POST /api/replay` → python http.server 200 + 正文回显 + flow 落库 + `GET /api/flows` 可见 | 通过 |
| 错误路径 | 无目标 → 200+`bad_request`；conn_refused → `error.code=conn_refused`；未授权 401 | 通过 |
| tabs | CRUD e2e：创建/部分更新/列表/删除 404 | 通过 |
| 导入 | curl（头/body/-u/-k/--compressed/引号转义/@file 警告）与 HAR（多 entry、补 Host/CL）单测；`POST /api/import` 落 tab | 全过 |
| UI | headless Chrome：History 渲染真实 flow（"共 1 条"）；Repeater 自动建"标签 1"、加载示例请求、四视图/发送按钮就位 | 通过 |
| 回归 | `go test -race ./...` 7 包全绿；`go vet`、`gofmt` 干净；`pnpm typecheck/build` 通过（gzip 95KB JS） | 通过 |

**顺延项**：CodeMirror 编辑器（现为可编辑 textarea）、SOCKS5 集成测试 → M4；响应 diff → M4。

### 8.4 M2 验收记录（2026-10-22）

| 项 | 方式 | 结果 |
|---|---|---|
| CA 生命周期 | `internal/cert` 单测：生成/复用/权限 0600、指纹、IP SAN、LRU 封顶 1000、重建持久化 | 全过 |
| MITM 解密 | e2e：`curl -x http://127.0.0.1:8898 --cacert ca.crt https://127.0.0.1:18443/sec?x=1` → 返回上游明文 `hello-mitm /sec` | 通过 |
| 抓包落库 | 同一次请求后 `/api/flows` 出现 `proxy GET https://…/sec`，`?body=1` 可见明文 `reqRaw`/`respRaw`，status=200 | 通过 |
| 默认上游校验 | 自签上游未开开关时返回 502 + `X-Replayd-Error: tls_cert` + 中文说明（**不静默降级**） | 通过 |
| 明文代理 | `curl -x` 访问 http 上游 → flow 记录（scheme=http） | 通过 |
| bypass 隧道 | CONNECT 主机命中 bypass → 只做 TCP 透传，仅记录 `CONNECT` 隧道 flow，不产生解密 flow | 通过 |
| WebSocket | 升级请求走盲隧道：101 原样透传 + 双向字节回显（`echo:hi-ws`） | 通过 |
| 502 与错误流 | 上游拒绝 → 客户端收到 502，flow 带 `error.code=conn_refused` | 通过 |
| 客户端未装 CA | `curl` 不带 `--cacert` → 退出码 60；服务器日志记录"客户端拒绝 MITM 证书"并落隧道 flow | 通过 |
| 系统信任诊断 | `/api/proxy/diagnose` 用系统池连本地 leaf：未安装时 `trusted=false` + 5 条分平台安装指引 | 通过 |
| CA 下载 | ca.pem（PEM）≡ ca.crt（DER）同一证书；mobileconfig 为合法 plist 描述文件 | 通过 |
| 实时流 | History 订阅 `flow.new`：经代理请求后 headless Chrome 渲染出 1 行（`>proxy<`、URL 含 :18901、`flow-to-repeater-*`） | 通过 |
| 前端 | Settings 渲染代理卡（启动/停止、监听、忽略校验）+ CA 卡（真实指纹、3 个下载、诊断、重建确认）；NavRail 状态灯 real-time 变绿「抓包中」 | 通过 |
| 回归 | `go test -race ./...` 10 包全绿；`go vet`/`gofmt` 干净；`pnpm typecheck/build` 通过（gzip 98KB JS） | 通过 |

**顺延项**：HTTP/2 MITM（现只 offer h1.1，浏览器自动回退）、SOCKS5 集成测试、bypass 规则持久化 → M4/M5。

### 8.5 M3 验收记录（2026-10-22）

| 项 | 方式 | 结果 |
|---|---|---|
| 运行时 | 17 项单测：改 header/body、headers get/set/add/remove/all 语义、onResponse 改写、断言三态（assert()/return bool/未断言）、超时中断、语法/运行时异常带钩子名、ctx.vars/env、日志封顶、ctx 取消 | 全过 |
| 加密 helpers | 已知向量对齐：sha256("abc")、hmacSHA256("key","data")、md5("abc")、base64 往返、urlencode；AES-CBC 加解密往返 + 非法填充抛异常 | 全过 |
| 两阶段会话 | 同一个 VM 执行 onRequest 与 onResponse/onAssert，`ctx.vars`/日志跨阶段连续（不是跑两遍脚本） | 通过 |
| 改包落线 | e2e：`scriptId` 重放后，flow 的 `reqRaw` 里出现脚本写入的 `X-Sign: 8bb990…`（证明改的是真正发出的字节） | 通过 |
| 断言 | `assert(res.status===404, …)` → `script.assert.ok=true` 且 message 回传；断言失败时响应仍返回、仅标记失败 | 通过 |
| 失败不发送 | 脚本抛异常 → `error.code=script_error`、上游 0 次命中、不产生 flow（避免"半成品请求"上线） | 通过 |
| 执行记录 | `script_runs` 落库并关联 `flowId`；`/api/scripts/{id}/runs` 可查 | 通过 |
| CRUD 与并发 | 创建/更新/删除；`updatedAt` 乐观锁冲突返回 409；store 层时间戳强制单调（同毫秒也能测出冲突） | 通过 |
| 试跑 | `/test` 默认只跑钩子（不联网）并回传改写后的 raw；`send=true` 完整发包并回传上游响应 | 通过 |
| 前端 | Scripts 页：列表/新建/编辑器/三钩子开关/启停/示例插入/试跑/日志/断言/最近执行；Repeater：每 tab 挂脚本 + 发送后显示脚本结果条 | 通过 |
| 规范偏差修正 | 发现引擎未实现 SPEC-HTTP §2.2 的"有 body 无 CL/TE 时自动补 Content-Length"，已实现并补测试（可用 `disableAutoContentLength` 关闭） | 已修 |
| 回归 | `go test -race ./...` 11 包全绿；`go vet`/`gofmt` 干净；`pnpm typecheck/build` 通过（gzip 102KB） | 通过 |

**顺延项**：Python sidecar（M3.5）、CodeMirror 语法高亮（M4）。

### 8.6 「北京时间」取证面板验收记录（2026-10-22，方案 C 三栏并排）

> 背景：攻防演练中裁判常要求截图里包含"北京时间"网页作为时间证据。难点不在前端，而在多数授时站点用
> `X-Frame-Options: SAMEORIGIN` / `CSP frame-ancestors 'self'` 拒绝被第三方内嵌。

| 项 | 方式 | 结果 |
|---|---|---|
| 内嵌可行性判定 | `evidence.Frameable` 单测：XFO DENY/SAMEORIGIN/ALLOW-FROM、CSP frame-ancestors none/self/*/允许本机 | 全过 |
| 快照改写 | `evidence.Rewrite` 用 x/net/html 做真实 DOM 改写：剥离 `<script>`、内联 `on*`、`javascript:`，移除 meta CSP/XFO，注入 `<base href=原站目录>`；保留正文与相对资源 | 全过 |
| 快照缓存 | LRU + TTL 单测：容量淘汰、TTL 过期、超大快照截断到 4MB | 全过 |
| 实测：可内嵌站点 | `beijing-time.org` → `mode=direct`，iframe 直指原站（`sandbox="allow-scripts"`，无 same-origin） | 通过 |
| 实测：禁止内嵌站点 | 本地靶机（XFO DENY + CSP frame-ancestors self）→ 自动转 `mode=snapshot`，水印条标注「不可直嵌：X-Frame-Options: DENY」 | 通过 |
| 快照字节核验 | 快照响应：`<script`/`onload=`/`onclick=`/`javascript:`/原文脚本标记 均为 0；`<base href="http://127.0.0.1:18906/"/>` 已注入；正文与 `clock.png` 保留 | 通过 |
| 证据链 | 每次抓取写一条 flow（`note = "evidence: <url> · direct|snapshot"`）并广播 `flow.new`；水印条显示 flowId，History 可回看 | 通过 |
| 三栏布局 | CDP 实测：`repeater-request / repeater-response / evidence-panel` 三等分（414/414/413 @1440） | 通过 |
| 面板能力 | 预设源下拉、自定义 URL、模式（自动/强制直嵌/强制快照）、自动刷新 30/60s、允许脚本开关、全屏取证、隐藏回两栏 | 通过 |
| 溢出与切换 | 文档级/面板级/水印条横向溢出均为 0；隐藏与恢复（两栏↔三栏）正常 | 通过 |
| 安全 | 快照与 evidence 端点均需鉴权；iframe `sandbox="allow-scripts"`（不给 same-origin）→ 实测父页面无法读取其 DOM；快照剥离一切可执行入口 | 通过 |
| 回归 | `go test -race ./...` 12 包全绿；`go vet`/`gofmt` 干净；`pnpm typecheck/build` 通过（gzip 105KB） | 通过 |

**已知限制**：快照是"抓取时刻的静态页面"，页面时钟停在抓取时间（水印条已标注）；要真实走字请选允许内嵌的站点（beijing-time.org / bjtime.cn）或勾选「允许脚本」。方案预览页见 `docs/preview/evidence-panel.html`。

### 8.7 Agent 无头渲染 + MCP over HTTP 验收记录（2026-10-22）

> 目标：Agent 不能自己「看」网页。它把 URL / 数据包交给 replayd，replayd 用无头浏览器**真实渲染**，
> 再把渲染后的文本、无障碍树、PNG 截图交回。纯 HTTP 抓取拿不到 JS 执行后的结果，这正是本能力存在的理由。

**决策（用户确认）**：产物 = PNG 截图 + 可读文本 + 无障碍树；数据源 = 直渲 URL（可选经 MITM）；
浏览器 = 首次自动下载 chromium-headless-shell；调用 = REST + **HTTP 型 MCP**；同步 + 可选异步；
默认允许渲染任意 URL；进程模型 = 常驻复用 + 每任务独立 BrowserContext；产物**永久保留**；
MCP 暴露渲染 + 重放 + 读历史；渲染动作记入抓包历史。

| 项 | 方式 | 结果 |
|---|---|---|
| CDP 客户端 | 纯 Go + gorilla/websocket（无 Playwright）；单测：假 DevTools 服务器验证 `Call/On/错误透传/sessionId/并发/超时/关闭` | 全过 |
| 浏览器解析链 | `REPLAYD_CHROME_PATH` → 系统 Chrome/Chromium/Edge → 已下载；单测覆盖优先级、可执行位、zip 路径穿越拒绝、最新版本选取 | 全过 |
| 自动下载 | chrome-for-testing 版本索引 + `npmmirror`→Google CDN 兜底；实测 99.1MB，npmmirror 9.4MB/s（~11s）、Google 2.2MB/s（~47s）；解压后 `--version` 校验 | 通过 |
| 渲染器 | 轮询 `document.readyState` + 资源数稳定（不用事件订阅，避免长连接上处理器堆积）；`load`/`networkidle`；视口与**整页**截图（拉高视口法） | 全过 |
| **JS 执行验证** | 靶机页面用 JS 写 DOM；渲染后文本含 `控制台 · admin 已登录` 与 60 条由 JS 生成的记录 | 通过 |
| 无障碍树 | `Accessibility.getFullAXTree` 裁剪（过滤 ignored 与无语义容器）；靶机实测 127 个节点，含按钮 | 通过 |
| 截图字节 | 下载产物校验 PNG 魔数与尺寸：整页 **1440×1459**、视口 **1440×900**（整页确实高于视口） | 通过 |
| 产物存储 | 新增 `0002_artifacts` 迁移 + blob 内容寻址去重 + 引用计数；单测：往返、去重（3 条同内容→1 blob/refcount 3）、按 kind 过滤、删除与重复删除 | 全过 |
| 同步/异步 | `POST /api/render` 同步返回；`async=true` → 202 `{jobId,poll}`，`GET /api/render/jobs/{id}` 轮询到 done | 通过 |
| 经 MITM 渲染 | `viaProxy=true` → 浏览器上下文设 `proxyServer`；**实测发现并修复 Chrome 默认绕过回环地址**，加 `proxyBypassList=<-loopback>` 后靶机子请求被抓到 4 条（修复前 0 条） | 通过 |
| 参数错误语义 | 缺 url / 非 http(s) / 非法 waitUntil → 400；`viaProxy` 未启动代理 → 400 并说明原因（不静默直连）；引擎失败 → 200 + `error.code` | 通过 |
| 渲染进历史 | 渲染写一条 flow（`note = "render: <url>"`，经代理时追加 `· via http://127.0.0.1:8898`），`respBody` = 渲染后文本；实测历史 4→8 条 | 通过 |
| MCP over HTTP | `POST /mcp` JSON-RPC：`initialize`（protocolVersion 2025-06-18 / serverInfo replayd / capabilities.tools）、`notifications/*`→202 空响应、`tools/list`（5 个工具，含 inputSchema）、`tools/call`、批量数组、`GET /mcp`→405、未鉴权→401 | 全过 |
| MCP 工具 | `render_url`（文本+**image 内容块**，实测 194KB PNG base64 解码后为合法 PNG）、`render_status`、`replay_request`、`list_flows`、`get_flow`；未知工具 → `isError:true` | 全过 |
| 回归 | `go test -race ./...` **15 包全绿**；`go vet`/`gofmt` 干净 | 通过 |

**已知限制**：整页截图高度上限 16000px；`viaProxy` 时浏览器后台流量（如 google.com 的 CONNECT）也会进历史（信息性噪音，可读性过滤留待 M4）；产物永久保留，仅提供 `DELETE /api/artifacts/{id}` 手动清理。

### 8.8 可用性补强：MCP 接入信息 + 历史分页（2026-10-22）

| 项 | 结果 |
|---|---|
| 设置页 MCP 卡 | 端点 `http://127.0.0.1:<port>/mcp`、令牌（默认打码 `4b425f…db8e32（共 64 字符）`，可显示/复制）、5 个工具徽标、客户端配置片段（含 `mcpServers`/`/mcp`）、curl 示例、**测试握手**按钮 |
| 握手实测 | 设置页点「测试握手」→ `✓ 握手成功：replayd 0.1.0 · 协议 2025-06-18 · 能力 tools` |
| 历史分页 | 由「一次拉 200 条」改为 keyset 游标 + 游标栈：`第 X 页 · 每页 M 条 · 共 N 条`，每页 25/50/100/200（记忆到 localStorage），« 最新 / ‹ 上一页 / 下一页 ›，键盘 ←/→ |
| 分页实测 | 61 条数据：第 1 页 25 行 → 下一页 = 第 2 页 25 行；每页改 25 生效并持久化；←/→ 键盘翻页正常 |
| 实时流与分页 | 停在较早页时新抓包不插入，显示「↑ 1 条新记录」；点击回到最新页后总数 61 → 62、提示消失 |
| 列表徽标 | 来源列区分 `取证`（evidence）与 `渲染`（render） |
| 后端 | 新增 `Store.CountFlows(filter)`（原无参版本更名 `CountAllFlows`）；`GET /api/flows` 返回 `total`/`hasMore`；新增 `GET /api/mcp` |
| 回归 | `go test -race ./...` 全绿；`pnpm typecheck`/`build` 通过（gzip 107KB） |

### 8.9 界面自截图（Agent 产出"结果 + 北京时间"证据图，2026-10-22）

> 需求澄清：Agent 要的不是"目标网站渲染结果"，而是**把 replayd 自己的 Repeater 界面（请求 + 响应 + 取证）截成图**。
> 全自动：填包 → 点发送 → 等响应与取证面板 → 整窗截图。只做 Repeater 页。

| 项 | 结果 |
|---|---|
| 实现 | `internal/capture`：独立 BrowserContext（不经 MITM）+ `?token=` 自动登录 + 原生 setter 填表 → 点发送 → 等响应标记 → 等取证 → `Page.captureScreenshot` |
| 接口 | `POST /api/capture`（同步）+ MCP 工具 `capture_repeater`（text 摘要 + image 内容块） |
| 成品图 | 1600×1050 PNG：左栏请求报文、中栏 `200 OK · 415 B` + 响应头 + 响应体、右栏取证面板显示**真实 beijing-time.org 页面（时钟 19:29:14 走动）** + 水印（来源/模式/抓取时间/本机时间/flowId） |
| 文本回读 | `statusLine`/`responseHeaders`/`evidenceWatermark`/`requestSeen` 全部从界面 DOM 读回，Agent 不看图也能判断 |
| 绘制时序（踩坑记录） | 跨源 iframe 是 OOPIF：`Page.getFrameTree` **看不到**它，`Target.getTargets` 也拿不到，父页面亦读不到 `contentDocument`。最终方案＝「等面板已有结果」+ 绘制等待（snapshot 1.5s / direct 4s）；修复前截图右栏为空白，修复后 179KB 且内容完整 |
| 耗时 | 合计约 6.2s（发送 203ms / 取证 4.2s） |
| 验证 | `internal/capture` 单测（SelfURL 归一化、参数校验、send 默认值）+ 真机端到端截图肉眼核验 + 15 包 `go test -race` 全绿 |

### 8.10 请求/响应高亮（2026-10-22）

> 需求：请求包与响应包都要能"选中即高亮"，方便在证据截图里把 payload / 回显 / 时间框出来。

| 项 | 结果 |
|---|---|
| 交互 | 鼠标选中 → 浮出工具条：4 色（黄/绿/红/蓝）+ 复制 + 清除（选区已有高亮时才出现）+ 关闭；Esc 关闭 |
| 请求侧 | textarea 无法给选区上色 → **底层色块 + 上层透明 textarea**：canvas 测等宽字符宽度/行高，按偏移算矩形（多行自动拆分），`wrap="off"` 保证几何精确，滚动同步 |
| 响应侧 | `<pre>` 按偏移切成片段用 `<mark>` 内联渲染（天然支持折行），偏移由 DOM Range 走 TreeWalker 累加得到 |
| 存储 | **存服务端标签页**（迁移 `0003_tab_highlights`）：`{"request":[…],"response":{"raw|pretty|hex":[…]}}`；前端乐观更新 + `PUT /api/tabs/{id}/highlights` |
| 为什么存服务端 | `/api/capture` 用全新浏览器 profile 截图，存 localStorage 的高亮不会出现在截图里 |
| API 校验 | 只接受 `yellow/green/red/blue`、`0 ≤ start < end ≤ 8M`；自动排序去重叠；单页上限 300 条、请求体上限 64KB；视图名 ≤16 字符 |
| 面板计数 | 请求/响应面板头各有「高亮 N」按钮，一键清空该侧（响应按当前视图清） |
| 实测 | 选中响应里 `token=…` → 工具条弹出（"54 字符"）→ 绿色 mark 生成；选中请求 `Host:` 行 → 红色色块 1 个；`GET /api/tabs` 确认落库 `{"request":[{15,36,red}],"response":{"pretty":[{58,112,green}]}}`；刷新后计数与色块仍在；`POST /api/capture` 截出的图里**请求红色高亮清晰可见** |
| 已知边界 | 响应高亮偏移按视图记录，响应内容变化后 mark 可能落在别处（同视图内偏移是准的）；高亮不随响应体一起持久化 |

### 8.11 Agent 打高亮（2026-10-22）

> 问题：`PUT /api/tabs/{id}/highlights` 要字符偏移。请求偏移 Agent 能算，**响应偏移它算不出来**
> （响应在发包后才存在，且 Pretty/Raw/Hex 三视图偏移各不同）。因此补上"按文本匹配"并内建进截图调用。

| 项 | 结果 |
|---|---|
| `POST /api/capture` | 新增 `highlight`：`{"request":["Host:"],"response":["role=admin"],"color":"yellow"}` |
| 实现 | 在页面内驱动真实交互：请求侧 `setSelectionRange` + `select/mouseup` → 点色点；响应侧 TreeWalker 构造 Range → 点色点。因此高亮走前端既有持久化逻辑，落到标签页上 |
| 结果回执 | `highlightsApplied` / `highlightsMissing`（片段没找到会明确列出，不静默失败） |
| MCP | `capture_repeater` 新增 `highlight_request` / `highlight_response` / `highlight_color`，**一次调用即得带高亮的证据图** |
| 实测（REST） | 一次调用：`已高亮 request:Host: 127.0.0.1:18910、response:role=admin、response:token=`，截图 132KB |
| 实测（MCP） | 一次调用：`已高亮 request:Host:… 、response:uid=10100`，image 内容块 176KB base64 |
| 响应高亮可视化 | DOM 核验：`mark` 2 个、文本 `token=`/`role=admin`、背景 `rgba(250,204,21,.32)`/`rgba(96,165,250,.34)` —— 功能正常，但**透明度偏淡**，已整体调深（0.32/0.30/0.34 → 0.52/0.48/0.52）以便截图与 PDF 里一眼可见 |
| 校验 | 颜色白名单、每侧 ≤20 片段、单片段 ≤200 字符、空片段拒绝；非法参数返回 400 |

### 8.12 取证信息收进 ⓘ（方案 C，2026-10-22）

> 用户选择：把「来源 / 模式 / 抓取 / 本机 / flowId」从 iframe 上方的多行水印块，收进面板头的 ⓘ。

| 项 | 结果 |
|---|---|
| 面板头 | `取证` · 模式徽标 · **抓取 2026-10-22 22:21:24**（常显，一眼可见访问时刻）· ⓘ · 全屏取证 · 隐藏 |
| ⓘ 弹层 | 键值对排版：来源（完整 URL）/ 模式 / 抓取（RFC3339）/ 本机（走字）/ 已记入历史（flowId）/ 不可直嵌原因 / 截断提示；点 ⓘ 或 Esc 收起 |
| 版面收益 | iframe 上方那 5 行小字整块消失，时间页直接顶到工具栏下方 |
| 截图兼容（关键） | 界面默认收起，但无头截图**没法体现"悬停/点击展开"** → `POST /api/capture` 的 `evidenceDetails`（默认 `true`）会在截图前自动点开 ⓘ；传 `false` 则保持收起 |
| 探测与回读 | 截图端不再依赖水印文本：改读 ⓘ 的 `data-has-result` / `data-summary` 属性（隐藏的 `evidence-watermark` 纯文本作为兜底），`evidenceWatermark` 字段仍返回一行完整摘要 |
| 实测 | 截图 1600×1000：头部为 `服务端快照 · 抓取 22:21:24 · ⓘ`，弹层展开显示 5 项（含 `flw_06GP7Z89EK91DEDV0GBQ4A53MR`）；请求黄色高亮仍在；接口回读摘要含来源/模式/抓取/本机/flowId |
| 方案预览 | `docs/preview/evidence-watermark.html`（A–F 六种摆放对比，含"截图里能否读全""是否遮内容"取舍） |

### 8.13 启动端口随机化（2026-10-23）

> 需求：每次启动的端口都在 7000–8000 里随机，避免固定端口被扫描/冲突。

| 项 | 说明 |
|---|---|
| 规则 | 仅当 `-listen` / `-proxy-listen` **命令行与环境变量都没给**时才随机；显式指定一律优先 |
| 范围 | `[7000, 8000]`，绑定主机固定 `127.0.0.1`（保持仅回环） |
| 选口 | `crypto/rand` 随机 + `net.Listen` 探测空闲（最多试 50 次）；代理端口会**排除**控制台端口，二者必不相同 |
| 可见性 | 启动横幅追加「（本次随机分配 7000-8000）」；`Config.ListenRandom/ProxyListenRandom` 供程序判断 |
| 不受影响 | Docker 镜像（ENV 显式 `0.0.0.0:8899`）、显式传参的一切现有脚本 |
| 测试 | 默认值落在范围内且标记 random；控制台 ≠ 代理端口；显式 flag 覆盖随机；env 覆盖随机；多次启动端口不同 |

### 8.14 报文自带目标 + 换行规范化（2026-10-23，接入哨兵控制台时发现）

> 背景：接入「全链哨兵」后调用方变成 Agent，它通常**只丢一个数据包**过来，没有独立的
> scheme/host/port 字段；而 `/api/capture` 是驱动界面 textarea 填包再发送的，textarea
> 的 value 取值会把 CRLF 规范化成 LF（HTML 规范）。

| 项 | 结果 |
|---|---|
| 现象一 | 只给 `raw` 时 `/api/capture` 一直等到超时（界面上的目标字段空着），`/api/replay` 报 `bad_request`（origin-form 无从确定去处） |
| 现象二 | 纯 LF 报文经界面发出后丢掉 `\r`：Node 目标回 `400 Bad Request` + `HPE_INVALID_VERSION: Expected CRLF after version`，Go/Python 靶机容忍纯 LF，所以此前验收没暴露 |
| 目标推断 | 新增 `httpreplay.TargetFromRaw`：absolute-form / CONNECT 以请求行为准，origin-form 读 `Host` 头（带端口就用，443 → https，其余 → http）；`/api/replay` 与 `/api/capture` 在缺目标时都走它 |
| 换行规范化 | 前端 `sendReplay` 前置 `normalizePacketLineEndings`：整段没有任何 CR 时按 CRLF 发送；出现过 CR 一律原样，字节保真不打折 |
| 测试 | `TestTargetFromRaw` 表驱动 9 例（origin/absolute/CONNECT/裸 LF/大小写/IPv6/无 Host）；`TestReplayBadRequest` 拆成"既无 target 又无 Host → bad_request"与"只有 Host → 失败发生在连接阶段" |
| 实测 | 真容器（host 网络 + sentinel:latest）：只给 raw 的 `/api/replay` 200；纯 LF 只给 raw 的 `/api/capture` 200 + 1600×1000 PNG（目标侧确认收到合法 CRLF 请求）；host/port 无 scheme 也 200 |
