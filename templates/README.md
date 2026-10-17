# 插件前端模板

| 目录 | 说明 |
|---|---|
| `plugin-ui-vanilla` | 零构建：`index.html` + `sdk.js` + 原生 JS |
| `plugin-ui-react` | Vite + React，构建产物放进镜像的 `/ui/` |

两者契约相同：入口 HTML、相对路径、`sdk.js` 握手、`window.SentinelPlugin` API。
字段与安全边界见 [docs/plugin-ui.md](../docs/plugin-ui.md)。
