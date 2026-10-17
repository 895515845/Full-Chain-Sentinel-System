# 插件前端模板（vanilla）

零构建模板：`index.html` + `sdk.js` + `app.js` + `app.css`，直接放进插件镜像的 `/ui/`。

## 用法

1. 复制本目录到插件的 `ui/` 下，改 `app.js` 与 `app.css`。
2. 在 `plugin.json` 里声明：

```json
"ui": { "entry": "/ui/index.html", "title": "插件界面", "protocol": 1 }
```

3. 镜像里让 HTTP server 把 `/ui/*` 当静态文件返回。参考
   `examples/plugins/hello-world/server.mjs`。

## 约束

- 所有资源用相对路径（`./app.js`），最终会挂在控制台的 `/plugin-ui/<host>/<plugin>/` 下。
- 不要给自己加 `allow-same-origin` 的假设：页面是 opaque origin，不能读控制台 Cookie，也不能
  `fetch` 控制台接口。
- 只通过 `sdk.js` 的 API 拿数据；框架不限，换成 Vue/Svelte 也可以，只要能输出静态文件。
