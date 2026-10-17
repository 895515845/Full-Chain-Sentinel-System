# 插件示例

| 目录 | 作用 | 验证的能力 |
|---|---|---|
| `hello-world` | 最小 MCP server（Node，无依赖） | 安装、健康检查、工具挂载、产物回传 |
| `recon` | subfinder + naabu 包装（Python） | 长任务、大输出截断、`NET_RAW` capability、产物回传 |

两个示例都是源码包：`zip -r <name>.zip <dir>/` 后在插件页上传，由插件主机本地构建。
上传前把 `plugin.json` 的 `source` 改成真实仓库地址。

整体约定见 [docs/plugin-center.md](../../docs/plugin-center.md)，作者步骤见
[docs/plugin-authoring.md](../../docs/plugin-authoring.md)。
