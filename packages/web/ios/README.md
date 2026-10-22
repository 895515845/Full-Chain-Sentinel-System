# SentinelBridge（iOS 端）

越狱设备上的反向 WebSocket daemon：设备主动连控制台，接受 `exec` / `pull` / `push` / `screencap` / TCP 隧道请求。
控制台侧实现在 `packages/web/src/ios-gateway.ts`，协议在 `ios-protocol.ts`，部署与决策记录在 `docs/ios-agent-qa.md`。

**只支持 deb，不再提供 IPA。** iPad/iPhone 上不需要装 App：daemon 由 launchd 以 root 运行，控制台网页就是全部 UI。首次安装后由设备本机 Safari 打开 `http://127.0.0.1:9945/setup` 完成配对。

## 两种安装形态

| 形态 | 架构 | 路径 | 说明 |
| --- | --- | --- | --- |
| rootful | `iphoneos-arm` | `/usr/bin`、`/Library/LaunchDaemons` | iOS 14/15，checkra1n 等 |
| rootless | `iphoneos-arm64` | `/var/jb/usr/bin`、`/var/jb/Library/LaunchDaemons` | Dopamine 等 iOS 15/16 |

daemon 启动时探测 `/var/jb`，因此同一份源码可以打两种包；但二进制的最低系统版本不同，rootful 包请用 `IOS_MIN=14.0` 构建，rootless 用 15.0。

不支持 roothide：它的越狱根每个进程随机，固定路径的 LaunchDaemon 不成立。控制台在 hello 阶段会以 4005 拒绝。

## 构建

前置：Xcode。`ldid` 用来签 entitlements（没有时脚本会提示用 `SKIP_SIGN=1`），`dpkg-deb` 用来打 deb（没有时自动用 `scripts/debpack.py` 的纯 Python ar+tar 实现）。

```sh
cd packages/web/ios

# rootful（iOS 14+）
IOS_MIN=14.0 scripts/build-ios.sh
scripts/build-deb.sh rootful

# rootless（iOS 15+）
IOS_MIN=15.0 scripts/build-ios.sh
scripts/build-deb.sh rootless

# 生成 Sileo 静态源（docs/repo）
scripts/build-repo.sh
```

发布到独立的小写 Pages 仓库：

1. 创建 `zgsfsec/sentinel-ios-repo`（public，空仓库，默认分支 `main`）。
2. 该仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`、目录 `/ (root)`。
3. 在**主仓库** Settings → Secrets and variables → Actions 新建 `PAGES_REPO_TOKEN`：fine-grained PAT 给 `sentinel-ios-repo` 的 Contents 写权限，或 classic PAT 的 `repo` scope。
4. push `docs/repo` 变更；`.github/workflows/ios-repo.yml` 会把静态源推到 `sentinel-ios-repo` 的 `main`。

产物：

```
build/sentinelbridged
build/com.zgsfsec.sentinelbridge_0.1.1_iphoneos-arm.deb
build/com.zgsfsec.sentinelbridge_0.1.1_iphoneos-arm64.deb
docs/repo/{Packages,Release,pool/*.deb}
```

没有 `ldid` 时可以 `SKIP_SIGN=1 scripts/build-ios.sh` 只验证编译，再用 `codesign --force --sign - --entitlements entitlements.plist build/sentinelbridged` 做 ad-hoc 签名。

## 安装与配对

推荐路径：

1. Sileo 添加源 `https://zgsfsec.github.io/sentinel-ios-repo/`，安装 `SentinelBridge`。
   新仓库 `sentinel-ios-repo` 的 Pages Source 选 `main` / root；发布内容就是仓库根，不要再加 `/repo/`。
   Actions 首次部署前需要在 Settings → Pages → Build and deployment 把 Source 设为 GitHub Actions；也可以在仓库 Secrets 添加 `PAGES_TOKEN`（fine-grained PAT 给 Pages write + 仓库 read，或 classic PAT 的 `repo` scope），workflow 会用它自动启用 Pages。`GITHUB_TOKEN` 本身没有创建 Pages 站点的权限。
2. 控制台「iOS 设备」页生成 6 位配对码。
3. iPhone Safari 打开 `http://127.0.0.1:9945/setup`。
4. 填控制台地址（如 `https://console.example.com`）和配对码；点「检测证书」，确认指纹与控制台显示一致，再点「配对」。
5. 配对成功后 daemon 自动重启并反连；设备出现在控制台设备列表。

SSH 回退（设备需开 OpenSSH）：

```sh
packages/web/ios/scripts/install-ios.sh root@192.168.1.50 --with-deps \
  --url wss://console.example.com/ws/ios \
  --token ios_xxx
```

不带 `--url/--token` 时，脚本只装 deb，随后用 Safari 走上面的 setup 页。

## 配对协议

- 控制台生成 6 位码，10 分钟有效、一次性，绑定一个 token。
- 设备 setup 页只在 `127.0.0.1:9945` 监听；配对成功写 `/var/jb/etc/sentinelbridge.json`（0600）后退出。
- 设备到控制台的 claim 请求走 `POST /api/ios/pair/claim`，不经过控制台 gate/登录；控制台按 IP 限速并做一次性消费。
- 自签证书必须核对指纹：setup 页先 probe 控制台叶证书 SHA-256，用户确认后 pairing 请求用同一指纹 pin，避免把 6 位码发给中间人。

## 设备 ID 与状态

- 设备 ID 首次启动时生成，保存在 `/var/lib/sentinelbridge/device-id`（rootless 在 `/var/jb/var/lib/sentinelbridge/`）。
- 删除该文件等于换一台新设备，控制台会多出一条记录。
- 心跳 15s；控制台 45s 没收到心跳标为 stale，但 socket 仍在。iOS 挂起进程时会出现这种状态，重开 daemon 即可。
- 日志：`/var/log/sentinelbridge.log`。

## 已验证范围

- macOS 主机契约测试：`test/ios-daemon.test.ts` 用同一份 Swift 源码连真实 Node 网关，覆盖 hello、exec、1.5MB 分片 pull/push、TCP echo 隧道、SIGTERM 退出。
- 8P 真机（iOS 16.7.12，rootless）：安装、launchd、反连、exec/pull/push/apps/profiles/TCP 隧道、tcpdump、HTTP 日志、砸壳主二进制；deb-only setup 配对已通过（6 位码 + 自签证书指纹 + 配置写入 + launchd 重启）。
- 未验证：rootful 真机、roothide、第二台设备 `verifyDevice`、`ldid` 重签、`bfdecrypt` 回退。

## 故障排查

- **控制台显示“反连被拒绝：token 无效或已删除”**：token 填错或被删；在控制台生成新配对码重新配对。
- **Safari 打不开 setup 页**：确认 daemon 正在运行（`launchctl list | grep sentinel`）且没有旧配置；有旧配置时 daemon 直接反连，不会开 setup 页。重新配对先删配置并重启：`rm /var/jb/etc/sentinelbridge.json && launchctl kickstart -k system/com.zgsfsec.sentinelbridged`。
- **设备在线但工具报“设备无响应”**：45s 没有心跳，通常是 iOS 挂起了进程；重开 daemon。
- **`daemon 不是 root`**：检查 plist 的 `UserName` 与 `launchctl print system/com.zgsfsec.sentinelbridged`。
- **TLS pin mismatch**：日志会打印实际叶证书指纹；确认反向代理没有换成另一张证书。

## 安全边界

- daemon 以 root 运行，`ios_shell` 的审批在控制台侧完成；daemon 只执行收到的命令。
- setup 页只绑回环，配对成功即退出；不要在配对窗口期把 127.0.0.1:9945 转发到局域网。
- 公网必须 `wss://`；自签证书必须核对指纹。
- pull/push 的路径限制在控制台项目工作目录内，由控制台工具层校验；daemon 本身不做目录白名单。
