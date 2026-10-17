# 插件示例

| 目录 | 作用 | 验证的能力 |
|---|---|---|
| `hello-world` | 最小 MCP server（Node，无依赖） | 安装、健康检查、工具挂载、产物回传 |
| `recon` | subfinder + naabu 包装（Python） | 长任务、大输出截断、`NET_RAW` capability、产物回传 |

两个示例的 `plugin.json` 里 `image` 都是占位 digest。发布镜像后替换成
`docker inspect --format '{{index .RepoDigests 0}}' <镜像>` 的输出，否则插件主机会在
digest 校验这一步拒绝安装。

整体约定见 [docs/plugin-center.md](../../docs/plugin-center.md)，作者步骤见
[docs/plugin-authoring.md](../../docs/plugin-authoring.md)。
