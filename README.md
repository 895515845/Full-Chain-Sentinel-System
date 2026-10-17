# 全链哨兵 Full Chain Sentinel System

知攻善防实验室，基于 [pi](https://github.com/earendil-works/pi) agent harness 改造的**授权渗透测试 Agent**，带中文 Web 控制台与容器化作业环境。

## 授权使用声明

本项目是攻击性安全工具，**只能用于你已获得书面授权的目标**。

- 未经授权对他人系统做渗透测试、漏洞扫描、口令破解或入侵，在中国大陆及多数司法辖区属于违法行为（参见《网络安全法》第二十七条，《刑法》第二百八十五条、第二百八十六条、第二百八十七条之二；本段不构成法律意见）。
- 首次进入控制台必须勾选「我承诺只用于授权合法的渗透测试」，承诺与声明的哈希保存在本机配置目录，声明更新或换账号会重新确认。
- Agent 的行为难以完全管控：自动执行模式下模型可以运行任意命令。**因使用本项目造成的业务中断、数据损坏、越权访问或其他后果，由使用者自行承担**，作者与贡献者不承担任何责任。
- 请在授权范围内、隔离环境中使用；对生产系统测试前先取得书面授权并约定时间窗。

本项目以 MIT 许可发布，不附带任何担保。

## 功能

- **方法论驱动的渗透流程**：侦察 → 枚举 → 漏洞映射 → 验证 → 利用 → 后渗透 → 报告，系统提示强调授权范围、证据留痕与最小侵入。
- **中文 Web 控制台**（[packages/web](packages/web/README.md)）：流式对话与思考过程、工具执行卡片、会话树、文件与子代理弹窗、项目选择。
- **三档执行模式**：审批模式（默认，每条 bash 命令可编辑后放行或拒绝）、自动执行、AI 审批（守门员模型逐条判定 `ALLOW` / `BLOCK`，判定失败或超时一律放行）。审批链覆盖 bash 与安卓 shell 命令（`droid_shell`）；frida、抓包、APK 分析与文件面板直接调用容器，不过审批门。
- **容器化作业环境**：每个项目一个 Kali 容器，内置侦察、枚举、Web 利用、口令与内网工具；容器网络模式在「设置 → 环境」切换（默认 host）。
- **漏洞中枢**：`vuln_submit` 提交已验证漏洞，必填 CVSS 分数，原始数据包逐字保存，操作员复核留时间线，可按项目导出 Markdown 报告。
- **业务建模与 POC 库**：把目标站点还原成 OpenAPI 3.0 文档；Nuclei POC 订阅、检索与引用。
- **安卓设备插件**：root 测试机安装自研 DroidBridge APK 主动反连，提供 shell、文件上下行、截屏、logcat、tcpdump 抓包、frida 动态调试与 APK 静态分析。
- **资产测绘平台插件**（设置 → 资产测绘）：接入 **FOFA**、**360 Quake**、**奇安信 Hunter**，Agent 用 `fofa_search` / `quake_search` / `hunter_search` 三个工具按各平台自己的查询语法测绘公网资产（域名、IP、端口、标题、服务、指纹），原始响应落到项目 `evidence/asset/`，每次查询记一条流水。**只有「已启用 + 已配置密钥 + 验证通过」的平台才会挂载工具**，没配置或密钥不可用时 Agent 根本看不到该工具；查询由控制台进程直接发起，密钥不进容器、不进 bash 审计，也不进守门员判定。
- **Web 搜索插件**（设置 → Web 搜索）：接入 **Tavily**，Agent 用 `web_search`（公网搜索）与 `web_extract`（页面正文抓取）做目标情报收集（泄露文档、公开报告、技术文章）。支持多 Key 号池，控制台按各 Key 剩余额度自动轮换，额度耗尽自动切换；查询流水入 `websearch.db`，原始响应落项目 `evidence/search/`。只有「权限 → Web 搜索」开关打开且号池里有已验证的 Key 时才会挂载工具；密钥明文存本机 `websearch.json`（0600），不进容器、不进 bash 审计。
- **自定义 MCP 插件**（设置 → MCP）：在控制台里增删改查 MCP 服务器（`http`、`sse` 或 `stdio`）并逐个测试连接，工具以 `mcp__<服务器>__<工具>` 挂给 Agent，仍受「权限 → MCP」总开关约束，且该开关下可逐个服务器放开或关掉。配置由哨兵自己拥有（`mcp-servers.json`，0600），**不读 pi 原生的 `mcp.json`**，所以列表里没有的服务器 Agent 看不到。**stdio 服务器在控制台宿主机上直接执行**（不在容器内、不过 bash 审批），必须逐条勾选风险确认才能保存。

- **社区插件中心**（设置 → 插件）：插件以 Docker 镜像交付，可以跑在本机，也可以跑在用户自己的 VPS 上。控制台主动出站连接插件主机，所以本地部署没有公网 IP 也能用，不需要反向隧道。每个插件就是一个 MCP server，工具沿用 `mcp__<插件>__<工具>` 命名，受「权限 → MCP」总开关约束。安装时展示 manifest 声明的网络模式与 capabilities，`host` 网络和 `privileged` 必须单独确认；工具调用不逐条拦截，只写审计，插件页可一键停用。插件包是一个 zip（根目录或一层子目录里有 `plugin.json`）或单个 `plugin.json`，在「设置 → 插件」上传安装；镜像必须带 digest，`source` 必须公开。详见 [docs/plugin-center.md](docs/plugin-center.md) 与 [docs/plugin-authoring.md](docs/plugin-authoring.md)。
- **OpenAI 兼容端点**：支持 vLLM、one-api、new-api 等自建端点，界面直接配置。
- **会话即审计**：复用 pi 的 JSONL 会话树，命令、输出与模型决策完整留痕。

# Releases 快速开始

你需要提前安装好 Docker，怎么安装 Docker，在此就不赘述

```sh
root@VM-0-11-ubuntu:~# tar -xzvf sentinel-web-linux-x64.tar.gz 
sentinel-web/
sentinel-web/sentinel-web

root@VM-0-11-ubuntu:~# cd sentinel-web/

root@VM-0-11-ubuntu:~/sentinel-web# ls
sentinel-web

root@VM-0-11-ubuntu:~/sentinel-web# chmod +x sentinel-web 
root@VM-0-11-ubuntu:~/sentinel-web# ./sentinel-web 

```
首次运行访问需要设置账号密码

![](images/Pasted%20image%2020261017122835.png)
请确保你的所有测试在本地，或者有正规合法的渗透测试授权，并且同意AI 生成式风险，否则无法进入平台。

进入平台后请先部署好容器：
![](images/Pasted%20image%2020261017123006.png)
等待即可
![](images/Pasted%20image%2020261017123905.png)

全链哨兵（PCSS）是以项目为隔离，为了安全考虑，每个项目一个 kali 容器。
建议开 host 模式，否则公网环境无法进行监听操作。


## Dev 快速开始

要求 Node.js >= 22.19.0。

```bash
npm install --ignore-scripts
npm run build:offline  # 后端各包与 coding-agent（不联网，模型目录已入库）
npm run build:web      # Web 控制台与前端资源
npm run start:web
```

`npm run build` 只构建后端各包，控制台需要额外的 `npm run build:web`。

启动后日志里会打印本次的入口地址，形如 `https://<地址>:<端口>/<随机串>`。默认监听 `0.0.0.0`，随机入口串与 cookie 校验用于挡扫描器：没有入口串的请求一律返回普通 404，入口串每次启动都变。请在日志里取完整地址访问。

默认使用自签 HTTPS：首次启动用本机 openssl 生成证书（存于配置目录 `tls/`，SAN 覆盖 localhost 与当前所有网卡 IP），之后复用。浏览器首次访问会提示证书不受信任，选择「高级 → 继续前往」即可，也可把 `tls/cert.pem` 导入系统信任。换网络后局域网 IP 变化导致证书域名不匹配时用 `--tls-regen` 重签。

首次访问的流程：

1. 设置控制台密码（scrypt 哈希，保存在本机配置目录）。
2. 阅读并勾选授权使用承诺。
3. 在左侧「模型设置」配置端点（Base URL / API Key / 模型 ID）。

启动参数与环境变量：

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--host <地址>` | `SENTINEL_HOST` | 监听地址，默认 `0.0.0.0` |
| `--port <端口>` | `SENTINEL_PORT` | 监听端口，默认 `7777` |
| `--cwd <目录>` | `SENTINEL_CWD` | 工作目录，默认当前目录 |
| `--gate-token <串>` | `SENTINEL_GATE_TOKEN` | 固定入口串，默认每次启动随机 |
| `--no-gate` | — | 关闭随机入口，直接以 `/` 提供服务（仅本机调试） |
| `--no-tls` | `SENTINEL_TLS=0` | 关闭 HTTPS，退回明文 HTTP（默认自签 HTTPS） |
| `--tls-cert` / `--tls-key` | — | 使用指定证书与私钥（成对使用，优先于自动生成） |
| `--tls-regen` | — | 重新生成自签证书（本机 IP 变化、浏览器报域名不匹配时用） |
| `--no-consent` | — | 跳过首次授权承诺（自动化环境） |
| `--check` | — | 只做启动前自检并打印报告，不启动服务 |

```

## 目录结构

本仓库沿用上游 pi monorepo 的分包结构（包名仍是上游的 `@earendil-works/*`，改名单独进行）：

| 包 | 说明 |
| --- | --- |
| [packages/web](packages/web) | 全链哨兵 Web 控制台：HTTP + WebSocket 服务与前端 |
| [packages/coding-agent](packages/coding-agent) | Agent CLI 与运行时 |
| [packages/agent](packages/agent) | 工具调用与状态管理 |
| [packages/ai](packages/ai) | 多 provider LLM API |
| [packages/tui](packages/tui) | 终端 UI 库 |
| [packages/durable](packages/durable) | 会话、任务与文档运行时 |
| [packages/mcp](packages/mcp) · [packages/protocol](packages/protocol) | MCP 与协议层 |
| [packages/droid-apk](packages/droid-apk) | 安卓 DroidBridge APK（Kotlin） |
| [docker](docker) | 作业容器镜像（Kali + 工具链） |

## 开发

```bash
./test.sh                   # 全部非 e2e 测试
npm run check               # biome + 依赖/导入/入口图检查 + tsc + webui + 浏览器冒烟
npm run build:offline       # 全量构建，不联网、不重生成模型目录
```

本仓库不跑 CI（只保留发布流程）：提交前请自己跑 `npm run check` 和 `./test.sh`。

单测从包根目录跑：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<name>.test.ts
```

`packages/ai/src/providers/data/` 是 `generate-models` 的产物，已固定在版本库里：模型 id 的类型联合体直接由它推导，固定它之后 `tsc` 和测试不会随厂商轮换模型而漂移（全新克隆也能离线做类型检查）。要更新目录时跑 `npm run generate:models`（需联网）并提交改动——刷新会改到 `.manifest.json` 的 `generatedAt` 时间戳，属正常。发布流程仍会实时刷新，发布产物里的目录是最新的。

作业容器：

```bash
docker build -t sentinel:latest docker/
```

基础镜像与 apt/pip/npm/go 软件源可在控制台「设置 → 环境」配置，也可以在命令行用 `--build-arg` 覆盖。

## 安全边界

**控制台**：Docker 是硬依赖。每个项目一个 Kali 容器（`sentinel:latest`），Agent 的 bash 命令**在容器内执行**（`docker exec`），项目目录 bind mount 进 `/work`，容器**以 root 运行**。容器网络默认 **host**（容器直接用宿主机网络栈，反向 shell、payload 服务、本地靶场、内网与 VPN 才是真实的），可在「设置 → 环境 → 容器网络」切到 **bridge**；两种模式都保留 `NET_RAW`，`NET_ADMIN` 只在 bridge 模式授予。Docker 检查有阻断项时控制台拒绝 `prompt`、`compact` 与持续目标。

**但容器只约束命令，不是整体沙箱**：控制台与 Agent 进程本身以启动者的用户身份跑在宿主机上，只有命令进容器。

- 审批链只覆盖 bash 与安卓 shell（`droid_shell`），子代理的 bash 走同一条链；**read/edit/write、文件面板、MCP 工具、codemode，以及 frida、抓包、APK 分析等直接调用容器的工具都不过门**。工程任务的 bash 另有一套正则黑名单、20 秒超时与 40 条预算，同样不走审批门。
- `read/edit/write` 直接读写宿主机文件系统，项目目录只是相对路径的基准，绝对路径不受限制；MCP 的 stdio 服务器是宿主机子进程。
- AI 审批（守门员）只判六类破坏性操作，判定失败、超时或无法解析一律放行（fail-open），**不是沙箱、也不做数据防泄漏**。
- 容器以 root 运行，没有资源上限，也没有 cap-drop / seccomp / read-only；同一项目的所有会话与并发任务共用一个容器。
- 控制台会加载项目目录下的 `settings.json`、`.pi/extensions`、`AGENTS.md`，且没有项目信任确认步骤——不要把来源不可信的工作目录设为项目。MCP 服务器不在此列：它们只来自「设置 → MCP」，项目目录里的 `.pi/mcp.json` 与配置目录里的 `mcp.json` 都不读。
- **自定义 MCP 的 stdio 服务器在控制台宿主机上直接执行**：不在容器内，也不经过 bash 审批与守门模型，因此必须逐条勾选风险确认才能保存。需要 OAuth 登录的 HTTP 服务器请在终端执行 `sentinel mcp login`。
- **Web 搜索会把搜索关键词与 API Key 发送给 Tavily**：请求在控制台进程里直接 HTTPS 发出，不过审批门、也不经过容器；搜索内容对 Tavily 可见。多 Key 明文存本机 `websearch.json`（权限 0600），前端不回显；流水与原始响应留在本机（`websearch.db` 与项目 `evidence/search/`）。
- **资产测绘会把查询内容与 API Key 发送给第三方平台**（FOFA / 360 Quake / 奇安信 Hunter）：查询在控制台进程里直接 HTTPS 发出，不过审批门、也不经过容器，但目标域名、IP 等查询内容对这些平台可见。密钥明文存在本机配置目录的 `assets.json`（权限 0600），前端不回显；查询流水与原始响应留在本机（`assets.db` 与项目 `evidence/asset/`）。

完整边界与配置见 [packages/web/README.md](packages/web/README.md#安全提示)。

自动执行模式下模型可运行任意命令，持续目标在自动执行下也没有危险命令黑名单，请仅在**授权目标与隔离环境**中使用；需要无人值守又不愿全放行时用 AI 审批。控制台的登录、随机入口串与授权承诺只用于防误用与防扫描，不构成隔离。

安全问题请通过仓库 Issue 反馈，不要在公开 Issue 里附可直接利用的细节。

## 上游与许可

本项目是 [pi](https://github.com/earendil-works/pi) 的衍生作品（fork），**不是上游官方项目**，与上游团队无关。

上游代码以 MIT 许可发布，版权归 Mario Zechner，许可全文见 [LICENSE](LICENSE)；本仓库保留该许可与版权声明，并在此基础上加入渗透测试相关的系统提示、Web 控制台、容器化作业环境与安卓设备插件。

- 上游仓库：https://github.com/earendil-works/pi
- 本项目新增部分的版权归本项目作者，同样以 MIT 发布。
- 例外：[packages/coding-agent/examples/extensions/doom-overlay/doom/](packages/coding-agent/examples/extensions/doom-overlay/doom/) 是 GPLv2 的 DOOM 编译产物及其对应源码，不属于 MIT，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 何为全链路？

渗透测试场景在安全服务工作中，通常分为三种

**1.Web 渗透 2.小程序渗透 3.APP 渗透**

至此，我们全链路打通，一个平台畅游所有任务

三端是怎么打通的呢？
我们要知道我们渗透测试测的是什么？很多人都不明白道理，我们渗透测试过程，90% 的针对服务器后端进行测试的，后端想给我们前端展示，所以想打通三端也只是不同载体的问题。
比如：

**Web** 前端载体就是浏览器，

**小程序**的前端载体就是小程序容器

**APP** 的前端载体就是一些 UI 框架

所以，本质上 Web、小程序、APP，都是一样的。

## 使用

使用前必须创建项目，否则无法使用
![](images/Pasted%20image%2020261017124002.png)

![](images/Pasted%20image%2020261017124018.png)


简单说几个场景怎么用吧，
1.**Web 测试**
直接输入框使用即可

2.**小程序**
选择预设 Agent 然后自己在 Tscan 这类工具中把微信小程序反编译，点击左下角“附件”上传即可。

3.**APP**
在左侧安卓设备中配置好你的安卓机器，然后在你的安卓里面安装好对应 APP，然后在对话框中选择“安卓”即可

![](images/Pasted%20image%2020261017124047.png)

因为本人想法是更少的工具和上下文，所以，你如果不开“安卓”这个按钮的话，他是不会插入安卓相关的工具调用的、也不会插入相关 prompt 

## 关于安卓配置

你需要有一台 root 后的设备（虚拟机亦可），并且安装配套的 app 即可

![](images/Pasted%20image%2020261017124555.png)


关于手机 root，这里就不再讲解，有兴趣可以去酷安社区逛逛,安卓机为反连主平台，所以你可以将主程序部署在公网服务器。

<img src="images/Pasted%20image%2020261017124518.png" width="295" alt="Pasted image 20261017124518.png" />

## 工程模式 

适用于批量测试环节，指挥官架构，适用于多任务指挥，这个还是测试阶段，自行玩一玩吧。

![](images/Pasted%20image%2020261017124651.png)

## 守门审计

建议在设置->模型里面再配置一个小模型，比如 qwen,Hook所有 Bash 调用过程，建议用千问的 API 按量付费，不可以用 CodingPlan 模型，因为 CodingPlan 会有速率限制。

https://www.qianwenai.com/models/qwen-flash

采用小模型监管大模型，最大程度上尽量避免对生产环境造成影响。

![](images/Pasted%20image%2020261017125228.png)

## 关于 POC 订阅

你可以做一些自己的 Nuclei 的 POC 订阅服务，放进“设置->POC订阅”里面，这种应用场景主要是打 nday ，本来没打算加 Nuclei 固定 POC 的功能的，但是考虑到像 jeecg boot 、若依这种开发框架，的 api 路由自定义功能，还是加了吧。

你只需要在你的远程服务器上定时的把Nuclei 的所有 POC 打包成 zip，然后远程同步即可。

也可以直接同步 Nuclei 官方的 POC

![](images/Pasted%20image%2020261017125244.png)


## 如何持久化运行？

建议使用 screen -R sentinel

![[images/Pasted image 20261017133338.png]]

然后 ctrl +a ,键入 d 即可，更多用法自行学习 screen

## 全链哨兵交流群

加群的，一定要在“打招呼内容”备注“全链哨兵”。

<img src="images/Pasted%20image%2020261017125335.png" width="294" alt="Pasted image 20261017125335.png" />

<img src="images/Pasted%20image%2020261017125351.png" width="340" alt="Pasted image 20261017125351.png" />