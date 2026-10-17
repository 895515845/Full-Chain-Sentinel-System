# 插件前端模板（React + Vite）

构建产物放进插件镜像的 `/ui/`。

## 用法

```sh
npm install
npm run build     # 输出 dist/，把 dist 的内容拷进镜像的 /ui/
```

```dockerfile
COPY dist /ui
```

`plugin.json` 声明：

```json
"ui": { "entry": "/ui/index.html", "title": "插件界面", "protocol": 1 }
```

## 关键约束

- `vite.config.ts` 里的 `base: "./"` 不能去掉：页面挂在 `/plugin-ui/<host>/<plugin>/` 下，
  绝对路径的资源会 404。
- `sdk.js` 被 `main.tsx` 直接 import，打包进 bundle；它只依赖 postMessage，不需要额外配置。
- 不要假设同源：iframe 是 `sandbox="allow-scripts"` 的 opaque origin，不能读控制台 Cookie，
  也不能直接 fetch 控制台接口。所有数据走 `window.SentinelPlugin`。
