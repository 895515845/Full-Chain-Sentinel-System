# 社区插件中心设计（v0）

- 状态：M0–M4 已实现（索引订阅、自动拉取产物留待下一阶段）
- 日期：2026-10-17
- 范围：哨兵 Web 控制台 + `sentinel-web plugin-host` 子命令

## 1. 目标

1. 插件以 Docker 镜像交付，用户自行部署、按需启停。
2. 插件可以跑在用户自己的 VPS 上，本地控制台主动出站连接。
3. 不建中心化市场：插件包由作者在开源仓库发布，用户下载后上传安装。

v1 明确不做：代存镜像、账号体系、评分、自动更新、插件间通信、索引订阅。插件可以自带前端，但运行在沙箱 iframe 里，见 [plugin-ui.md](./plugin-ui.md)。

## 2. 前提：不需要反向隧道

「本地没有公网 IP」只影响从外网访问本地。本方案的数据流方向始终是控制台主动出站到 plugin-host，所以不需要 relay、frp 或 NAT 打洞。

需要写进插件规范的一点：插件跑在 VPS 上，它的网络出口就是 VPS 的出口。公网测绘类插件合适，内网扫描和本地抓包类插件必须标 `locality: local-only`，只能装在本地 host。

## 3. 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 云端角色 | 插件跑在用户自己的 VPS，控制台出站连接 |
| 2 | 插件边界 | 以工具/能力为主；可选的插件自带前端由控制台以沙箱 iframe 打开 |
| 3 | 权限模型 | 安装时用户选择：受限容器或 host 网络 |
| 4 | 市场形态 | 无中心，插件包由作者发布、用户上传安装 |
| 5 | 包内容 | manifest + Dockerfile + 构建上下文，安装时在 host 上本地构建 |
| 6 | host 部署 | 同一镜像，本地与 VPS 都能跑 |
| 7 | 产物 | 结果走 MCP，大文件走 artifacts 拉取接口 |
| 8 | 审批 | 不拦截，只审计；靠安装时同意 + 一键停用 |
| 9 | 与 Kali 的关系 | 互补，Kali 容器保持不动 |
| 10 | host 交付 | `sentinel-web plugin-host` 子命令 |

## 4. 架构

```
┌─────────────────────────┐   HTTP(S) + Bearer token   ┌──────────────────────────┐
│ 控制台 (sentinel-web)    │ ─────────────────────────▶ │ plugin-host (VPS 或本机)  │
│  - 插件中心页            │                            │  - 容器生命周期           │
│  - 虚拟 MCP 服务器        │ ◀───────────────────────── │  - 解包、构建与校验       │
│  - 审计 / 证据            │   MCP over HTTP            │  - 反代 /plugins/<id>/mcp │
└─────────────────────────┘                            │  - 健康检查 / 日志        │
                                                       └────────────┬─────────────┘
                                                                    │ docker
                                                       ┌────────────▼─────────────┐
                                                       │ sentinel-plugin-<id>     │
                                                       │ MCP server :7801         │
                                                       └──────────────────────────┘
```

插件容器只把端口发布到 `127.0.0.1` 的随机端口，控制台只连 host 的 `/plugins/<id>/mcp`，由 host 反代。这样一个 host 只暴露一个端口、一套鉴权，容器永远不会直接暴露在公网。

| 组件 | 职责 |
|---|---|
| 控制台 | 安装同意、启停、虚拟 MCP 服务器注册、工具调用审计、产物落盘 |
| plugin-host | Docker 操作、镜像校验、配置与密钥注入、健康检查、MCP 反代、日志 |
| 插件容器 | 实现 MCP server，暴露工具，把大文件写进 `/artifacts` |

## 5. 插件包

### 5.1 目录

```
my-plugin/
├── plugin.json
├── Dockerfile
├── .dockerignore
├── server.mjs
└── ui/                 # 可选

zip -r my-plugin.zip my-plugin/
```

### 5.2 plugin.json

```json
{
  "schema": 1,
  "id": "com.example.recon",
  "name": "侦察工具集",
  "version": "0.1.0",
  "description": "subfinder 子域名枚举与 naabu 端口扫描",
  "author": "github:someone",
  "source": "https://github.com/someone/sentinel-plugin-recon",
  "license": "MIT",
  "build": { "dockerfile": "Dockerfile", "context": "." },
  "mcp": {
    "transport": "http",
    "port": 7801,
    "path": "/mcp",
    "startupTimeoutMs": 20000,
    "requestTimeoutMs": 300000
  },
  "config": [
    { "key": "RATE_LIMIT", "label": "默认速率", "type": "number", "default": 1000, "required": false }
  ],
  "permissions": { "network": "bridge", "capAdd": [], "privileged": false },
  "locality": "any",
  "resources": { "cpus": 1, "memory": "1g", "pidsLimit": 256 },
  "healthcheck": { "path": "/healthz", "intervalMs": 10000, "timeoutMs": 3000, "retries": 3 },
  "artifacts": { "path": "/artifacts", "maxFileBytes": 52428800 },
  "tools": [
    { "name": "subfinder_enum", "description": "枚举子域名" },
    { "name": "naabu_scan", "description": "端口扫描" }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | int | 是 | 规范版本，当前为 1 |
| `id` | string | 是 | 反向域名，`^[a-z0-9]+(\.[a-z0-9-]+)+$` |
| `name` | string | 是 | 展示名，不超过 60 字符 |
| `version` | string | 是 | 语义化版本 |
| `description` | string | 是 | 不超过 400 字符 |
| `author` | string | 是 | `github:<handle>` |
| `source` | string | 是 | 源码仓库，纯开源项目不允许闭源镜像 |
| `license` | string | 是 | 许可证标识 |
| `build` | object | 是 | `dockerfile`、`context` 是插件包内的相对路径；`args` 可选，传给 `docker build --build-arg`；写 `image` 会被拒绝 |
| `mcp` | object | 是 | `transport` 只能是 `http`（streamable HTTP）；`port` 为容器内端口；`requestTimeoutMs` 为单次工具调用超时 |
| `config` | array | 否 | 配置项，控制台据此渲染表单 |
| `permissions` | object | 是 | `network`：`none`/`bridge`/`host` |
| `locality` | string | 是 | `local-only`/`remote-only`/`any` |
| `resources` | object | 否 | 被 host 策略封顶：cpus ≤ 2，memory ≤ 2g，pids ≤ 1024 |
| `healthcheck` | object | 否 | 缺省按 `/healthz` 检查 |
| `tools` | array | 否 | 仅用于安装前预览，运行时以 MCP 返回为准 |
| `ui` | object | 否 | 可选前端：`entry`（容器内 html 路径）、`title`、`protocol`（当前 1）、`sidebar`（作者建议的侧栏标签/图标，需操作员勾选） |

### 5.3 校验规则

- 安装包必须包含 `build.dockerfile` 与 `build.context`；host 解压后构建，构建失败不落记录。
- 安装必须显式同意「在插件主机上执行 Dockerfile 构建」；没有同意返回 403。
- `id` 在单个 host 内唯一；重复安装视为升级，需显式确认。
- `source` 必填，UI 上展示为「未验证」。
- `config.key` 必须匹配 `^[A-Z][A-Z0-9_]*$`，注入容器时加 `PLUGIN_` 前缀。
- 插件是 host 级、跨项目共享的，因此不挂载项目工作区。需要读项目文件的插件 v1 不支持。
- `network: none` 无法提供 MCP 端点，安装时直接拒绝。
- 只支持 streamable HTTP。`transport` 写 `stdio` 或 `sse` 会在校验时报错，由插件作者自行转换成 HTTP。
- `mcp.requestTimeoutMs` 是可选的单次调用超时，单位毫秒，范围 5000–1800000，默认 300000。MCP 客户端自己的默认超时是 60 秒，长任务插件必须显式调大。
- `capAdd` 只允许 `NET_RAW`、`NET_ADMIN`、`NET_BIND_SERVICE`、`SYS_PTRACE`。

### 5.4 官方插件

官方插件是随控制台发布的策展包，不走远程市场：

- 列表在插件页的「官方插件」tab，卡片展示名称、版本、工具、权限、包大小与源码；已安装的显示当前版本，版本不同时提示「更新到 vX」。
- 点安装打开与上传插件包相同的抽屉：选择主机、确认权限、勾选构建同意，然后由服务端直接用内置的 manifest 和 zip 安装，客户端不接触包体。
- 更新是手动的，不会自动重建容器；卸载/启停/配置与普通插件一致。
- 首批内置 MemShellParty 和 VShell 控制台；目录定义在 `packages/web/official-plugins.json`，`scripts/generate-official-plugins.mjs` 把目录打成 zip 并生成 `src/official-plugins.generated.ts`，随 `npm run build` 更新。离线控制台也能安装。

## 6. plugin-host

### 6.1 交付与启动

```sh
# 本地：只监听 127.0.0.1，随机端口，控制台自动发现
sentinel-web plugin-host --local

# VPS：放在 Caddy/nginx 的 HTTPS 反向代理后面
sentinel-web plugin-host --listen 0.0.0.0:7800

# VPS：也可以直接提供 HTTPS（证书需要被控制台信任）
sentinel-web plugin-host --listen 0.0.0.0:7800 --tls-cert /path/cert.pem --tls-key /path/key.pem
```

在仓库里本地调试时，不用先 build，直接跑 TypeScript 源码：

```sh
cd <仓库根目录>
npm run plugin-host -- --local                        # 默认数据目录 ~/.sentinel/plugin-host
npm run plugin-host -- --local --data-dir /tmp/sph-dev # 不污染本机配置
npm run plugin-host -- --help
```

等价的直接命令是 `node packages/web/src/index.ts plugin-host --local`；跑构建产物则用
`node packages/web/dist/index.js plugin-host --local`（需要先 `npm run build:web`）。

首次启动生成 token（`sph_` 前缀）并打印；之后每次启动复用，`--rotate-token` 才会换。本地模式把端口和 token 写进 `~/.sentinel/plugin-host/host.json`（0640），控制台读它自动发现，不用手填。数据目录可用 `--data-dir` 或 `SENTINEL_PLUGIN_HOST_DIR` 改。

```
~/.sentinel/plugin-host/
├── host.json                 # port、token、pid
└── plugins/
    └── com.example.recon/
        ├── manifest.json
        ├── record.json       # 安装元数据，不含密钥
        ├── config.json       # 0600，PLUGIN_* 值，API 永远不返回
        ├── data/             # 挂到 /data
        └── artifacts/        # 挂到 /artifacts
```

### 6.2 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活检查，不需要 token |
| GET | `/v1/host` | 版本、模式、Docker 状态、插件数 |
| GET | `/v1/plugins` | 列表、状态、健康、错误 |
| POST | `/v1/plugins` | 安装或升级 |
| DELETE | `/v1/plugins/{id}` | 卸载，`?purge=1` 同时删数据 |
| POST | `/v1/plugins/{id}/start` | 启动并等健康检查 |
| POST | `/v1/plugins/{id}/stop` | 停止 |
| PUT | `/v1/plugins/{id}/config` | 更新配置，密钥只写不读 |
| GET | `/v1/plugins/{id}/logs` | `?tail=200` |
| GET | `/v1/plugins/{id}/artifacts` | 列表，`?path=` 时下载 |
| ANY | `/plugins/{id}/mcp` | MCP 反代 |

安装请求：

```json
{
  "manifest": { "...": "完整 plugin.json" },
  "allowHostNetwork": false,
  "allowPrivileged": false,
  "config": { "RATE_LIMIT": "1000" }
}
```

`allowHostNetwork` 为 `false` 时，manifest 声明 `host` 网络直接 403，不做降级。`allowPrivileged` 同理。

### 6.3 容器约定

- 命名 `sentinel-plugin-<id 的点与下划线转横线>`，标签 `sentinel.plugin.id`、`sentinel.plugin.version`。
- `restart: unless-stopped`；重启次数超过 5 次后状态标为 `failed`（Docker 仍会按策略重启，需要人工停用）。
- 日志走 json-file，创建时设置 `max-size=10m`、`max-file=3`。
- 默认 `bridge`，端口发布到 `127.0.0.1::<容器端口>`，host 用 `docker port` 读回实际端口再反代。
- `host` 网络时必须 `allowHostNetwork=true`，UI 单独确认。
- 挂载固定两个：`/data` 持久化，`/artifacts` 产物。
- 容器内不挂 docker socket；`privileged` 默认禁止。
- 配置以 `PLUGIN_<KEY>` 环境变量注入，密钥不进 manifest、不进日志、不进审计参数。

### 6.4 鉴权与传输

- 本地模式：`http://127.0.0.1:<port>`，token 仍然校验，控制台自动读取。
- 远端模式：必须 HTTPS，且证书要受信任。可以用 `--tls-cert/--tls-key` 直接提供，也可以放在 Caddy/nginx 后面；纯 IP 的自签证书无法被控制台的 MCP 客户端接受，建议用域名 + Let's Encrypt。
- 本地模式不支持 HTTPS：控制台按 `http://127.0.0.1` 自动发现，回环上的明文没有暴露面。
- 明文 HTTP 只允许回环地址；控制台保存 host 时会拒绝其它 http 地址。
- token 轮换：`--rotate-token` 重启生效，旧 token 立即失效。

### 6.5 构建

- 不上传、不拉取镜像；host 解压插件包后执行 `docker build -f <dockerfile> -t sentinel-plugin/<id>:<version> <context>`。
- 构建上下文来自包内，路径不能越出插件目录；构建日志写到 `plugins/<id>/build.log`。
- 构建需要的基础镜像与依赖由 host 的 Docker 守护进程下载，第一次安装会慢一些。
- 升级重新构建并覆盖同名 tag；卸载时删除本地镜像；`purge` 同时删除解压目录。
- 构建按 host 架构进行；arm64 host 需要 Dockerfile 自身支持 arm64。

## 7. 控制台

### 7.1 页面

- 插件中心（设置 → 插件）：host 列表、已安装插件、启停、卸载、日志、产物、改配置。改配置会重建容器；密钥字段留空表示保持已保存的值。
- 插件界面（`ui`）：抽屉里的「打开界面」在全屏浮层中加载插件的 `/ui/`，iframe 走 `sandbox="allow-scripts"`，通过 postMessage 桥调用自己的工具、产物、配置与 storage。插件声明 `ui.sidebar` 后默认固定到左侧工作台组，操作员可在抽屉关掉；点开后在主内容区加载，插件停止时入口置灰。详见 [plugin-ui.md](./plugin-ui.md)。
- 安装：上传 `.zip` 插件包（含 `plugin.json`、Dockerfile 与构建上下文），读取 manifest、展示权限与构建配置；勾选同意后 host 解压并构建。
- 设置 → 插件主机：新增/编辑/测试/删除 host。

### 7.2 安装流程

1. 上传 zip，读取其中的 manifest，展示 name、version、author、source（标注「未验证」）。包根目录或一层子目录里有 `plugin.json`，同级必须有所声明的 Dockerfile 与上下文。
2. 展示权限差异：网络模式、capabilities、privileged、资源上限。
3. 展示构建配置（Dockerfile、上下文）与 `tools` 预览。
4. 用户选择受限 / host 网络，勾选 privileged（仅声明时出现），并勾选「允许在插件主机上执行 Dockerfile 构建」。
5. host 解压、`docker build`、起容器、等健康检查；失败时返回构建日志尾部。
6. 注册虚拟 MCP 服务器，默认启用，写入审计。

### 7.3 工具挂载

复用现有 MCP 客户端：每个插件注册成一个虚拟 MCP 服务器，名为 `plugin-<id 的非法字符换成横线>`，工具名沿用 `mcp__<server>__<tool>`，即 `mcp__plugin_com_example_recon__subfinder_enum`。UI 显示插件名，不显示这串名字。

插件工具受现有「权限 → MCP」总开关约束，没有另开一个开关：插件在实现上就是 MCP 服务器，两个总开关会让「MCP 关了但插件还能用」这种矛盾状态出现。插件中心在每个插件上另有独立开关，关掉即摘工具，不重启会话。

### 7.4 审计与审批

不拦截，只审计。护栏三条：

1. 安装同意文案必须写明「该插件的工具会被 Agent 在自动执行模式下直接调用，不经逐条审批」。
2. `host` 网络与 `privileged` 不允许默认勾选，必须单独一步确认。
3. 插件中心一键停用，立即从 Agent 上下文摘掉工具。

审计分两处：

- 工具调用：由现有会话审计链路覆盖，因为插件工具就是 MCP 工具（会话 JSONL 里有工具名、参数与结果）。
- 管理操作：安装、卸载、启停、开关、改配置、拉产物、增删 host 追加到配置目录的 `plugin-audit.jsonl`（0600，每行一个 JSON，超过 2MB 轮转一份）。配置变更只记 key，不记值。

### 7.5 产物

- 插件把文件写进 `/artifacts/<run-id>/`。
- 插件中心列出产物（路径倒序、每页 10 个、可筛选），操作员点「拉取到证据目录」后写入项目 `evidence/plugin/<host>/<plugin>/<相对路径>`，页面顶部显示保存后的路径。
- 单插件最多索引 2000 个产物文件，超过时列表会提示；更早的产物需要清理。
- 自动拉取（工具结果里的 `_meta.artifacts`）留给下一阶段：需要在 MCP 客户端拦截工具返回值，不做会影响现有会话证据链。
- 限额：单文件默认 50MB，host 侧校验，超出报错。

## 8. M1 验收：subfinder + naabu

示例在 `examples/plugins/recon`，一个镜像内装 subfinder 与 naabu，MCP server 暴露两个工具。

验收清单：

1. 本地 host 安装成功，健康检查通过。
2. 自动执行模式下 Agent 能直接调用 `subfinder_enum`，会话审计有完整记录。
3. 30 秒内的调用正常返回；2 分钟的长扫描期间请求保持打开，控制台 UI 不阻塞（示例插件暂未发送进度通知）。
4. 超过子进程超时返回部分结果，容器不残留。
5. `subfinder.txt` 落回 `evidence/plugin/<host>/com.sentinel.recon/`。
6. 停用后工具从 Agent 上下文消失。
7. VPS 上安装同一插件，本地控制台能连通并调用。
8. 容器崩溃后自动重启，重启次数超过 5 次时状态显示 `failed`，并给出最后错误。

## 9. 里程碑

| 阶段 | 交付物 | 状态 |
|---|---|---|
| M0 | manifest schema、host 最小实现、hello-world 插件 | 完成 |
| M1 | MCP 反代、安装/启停、工具挂载、权限开关、审计 | 完成 |
| M2 | token、host 列表、远端连接、超时与重连 | 完成（TLS 用受信任证书） |
| M3 | artifacts 拉取、配置与密钥、日志查看 | 完成 |
| M4 | 插件包上传安装、示例插件、作者文档 | 完成（索引订阅未做） |

## 10. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| host 网络插件等同宿主 root | 恶意插件可直接控制主机 | 默认受限、单独确认、一键停用；高危能力在 UI 标红 |
| plugin-host 持有 docker socket | host 自身就是 root | 只允许部署在用户控制的主机，不做共享服务 |
| 不拦截只审计 | 装错插件即裸奔 | 强制同意文案、默认关闭 MCP 总开关、审计可回溯 |
| 远端网络抖动 | 工具调用挂起 | 独立的超时与明确错误文案，不与本地工具共用重试 |
| 证据链断裂 | 报告缺证据 | 产物落 `evidence/plugin/`，UI 显式提示 |
| 无审核 | 劣质插件占满资源 | 资源封顶、健康检查、重启上限、插件数上限 32 |
| 分发渗透工具 | 合规风险 | 索引与 README 保留授权使用声明 |

## 11. 未决

1. 官方示例仓库的位置与命名，建议独立仓库 `sentinel-plugins`。
2. 多 host 下同名插件的展示与工具命名，当前后者跳过并报错，建议按 host 分组。
3. 升级与回滚保留几个旧镜像，建议保留上一版并支持一键回滚。
4. 卸载是否删除数据，当前默认保留，API 支持 `purge=1`。
5. arm64 支持：构建在 host 本地进行，Dockerfile 需要兼容 host 架构。
6. 镜像站前缀（`SENTINEL_PLUGIN_REGISTRY_MIRROR`）。
7. 自动拉取 `_meta.artifacts`。
