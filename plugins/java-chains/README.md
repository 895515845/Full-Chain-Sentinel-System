# Java Chains MCP 插件（Phase 1）

把 [Java Chains](https://github.com/vulhub/java-chains) CLI 的 payload 生成能力接成哨兵插件，并提供轻量生成台。

## 架构

```
Agent / 插件界面 ──streamable HTTP MCP──> :7801（Go adapter）
                                             │  java -jar java-chains-cli.jar
                                             ▼
                                   本地 CLI（离线生成）
                                             │ 可选
                                             ▼
                                   远端 Java Chains API（inventory / services）
```

- 不启动 Java Chains 的 8011 Web 和 8 个协议端口；需要完整平台时用第二个插件。
- CLI jar 使用 v2.0.0-beta7（190MB），构建时下载；可用 `CHAINS_CLI_URL` 换镜像源。
- 生成的 payload 写入 `/artifacts`，在插件详情或「产物」区取。
- preset 优先走远端；如果远端 generate 权限不可用，会用远端 preset 元数据展开成本地自由链再生成。

## 配置

| key | 说明 |
|---|---|
| `CHAINS_SERVER` | 可选，远端 Java Chains 地址，如 `http://1.2.3.4:8011` |
| `CHAINS_API_TOKEN` | 远端 API token（secret） |
| `CHAINS_EXECUTION` | `local` / `remote` / `auto`，默认 `local` |
| `CHAINS_TIMEOUT` | 单次 CLI 超时秒数，默认 120 |

远端 token 需要相应 scope：inventory 读取、preset 生成、services 需要 `runtime:read` / `runtime:control`。没有 scope 时工具会返回明确错误。

## 能力矩阵

| 能力 | 状态 | 说明 |
|---|---|---|
| `catalog` / `describe` / `chain next` / `chain validate` / `presets match` | 远程可用 | 通过 `chains_exec` 或对应工具 |
| `generate` / `generate preset` | 远程 + 本地 | 本地用 CLI jar；远程需要 `generate` scope |
| `ai bootstrap` | 远程 + 本地 | 清单、preset、guide |
| `services list/get` | 可用 | 需要 `runtime:read` |
| `services start/stop/restart` | 可用 | 需要 `runtime:control`；工具要求 `confirm=true`，start/restart 必须带 `request.advertisedHost` |
| `jobs submit/list/get` | 未验证 | 通过 `chains_exec`；`submit` 需要 `generate` + `runtime:publish` |

> 当前 8 个工具里没有单独的 jobs 工具；`jobs` 属于高级逃生口，用 `chains_exec` 传 `["jobs", ...]`。没有对应 scope 时 CLI 会返回 `SCOPE_FORBIDDEN`，插件会原样显示。

### Scope 对照

- `catalog` / `describe` / `presets`：读 scope
- `generate` / `generate preset`：`generate`
- `services list/get`：`runtime:read`
- `services start/stop/restart`：`runtime:control`；start/restart 必须提供 `request.advertisedHost`（目标可达地址），端口默认取服务配置
- `jobs submit`：`generate` + `runtime:publish`
- `jobs list/get`：`runtime:read`（以服务端实现为准）

## 工具

1. `list_calls` — 最近 200 条工具调用历史
2. `chains_guide` — CLI 的 AI 用法契约
3. `chains_inventory` — payload / gadget / preset 清单
4. `chains_describe` — 查单个节点定义
5. `chains_generate` — 自由链生成
6. `chains_generate_preset` — 按 preset 生成（支持远端元数据 + 本地回退）
7. `chains_validate_chain` — 校验链连通性
8. `chains_exec` — CLI 透传（高级逃生口）
9. `chains_services` — 远端服务 list/get/start/stop/restart；启停必须 `confirm=true`

## 前端

插件页只做**使用历史**，和 MemShellParty 一致：

- 最近 200 条 MCP 工具调用
- 时间、工具、目标、成功/失败、耗时、结果大小、产物数
- 每页 10 条，点击行查看参数、结果、错误和产物路径
- 自动刷新
- 参数里的 token / password / secret 显示为 `***`

生成、清单、服务管理仍作为 MCP 工具提供给 Agent，不在插件页做表单。

## 构建

```sh
docker build -t sentinel-plugin-java-chains:0.1.0 .
```

Dockerfile 从 `gh-proxy.com` 下载 CLI；构建参数 `CHAINS_CLI_URL` 可换成可达镜像。基础镜像走 `docker.1ms.run`。

## 安全

Java Chains 是 Java payload 生成平台。仅限已获得书面授权的安全测试、红队评估和安全研究。`chains_exec` 可以执行任意 CLI 子命令，`chains_services` 可以启停远端协议服务；这两个工具按操作员确认和审计要求使用。

## 后续

Phase 2 是独立的 `com.sentinel.java-chains-platform`：host 网络、8011 Web、8 个协议端口、`chains-config` 持久化。两条路线分开，避免只想生成 payload 的用户被迫暴露公网端口。
