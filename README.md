# 全链哨兵 Full Chain Sentinel System

基于 [pi](https://github.com/earendil-works/pi) agent harness 改造的**授权渗透测试 Agent**，带中文 Web 控制台与容器化作业环境。

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
- **OpenAI 兼容端点**：支持 vLLM、one-api、new-api 等自建端点，界面直接配置。
- **会话即审计**：复用 pi 的 JSONL 会话树，命令、输出与模型决策完整留痕。

## 快速开始

要求 Node.js >= 22.19.0。

```bash
npm install --ignore-scripts
npm run build:offline  # 后端各包与 coding-agent（不联网，模型目录已入库）
npm run build:web      # Web 控制台与前端资源
npm run start:web
```

`npm run build` 只构建后端各包，控制台需要额外的 `npm run build:web`。

启动后日志里会打印本次的入口地址，形如 `http://<地址>:<端口>/<随机串>`。默认监听 `0.0.0.0`，随机入口串与 cookie 校验用于挡扫描器：没有入口串的请求一律返回普通 404，入口串每次启动都变。请在日志里取完整地址访问。

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
| `--no-consent` | — | 跳过首次授权承诺（自动化环境） |
| `--check` | — | 只做启动前自检并打印报告，不启动服务 |

CLI 同样可用：

```bash
./pi-test.sh --no-env      # 从源码运行 sentinel CLI
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
- 控制台会加载项目目录下的 `settings.json`、`.pi/extensions`、`AGENTS.md`、`mcp.json`，且没有项目信任确认步骤——不要把来源不可信的工作目录设为项目。

完整边界与配置见 [packages/web/README.md](packages/web/README.md#安全提示)。

**CLI**：沿用 pi 的权限模型，无内建沙箱，工具以当前用户权限在宿主机执行；需要隔离就把 CLI 整个跑进容器（[containerization.md](packages/coding-agent/docs/containerization.md) 是上游文档，命令与路径名仍是 `pi`）。

自动执行模式下模型可运行任意命令，持续目标在自动执行下也没有危险命令黑名单，请仅在**授权目标与隔离环境**中使用；需要无人值守又不愿全放行时用 AI 审批。控制台的登录、随机入口串与授权承诺只用于防误用与防扫描，不构成隔离。

安全问题请通过仓库 Issue 反馈，不要在公开 Issue 里附可直接利用的细节。

## 上游与许可

本项目是 [pi](https://github.com/earendil-works/pi) 的衍生作品（fork），**不是上游官方项目**，与上游团队无关。

上游代码以 MIT 许可发布，版权归 Mario Zechner，许可全文见 [LICENSE](LICENSE)；本仓库保留该许可与版权声明，并在此基础上加入渗透测试相关的系统提示、Web 控制台、容器化作业环境与安卓设备插件。

- 上游仓库：https://github.com/earendil-works/pi
- 本项目新增部分的版权归本项目作者，同样以 MIT 发布。
- 例外：[packages/coding-agent/examples/extensions/doom-overlay/doom/](packages/coding-agent/examples/extensions/doom-overlay/doom/) 是 GPLv2 的 DOOM 编译产物及其对应源码，不属于 MIT，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
