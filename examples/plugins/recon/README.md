# 侦察工具集插件

把 subfinder 和 naabu 包成两个 MCP 工具，作为 M1 的验收用例。它验证的是长任务、
大输出和产物回传：完整结果写文件，模型只拿到前 300 行摘要和产物路径。

## 构建与发布

```sh
docker build -t ghcr.io/<你的账号>/sentinel-plugin-recon:0.1.0 .
docker push ghcr.io/<你的账号>/sentinel-plugin-recon:0.1.0
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/<你的账号>/sentinel-plugin-recon:0.1.0
```

把输出粘进 `plugin.json` 的 `image`。基础镜像用的是 projectdiscovery 官方镜像，
拷贝的是 `/usr/local/bin` 下的二进制；如果上游改了路径，构建会直接失败，不会静默产出坏镜像。

## 能力与限制

- `NET_RAW`：naabu 的 SYN 扫描需要，安装页会单独展示这个 capability。
- 网络出口：装在 VPS 上时扫描从 VPS 发起，不是操作员本地网络。要扫内网请装本地 host，
  但这个插件的 `locality` 是 `any`，两端都能装。
- 超时：子进程默认 120 秒（subfinder）与 180 秒（naabu），上限 600 秒，超时会返回部分结果。
- 速率：`DEFAULT_RATE` 是插件配置项，也可以用工具参数逐个调用覆盖。

## 安装后

```text
subfinder_enum(domain="example.com")
naabu_scan(host="example.com", top_ports="100")
```

产物写在插件主机的
`~/.sentinel/plugin-host/plugins/com.sentinel.recon/artifacts/run-*/`，
在插件页点「产物 → 拉取到证据目录」会落到当前项目 `evidence/plugin/` 下。
