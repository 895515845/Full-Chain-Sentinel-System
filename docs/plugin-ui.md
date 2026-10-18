# 插件前端界面设计（v0）

- 状态：U0–U3 已实现（v1 只要声明 `ui` 即可使用全部桥方法）
- 日期：2026-10-17
- 范围：`packages/web`（控制台 + 插件主机）、插件镜像内的 `/ui/`、官方模板

## 1. 已定决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 打开方式 | 默认全屏浮层，从插件抽屉的「打开界面」进入；声明 `ui.sidebar` 并被操作员固定后，也可从左侧工作台以整页打开 |
| 2 | 能力范围 | 完整：context、artifact.read、tool.call、config.write、storage |
| 3 | 资源位置 | 插件镜像内的 `/ui/`，与本地构建的插件版本同源 |
| 4 | 模板约束 | 固定入口与 SDK 协议，框架不限；官方提供 vanilla 与 React 两个模板 |
| 5 | 外网访问 | 默认禁止；iframe 内不能直接 fetch 外网 |

## 2. 为什么用沙箱 iframe

插件前端是第三方 JS。把它挂进控制台的 React 树，等于让它拿到控制台的 Cookie、DOM 和内部 API，可以冒充登录页、读会话令牌、以操作员身份发请求。

因此：

- iframe 的 `sandbox` 只有 `allow-scripts`，**永远不加 `allow-same-origin`**。
- 不给 `allow-forms`、`allow-popups`、`allow-top-navigation`。
- iframe 内是 opaque origin，读不到控制台存储，也不能带凭据调用 `/api`。
- 所有数据走 postMessage 桥，由控制台校验、审计后转发。

## 3. 架构

```
控制台 https://console/
  └─ iframe sandbox="allow-scripts"
       src="https://console/plugin-ui/<token>/<hostId>/<pluginId>/<ui.entry>#nonce=..."
              │
              ├─ 控制台静态反代（带控制台会话）
              │     └─ plugin-host GET /plugins/<id>/ui/*
              │           └─ 插件容器 /ui/*
              │
              └─ postMessage ⇄ 控制台桥
                    └─ plugin-host /v1/...（artifacts/config/storage/tool call）
```

第三个原因：iframe 是 opaque origin，浏览器不会随它的 `<script>` / `<link>` 请求发送控制台的 gate
与登录 cookie。控制台在已登录的 WebSocket 上收到 `plugin_ui_open` 后签发一个 12 小时有效的随机
token，放进 iframe 路径；静态资源请求靠这个 token 通过校验，不依赖 cookie。插件不需要处理它。

两个必须由控制台反代的原因：

1. 控制台默认 HTTPS，本地 host 是 `http://127.0.0.1:<port>`。直接 iframe 会被浏览器按 mixed content 拦截。
2. 统一路径后，插件资源不依赖 host 的地址与证书，远端和本地行为一致。

## 4. manifest 契约

`plugin.json` 新增可选块：

```json
"ui": {
  "entry": "/ui/index.html",
  "title": "侦察面板",
  "protocol": 1,
  "sidebar": { "label": "侦察", "icon": "/ui/icon.svg" }
}
```

浮层由控制台负责标题、版本、连接状态（连接中/已连接/未连接）、重载和关闭；12 秒内没有收到 SDK 握手会显示错误与「重试」。插件未运行时「打开界面」不可用。

`ui.sidebar` 是作者声明：声明后**默认显示**在左侧工作台组；操作员可以在插件抽屉的「界面」里关掉，关掉的选择按 `hostId+pluginId` 记在控制台。侧栏条目在主内容区打开同一个沙箱界面（不是浮层），仍然使用同一次 `plugin_ui_open` 签发的 token；插件停止时条目置灰，卸载时消失。

v1 不再细分 `ui.permissions`：插件一旦声明界面，就获得 `context`、`artifact.read`、`tool.call`、`config.write`、`storage` 五类方法。`network` 显式写 `true` 会被校验拒绝。

规则：

- `entry` 必须是容器内的绝对路径，以 `.html` 结尾；其余资源相对 `entry` 所在目录。控制台会保留 `/ui/` 之后的完整路径，例如 `/ui/panel/index.html` 会代理到 `/plugins/<id>/ui/panel/index.html`，`./app.js` 也在 `panel/` 下解析。
- `protocol` 当前为 1；控制台只接受认识的值。
- `ui.sidebar` 可写成 `true`（使用默认标签）或 `{ "label": "...", "icon": "/ui/icon.svg" }`；`label` 缺省回退到 `ui.title` / 插件名，`icon` 必须是 `/ui/` 下平铺的 `.svg` 或 `.png`，缺省用通用插件图标。
- 不声明 `ui` 的插件没有「打开界面」入口，也没有侧栏开关。
- v1 不允许 `network` / 自定义 `sandbox`；需要外网时由插件容器自己请求，再把结果通过工具或产物交给 UI。

## 4.1 官方基础样式

插件界面运行在 `sandbox="allow-scripts"` 的 opaque origin 里，拿不到控制台的全局 CSS。为了避免每个插件各写一套字体、颜色和间距，官方提供一份基线样式：

- 位置：`templates/plugin-ui-shared/base.css`
- 用法：复制到插件的 `/ui/base.css`，在入口页里 `<link rel="stylesheet" href="./base.css" />`
- 组件：`pui-page`、`pui-bar`、`pui-card`、`pui-table`、`pui-btn`、`pui-field`、`pui-input`、`pui-pill`、`pui-output`、`pui-empty` 等
- 页面只放业务内容，不要再定义一套 `:root` 颜色；需要覆盖时写在 `app.css`，按页面加载顺序放在 `base.css` 之后

`hello-world`、`memshell-party` 和两个官方模板都已使用这份基线。控制台的浮层负责标题、连接状态、重载和关闭；插件页面从工具栏开始，不要重复大标题。

## 4.2 侧栏入口

`ui.sidebar` 是作者建议，不是自动入口：

```json
"sidebar": {
  "label": "侦察",
  "icon": "/ui/icon.svg"
}
```

- 声明后默认出现；操作员在插件抽屉的「界面 → 显示在侧边栏」关掉时记录一条隐藏，存在控制台的 `plugins.json`，按 `hostId+pluginId` 记录，跨项目生效。
- 入口放在左侧「工作台」组，和对话、项目、工程同级；标签取 `label`，缺省依次回退 `ui.title`、插件名。
- `icon` 必须是 `/ui/` 下平铺的 `.svg` 或 `.png`，由控制台用登录会话反代；缺省或插件未运行时使用通用插件图标。
- 插件未运行时入口置灰，不能点；卸载后入口消失。再次安装如果 manifest 仍声明 `ui.sidebar`，之前的固定选择会恢复。
- 点开后在主内容区以同一个 sandbox iframe 打开；token、握手、桥方法与浮层完全一致，只是没有关闭按钮和全屏遮罩。

## 5. 资源与代理

### 5.1 插件容器

静态文件放在镜像的 `/ui/`：

```
/ui/index.html
/ui/sdk.js
/ui/app.js
/ui/app.css
```

普通静态文件服务即可，不需要认识 MCP。模板要求所有引用使用相对路径（`./app.js`），因为最终前缀是 `/plugin-ui/<hostId>/<pluginId>/`。

### 5.2 plugin-host

新增：

```
GET /plugins/<id>/ui/<path>     → 容器 <ui base>/<path>
```

- 只允许 GET/HEAD，`path` 做穿越校验。
- 按扩展名返回 `content-type`；未知类型 `application/octet-stream`。
- 大小上限 20MB；`cache-control: no-store`。
- 不经过 MCP 反代，不复用 `/plugins/<id>/mcp` 的路径规则。

### 5.3 控制台

新增：

```
GET /plugin-ui/<hostId>/<pluginId>/<path>   需要控制台会话
```

- 读取 host token，转发到 host 的 `/plugins/<id>/ui/<path>`；token 不到达 iframe。
- 响应头：`access-control-allow-origin: *`（模块脚本从 opaque origin 加载需要 CORS）、`x-content-type-options: nosniff`、`cache-control: no-store`。
- 路径穿越与 host/plugin 存在性校验在控制台和 host 各做一次。
- 不缓存到磁盘；UI 随镜像版本更新。

## 6. SDK 与桥

### 6.1 握手

控制台生成一次性 nonce，放在 iframe URL 的 fragment 里（fragment 不会发给服务器）：

```js
const ui = await SentinelPlugin.connect();
```

消息序列：

```
iframe → parent  { kind: "sentinel-ui:hello", protocol: 1, nonce, pluginId }
parent → iframe  { kind: "sentinel-ui:init", context }
iframe → parent  { kind: "sentinel-ui:call", id, method, params }
parent → iframe  { kind: "sentinel-ui:result", id, ok, result? , error? }
```

控制台校验：

- `event.source === iframe.contentWindow`
- `nonce` 匹配本次打开
- `pluginId` 与路由一致
- `method` 在允许列表内，且 manifest 声明了对应能力

### 6.2 方法

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `context` | 握手时随 `init` 下发 | 插件 id/版本、host、项目名、配置键、工具预览 | 始终允许 |
| `artifact.list` | — | `[{path,size}]` | 只列本插件产物 |
| `artifact.read` | `{path, encoding}` | 文本或 base64 | 单文件上限 1MB，超过报错 |
| `tool.call` | `{name, arguments}` | MCP `content` + `_meta` | 只能调本插件工具 |
| `config.get` | — | 非密钥值 | 密钥只出现在 `context.configKeys` |
| `config.save` | `{values}` | 新的配置键列表 | 非密钥；密钥只写不读 |
| `storage.get` | `{key}` | 字符串或 null | 插件级命名空间 |
| `storage.set` | `{key, value}` | ok | ≤32KB/值，≤64 键 |
| `storage.delete` | `{key}` | ok | — |

限制：

- 每个 iframe 同时最多 4 个未完成调用；超时 5 分钟。
- `tool.call` 使用 manifest 的 `mcp.requestTimeoutMs`。
- 错误统一返回 `{ ok: false, error }`，不把 host token 或堆栈带进 iframe。

### 6.3 tool.call 的实现位置

控制台的插件 UI 不一定有活动会话，所以不经过会话里的 MCP 客户端。plugin-host 新增：

```
POST /v1/plugins/<id>/call
body: { "name": "<tool>", "arguments": { ... } }
```

host 用 host token 保护，向容器 `/mcp` 发 `initialize` + `tools/call`，解析 JSON 或 SSE 响应，返回 `content` 与 `_meta`。这样 MCP 报文只在一个地方解析，控制台只转发。

## 7. 存储

插件 UI 的 key-value 存在 host：

```
~/.sentinel/plugin-host/plugins/<id>/ui-storage.json   0600
```

- 每个插件独立命名空间，卸载时默认保留，`purge` 时删除。
- 总大小 256KB，单值 32KB，键数 64；超出报错。
- 只有该插件的 UI 能读写，控制台设置页也能看到键名（不显示值）。

## 8. 安全清单

1. iframe 永远 `sandbox="allow-scripts"`，代码里禁止出现 `allow-same-origin`。
2. 反代只提供静态文件，不转发 `/api`、不注入 Cookie。
3. UI 资源响应带 `nosniff`、`no-store`、`ACAO: *`。
4. iframe 外层始终保留控制台自己的栏：插件名、id、host、关闭；防止插件画假登录页。
5. 桥的每个方法按 manifest 能力放行；未声明即拒绝。
6. `tool.call`、`config.save`、`artifact.read`、打开界面都写审计。
7. 首次打开界面时显示一次性提示：界面由第三方插件提供，不要在其中输入控制台密码。
8. UI 代码不能读宿主机 token、不能读控制台会话、不能读其他插件的数据。

## 9. 模板

两个官方模板，契约相同：

```
templates/plugin-ui-vanilla/
  index.html      # 引 ./sdk.js 与 ./app.js
  sdk.js
  app.js
  app.css
  README.md

templates/plugin-ui-react/
  index.html
  src/main.tsx
  vite.config.ts  # base: "./"
  README.md
```

固定的是：入口文件、`sdk.js` 握手、postMessage 协议、相对路径、能力声明。框架不限。

`examples/plugins/hello-world` 增加一个最小界面：显示插件的工具、调用 `hello_echo`、列出产物。

## 10. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| U0 | manifest `ui` 校验、host 静态代理、控制台反代、沙箱 iframe 浮层、SDK 握手、hello-world 界面 | 完成 |
| U1 | `context`、`artifact.list/read`、审计 | 完成 |
| U2 | `tool.call`（host `/call`）、`config.get/save`、`storage`、上限 | 完成 |
| U3 | vanilla/React 模板、作者文档、hello-world 示例界面 | 完成 |
| U4 | 独立页面/侧栏固定、开发模式热更新、多实例 | 未做 |

U0 完成即可验证「插件可以带界面」；U2 完成才是可用的管理面板。

## 11. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 误加 `allow-same-origin` | 插件 JS 与控制台同源，等于接管会话 | 代码评审红线；测试断言 sandbox 属性 |
| 模块脚本被 CORS 拦 | 打包后的 React 模板白屏 | UI 资源统一 `ACAO: *`；模板构建 `base:"./"` |
| mixed content | 本地 host 的界面在 HTTPS 控制台打不开 | 一律走控制台反代，不直接嵌 host |
| 插件画假登录页 | 骗取操作员控制台密码 | 外层固定栏 + 首次提示 + 禁用表单提交/顶层跳转 |
| tool.call 绕过审批 | UI 直接触发插件工具 | 与 MCP 工具同策略：只审计；安装时已确认权限 |
| 长任务无流式进度 | 界面看起来卡住 | v1 返回前显示 pending；U4 再加进度事件 |
| 改配置会重建容器 | 保存后 iframe 断连 | 保存前提示「界面会重连」，保存后自动刷新 iframe |

## 12. 未决

1. 是否需要在安装页预览插件的 UI 截图（静态截图需作者提供）。
2. `tool.call` 是否要同时把结果写进当前会话的审计叙述，还是只写 `plugin-audit.jsonl`。
3. 多实例（同一插件开两个面板）：当前浮层一次只开一个；storage 按插件共享。
4. UI 资源是否需要 ETag/版本查询参数，减少重复拉取；v1 统一 `no-store`。
5. 是否给 iframe 加 `allow-downloads`（产物导出）——v1 用桥下载，不给。
