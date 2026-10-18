# VShell 控制台插件

把 [vshell_mcp](https://github.com/zgsfsec/vshell_mcp) 的 v_shell 管理能力接成哨兵插件，并在插件页提供完整操作台。

## 架构

```
Agent / 插件界面 ──streamable HTTP MCP──> :7801（Go 适配器）
                                             │ HTTP API / Terminal WebSocket
                                             ▼
                                    v_shell 管理平台（用户自己的地址）
```

- 上游 vshell_mcp 使用 SSE；本插件把传输改成 mcp-go 的 streamable HTTP（`/mcp`），并加 `/healthz`。
- 登录用账号密码换 JWT，过期自动重新登录；也可以预置 JWT。
- 命令控制走 v_shell 的 `/api/terminal/ws`，文件/隧道/监听/客户端走 REST API。
- 插件主机必须能访问 `VSHELL_URL`；如果 v_shell 在内网，就把插件装在内网可达的 host 上。
- 控制台通过容器内的 `/ui/*` 读取前端，所以镜像必须包含 `ui/`，Go 适配器也必须在 MCP 端口上提供静态文件；只注册 `/mcp` 会让界面资源全部 404。

## 配置

| key | 说明 |
|---|---|
| `VSHELL_URL` | 必填，如 `http://1.2.3.4:18082` |
| `VSHELL_USERNAME` | 默认 `admin` |
| `VSHELL_PASSWORD` | 登录密码（secret） |
| `VSHELL_TOKEN` | 可选，预置 JWT；设置后跳过账号密码登录 |
| `VSHELL_API_PREFIX` | 默认 `/api` |
| `VSHELL_TIMEOUT` | 单次请求超时秒数，默认 60 |

密码或 Token 至少配置一个；改配置会重建容器。

## 工具

共 28 个：

- 服务器：`get_server_info`、`get_dashboard`
- 主机/命令：`list_hosts`、`execute_command`
- 文件：`list_directory`、`get_disks`、`read_file`、`write_file`、`create_directory`、`create_file`、`delete_file`、`delete_files`、`rename_file`、`upload_file`、`upload_file_base64`、`download_file`、`wget_file`
- 隧道：`list_tunnels`、`add_tunnel`、`edit_tunnel`、`set_tunnel_remark`、`start_tunnel`、`stop_tunnel`、`delete_tunnel`、`delete_tunnels`
- 监听：`list_listeners`、`add_listener`（不提供删除，和上游一致）
- 客户端：`generate_client`

`upload_file_base64` 是给插件界面的文件选择器用的；Agent 用 `upload_file` 即可。

### 本机文件

上游的 `local_path` / `save_path` 指 MCP 服务器本地路径。插件里统一限制在 `/artifacts`：

- `download_file` 下载到 `/artifacts/downloads/<文件名>`；
- `generate_client` 用 `save_path` 的相对路径，例如 `clients/stage_linux`；
- `upload_file` 从 `/artifacts` 下读文件；
- 完成后在插件页「产物」里下载。

## 前端

插件页默认显示在左侧「工作台」组，只提供三块：

- 主机与命令：主机列表、选中主机、命令控制台（输出保留在当前页面）
- 文件：目录浏览、读/写/删除/重命名、新建、上传、URL 下载
- 隧道：列表、启用/停用、删除、改备注

监听、客户端生成、产物/总览没有前端页面，但仍作为 MCP 工具保留，由 Agent 调用。文件下载仍写到 `/artifacts`，在「插件 → 详情 → 产物」下载。

高风险操作（删除、写入、生成客户端）保留，调用会进入插件审计；只允许在授权目标上使用。

## 构建与安装

```sh
docker build -t sentinel-plugin-vshell:0.1.0 .
```

安装时把插件包（zip）上传到控制台，勾选构建同意。Go 依赖走 `goproxy.cn`，基础镜像走 `docker.1ms.run`。

## 授权声明

VShell 是远控/C2 管理平台。本插件仅限**已获得书面授权**的渗透测试、红队评估与安全研究使用。
