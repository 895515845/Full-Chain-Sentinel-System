# replayd web

replayd 的 Web 前端（M0 骨架）：导航、布局与四个页面的空态，并通过 `/api/health` 展示后端状态。

技术栈：Vite 6 · React 19 · TypeScript 5（strict）· react-router-dom v7 · Tailwind CSS v4。

## 开发

```bash
cd web
pnpm install
pnpm dev
```

开发服务器运行在 <http://127.0.0.1:5173>，`/api`（含 WebSocket）代理到 `http://127.0.0.1:8899`。

## 类型检查与构建

```bash
cd web
pnpm typecheck   # tsc -b --force，strict
pnpm build       # tsc -b && vite build
```

构建产物输出到 `../internal/api/dist`（`index.html` 与 `assets/`），用于嵌入 Go 二进制。`emptyOutDir` 已开启，每次构建会清空该目录。

## 路由

| 路径 | 页面 |
| --- | --- |
| `/` | 重定向到 `/history` |
| `/history` | 抓包历史（空态） |
| `/repeater` | 请求重放（空态） |
| `/scripts` | 脚本钩子（空态） |
| `/settings` | 只读运行信息 |
| 其他 | 404 页 |

使用 BrowserRouter（非 hash 路由），后端静态服务需将未知路径回落到 `index.html`。
