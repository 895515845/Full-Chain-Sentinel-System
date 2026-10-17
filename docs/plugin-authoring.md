# 插件作者指南

一个插件是一个 zip 包：`plugin.json` + `Dockerfile` + 构建上下文。安装时插件主机解压、执行 `docker build`、起容器，控制台把它的工具挂给 Agent。不需要镜像仓库，也不需要 digest。

## 最小结构

```
my-plugin/
├── plugin.json
├── Dockerfile
├── .dockerignore
├── server.mjs
└── ui/               # 可选前端
```

打包上传：

```sh
zip -r my-plugin.zip my-plugin/
```

`plugin.json` 的字段与校验规则见 [plugin-center.md](./plugin-center.md#5-插件包)。三条硬性要求：

1. `build.dockerfile` 和 `build.context` 指向包内的 Dockerfile 与上下文，不能越出插件目录。
2. `source` 指向公开仓库。本项目只分发开源插件。
3. 容器监听 `0.0.0.0:<mcp.port>`，`healthcheck.path` 返回 2xx 才算启动成功。

## MCP server 要求

- 传输：只支持 streamable HTTP（`transport: "http"`），POST 到 `mcp.path`。stdio 和 SSE 需要自己转换成 HTTP 再打包；写 `stdio`/`sse` 会在安装校验时被拒绝。
- 允许用普通 JSON 响应，不必强制 SSE。需要进度通知时再返回 `text/event-stream`。
- 必须实现 `initialize`、`tools/list`、`tools/call`。`ping` 建议实现。
- 工具名只用字母、数字、下划线和短横线。
- 每个工具都应有 `description` 与 `inputSchema`。模型靠它决定调不调用。
- 单次调用的超时由 `mcp.requestTimeoutMs` 决定（毫秒，5 秒–30 分钟，默认 5 分钟）。长任务要显式调大，否则会被 MCP 客户端切断。

可以直接抄 `examples/plugins/hello-world/server.mjs`（Node，无依赖）或
`examples/plugins/recon/server.py`（Python，包一层 CLI）作为起点。

## 插件界面（可选）

插件可以在镜像里带一个前端，由控制台以沙箱 iframe 打开：

```json
"ui": { "entry": "/ui/index.html", "title": "侦察面板", "protocol": 1 }
```

静态文件放在镜像的 `/ui/`，用相对路径互相引用。视觉基线用 `templates/plugin-ui-shared/base.css`
（复制成 `ui/base.css`，`pui-*` class）；不要自己另写一套 `:root` 颜色。HTTP server 需要把 `/ui/*` 当静态文件返回，
参考 `examples/plugins/hello-world/server.mjs`。

页面里引入同目录的 `sdk.js`，然后：

```js
const ui = await SentinelPlugin.connect();
ui.context;                        // 插件、host、项目、工具、已配置的键
await ui.callTool("subfinder_enum", { domain: "example.com" });
await ui.listArtifacts();
await ui.saveConfig({ DEFAULT_RATE: "1000" });
await ui.storage.set("lastDomain", "example.com");
```

约束：

- iframe 是 `sandbox="allow-scripts"` 的 opaque origin：不能读控制台 Cookie/DOM，不能直接 fetch 控制台接口，所有数据走 SDK。
- 页面资源必须用相对路径，最终前缀是 `/plugin-ui/<hostId>/<pluginId>/`。
- 单个产物读取上限 1MB；更大的文件让操作员在插件页下载。
- `ui.protocol` 当前只支持 `1`；`network: true` 会被拒绝（外网请求应由插件容器发起）。
- 模板：`templates/plugin-ui-vanilla`（零构建）与 `templates/plugin-ui-react`（Vite）。
  完整说明见 [plugin-ui.md](./plugin-ui.md)。

## 构建与安装

不需要推仓库。插件主机会用上传包里的 Dockerfile 构建：

```sh
cd my-plugin
docker build -t sentinel-plugin-local .   # 先在本地确认 Dockerfile 能过
cd ..
zip -r my-plugin.zip my-plugin/
```

控制台「设置 → 插件 → 上传插件包」选择 zip，确认权限，勾选「允许在插件主机上执行 Dockerfile
构建」，安装。构建需要的基础镜像和依赖都在主机上下载，第一次会慢一些；失败时看构建日志。

- 构建标签由主机生成：`sentinel-plugin/<id>:<version>`。
- Dockerfile 可以 `RUN` 任意命令，这是构建的固有权限；插件页会在安装前明确征得同意。
- 写 `image` 字段会被拒绝，包只从上传的上下文构建。
- 需要在构建时换镜像源/传参数，用 `build.args`（键是 `[A-Z][A-Z0-9_]*`，最多 16 项），host 会转成 `--build-arg`。

### 镜像源（强制）

所有镜像源必须使用中国大陆可访问的源，不得依赖 Docker Hub、npmjs、pypi.org 等直连：

| 用途 | 推荐 |
|---|---|
| Docker 基础镜像 | `docker.1ms.run/library/...` 或 `ghcr.nju.edu.cn/...` |
| Alpine apk | `mirrors.tuna.tsinghua.edu.cn` |
| npm | `registry.npmmirror.com` |
| pip | `pypi.tuna.tsinghua.edu.cn/simple` |
| Go module | `goproxy.cn` |
| Maven | `maven.aliyun.com/repository/public` |

Dockerfile 里显式写镜像源，或者在 `build.args` 里传进去；`Dockerfile` 的默认值也要是大陆源，不能只在 CI 里覆盖。

## 本地调试

镜像发布前，可以绕过插件主机直接跑 server：

```sh
PLUGIN_ARTIFACTS_DIR=/tmp/artifacts PORT=7801 node server.mjs
curl http://127.0.0.1:7801/healthz
curl -s http://127.0.0.1:7801/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

发布后，在仓库根目录起一个本地 host：

```sh
npm run plugin-host -- --local
# 想用独立数据目录，避免污染 ~/.sentinel：
npm run plugin-host -- --local --data-dir /tmp/sph-dev
```

控制台会自动发现它。然后在「设置 → 插件」上传 `my-plugin.zip`，安装前会展示 manifest、构建配置与
声明的权限。zip 的根目录或一层子目录里有 `plugin.json`，且同级有 Dockerfile 与构建上下文。

跑构建产物而不是源码时用 `node packages/web/dist/index.js plugin-host --local`（先 `npm run build:web`）。

## 配置与密钥

`config` 里的字段会以 `PLUGIN_<KEY>` 环境变量注入容器。`type: "secret"` 的值只存在宿主机的 `config.json`（0600），API 永远不返回，也不会进审计参数。

- 必填字段在安装时校验，缺了会拒绝安装。
- 改配置会重建容器（环境变量是创建时固定的），数据目录保留。
- 不要把密钥写进镜像、日志或工具返回值。

## 产物

大输出写文件，不要塞进 MCP 返回：

```text
/artifacts/<run-id>/result.txt
```

工具结果里用 `_meta.artifacts` 声明相对路径：

```json
{
  "content": [{ "type": "text", "text": "扫描完成，共 42 条" }],
  "_meta": { "artifacts": ["run-20261017-162000/result.txt"] }
}
```

操作员在插件页可以把产物拉进当前项目的 `evidence/plugin/`。单文件超过 `artifacts.maxFileBytes` 会被 host 拒绝。

控制台按路径倒序、每页 10 个展示，单插件最多索引 2000 个文件；产物不要无限堆积，按 run 定期清理。

## 权限声明

| 字段 | 说明 |
|---|---|
| `network: bridge` | 默认，能出网，不能被外部直接访问 |
| `network: host` | 与宿主机共享网络栈，安装时必须单独确认 |
| `capAdd` | 只允许 `NET_RAW`、`NET_ADMIN`、`NET_BIND_SERVICE`、`SYS_PTRACE` |
| `privileged: true` | 等价于宿主机 root，安装时单独确认，强烈不建议 |

能力要按实际需要声明，不要为了省事全开。安装页会把声明的权限原样展示给操作员。

## locality

- `any`：本地和 VPS 都能装。
- `local-only`：需要操作员的本地网络视角（扫内网、抓本地流量），装到远端 host 会被拒绝。
- `remote-only`：需要公网出口或固定公网地址，装到本地 host 会被拒绝。

装错位置不会报运行时错误，而是在安装时直接拒绝，所以这个字段要填对。

## 发布检查清单

- [ ] `plugin.json` 通过校验（控制台安装时的报错会列全）
- [ ] Dockerfile 在本机能 `docker build` 成功，容器监听 `0.0.0.0`
- [ ] zip 里的 Dockerfile 与 `build.context` 路径和 manifest 一致
- [ ] `/healthz` 在容器启动后 20 秒内可用
- [ ] 工具描述能让模型看懂什么时候调用
- [ ] 密钥走 `config`，没有硬编码
- [ ] 大输出写 `/artifacts`，返回值只有摘要
- [ ] README 写清权限需求与网络出口
