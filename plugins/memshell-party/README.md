# MemShellParty 插件

把 [MemShellParty](https://github.com/ReaJason/MemShellParty)（Java 内存马生成器）接成哨兵插件。镜像是自包含的：Spring Boot 后端 + 一层零依赖 Node 适配器，对外只暴露一个 HTTP MCP 端点。

## 架构

```
Agent / 控制台 ──HTTP MCP──> :7801 适配器（server.mjs） ──REST──> :18080 MemShellParty
                                 ├─ /ui/  调用历史界面
                                 └─ /healthz
```

- `:18080` 只在容器内监听，不发布。
- `:7801` 是插件端口，暴露 `/mcp`、`/ui/`、`/healthz`。
- 上游未就绪时 `/healthz` 返回 503，插件主机等到它就绪才标记 running。

## 工具

| 工具 | 说明 |
|---|---|
| `list_servers` | 中间件 → 壳类型映射、打包器、shellTools、探测方式与探测项 |
| `generate_memshell` | 生成内存马：Godzilla/Behinder/Command/AntSword/Suo5/NeoreGeorg/Proxy/Custom |
| `generate_probe` | 生成探测马：DNSLog / Sleep / ResponseBody |
| `parse_class_name` | 解析 class 字节码类名，注入后排查用 |
| `list_calls` | 最近的生成记录，供调用历史界面使用 |

生成结果会写到 `/artifacts/<run-id>/`：`result.json` 是上游原始响应，每个打包器另存一个 `.txt`。载荷超过 `MAX_INLINE_CHARS`（默认 20000 字符）时工具只返回摘要和产物路径，不把几万字符塞进模型上下文。

## 调用历史界面

`plugin.json` 里声明了 `ui.entry = /ui/index.html`。安装后在插件抽屉点「打开界面」：

- 列出最近 200 次调用，每页 10 条，可按路径/工具翻页；点行在弹层里看参数与产物，不用滚到页面底部
- 点任意一行查看参数（密码/密钥/class 字节码显示为 `***`）与产物路径
- 每 5 秒自动刷新；数据来自适配器写入的 `/data/history.json`

## 打包与安装

插件主机在安装时用包里的 Dockerfile 构建，不需要推镜像：

```sh
cd plugins/memshell-party
zip -r memshell-party.zip .
# 控制台 → 设置 → 插件 → 上传插件包
# 勾选「允许在插件主机上执行 Dockerfile 构建」
```

构建需要下载约 72MB 的 `boot-2.10.0.jar`，第一次安装会慢一些。国内网络可以在
`plugin.json` 的 `build.args` 里覆盖镜像源，例如：

```json
"build": {
  "dockerfile": "Dockerfile",
  "context": ".",
  "args": {
    "APK_MIRROR": "mirrors.tuna.tsinghua.edu.cn",
    "JAR_URL": "https://ghfast.top/https://github.com/ReaJason/MemShellParty/releases/download/v2.10.0/boot-2.10.0.jar"
  }
}
```

`APK_MIRROR` 只影响构建时安装 JRE 的 Alpine 源，运行镜像里没有额外依赖。

`Dockerfile.offline` 是给本机 `docker build` 用的离线构建文件（需要先放
`download/boot.jar`）。它不适合走插件页上传：插件包上限 8MB，装不下 72MB 的 jar。
`download/` 已在 `.gitignore` 里，不要把 jar 提交进仓库。

## 本地调试

适配器可以脱离 Docker 跑，只要有一个 MemShellParty 实例或一个假上游：

```sh
MSP_URL=http://127.0.0.1:18080 \
PLUGIN_ARTIFACTS_DIR=/tmp/msp-artifacts \
PLUGIN_DATA_DIR=/tmp/msp-data \
PORT=17801 node server.mjs

curl -s http://127.0.0.1:17801/healthz
curl -s http://127.0.0.1:17801/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 授权声明

内存马属于攻击载荷。本插件仅限**已获得授权**的渗透测试、红队评估与安全研究使用。未经授权对他人系统使用可能构成违法；使用前请确认目标在授权范围内。
