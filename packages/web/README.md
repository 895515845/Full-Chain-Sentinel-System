# ZGAgent Web

ZGAgent 的 Web 控制台：内嵌 pi coding-agent SDK 的 HTTP + WebSocket 服务，以及浏览器端中文控制台界面。

## 功能

- 流式对话（文本 + 思考过程）与工具执行卡片实时展示（含长命令执行中的滚动输出）
- 双执行模式：
  - **审批模式（默认）**：bash 命令执行前弹出审批，可编辑命令后放行或拒绝
  - **自动执行**：命令直接运行，不做拦截
- **子代理（spawn_agent）**：主代理可将独立子任务（如单主机侦察）委派给隔离子会话并行执行；默认 explore 只读模式，act 模式下子代理的 bash 同样经过审批门（弹窗标注来源），且子代理不能再派生子代理
- 审批队列：并发工具调用逐条列出，可单条批准（可编辑）、全部批准、全部拒绝；支持「本会话自动放行此前缀」与命令前缀白名单（复合命令永不白名单放行）
- 端点测试连接：保存前一键验证，失败给出具体原因（超时 / 401 / 404 路径 / 模型不存在）与建议；空 API Key 的本地端点可直接使用
- 长输出查看：复制命令 / 复制输出 / 全屏查看 + 行过滤搜索
- 会话分支：分支树视图、任意历史用户消息处一键分叉
- 用量统计：输入 / 输出 / 缓存 token 与费用
- **项目管理**：命名的独立工作目录（侧栏顶部切换），会话/上下文文件/bash 目录按项目自动隔离；删除项目需输入项目名确认并连带清理其会话；重启自动恢复上次项目
- 会话管理：历史会话列表、切换、新建、重命名、删除（JSONL 会话文件即审计日志）
- 模型端点配置：OpenAI 兼容端点（vLLM / one-api / new-api 等），写入 `~/.zgagent/agent/models.json`

## 架构

```
浏览器（React，中文界面）
   │  WebSocket /ws（JSON 协议，见 src/protocol.ts）+ 静态资源 HTTP
server.ts（node:http + ws）
   │  直接调用 SDK
zg-session.ts —— createAgentSession() + baseToolsOverride(bash 包装审批门)
   │
pi coding-agent（AgentSession / SessionManager / 工具 / 压缩 / 会话树）
```

bash 工具通过 `BashOperations.exec` 包装实现审批拦截：审批模式下命令先广播到所有已连接的控制台，等待操作员决定（批准 / 编辑后批准 / 拒绝）；中止运行会取消未决审批。

## 使用

在仓库根目录：

```bash
npm install --ignore-scripts
npm run build          # 构建所有包（包括本包）
npm --prefix packages/web run start
```

打开 http://127.0.0.1:7777 。

首次使用先在左侧「模型设置」中配置端点，或在 `~/.zgagent/agent/models.json` 手动配置：

```json
{
	"providers": {
		"zg-endpoint": {
			"baseUrl": "http://127.0.0.1:8000/v1",
			"api": "openai-completions",
			"apiKey": "sk-…",
			"models": [{ "id": "deepseek-v3.1" }]
		}
	}
}
```

环境变量 / 命令行参数：

| 参数 | 说明 | 默认 |
|---|---|---|
| `ZG_PORT` / `--port` | 监听端口 | 7777 |
| `ZG_HOST` / `--host` | 监听地址 | 127.0.0.1 |
| `ZG_CWD` / `--cwd` | Agent 工作目录 | 进程当前目录 |
| `ZGAGENT_CODING_AGENT_DIR` | 配置目录 | ~/.zgagent/agent |

## 安全提示

- 审批模式只拦截 bash 工具；read/edit/write 不拦截。
- 自动执行模式下模型可运行任意命令。pi 无内建沙箱，请仅在授权目标与隔离环境中开启自动执行，必要时配合容器化运行。
