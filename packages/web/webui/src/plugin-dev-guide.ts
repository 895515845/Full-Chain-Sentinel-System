/**
 * The install page's developer guide, kept as one plain-text block.
 *
 * It is written for a coding AI, not for a reader: a single copy gives the model
 * the whole contract, the constraints, a runnable skeleton, and the acceptance
 * checks. Markdown fences use `~~~` so the text can live in a template literal.
 */
export const PLUGIN_DEV_GUIDE = `# 哨兵插件开发任务

你要为一个「全链哨兵」社区插件写代码。严格按下面的契约产出，不要引入未说明的机制。
最终交付：一个 zip 包，里面有 plugin.json、Dockerfile 和构建上下文。安装在哨兵的插件主机上
执行 docker build，然后直接运行——不需要任何镜像仓库，也不需要 digest。

## 1. 包结构

~~~
my-plugin/
├── plugin.json
├── Dockerfile
├── .dockerignore
├── server.mjs          # MCP server（语言不限）
└── ui/                 # 可选前端
    ├── index.html
    ├── sdk.js
    ├── app.js
    └── app.css
~~~

打包：zip -r my-plugin.zip my-plugin/
上传后插件主机会解压、执行 docker build（标签 sentinel-plugin/<id>:<version>）再起容器。

## 2. plugin.json（完整契约）

~~~json
{
  "schema": 1,
  "id": "com.example.recon",
  "name": "侦察工具集",
  "version": "0.1.0",
  "description": "一句话说明这个插件做什么",
  "author": "github:your-name",
  "source": "https://github.com/you/sentinel-plugin-recon",
  "license": "MIT",
  "build": { "dockerfile": "Dockerfile", "context": "." },
  "mcp": {
    "transport": "http",
    "port": 7801,
    "path": "/mcp",
    "startupTimeoutMs": 20000,
    "requestTimeoutMs": 300000
  },
  "config": [
    { "key": "API_KEY", "label": "API Key", "type": "secret", "required": true },
    { "key": "RATE", "label": "速率", "type": "number", "required": false, "default": 1000 }
  ],
  "permissions": { "network": "bridge", "capAdd": [], "privileged": false },
  "locality": "any",
  "resources": { "cpus": 1, "memory": "512m", "pidsLimit": 128 },
  "healthcheck": { "path": "/healthz", "intervalMs": 10000, "timeoutMs": 3000, "retries": 3 },
  "artifacts": { "path": "/artifacts", "maxFileBytes": 52428800 },
  "tools": [
    { "name": "recon_scan", "description": "扫描一个域名" }
  ],
  "ui": {
    "entry": "/ui/index.html",
    "title": "侦察面板",
    "protocol": 1,
    "sidebar": { "label": "侦察", "icon": "/ui/icon.svg" }
  }
}
~~~

硬性规则：
- id 是反向域名；version 是语义化版本；description ≤400 字。
- build.dockerfile 和 build.context 都是相对插件根目录（plugin.json 所在目录）的路径，不能以 / 开头或包含 ..。
- 不再有 image 字段。写 image 会被校验拒绝；镜像一律由插件主机现场构建。
- mcp.transport 只能是 "http"（streamable HTTP）。stdio 和 SSE 不支持，作者自行转换。
- mcp.requestTimeoutMs 单位毫秒，范围 5000–1800000，默认 300000。
- permissions.network 取 none/bridge/host；bridge 是默认。capAdd 只允许 NET_RAW、NET_ADMIN、NET_BIND_SERVICE、SYS_PTRACE。
- resources 上限：cpus ≤2、memory ≤2g、pidsLimit ≤1024。
- locality：local-only（需要本地网络视角）/ remote-only（需要公网出口）/ any。
- ui 可选；v1 只有 entry/title/protocol，protocol 固定 1，禁止 network:true。
- config 的 key 必须匹配 ^[A-Z][A-Z0-9_]*$，容器里以 PLUGIN_<KEY> 注入。

## 3. Dockerfile 要求

- 构建发生在插件主机上，使用主机的 Docker 守护进程；基础镜像必须能从主机访问的仓库拉到。
- 所有镜像源必须使用中国大陆可访问的源：Docker 用 docker.1ms.run/library/... 或 ghcr.nju.edu.cn/...，
  apk 用 mirrors.tuna.tsinghua.edu.cn，npm 用 registry.npmmirror.com，pip 用 pypi.tuna.tsinghua.edu.cn，
  Go 用 goproxy.cn，Maven 用 maven.aliyun.com。不要依赖 Docker Hub、npmjs、pypi.org 直连。
- 不要把依赖放在宿主机路径里，构建上下文就是你包里能 COPY 到的所有东西。
- 容器里必须启动 MCP server，监听 0.0.0.0:<mcp.port>；只绑 127.0.0.1 会导致端口映射不可达。
- 需要 JDK/JRE、Python、Node 的，自己在 Dockerfile 里装；不要假设宿主有。
- 建议写 .dockerignore，别把 .git、node_modules、大文件塞进构建上下文。
- 需要在构建时换源或传参数，用 \`build.args\`（例如 \`{"APK_MIRROR":"mirrors.tuna.tsinghua.edu.cn"}\`），host 会转成 \`docker build --build-arg\`。
- 构建失败时，插件页会显示构建日志的最后一段；日志也写在插件主机的 plugins/<id>/build.log。

最小示例：

~~~dockerfile
FROM docker.1ms.run/library/node:22-alpine
WORKDIR /app
COPY server.mjs .
COPY ui ./ui
ENV PORT=7801
EXPOSE 7801
CMD ["node", "server.mjs"]
~~~

## 4. 容器与 MCP server

- GET <healthcheck.path> 返回 2xx 才算启动成功。
- MCP 端点是 POST <mcp.path>，JSON-RPC 2.0；返回普通 JSON 即可，也可以返回 SSE。
- 必须实现：initialize、tools/list、tools/call；建议支持 ping。
- 工具名只用字母、数字、下划线、短横线；每个工具都要有 description 和 inputSchema（JSON Schema）。
- 工具内部错误用 result.isError=true + content 文本说明，不要抛 500。

请求/响应示例：

~~~json
// 请求
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}
// 响应
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"recon","version":"0.1.0"}}}

// 请求
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"recon_scan","arguments":{"domain":"example.com"}}}
// 响应
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"找到 42 个子域名"}]}}
~~~

最小 Node 骨架（可直接改）：

~~~js
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 7801);
const ARTIFACTS = "/artifacts";
const TOOLS = [{
  name: "recon_scan",
  description: "扫描一个域名",
  inputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
}];

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function handle(message) {
  const id = message.id;
  if (message.method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "recon", version: "0.1.0" } } };
  }
  if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (message.method === "tools/call") {
    const domain = String(message.params?.arguments?.domain ?? "");
    const run = "run-" + Date.now();
    mkdirSync(join(ARTIFACTS, run), { recursive: true });
    writeFileSync(join(ARTIFACTS, run, "result.txt"), domain);
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "完成：" + domain }], _meta: { artifacts: [run + "/result.txt"] } } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") return send(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(404).end(); return; }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => send(res, 200, handle(JSON.parse(body))));
}).listen(PORT, "0.0.0.0");
~~~

## 5. 配置与密钥

- config 字段以 PLUGIN_<KEY> 环境变量注入，进程启动时读。
- type:"secret" 的值只存插件主机的 config.json（0600），API 不回显；不要写日志、不要放进工具返回值。
- 改配置会重建容器；数据目录 /data 保留。

## 6. 产物

- 大输出写 /artifacts/<run-id>/，工具返回值只放摘要。控制台按每页 10 个展示，单插件最多索引 2000 个文件。
- 在 result._meta.artifacts 里给相对路径，例如 ["run-1/result.txt"]。
- 单文件默认上限 50MB，由 artifacts.maxFileBytes 控制。

## 7. 可选前端 /ui/

声明 ui.entry 后，插件抽屉会出现「打开界面」。链接到的是控制台路径 /plugin-ui/<host>/<plugin>/，由控制台反代到容器的入口目录。

规则：
- 入口是 ui.entry 指向的 HTML；其余资源用相对路径（./app.js），不能用绝对路径 /app.js。
- 必须在页面里引入同目录的 sdk.js，并等 SentinelPlugin.connect() 返回后再发请求。
- 控制台浮层已经有插件名、版本、连接状态、重载和关闭；页面从工具栏开始，不要重复宿主标题。
- ui.sidebar 声明后默认固定到左侧工作台组，操作员可以在插件抽屉的「界面」里关掉；点侧栏条目会在主内容区打开同一个界面。icon 必须是 /ui/ 下平铺的 svg/png，label 缺省用 ui.title 或插件名。

### 7.1 侧栏入口（可选）

~~~json
"ui": {
  "entry": "/ui/index.html",
  "title": "侦察面板",
  "protocol": 1,
  "sidebar": { "label": "侦察", "icon": "/ui/icon.svg" }
}
~~~

- 声明后默认显示；操作员关掉时保存一条隐藏，存在控制台，跨项目生效。
- 入口在左侧「工作台」组，和对话、项目、工程同级；插件未运行时置灰。
- icon 只支持 /ui/ 下平铺的 .svg/.png；没有就省略，控制台会用通用图标。
- 点开后是同一个 sandbox iframe 和桥，不需要额外代码；从插件页切走再回来会重新加载页面。
- 页面是 opaque origin，不要依赖控制台 cookie；静态资源用相对路径，控制台会自动带上本次打开的能力 token。
- 从 templates/plugin-ui-shared/base.css 复制一份 base.css 到 /ui/，用 pui-page / pui-bar / pui-card /
  pui-table / pui-btn / pui-input / pui-pill / pui-output 这些 class 组织页面；不要自己再定义一套字体和颜色。
- iframe 是 sandbox="allow-scripts" 的 opaque origin：读不到控制台 Cookie/DOM/localStorage，不能直接 fetch 控制台接口，不能提交表单到控制台，不能打开顶层页面。
- v1 不允许界面访问外网（manifest 里写 network:true 会被拒绝）。需要外网时由插件容器请求，把结果通过工具/产物给界面。
- 单次读取产物上限 1MB；storage 总量 256KB、单值 32KB、最多 64 键。

SDK API（window.SentinelPlugin）：

~~~js
const ui = await SentinelPlugin.connect();
ui.context;                              // {plugin, host, project, tools, configKeys}
await ui.callTool("recon_scan", { domain: "example.com" }); // 只能调本插件自己的工具
await ui.listArtifacts();                // [{path,size}]
await ui.readArtifact("run-1/result.txt", "text");
await ui.getConfig();                    // 非密钥配置
await ui.saveConfig({ RATE: "1000" });   // 会重建容器，保存后界面会断连重连
await ui.storage.set("lastDomain", "example.com");
await ui.storage.get("lastDomain");
~~~

最小页面：

~~~html
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body>
  <h1 id="name">插件</h1>
  <button id="run">调用 recon_scan</button>
  <pre id="out"></pre>
  <script src="./sdk.js"></script>
  <script>
    SentinelPlugin.connect().then(async (ui) => {
      document.getElementById("name").textContent = ui.context.plugin.name;
      document.getElementById("run").onclick = async () => {
        const result = await ui.callTool("recon_scan", { domain: "example.com" });
        document.getElementById("out").textContent = JSON.stringify(result, null, 2);
      };
    });
  </script>
</body></html>
~~~

模板：templates/plugin-ui-vanilla（零构建）、templates/plugin-ui-react（Vite，base 必须是 "./"）。

## 8. 打包与安装

~~~sh
zip -r my-plugin.zip my-plugin/
~~~

控制台「设置 → 插件 → 上传插件包」选择 zip，确认 manifest 与权限，勾选「允许在插件主机上执行 Dockerfile 构建」，安装。
构建在主机上进行，可能需要几分钟（基础镜像、依赖下载都算在构建里）。失败时看构建日志。

本地调试可以只跑 server.mjs，不经过 Docker：

~~~sh
PORT=7801 node server.mjs
curl http://127.0.0.1:7801/healthz
~~~

## 9. 验收清单

- [ ] zip 根目录或一层子目录里有 plugin.json、Dockerfile、构建上下文
- [ ] docker build 在本机能成功，容器监听 0.0.0.0
- [ ] GET /healthz 返回 2xx
- [ ] initialize / tools/list / tools/call 都能返回合法 JSON-RPC
- [ ] 容器在 startupTimeoutMs 内启动完成
- [ ] 密钥只来自 PLUGIN_<KEY>，没有硬编码、没有写日志
- [ ] 大输出写 /artifacts，工具返回值只有摘要
- [ ] 有界面时：资源用相对路径，只通过 sdk.js 拿数据，没有访问外网

## 10. 不要做的事

- 不要写 image 字段或依赖镜像仓库；插件主机只从上传的包构建。
- 不要在 Dockerfile 里 COPY 包外的文件；构建上下文之外的东西不存在。
- 不要用 stdio / SSE 传输；不要依赖 docker socket；不要 privileged。
- 不要在界面里假设同源，不要读 document.cookie，不要 fetch /api。
- 不要把大段扫描输出直接塞进工具返回值。

参考实现：examples/plugins/hello-world（带界面）、examples/plugins/recon（CLI 包装）、plugins/memshell-party。
完整文档：docs/plugin-authoring.md、docs/plugin-ui.md。
`;
