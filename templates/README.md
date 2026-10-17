# 插件前端模板

| 目录 | 说明 |
|---|---|
| `plugin-ui-vanilla` | 零构建：`index.html` + `sdk.js` + 原生 JS |
| `plugin-ui-react` | Vite + React，构建产物放进镜像的 `/ui/` |

两者契约相同：入口 HTML、相对路径、`sdk.js` 握手、`window.SentinelPlugin` API。
字段与安全边界见 [docs/plugin-ui.md](../docs/plugin-ui.md)。

## 插件界面基础样式

`plugin-ui-shared/base.css` 是插件界面的视觉基线（`pui-*` class）。复制到插件的 `ui/base.css`，
在入口页里用相对路径引入。两个模板和两个示例插件都使用它；不要再另写一套 `:root` 颜色。
