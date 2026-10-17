# Hello World 插件

最小可运行插件，用来验证三件事：安装与健康检查、MCP 工具挂载、产物回传。

## 打包与安装

插件主机在安装时用包里的 Dockerfile 构建，不需要推镜像：

```sh
# 可选：先在本地确认 Dockerfile 能过
docker build -t sentinel-plugin-hello:0.1.0 .

cd ..
zip -r hello-world.zip hello-world/
```

控制台「设置 → 插件 → 上传插件包」选择 zip，勾选「允许在插件主机上执行 Dockerfile 构建」。
同时把 `plugin.json` 的 `source` 改成真实仓库地址。

## 本地起服务（不经过 Docker）

```sh
PLUGIN_ARTIFACTS_DIR=/tmp/hello-artifacts node server.mjs
curl http://127.0.0.1:7801/healthz
```

工具调用示例：

```sh
curl -s http://127.0.0.1:7801/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello_echo","arguments":{"text":"hi"}}}'
```

## 安装

1. 启动插件主机：`sentinel-web plugin-host --local`。
2. 控制台「设置 → 插件 → 安装」，填本目录路径。
3. 安装前会显示 manifest 与权限；这个插件只要 bridge 网络。

产物会出现在插件主机的 `~/.sentinel/plugin-host/plugins/com.sentinel.hello-world/artifacts/`，
在插件页点「产物」可以拉回当前项目的 `evidence/plugin/` 下。
