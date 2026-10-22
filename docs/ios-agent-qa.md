# iOS 设备端（SentinelBridge）设计 Q&A

目标：像 DroidBridge 一样，让一台**已越狱**的 iPhone 反连控制台，Agent 通过 `ios_*` 工具做信息收集、IPA 获取与静态分析、动态调试、抓包和凭据检查。

用法：每条 A 是建议答案。标〔待定〕的需要产品决策，标〔待验证〕的必须真机 spike 后才能定，标〔不做〕的是明确排除项。

> **2026-10-22 交付变更：IPA 已移除。** 当前只发 root daemon deb；首次安装后在设备 Safari 打开 `http://127.0.0.1:9945/setup`，填入控制台 wss 地址和 token 完成配置。下文 Q9/Q10、§20、§22.2 中关于 IPA 的描述是历史设计记录，实际以本注和 §26 为准。

## 0. 先定十件事

1. 形态是 **deb-only：root LaunchDaemon（干活）+ 控制台网页**；设备本地 setup 页负责首次配对。IPA 已移除，不再维护。
2. 必须越狱。TrollStore 只是安装器，不给 root。
3. 通道是设备主动反连 `wss://console/ws/ios?token=…`，复用 Droid 的帧语义。
4. 协议是 JSON 帧 + 1MB 分片二进制 + TCP-over-WS 隧道，与安卓保持一致。
5. 工具前缀 `ios_*`；shell、装/卸 IPA 走同一条审批/守门链，读取类不过门。
6. 会话开关是 `zg-ios`，按对话挂载，与 `zg-droid` 相互独立。
7. 服务端新增独立 `ios-gateway.ts` / `ios.ts` / `ios.db`，不动安卓实现；只共用协议常量与分片/隧道 helper。
8. 能力分期：M1 shell/文件/截屏 → M2 应用/IPA/静态 → M3 frida/抓包/日志 → M4 FairPlay 解密 + keychain（v1 必做）。
9. 非越狱设备只走主机侧（IPA 静态、代理抓包），不提供设备端工具。
10. root daemon 是最高权限植入物：授权、留痕、可卸载三件事写进产品，不是文档补丁。

```
┌────────────── iPhone（已越狱）──────────────────┐
│ SentinelBridge.app（SwiftUI）                   │
│   配对二维码 / 在线状态 / 引导安装 deb            │
│        │ Keychain 共享 token                    │
│ SentinelBridgeD（root LaunchDaemon）            │
│   exec / file / screencap / tcpdump / frida     │
└───────────────┬─────────────────────────────────┘
                │ 设备主动反连
                │ wss://console/ws/ios?token=…
┌───────────────▼─────────────────────────────────┐
│ DeviceGateway（服务端）                          │
│   心跳 / 分片 / TCP 隧道 / 无响应判定             │
│        │                                        │
│ SentinelRuntime → ios_* 工具 → evidence/ios/    │
└─────────────────────────────────────────────────┘
```

## 1. 范围与定位

**Q1. 这个功能解决什么问题？**
让「全链」从 Web、安卓扩到 iOS，并且不依赖 USB。操作员在控制台里看到设备、跑命令、拉证据；Agent 自己完成收集和分析，证据留在项目工作目录里。

**Q2. 和安卓 Droid 是什么关系？**
同一套设备网关和协议语义，设备端实现不同。工具前缀分 `droid_*` / `ios_*`，会话开关分开。不要把 iOS 伪装成安卓：签名、越狱形态、后台模型、工具链全都不一样。

**Q3. v1 的验收标准是什么？**
一台越狱机装好后：控制台 30 秒内看到在线；Agent 能执行 `id`（root）、拉一个文件、截屏、列应用；断网重连自动恢复；设备重启后 daemon 自动回来；每条 shell 在审计页有记录。

**Q4. v1 明确不做什么？**
〔不做〕非越狱设备的设备端能力；App Store 账号下载 IPA；锁屏密码绕过；多设备编排；iOS 模拟器；UI 自动化点击（v2 再评估）。

**Q5. 支持哪些 iOS 版本和机型？**
三类都保证〔已定〕：rootless 15–16（Dopamine/palera1n）、rootful 14–15（checkra1n/unc0ver）、checkm8 机型的 17/18。产物是 rootful/rootless 两个 deb，运行时探测形态；roothide 仍不支持，识别到就明确报错。iOS 26 的 Dopamine 3 等新工具现场实测后再列入。参考：[palera1n 文档](https://github.com/palera1n/palera1n/blob/main/docs/palera1n.1)、[Dopamine 3 报道](https://www.macrumors.com/2026/08/07/ios-26-dopamine-jailbreak/)。

**Q6. 为什么必须越狱？**
没有 root 就拿不到别的 App 容器、装不了 LaunchDaemon、起不了 tcpdump、attach 不了进程（`task_for_pid`）、读不了 keychain。越狱是能力前提，不是偏好。

**Q7. 非越狱设备一点办法都没有吗？**
有，但只是主机侧：拿 IPA 做静态分析、代理抓包、看备份（需 USB）。这些不需要在设备上装东西，走容器和现有工具；不提供设备端 shell/文件工具。

**Q8. 支持 iPad 吗？**
支持，iPadOS 同一套。但分屏和多任务会打破「前台全屏」假设，v1 以 iPhone 为主，iPad 只保证 daemon 能力，不保证截屏与前台交互。

**Q9. 一台控制台能带几台 iOS 设备？**
v1 建议 ≤8 台在线，按项目隔离 token。网关本身没有硬上限，瓶颈是并发 shell 和 tcpdump。

**Q10. 和 Burp / Charles / objection 是什么关系？**
互补。Burp/Charles 是操作员的交互工具，本功能是给 Agent 用的；frida 既可由 Agent 通过隧道用，也可操作员手工用。不要试图替代它们。

## 2. 交付、签名与越狱形态

**Q11. 为什么 IPA 不能自己装 root daemon？**
iOS 应用由 launchd 以 mobile 用户启动，沙箱禁止写系统目录；LaunchDaemon 必须由 root 写入 `/Library/LaunchDaemons`（rootless 是 `/var/jb/Library/LaunchDaemons`）。IPA 安装器（TrollStore/Sideloadly）给不了 root，最多给 no-sandbox entitlement。所以「装一个 IPA 就得到 root 守护进程」不成立。

**Q12. 有哪几种交付组合？**
A. TrollStore 装 IPA（无 root）+ Sileo 装 deb；B. 自签 IPA + SSH/NewTerm 手动装 deb；C. 只发 deb，无 UI，纯命令行配置；D. 纯 App 降级模式，无 root。

**Q13. 推荐哪一种？**
已定 A。IPA 负责配对、状态、引导，deb 负责能力。TrollStore 不需要证书、不过期，IPA 可以当安装向导；deb 装好后 daemon 独立存活，App 可以关掉甚至删掉。批量或无 UI 场景用 C。

**Q14. 需要 Apple 开发者账号吗？**
不需要。自签 + `ldid` 就够；TrollStore 也不需要。只有 AltStore/Sideloadly 的免费证书会 7 天过期。

**Q15. 自签怎么做？**
`xcodebuild -sdk iphoneos -configuration Release CODE_SIGNING_ALLOWED=NO` 出未签名 app，然后 `ldid -S<entitlements> SentinelBridge`，再打 `Payload/` 成 IPA。daemon 同理，entitlements 至少包含 `platform-application`、`com.apple.private.security.no-sandbox`、`com.apple.private.skip-library-validation`。

**Q16. TrollStore 算什么？**
永久签名安装器：让 IPA 带任意 entitlement 安装且不过期。它不是越狱，不给 root、不装 daemon。它解决「IPA 怎么装」，不解决「权限从哪来」。

**Q17. rootful / rootless / roothide 怎么处理？**
三种布局不同：rootful 用 `/usr/bin`、`/Library/LaunchDaemons`；rootless 用 `/var/jb/usr/bin`、`/var/jb/Library/LaunchDaemons`；roothide 每个 App 一个随机 `.jbroot`，路径不可预测。v1 出 rootful/rootless 两个 deb，postinst 检测 `/var/jb`；三类系统共用同一份 daemon，路径差异收进一个 `PlatformPaths` 模块。hello 识别到 roothide 就拒绝安装并给明确提示。

**Q18. daemon 的 launchd plist 长什么样？**
`Label`、`ProgramArguments`、`RunAtLoad=true`、`KeepAlive=true`、`UserName=root`、`ThrottleInterval=10`、`ProcessType=Background`、`StandardOutPath`、`StandardErrorPath`。rootless 的 plist 放 `/var/jb/Library/LaunchDaemons`，`launchctl` 用 `/var/jb/usr/bin/launchctl`〔待验证〕。

**Q19. 装完怎么验证？**
`launchctl print system/com.zgsfsec.sentinelbridged`；`ps -ax | grep sentinelbridged`；控制台看到 hello；`tail /var/log/sentinelbridge.log`。

**Q20. 设备重启后会自动回来吗？**
会，`RunAtLoad` + `KeepAlive`。但 semi-untethered 越狱（unc0ver/Taurine 等）重启后要先重新越狱，daemon 才会被拉起。这点必须写进部署文档，否则客户会以为坏了。

**Q21. 怎么升级和卸载？**
升级用 `dpkg -i` 覆盖、daemon 重启；IPA 用 TrollStore 覆盖安装。卸载用 `dpkg -r` + `launchctl bootout`，或由 deb 的 `postrm` 停止并删除；App 内不做「自卸载」（它没有 root）。

**Q22. 批量部署怎么省事？**
出离线包：IPA + 两个 deb + 一页说明 + `SHA256SUMS`，再加一个 `install.sh` 走 SSH。越狱设备通常不纳管 MDM，实际就是逐台装。

**Q23. IPA 里到底放什么？**
App 二进制、图标、配对/状态 UI、内嵌 deb、默认配置。不放几十 MB 的 frida-server，由 Agent 按需从容器推到设备。

**Q24. 签名掉了或过期了怎么办？**
TrollStore 和越狱自签不过期；Sideloadly 免费证书 7 天过期，重签 IPA 即可。daemon 在 deb 里，不受 IPA 签名影响。

**Q25. 越狱工具本身要不要打包？**
不打包。越狱工具与机型、系统强绑定，分发有法律和供应链风险。文档给官方链接和校验方式即可。

**Q26. 客户不允许越狱怎么办？**
走 Q7 的主机侧流程，明确能力边界。不要用「免越狱也能全功能」误导客户。

## 3. 设备端架构

**Q27. App 和 daemon 怎么分工？**
App：配对、状态、开关、日志、引导安装 deb。Daemon：全部能力（shell/文件/截图/frida/抓包），开机自启，不依赖 UI。App 只在前台工作，daemon 永远在。

**Q28. daemon 用什么语言写？**
App 用 Swift/SwiftUI；daemon 用 Swift + 少量 ObjC/C（private API、IOKit）。不用 Theos+Swift 的主要原因是工具链和 Swift runtime 打包麻烦；用 Xcode 两个 target 更稳，deb 用脚本打。

**Q29. daemon 以什么身份跑？**
root，由 launchd 的 `UserName=root` 指定。shell 默认 root；`asRoot=false` 时 fork 后 `setgid`/`setuid` 到 mobile 再 exec。Darwin 的 `posix_spawn` 不能切到任意 uid，这一步只能用 fork + setuid。

**Q30. 需要哪些 entitlement？**
`platform-application`、`com.apple.private.security.no-sandbox`、`com.apple.private.security.container-required=false`、`com.apple.private.skip-library-validation`、`get-task-allow`（调试用，发布去掉）。frida-server 用它自己的签名，不要复用 daemon 的。

**Q31. iOS 后台限制怎么绕？**
不走后台任务。普通 App 进后台几十秒就被挂起，`beginBackgroundTask` 只争取约 30 秒；音频/定位后台模式是滥用，也会被用户发现。daemon 由 launchd 管理，不受 App 生命周期限制。

**Q32. 锁屏或息屏还能干活吗？**
daemon 可以。但锁屏后 App 内容可能被系统遮挡，截屏拿到的是锁屏或黑屏；读 App 容器、抓包、frida、文件操作不受影响。

**Q33. 心跳和冻结检测还需要吗？**
需要。App 降级模式会被挂起，socket 还在但不回包；复用安卓的 45 秒无心跳判定和「无响应」提示。daemon 模式基本不触发，但保留同一套判据。

**Q34. 崩溃了怎么办？**
launchd 的 `KeepAlive` 自动拉起；daemon 记录断开原因和最后一条请求到日志；控制台显示「上次断开原因」，不要只显示离线。

**Q35. 多个控制台同时连一台设备？**
不支持。一个 `deviceId` 只保留一个连接，新连接顶掉旧的，与安卓一致。要并行就多台设备。

**Q36. 设备 token 存哪？**
iOS Keychain（`kSecAttrAccessibleAfterFirstUnlock`），App 与 daemon 共享 access group。不写 plist、不写 UserDefaults；日志里不出现 token。

**Q37. 控制台地址变了怎么办？**
地址和证书指纹存在配对配置里；换地址后重新扫码。daemon 支持 `--server` 覆盖，供运维脚本用。

**Q38. 自签 HTTPS 怎么信任？**
URLSession 的 `didReceive challenge` 里比对证书 SHA-256 指纹，指纹来自配对二维码。不匹配就断开，不提供「忽略」开关（调试构建可开）。这样不需要在设备上装 CA。

**Q39. 需要开 SSH 吗？**
不需要。反连就是为了不依赖 SSH。SSH 只作为首次部署的备用通道，用完建议关闭或改掉默认密码。

**Q40. 怎么防越狱检测和反调试？**
这是 frida 脚本的事：hook `fileExistsAtPath`、`stat`、`sysctl`、dyld 检查；反调试（`PT_DENY_ATTACH`、`sysctl`）也在脚本里。不要做进 daemon，保持工具可组合。

## 4. 协议

**Q41. 复用 Droid 协议还是新开一套？**
复用帧语义，新开通道。exec/pull/push/tunnel/心跳/分片的语义完全一样，重写必然分叉；但 hello 字段、能力集、部分帧不同，硬塞进 `DroidRequest` 会让安卓代码到处判断平台。

**Q42. hello 帧带什么？**
`t:"hello", protocol:1, platform:"ios", token, deviceId, model, osVersion, build, arch, jailbreak:{form,name,version}, hasRoot, capabilities:[…], appVersion`。控制台据此决定挂哪些工具、显示什么。

```json
{"t":"hello","protocol":1,"platform":"ios","token":"…","deviceId":"A1B2…",
 "model":"iPhone15,2","osVersion":"16.6.1","build":"20G75","arch":"arm64e",
 "jailbreak":{"form":"rootless","name":"Dopamine","version":"2.0"},
 "hasRoot":true,"capabilities":["exec","pull","push","screencap","tcp","frida"]}
```

请求/应答与安卓同形：

```json
{"t":"exec","reqId":"7","cmd":"id","asRoot":true,"timeoutMs":30000}
{"t":"result","reqId":"7","ok":true,"code":0,"stdout":"uid=0(root) …","stderr":""}
```


**Q43. 二进制怎么传？**
与安卓相同：`data` 帧带 `reqId/seq/b64/done`；push 1MB 分片；单帧 8MB；单流 256MB。不要为新平台另开格式。

**Q44. TCP 隧道怎么用？**
与安卓相同：`tcp_open/send/close` 与 `tcp_opened/tcp_data/tcp_closed`；服务端起回环监听，容器经 `host.docker.internal` 连。frida-server 的 27042 是第一个用户。

**Q45. 新增哪些帧？**
`syslog`、`apps`、`app_info`、`ipa_pull`、`profiles`、`decrypt`、`keychain`、`install_ipa`、`uninstall_app`、`set_proxy`。读取类返回 `result` + `data` 分片，写入类只返回 `result`。

**Q46. 超时和重试怎么定？**
默认 30 秒，上限 600 秒；拉大文件单独 120 秒起；心跳 15 秒、45 秒判无响应。与安卓对齐，减少两套心智。隧道目前没有空闲超时（安卓也没有），关闭跟随连接与请求；要不要加，等真机跑过再定。

**Q47. 版本兼容怎么做？**
hello 带 `protocol:1`；控制台按版本决定可用帧；未知帧回 `result{ok:false,error:"unsupported"}`，不要静默丢弃。

**Q48. 大文件上限？**
单文件 256MB，与安卓一致。IPA 通常小于 200MB；pcap 可能超，超限就让 Agent 分段抓或先压缩，或把上限提到 1GB（需评估内存）。

## 5. 工具集

**Q49. 工具清单总表？**

| 工具 | 作用 | 过门 | 阶段 |
| --- | --- | --- | --- |
| `ios_devices` | 设备列表、能力、越狱形态 | 否 | M1 |
| `ios_shell` | root/mobile shell | 是 | M1 |
| `ios_file_pull` | 拉文件到 `evidence/ios/` | 否 | M1 |
| `ios_file_push` | 从 `/work` 推文件 | 否 | M1 |
| `ios_screencap` | 截屏 | 否 | M1 |
| `ios_list_apps` | 已安装应用 | 否 | M2 |
| `ios_app_info` | bundle/容器/entitlements/URL scheme | 否 | M2 |
| `ios_ipa_pull` | 打包已安装 `.app` | 否 | M2 |
| `ios_install` | 安装 IPA（appinst/ipainstaller，走审批） | 是 | M2 已落 |
| `ios_uninstall` | 卸载应用（走审批） | 是 | M2 已落 |
| `ios_profiles` | 描述文件与信任证书 | 否 | M2 |
| `ipa_info` / `ipa_files` / `ipa_plist` | 容器内 Info.plist/条目/架构/cryptid | 否 | M2 已落 |
| `ipa_search` / `ipa_strings` | 容器内正则检索与 strings | 否 | M2 已落 |
| `ipa_class_dump` | ObjC 类/方法枚举 | 否 | 由 frida 内建 `ios_class_dump` 覆盖（M3） |
| `ios_syslog` | 日志（frida 内建 `ios_nslog`） | 否 | M3 已落 |
| `ios_capture_start` / `ios_capture_status` / `ios_capture_pull` | tcpdump 抓包（按越狱形态找二进制，支持 BPF 过滤） | 否 | M3 已落 |
| `ios_frida_setup` | 推并启动 frida-server（按越狱形态选路径） | 否 | M3 已落 |
| `ios_frida_ps` | 进程/应用列表 | 否 | M3 已落 |
| `ios_frida` | attach/spawn + iOS 内建脚本 | 否 | M3 已落 |
| `ios_http_log` | NSURLSession/NSURLConnection 明文请求/响应，写入 `captures.db` | 否 | P0 已落 |
| `ios_decrypt` | FairPlay 解密（整包扫描/原包保留/重签/第二台机验证） | 否 | P1 已落 |
| `ios_keychain` | keychain 探测/导出 | 否 | M4 已落 |
| `ios_deps` | 检查 tcpdump/frida-server/appinst/ldid/bfdecrypt/keychain_dumper 是否可用 | 否 | deb-only 已落 |
| `ios_url_open` | 深链测试（走审批） | 是 | M3 已落 |
| `ios_ui_tap` | UI 自动化 | 是 | 〔不做〕v1 |

**Q50. `ios_devices` 返回什么？**
id、名称、型号、系统版本、越狱形态、架构、root、在线/无响应、能力集、最后心跳。字段直接来自 hello，不做二次推断。

**Q51. `ios_shell` 怎么执行？**
与 `droid_shell` 同构：`command`、`device`、`asRoot`、`timeoutSecs`。必须先过 `guardIosCommand`（三模式同一套）；daemon 里 `posix_spawn("/bin/sh","-c",cmd)`，捕获退出码、stdout、stderr，输出超过 16k 截断并提示写文件。

**Q52. 文件 pull/push 有什么约束？**
pull 落到 `evidence/ios/`，push 从 `/work` 读；路径必须绝对；拒绝 `/`、空路径和 `..` 穿越；超过 256MB 拒绝。分片规则与安卓共用。

**Q53. 截屏怎么实现？**
两条路：daemon 用 `CARenderServerRenderDisplay` + ImageIO 出 PNG（root，锁屏可能黑屏）；或推一个 `screenshot` helper。v1 先做前者，失败回退 helper〔待验证：iOS 15–18 私有 API 行为〕。

**Q54. 日志怎么拿？**
这是最弱的一环。iOS 没有 Android logcat 的等价 CLI。可选：装 `syslogd` 读 `/var/log/syslog`、frida hook `NSLog`/`os_log`、主机侧 `idevicesyslog`（需 USB）。v1 做「按 App + 关键字 + 时长」的 frida 采集；daemon 的 `syslog` 帧只在 syslogd 存在时可用。

**Q55. 应用列表和详情怎么拿？**
遍历 `/var/containers/Bundle/Application/*/iTunesMetadata.plist` 与 `.app/Info.plist`，拿 bundle id、名称、版本、容器 UUID；数据容器在 `/var/mobile/Containers/Data/Application/<uuid>`，按 `.com.apple.mobile_container_manager.metadata.plist` 匹配。

**Q56. 容器路径怎么定位才可靠？**
bundle 容器和 data 容器是两套 UUID。最稳的是 `mcm`（MobileContainerManager）私有框架；v1 用 Info.plist + metadata 匹配，失败再 `find`，并在结果里注明「推断路径」。

**Q57. 怎么拉已安装 App 的 IPA？**
`ditto -c -k --sequesterRsrc --keepParent App.app App.ipa`（设备上没有 `ditto` 就用 `zip -r`）。注意：App Store 应用拉下来仍是 FairPlay 密文，需要 Q58。

**Q58. 解密怎么做？**
FairPlay 只能 dump 运行时已解密的页：frida spawn 目标 App，读 `__TEXT` 的 `cryptoff/cryptsize`，写回 Mach-O、把 `cryptid` 置 0，再连 Frameworks/PlugIns 一起重新打包成 IPA。当前实现：控制台先扫描整个 bundle 的 Mach-O（`ios-bundle.ts`），dump 后对比应解/已解/漏解并重扫确认；保留原密文 IPA，两个 IPA 和替换二进制都算 SHA-256，dump 大小与 bundle 原文件比对；dump 前用 `ldid -e` 读 entitlements，替换后用 `ldid -S` 重签；frida 失败回退设备上的 `bfdecrypt`。`verifyDevice` 可把产物装到第二台设备并读回 `cryptid 0`。`bagbak` 需要 USB 主机，当前未接入；`CrackerXI` 是 GUI，未脚本化。详见第 11 节。

**Q59. 静态分析在哪跑、用什么？**
容器里跑，不进设备：`ipsw`（Mach-O/entitlements/symbols）、`lief`（Python 解析）、`plutil`/`libplist`、`nm`/`strings`/`otool`（llvm）、`class-dump`（ObjC 头）。命名与 `apk_*` 对称，用 `ipa_*`。

**Q60. keychain 怎么 dump？**
`keychain_dumper` 或 frida hook `SecItemCopyMatching`；`/var/Keychains/keychain-2.db` 是加密的，直接读没用。v1 只判断「可 dump / 不可 dump」，M4 做导出。

**Q61. 描述文件和信任证书？**
`/var/mobile/Library/UserConfigurationProfiles`、`/Library/Managed Preferences`，信任证书在 `TrustStore.sqlite`。`ios_profiles` 只读列出，不导入不删除。

**Q62. tcpdump 怎么装、怎么跑？**
优先用设备已有的 `/usr/sbin/tcpdump`（rootful）或 `/var/jb/usr/sbin/tcpdump`（rootless）；没有就推静态编译的二进制。先 `tcpdump -D` 列接口，默认抓 `en0`（蜂窝是 `pdp_ip0`），不要假设 `-i any` 可用。`tcpdump -i en0 -w /tmp/x.pcap -s 0`，停止后 pull，容器里用 tshark 解析；`ios_capture_pull` 会把明文 HTTP 用 `-T json` 转成 `captures.db` 条目，`capture_import` 也支持 `pcap` 格式。HTTPS 仍要用 `ios_http_log` 从 NSURLSession 层取。

**Q63. frida 怎么部署？**
与安卓同：推 `frida-server` 到 `/usr/bin` 或 `/var/jb/usr/bin`，`chmod 755`，root 启动，隧道到 27042。版本必须与容器 frida 一致；rootless 用 `fruity-frida` 的 rootless 构建（[fruity-frida](https://github.com/ChiChou/fruity-frida)）。

**Q64. SSL pinning bypass 与明文日志脚本？**
内置 `ios_ssl_bypass`（SSLKillSwitch 思路，hook `SecTrustEvaluate`/`SecTrustEvaluateWithError`/BoringSSL）、`ios_jailbreak_bypass`、`ios_nslog`、`ios_class_dump`、`ios_decrypt_dump`、`ios_http_log`（NSURLSession/NSURLConnection 请求、响应、头、body、状态码；不需要代理/CA）。`ios_http_log` 的结果由 `ios_http_log` 工具解析并写入 `captures.db`；`ios_crypto_log` 仍未实现。和安卓脚本库同一目录管理。

**Q65. 越狱检测 bypass 怎么做？**
见 Q40。用 frida hook 常见检测点，不改 App 二进制。脚本失败要明确回「未生效」，不要假装成功。

**Q66. URL scheme / 深链怎么测？**
读 Info.plist 的 `CFBundleURLSchemes`，用 `uiopen` 或 frida 调 `UIApplication openURL`。深链会改变 App 状态，建议过门。

**Q67. UI 自动化（点击/输入）做不做？**
v1 不做。真要做，daemon 里用私有 `IOHIDEvent` 注入或 frida 调 `UIControl sendActions`；稳定性和版本适配成本很高。

**Q68. 安装/卸载 IPA 怎么做？**
`ios_install_ipa`：推 IPA 到 `/tmp`，用 `ipainstaller`/`installipa` 或 `appinst`；卸载删 bundle + `uicache`。这两步改变设备状态，必须过门。

**Q69. 全局代理怎么设？**
iOS 没有可靠的全局 HTTP 代理写入点。v1 不做「一键全局代理」，只给 shell 命令建议；抓包以 tcpdump 和 frida 为主。

**Q70. 设备信息/电量/存储？**
用 `sysctl`/IOKit 取型号、电量、磁盘。v1 只放进 hello 和 `ios_shell`，不单独开工具。

**Q71. 不接 USB 能做备份吗？**
不能做整机备份。`idevicebackup2` 需要主机 USB。设备端能读容器文件，但「整机备份」不在 v1。

**Q72. 定位/麦克风/相机？**
〔不做〕。高敏感能力，超出渗透测试必要范围，合规风险高。

**Q73. 工具命名和描述风格？**
描述写「做什么 + 边界 + 证据落哪」，与 droid 一致；`device` 参数可省略（单台在线时）。

**Q74. 哪些工具要过审批？**
`ios_shell`、`ios_install_ipa`、`ios_uninstall_app`、`ios_url_open`（改变状态）过门。读取类不过门。与安卓的差异是「装/卸」从 shell 提升为独立工具，所以单独过门。

**Q75. 哪些工具 v1 不做？**
UI 自动化、整机备份、定位/相机/麦克风、App Store 下载、iCloud 数据、锁屏密码绕过、远程自毁。

## 6. 服务端与控制台

**Q76. 新 store 还是复用 droid？**
已定：独立 `ios.ts` + `ios.db`，不动 `droid.ts`。代价是约 700 行重复；为了不让两边漂移，把分片重组、帧校验、隧道握手抽成 `device-transport.ts` 共用，并加一份 fake 客户端契约测试，让两个网关跑同一组帧用例。等 iOS 稳定后再评估是否合并成 `DeviceGateway`。

**Q77. 网关怎么复用？**
已定：新增独立 `ios-gateway.ts`，服务端挂新的 upgrade 路径 `/ws/ios`，`/ws/droid` 与已部署 APK 完全不动。两个网关共用一个 `ws` 升级分发器，避免抢同一个 path。

**Q78. 会话开关怎么存？**
`zg-ios` 自定义条目，读法同 `session-droid.ts`；默认 false；fork 继承；删除条目即关闭。

**Q79. 权限页要不要加开关？**
不加新权限键。安卓的开关就是会话开关，iOS 沿用；`ios_shell` 的权威控制在命令门，不在工具挂载。

**Q80. 守门员怎么知道这是 iOS 命令？**
`guardIosCommand` 与 `guardDroidCommand` 同一套三模式，审计 `tool` 写 `ios_shell`，来源写 `iOS 设备「X」`。守门员提示词已经把「设备 shell」纳入判定对象，不需要改模型。

**Q81. 前端页面放哪？**
侧栏「工作台 → iOS 设备」，与「安卓设备」并列。页面复制 DroidPage：令牌、二维码、在线列表、监听地址，另加越狱形态/架构两列。

**Q82. 协议消息要不要改名？**
v1 新增独立消息 `ios_state`/`ios_token_*`，不改 `droid_*` 消息；等前端稳定后再考虑合并为 `device_*`。避免一次重构同时动两端。

**Q83. 证据存哪？**
`evidence/ios/` 下按类型分：`screenshots/`、`ipas/`、`pcap/`、`files/`、`keychain/`，与 `evidence/droid/` 并列。

**Q84. 删除项目怎么清理？**
删项目时清 `ios.db` 里该项目的使用记录；设备 token 是全局的，不随项目删。证据文件在项目目录里，随项目删。

**Q85. 中英文案？**
走 `i18n-messages.ts`，新增约 40 条；页面文案同 DroidPage。错误信息必须给可操作建议（重开 App、重装 deb、检查 launchctl）。

**Q86. 审计页怎么区分安卓和 iOS？**
审计已有 `tool` 字段，`ios_shell` 与 `droid_shell` 天然分开；来源标签区分「iOS 设备「X」」。

## 7. 安全与合规

**Q87. root daemon 的风险边界？**
daemon 以 root 运行，能读整机、能改系统，权限比安卓 App 更高。产品上必须：只连授权控制台、token 可吊销、TLS 指纹固定、每条 shell 过门并留审计、提供一键卸载。

**Q88. token 泄露怎么办？**
控制台删 token 后，设备下次 hello 被拒，已建立的连接立即断开。token 泄露等于对方能 root 你的测试机，按凭据泄露处理。

**Q89. 设备丢失怎么办？**
远程吊销 token，建议操作员抹机。daemon 不做「远程自毁」，太危险。

**Q90. 客户数据怎么留？**
证据在项目目录、数据库在配置目录、日志可关；文档写明留存周期和删除方式。默认不采集与目标无关的数据。

**Q91. 供应链怎么校验？**
frida 用官方发布 + sha256；越狱工具给官方源；不内置第三方二进制。控制台记录设备上 frida 的版本和哈希。

**Q92. 会不会被 Apple/EDR 发现？**
越狱设备本身就是「已被攻破」状态，企业 EDR/MDM 可能检测越狱并告警。渗透测试应使用客户提供的测试机或自备机，不要用员工日常机。

**Q93. 怎么防未授权设备接入？**
gate + 登录 + 授权承诺 + 设备 token 四层。控制台默认监听 0.0.0.0 是现状，文档要强调反代/防火墙，别把控制台裸露在公网。

**Q94. 免责声明怎么写？**
复用现有授权声明，新增「iOS 设备端」章节：越狱风险、root 权限、数据留存、卸载方法、仅限授权设备。

## 8. 测试与交付

**Q95. 没有真机怎么开发？**
服务端可以完全脱离真机：写 fake iOS 客户端跑协议，UI 用 mock 状态。真机只用于 daemon 和私有 API 验证。

**Q96. fake device 怎么写？**
`packages/web/test/fake-ios.ts`：用 `ws` 连 `/ws/ios`，按 hello/exec/pull 应答，支持注入延迟、错误、分片乱序，覆盖超时与重组逻辑。

**Q97. 单测覆盖什么？**
store 的 token/平台字段、hello 校验、帧路由、分片重组、隧道、`guardIosCommand` 三模式、工具挂载规则、协议版本拒绝。

**Q98. e2e 怎么跑？**
vitest + fake 客户端，不依赖真机；真机 e2e 用手工清单，验收项就是 Q3 列的那些。

**Q99. 构建流水线？**
服务端 CI 不变。iOS 用 GitHub Actions `macos-14` + Xcode 构建两个 target，`ldid` 签名，`dpkg-deb` 打包，产物算 sha256；不需要 Apple 账号。

**Q100. 发布物有哪些？**
`SentinelBridge.ipa`（TrollStore/自签）、`sentinelbridge-rootful.deb`、`sentinelbridge-rootless.deb`、`install.sh`、`SHA256SUMS`、一页部署文档。

**Q101. 文档写什么？**
部署（三种形态）、能力矩阵、安全边界、卸载、故障排查（不自动启动/被挂起/签名掉/launchctl 报错）、协议文档（给二次开发）。

## 9. 里程碑与工作量

| 阶段 | 内容 | 出口标准 | 相对量 |
| --- | --- | --- | --- |
| M0 | 独立 `ios.ts`/`ios.db`/`ios-gateway.ts` + `/ws/ios` + 共用 transport + fake 客户端 | droid 测试不受影响；fake iOS 能 hello/exec/分片 | 已完成（2026-10-22） |
| M1 | daemon 骨架：exec/pull/push/screencap + 两个 deb + launchd | 真机 root shell、拉文件、截屏；重启自恢复 | 代码完成（2026-10-22），真机验收待做 |
| M2 | 应用面：list_apps/app_info/ipa_pull/install/uninstall/profiles + `ipa_*` 静态 | Agent 能拉 IPA 并出结构化报告 | 进行中（2026-10-22）：设备清单/IPA 拉取/安装卸载与静态 `ipa_*` 已落，真机安装验收与拉取耗时优化待做 |
| M3 | 动态：frida 隧道 + 脚本 + tcpdump + 日志 | attach 目标 App、抓包落证据 | 代码完成（2026-10-22），真机验收待做 |
| M4 | 深度：FairPlay 解密 + keychain + 三形态适配 | 加密 App 能 dump 并验证；keychain 可导出 | 进行中（2026-10-22）：`ios_decrypt`/`ios_keychain` 已落，两设备验收与三形态适配待做 |
| M5 | 打磨：i18n/文档/审计/权限页/发布 | 可交付 | S |

单人估算约 15–19 周，不含真机采购与越狱适配等待。解密和三种越狱形态各贡献约 2–3 周的不确定性，建议单独留 50% 缓冲。

## 10. 已定决策与剩余问题

| # | 决策 | 结论 | 影响 |
| --- | --- | --- | --- |
| 1 | 交付模型 | deb-only + 本地 setup 页 | 2026-10-22 起移除 IPA；一个 deb 完成安装与配对 |
| 2 | FairPlay 解密 | 进 v1，按实验性能力交付 | M4 增加 2–3 周；不作为发布阻塞项 |
| 3 | 服务端网关 | 新增独立 `ios-gateway.ts` / `ios.ts` / `ios.db` | 安卓零回归；需共用 transport 防漂移 |
| 4 | 目标系统 | rootless 15/16 + rootful 14/15 + checkm8 17/18 | 两个 deb、形态探测、测试机至少 4 台 |
| 5 | daemon 语言 | Swift + 少量 ObjC/C | Xcode 两个 target，deb 用脚本打 |

仍需确认：

| # | 问题 | 建议 |
| --- | --- | --- |
| 1 | 是否在安装包里内置 `bfdecrypt` 作为解密回退 | 不内置，让 Agent 按需从 `/work` 推，避免供应链问题 |
| 2 | 最低支持到 iOS 14 是否值得 | 值得，老设备现场占比不低；但只保证 rootful deb |
| 3 | 调试时是否允许设备走 `--no-tls` | 允许，仅调试构建，正式构建强制指纹校验 |
| 4 | 单控制台在线设备上限 | 8 台，超出只警告不拒绝 |

## 11. FairPlay 解密专项（v1）

**Q102. v1 解密的目标是什么？**
输入 bundle id（或设备上的 `.app` 路径），输出 `evidence/ios/ipas/<name>-decrypted.ipa`：Mach-O 的 `cryptid` 为 0，能在另一台测试机安装并启动。不要求「一定能解开」，要求「失败时说清原因」。

**Q103. 为什么不能直接拉 `.app`？**
App Store 二进制的 `__TEXT` 是 FairPlay 密文，只有进程运行时系统才把用到的页解密到内存。直接 `ios_ipa_pull` 拿到的是密文，`class-dump`/`strings` 只能看到壳。

**Q104. 用哪条路径？**
按顺序回退：自研 frida 脚本（推荐，已实现）→ 设备上的 `bfdecrypt`（已实现，自动探测）→ `bagbak`（需要 USB，未接入）/ `CrackerXI`（GUI，未脚本化）。自研脚本的理由是我们已经有 frida 隧道，不依赖 USB。

**Q105. 在哪跑？**
解密在设备上、由 frida 脚本用 `File` API 写到 `/tmp/decrypted`，再用 `ios_file_pull` 拉回；容器里只做解包、替换二进制、修 `cryptid`、重打包。不要通过 WebSocket 传几十 MB 内存块，慢且容易 OOM。

**Q106. 设备要满足什么前提？**
目标 App 已安装且能正常启动（该登录的已登录）、frida-server 与容器版本一致、daemon 有 root、目标没有检测 frida/越狱（有就先跑 bypass 脚本）、Apple ID 已授权这台设备。少一条就会失败，所以工具要先做前置检查并逐条报告。

**Q107. 解密流程？**
1. `ios_app_info` 拿 bundle 路径与主二进制 `cryptid`；2. 拉整个 bundle 后扫描所有 Mach-O 得到应解列表；3. frida `spawn` 目标（挂起启动），脚本遍历已加载镜像、按 4MB 分块写 `/tmp/sentinel-decrypt`；4. 控制台拉回镜像、按 `manifest` 与原文件大小比对、替换 `.app` 内二进制、权限 755、`cryptid` 置 0；5. 用 dump 前读到的 entitlements 对替换二进制 `ldid -S` 重签；6. 归档原密文 IPA、重打包解密 IPA，整包重扫确认无残留密文；7. 写报告（前后 cryptid、SHA-256、漏解、告警）；8. 可选 `verifyDevice` 在第二台设备安装并读回 cryptid 0。

**Q108. 怎么验证成功？**
控制台侧：`machoInfo` 看每个替换后二进制的 `cryptid 0`，再整包重扫 `afterImages` 确认没有漏网；SHA-256 记录解密前后；`verifyDevice` 在另一台设备 `appinst` 后用 `app_info` 读回 `cryptid 0`。`ipsw`/`class-dump` 当前不在容器镜像里，作为可选增强。

**Q109. 失败模式有哪些？**
越狱/frida 检测导致启动即退出；反调试 `PT_DENY_ATTACH`；只 dump 了主二进制、框架仍是密文；App 扩展单独加密；Swift 元数据不在 `__TEXT`；大 App 读超时；目标需要网络/账号。每种都要有对应错误码和下一步建议，不要只回「失败」。

**Q110. 大 App 和框架怎么处理？**
按 4MB 分块读整个镜像（包含 `__LINKEDIT`，避免只读 `cryptsize` 导致重打包缺页），设备端边读边写，不攒内存；控制台先扫描 bundle 得到应解列表，dump 后报告 `missing`（未加载/未产出）与 `stillEncrypted`，不要假装完整；总超时 10 分钟，可中断。

**Q111. 证据怎么留？**
原 IPA（密文）、解密 IPA、`cryptid` 前后值、整包扫描/漏解/替换后重扫结果、设备型号/系统/越狱形态、时间、两个 IPA 与替换二进制的 SHA-256、失败原因。报告里写明「解密仅用于本次授权测试」。

**Q112. 合规边界？**
只在授权设备、授权目标上做；解密产物不传播、不公开、测试结束按客户要求删除；不绕过 App Store 购买。

**Q113. 什么算 v1 解密完成？**
两台不同越狱形态的设备上，各成功 dump 一个真实 App 并安装启动；失败路径有清晰错误。做不到就降级成「实验性，默认关闭」，不要阻塞整个 v1 发布。

## 12. 三种越狱形态的打包与测试

**Q114. 两个 deb 有什么差异？**
只有安装路径和 `postinst`/`prerm` 不同：rootful 写 `/usr/bin`、`/Library/LaunchDaemons`；rootless 写 `/var/jb/usr/bin`、`/var/jb/Library/LaunchDaemons`。daemon 是同一份源码，entitlements 相同；rootful 包用 `IOS_MIN=14.0` 构建，rootless 用 15.0，因为二进制的最低系统版本写在 Mach-O 里。

**Q115. 运行时怎么探测形态？**
`/var/jb` 存在 → rootless；否则检查 `/usr/libexec/cydia` 或 root 下的 `/Library/LaunchDaemons` → rootful；都不典型 → `unknown`。daemon 不因 unknown 拒绝启动，而是把探测结果放进 hello，由控制台显示兼容性；roothide 由控制台以 4005 拒绝。

**Q116. iOS 14/15/16/17/18 有哪些差异要兜？**
`launchctl bootstrap` 在 15+ 才稳定（14 用 `load`）；`uicache` 路径随越狱变化；截屏私有 API 在 16+ 行为变化；`dpkg`/`apt` 在 rootless 下走 `/var/jb`；`tcpdump` 接口名不同。集中进 `PlatformPaths` 与 `Capabilities` 两个模块，不要散在工具里。

**Q117. 测试矩阵最少几台？**
4 台：rootless 15、rootless 16、rootful 14、checkm8 17（palera1n）。再加 1 台只装 TrollStore 的设备验证降级模式，共 5 台。每台记录越狱工具版本。

**Q118. CI 怎么构建？**
GitHub Actions `macos-14` + Xcode 构建 app 与 daemon，`ldid` 签名，脚本生成两个 deb 和 IPA，产物算 sha256。真机矩阵不进 CI，用手工清单。

**Q119. 版本兼容策略？**
daemon 的 hello 上报 `osVersion`/`jailbreak.form`；控制台按能力集挂工具，不按版本号猜。新系统先跑「只读能力」验证，再放开写入类工具。

**Q120. 现场排查清单？**
`launchctl print` 是否加载、`ps` 是否有进程、日志最后一行、`/var/jb` 是否存在、token 是否被吊销、控制台地址与证书指纹是否匹配、设备时间是否正确（TLS 失败常见原因）。

## 13. 决策记录

| 日期 | 决策 | 结论 | 备注 |
| --- | --- | --- | --- |
| 2026-10-22 | 交付模型 | deb-only + setup 页 | IPA 已移除；配对由 127.0.0.1:9945 完成 |
| 2026-10-22 | FairPlay 解密 | 进 v1，实验性 | 两台设备跑通为验收线 |
| 2026-10-22 | 网关 | 独立 `ios-gateway.ts` | 共用 transport + 契约测试 |
| 2026-10-22 | 目标系统 | 三形态全覆盖 | 两个 deb |
| 2026-10-22 | daemon 语言 | Swift + 少量 ObjC/C | Xcode 双 target |


## 14. M0 实现记录

2026-10-22 完成。`npm run check` 通过；新增 27 个测试（`ios.test.ts` 18 个、`device-transport.test.ts` 9 个），与 droid 测试同跑 47 项通过。

| 文件 | 作用 |
| --- | --- |
| `packages/web/src/device-transport.ts` | 与平台无关的帧编码/8MB 上限、分片重组（含乱序拒绝）、请求登记与超时清理 |
| `packages/web/src/ios-protocol.ts` | v1 帧定义：hello/welcome/hb/exec/pull/push/screencap/tcp_*、能力集、越狱形态 |
| `packages/web/src/ios.ts` | `ios.db`：token、设备、meta；字段按机型/系统/架构/越狱形态建模 |
| `packages/web/src/ios-gateway.ts` | `/ws/ios` 反连、token 鉴权、hello 校验、分片、push、TCP 隧道、45s 无响应判定 |
| `packages/web/src/server.ts` | 在 gate 之前处理 `/ws/ios`；服务关闭时释放 gateway/store |
| `packages/web/test/fake-ios.ts` | 假设备：hello/exec/push 自动应答，可关自动应答手工注入乱序、断线、冻结 |
| `packages/web/test/ios.test.ts` | 端到端覆盖鉴权、握手、超时、流、push、替换连接、roothide 拒绝、隧道、冻结恢复 |

M0 有意未做：控制台页面、token 管理 API、Agent 工具、daemon 与 deb。token 目前只能通过 `IosStore` 创建；M1 接页面时补 `ios_tokens` 的增删查与“删除即断开在线设备”。

握手拒绝规则：`platform != "ios"`、`protocol != 1`、缺 `deviceId` 用 4002；`roothide` 用 4005 并提示不支持。同一 `deviceId` 的新连接替换旧连接（4003），旧连接的隧道与在途请求一并失败，避免指向已关闭的 socket。设备 45s 没有任何帧即判无响应，第一个后续帧（含心跳）恢复；这与“socket 还开着但进程被 iOS 挂起”的真实现象对应。


## 15. M1 实现记录

2026-10-22 完成控制台管理面、Agent 工具和 daemon 骨架；真机安装与截屏仍待设备验收。

| 文件 | 作用 |
| --- | --- |
| `packages/web/webui/src/components/IosPage.tsx` | 反连地址、token 创建/显示/复制/二维码/删除、设备列表（stale/重命名/移除）、接入指引 |
| `packages/web/webui/src/App.tsx`、`AppSider.tsx`、`Composer.tsx` | `ios` 路由、侧栏入口、按对话挂载 `ios_*` 的「iOS」开关 |
| `packages/web/src/ios-tool.ts` | 5 个工具；`ios_shell` 走守门/审批与审计，pull/push 限制在项目工作目录，证据落在 `evidence/ios/{screenshots,files}` |
| `packages/web/src/sentinel-session.ts`、`session-ios.ts` | 每会话 `iosOn`、`zg-ios` 标记、工具挂载/摘除、token 与设备 CRUD |
| `packages/web/ios/Sources/SentinelBridge/*.swift` | 反连、心跳、重连、exec（posix_spawn）、pull/push、截屏、TCP 隧道、TLS pin、配置与设备 ID |
| `packages/web/ios/scripts/build-ios.sh`、`build-deb.sh`、`debian/*` | arm64 构建 + ldid 签名；rootful/rootless 两个 deb 与 launchd |
| `packages/web/test/ios-tool.test.ts`、`session-ios.test.ts`、`ios-daemon.test.ts` | 工具契约、会话开关、真实 Swift daemon 的主机端到端 |

验证：

- `npm run check`、`npm run check:webui` 通过；新增工具/会话测试 13 项，与既有 iOS 测试一起通过。
- macOS `swift build` 通过；`test/ios-daemon.test.ts` 用同一份源码连真实 Node 网关，覆盖 hello、exec、1.5MB 分片 pull/push、TCP echo、SIGTERM 退出。该测试在未构建二进制时跳过。
- iOS SDK 交叉编译通过：`arm64-apple-ios14.0`，`LC_BUILD_VERSION` 的 `platform IOS / minos 14.0`；`IOS_MIN=15.0` 用于 rootless。
- 未验证：真机 launchd、rootless/rootful 路径、`_UICreateScreenUIImage` 截屏、TLS pin 握手、iOS 14 实际运行。`ldid` 与 `dpkg-deb` 不在当前主机，deb 只做了 staging 结构校验。

M1 的边界与已知限制：

- daemon 的 exec/pull/push 串行执行；一次大文件 pull 会挡住同一设备的其它请求，M2 再按请求并发化。
- exec 以 daemon 自身身份运行（越狱包是 root，TrollStore 受限模式是 mobile）；还没有「以 mobile uid 跑 App 上下文」的能力，M2 补。
- 截屏依赖私有 `_UICreateScreenUIImage`，iOS 16+ 若失效只返回错误，不阻塞其它工具。
- TLS pin 已实现但只比对叶证书；控制台换证书需要同步更新配置。
- TrollStore 受限模式（无 root、只能跑 App sandbox）尚未出 IPA；当前只有两个越狱 deb。
- roothide 仍不支持；检测到 `/var/jb/.roothide` 时上报 `roothide`，但控制台会拒绝。


## 16. M2 实现记录（进行中）

2026-10-22 完成应用面第一刀：设备清单、IPA 拉取、安装卸载、profile 列表与 `ipa_info`/`ipa_files` 静态读取。

协议新增：`apps_list`、`app_info`、`app_bundle`、`profiles_list`、`install`、`uninstall`。结构化结果统一放在 `result.stdout` 的 JSON 里，网关与 `IosResult` 不变，避免为每种清单再造一套帧。

| 位置 | 作用 |
| --- | --- |
| `packages/web/ios/Sources/SentinelBridge/AppInventory.swift` | Info.plist、容器、框架、URL scheme、profile 扫描、`ldid -e` entitlements、appinst/ipainstaller 安装卸载 |
| `packages/web/ios/Sources/SentinelBridge/MachO.swift` | 读 Mach-O 的架构与 `LC_ENCRYPTION_INFO` cryptid，fat/thin 都支持 |
| `packages/web/src/ios-tool.ts` | `ios_apps / ios_app_info / ios_ipa_pull / ios_profiles / ios_install / ios_uninstall / ipa_info / ipa_files / ipa_strings / ipa_search / ipa_plist` |
| `docker/Dockerfile` | 增加 `libplist-utils`，`ipa_info` 用 `plistutil` 转 XML plist |

关键设计：**设备不打包 IPA**。`app_bundle` 只返回相对路径/大小/权限/软链目标，控制台逐个 `pull` 到 `evidence/ios/ipa/<bundle>-<时间>/Payload/<App>.app/`，再在工程容器里 `zip -r -y` 出 IPA。这样手机不需要 `zip`，同一份清单也让“拉了哪些文件”可审计。上限 20000 个文件 / 2GB，超过直接报错而不是悄悄截断。

`ios_install` / `ios_uninstall` 走 `ctx.guard`（审计与审批），`ios_apps` / `ios_app_info` / `ios_profiles` / `ipa_info` / `ipa_files` 只读。`ios_app_info` 的 `cryptid` 非 0 时会明确标注“未解密”，把 FairPlay 留到 M4，而不是让静态分析得到误导性结论。

静态分析第二刀：`ipa_strings`（主可执行或指定条目的 strings，长度阈值可调）、`ipa_search`（解包后整包 grep -E，返回 file:line，上限 500 行）、`ipa_plist`（打印任意条目为 XML plist）。三者都在工程容器里跑，路径先过 `insideWorkDir`，条目通过位置参数传入，不拼 shell。

CMS 描述文件：iOS 没有公开的 CMSDecoder，`profilePlist` 在签名数据里扫描内嵌的 `<?xml`/`bplist00` 再交给 PropertyListSerialization。`ios_app_info` 因此能报 `provisionUUID / provisionName / provisionExpiration / provisionApplicationIdentifier / provisionEntitlements`，`ios_profiles` 也从“只有文件名”升级为解析出 UUID、团队与到期时间。主机契约测试用带前缀字节的伪 CMS 覆盖了这条路径。

剩余：真机安装验收（appinst/ipainstaller 在 rootless/rootful 的实际表现）、`ipa_info` 依赖容器 `plistutil`（镜像已加 `libplist-utils`，需重建镜像）、大 App 逐文件拉取的耗时优化。


## 17. M3 实现记录（进行中）

2026-10-22 完成动态面第一刀：frida 隧道、iOS 内建脚本、日志采集与深链测试。抓包（`ios_capture_*`）留到下一刀。

| 位置 | 作用 |
| --- | --- |
| `packages/web/src/frida-scripts-ios.ts` | 4 个 ObjC 层内建脚本：`ios_ssl_bypass`、`ios_jailbreak_bypass`、`ios_nslog`、`ios_class_dump`；与 Android 注册表分开，避免同名脚本语义混淆 |
| `packages/web/src/ios-frida-tool.ts` | `ios_frida_setup / ios_frida_ps / ios_frida / ios_syslog / ios_url_open`，复用 `openTunnel` 与容器的 frida CLI |

复用而非重写：`sectionOutput` 从 `frida-tool.ts` 导出后直接给 iOS 用，多脚本输出仍按脚本分节、各自限额；参数注入（`sp()`）与 `?k=v` 解析也复用 Android 那一套。

iOS 的差异点只有两处，都在这一层处理：

1. **frida-server 路径随越狱形态变化**：rootless/roothide 用 `/var/jb/usr/bin/frida-server`，rootful 用 `/usr/bin/frida-server`；`ios_frida_setup` 从设备记录的 `jailbreakForm` 选路径，测试覆盖了两种形态。
2. **脚本是 ObjC/C 层**：Android 的 `okhttp_log`、`ssl_pinning_bypass` 在 iOS 上无效。`ios_ssl_bypass` 替换 `SecTrustEvaluate` / `SecTrustEvaluateWithError` 并处理 BoringSSL 的 `SSL_CTX_set_custom_verify`；`ios_jailbreak_bypass` 同时打 `access`/`stat`/`lstat`/`fopen`/`open` 与 `NSFileManager fileExistsAtPath:`、`UIApplication canOpenURL:`；`ios_nslog` 打印 NSLog 与 os_log 的格式串（变参无法安全重放，文档里写明了）；`ios_class_dump` 用于 hook 前确认类与方法名。

`ios_syslog` 是 `ios_nslog` 的有界封装（默认 20 秒、可过滤），不引入第二个日志通道。`ios_url_open` 走 `ctx.guard`，审计行与 `ios_shell` 同源。

抓包第二刀：`ios_capture_start / ios_capture_status / ios_capture_pull`（`ios-capture-tool.ts`）。tcpdump 不随 iOS 提供，也不推二进制：工具在设备上按 `/var/jb/usr/bin`、`/usr/bin`、`/usr/local/bin` 顺序探测，缺失时提示用 Sileo 安装。默认接口 `any`，Wi-Fi 用 `en0`、蜂窝用 `pdp_ip0`；支持 BPF 过滤，过滤表达式经单引号转义后作为独立参数进入 exec 命令，不拼 shell。抓包文件写 `/var/tmp/sentinel-capture.pcap`，pull 时先 `pkill` 再走既有分片拉取，落 `evidence/ios/captures/`，容器内用 tshark 输出协议分布、明文 HTTP 请求、DNS 查询与 TLS SNI。

未做：frida-server 的自动下载（当前要求 `/work/frida-server` 已存在并给出下载命令）、Swift 符号级 hook、抓包流式（当前是停止后一次性拉取）。


## 18. M4 实现记录（进行中）

2026-10-22 完成深度面第一刀：`ios_decrypt` 与 `ios_keychain`。

**FairPlay 解密**（`ios-decrypt-tool.ts` + frida 内建 `ios_decrypt_dump`）。按第 11 节的设计，解密发生在设备上、由 frida 脚本完成：spawn 目标 App，遍历路径落在 `.app` 内且 `cryptid != 0` 的已加载 Mach-O，把整个镜像按 4MB 分块读出（内核在读加密页时解密）写到 `/tmp/sentinel-decrypt`，同时写 `manifest.json`，然后退出进程。控制台只做剩下的事：把原始 bundle 拉到 staging、用 dump 出来的镜像覆盖对应文件、把 `cryptid` 置 0、`chmod 755`、zip 成 `evidence/ios/ipas/<name>-decrypted.ipa`，并写同名 `.json` 报告（原/后 `cryptid`、每个二进制的 sha256、设备与越狱形态、时间、授权声明）。

没有把几十 MB 内存块塞进 WebSocket：dump 走设备端文件，控制台逐个分片拉取。失败按第 109 条分开报：frida 隧道不通、manifest 没产出（启动即退出/反调试/脚本未命中）、单个镜像拉取失败、`cryptid` 未清零，各自有独立信息，框架没加载只记 warning 不假装完整。

Mach-O 读写抽到 `packages/web/src/macho.ts`：`machoInfo`（arch/cryptid/cryptoff/cryptsize）与 `patchCryptid`，thin/fat 都处理，fat 的每个 slice 都会清零；`ipa_info` 也改用同一份实现，避免两套解析器漂移。

**keychain**（同文件的 `ios_keychain`）。v1 先回答“能不能 dump”：探测 `/var/Keychains/keychain-2.db` 与 `/var/jb/usr/bin`、`/usr/bin` 下的 `keychain_dumper`。有 dumper 就跑 `-a` 并把输出存 `evidence/ios/keychain/`；没有就明确说不可 dump、解释数据库加密、给出 frida hook `SecItemCopyMatching` 的下一步。传 bundleId 时另外报 `keychain-access-groups`（描述文件 entitlements 与 `ldid -e` 片段）。

未做：真机两设备验收（Q113 的验收线）、bagbak 回退路径、`bfdecrypt`/CrackerXI 回退、Swift 元数据与 `__TEXT` 之外的加密处理、keychain 的 frida 内建导出脚本（当前靠设备上的 keychain_dumper）。


## 19. 首轮真机验收：vphone 越狱虚拟机（2026-10-22）

设备：`ssh root@192.168.64.2`（密码 alpine），iPhone17,1，iOS 27.0.1（24A446），Darwin 25.4.0，arm64，roothide 风格启动链（`.jbroot-000114514191980C`），rootful 布局（`/usr/bin`，无 `/var/jb`），无 App Store。

**部署方式**：`IOS_MIN=15.0 SKIP_SIGN=1 ./scripts/build-ios.sh` 交叉编译，主机 `codesign --force --sign -` 做 ad-hoc 签名（VM 上 `ldid`/`codesign` 都不存在），scp 到 `/usr/bin/sentinelbridged`，用 `--url/--token/--state-dir` 直接跑；控制台侧临时起一个 `IosGateway`（不落正式库），主机 `ssh -R` 把 VM 的 `127.0.0.1:<port>` 反代到控制台回环端口，绕开“明文 ws 只许回环”的限制。

**通过项**：

- 反连与 hello：设备上线，model `iPhone17,1`、osVersion `27.0.1`、build `24A446`、arch `arm64`、jailbreakForm `rootful`、hasRoot true；心跳与 online 状态正常。
- 文件拉取：`pull /etc/hosts` 213 字节。
- 文件推送：push `/private/var/tmp/sentinel-push.txt` 后用 pull 读回 28 字节，内容一致。
- 应用清单：`apps_list system=true` 返回 259 个 App。
- 应用详情：`app_info com.apple.mobilesafari` 返回版本 27.0.1、路径、数据容器、bundleSize 4883121、URL scheme、`hasCodeSignature`。
- 描述文件：`profiles_list` 返回 `/var/MobileDevice/ProvisioningProfiles` 下的 mis.db 等文件。
- 截屏：`screencap` 返回合法 PNG（41760 字节，1206×2622）；画面全黑是因为 VM 显示处于休眠，不是接口失败。

**未通过项（VM 环境限制，不是协议问题）**：

- `exec`：`posix_spawn` 返回 EPERM（daemon 报“启动 shell 失败：Operation not permitted”）。该 VM 的 vroot 把 ad-hoc 签名二进制放进只读的 `/rootfs`（31 个 Apple 命令行工具，没有 shell），shell 调用一律失败；`bash` 因为是越狱信任的签名才能看到完整根。给二进制加 `platform-application` / `no-sandbox` / `no-container` / `skip-library-validation` / storage 等 entitlements 后行为不变，说明信任来自越狱的信任链而不是 entitlements。
- TCP 隧道：`openTunnel` 成功返回端口，但通过隧道连 `127.0.0.1:22` 与 `192.168.64.2:22` 都收不到 SSH banner（5 秒超时），疑似 vroot 拒绝出站连接或 hook 了 `connect`。
- `tcpdump`、`frida-server`、`appinst`/`ipainstaller`、`keychain_dumper`、`zip` 均未安装，M2/M3/M4 的设备端能力无法在这台 VM 上验；`/etc/apt/sources.list` 为空，离线装不了。
- `app_info` 的 Safari 没有返回 `arch`/`cryptid`：`/var/containers/Bundle/Application/...` 在 vroot 里不可读（`/Applications` 可见），Mach-O 读取失败，属于路径可见性问题。

**结论**：这台 VM 适合验证“反连 + 文件传输 + 应用清单 + 截屏”这条链路，不适合验证 shell/隧道/动态工具。真实 iPhone 8 Plus（checkm8/palera1n，rootful 或 rootless）应当没有 vroot 限制，下一轮以它为准。

**副作用披露**：探测过程中误把 `/usr/bin/jbroot`（roothide 辅助工具）覆盖成了测试二进制；该文件与 jbroot 内的副本是同一 inode，没有备份。VM 是研究环境，重装 roothide 或重建 VM 即可恢复；不影响本仓库代码。


## 20. 交付物：deb only（2026-10-22 修订）

IPA 已移除；设备端只发两个 deb，均在 `packages/web/ios/build/`：

| 文件 | 用途 |
| --- | --- |
| `com.zgsfsec.sentinelbridge_0.1.7_iphoneos-arm.deb` | rootful（iOS 14+，`/usr/bin` + `/Library/LaunchDaemons`）。 |
| `com.zgsfsec.sentinelbridge_0.1.7_iphoneos-arm64.deb` | rootless（iOS 15+，`/var/jb/...`）。 |

构建：`scripts/build-ios.sh` + `scripts/build-deb.sh <rootful|rootless>`；`scripts/build-repo.sh` 生成 `docs/repo/` 的 Sileo 静态源（`Packages`、`Release`、`pool/*.deb`），由 `.github/workflows/ios-repo.yml` 发布到 GitHub Pages。

首次安装后的配对不再需要 App：deb 的 `postinst` 总是加载 LaunchDaemon；daemon 发现没有有效配置时进入 setup 模式，只在 `127.0.0.1:9945` 提供配对页。用户在设备 Safari 打开 `http://127.0.0.1:9945/setup`，填控制台 wss 地址、token，核对自签证书指纹后写入 `/var/jb/etc/sentinelbridge.json`（0600），daemon 退出并由 launchd 重启为正常反连模式。

签名：没有 `ldid` 时用 `SKIP_SIGN=1` 编译，再用 macOS `codesign --force --sign - --entitlements entitlements.plist` 做 ad-hoc 签名；deb 依赖越狱的 AMFI 补丁。真机安装前需确认 `launchctl` 能加载 LaunchDaemon。

## 21. 反连监听、断线诊断与一键安装（2026-10-22）

### 21.1.1 挂起 watchdog

deb 现在同时安装 `com.zgsfsec.sentinelbridgewatchdog`。主 daemon 每 5s 写 `/var/…/sentinelbridge/watchdog-heartbeat`，看门狗每 10s 检查文件 mtime；超过 45s 未更新就 `launchctl kickstart -k system/com.zgsfsec.sentinelbridged`。这解决的是 launchd `KeepAlive` 无法处理的场景：进程被 iOS 挂起（SIGSTOP）、socket 仍 ESTABLISHED、心跳不再发送，但进程没有退出，launchd 不会重启。看门狗是独立 LaunchDaemon；整机睡眠时也会被挂起，这种情况只能等设备唤醒。

### 21.1 iOS 独立反连监听

与安卓对齐：iOS 页左栏新增「反连服务」，可绑定 `0.0.0.0` / `127.0.0.1` / 单张网卡与端口（默认 9945），应用后立即重绑，独立于控制台端口。实现上 `IosGateway.listen(host, port)` 自建一个 TLS server（控制台启用 TLS 时，iOS 强制 wss），把 upgrade 交给同一个 `handleUpgrade`，所以 token 校验、`/ws/ios` 路径、hello 校验与替换规则完全一致；`ios_set_listen` 持久化在 `ios_meta`，控制台重启后自动恢复监听。页面同时显示监听状态与可拨号地址（绑 `0.0.0.0` 时取第一张网卡 IPv4）。

iOS 强制 wss：不再允许 `ws://`，独立监听也复用控制台的 TLS 证书，只有控制台启用 TLS 时才可绑定；token 不再有明文传输路径。

### 21.2 一直断开重连的排查

先看两端日志，现在都带关闭码：

- 服务端：`[sentinel-ios] iOS 设备断开：<name>（code XXXX，reason）`；401 会在 upgrade 阶段直接拒绝并记「token 无效或已删除」。
- 设备端：`server closed the socket: code=XXXX reason=...`（daemon 日志 / IPA 界面状态行）。

常见原因：`4005 roothide is not supported`（换非 roothide 越狱或等 M4 适配）、`4002 protocol N required`（控制台与设备端版本不一致，重装同版本）、upgrade 401（token 复制不完整或已删除）、App 被 iOS 挂起（TrollStore 形态没有后台保活，回到前台会自动重连；这是预期行为，不是崩溃）。如果两边都没有关闭码而只是周期断，检查中间的 nginx/反代是否有 WS idle timeout。

### 21.3 一键安装并启动

新增 `scripts/install-ios.sh`：

```sh
scripts/install-ios.sh root@192.168.1.50 \
  --url wss://192.168.1.10:9945/ws/ios \
  --token ios_xxx
```

它按设备是否挂载 `/var/jb` 自动选 rootful/rootless deb（也支持 `--arch` 覆盖），scp + `dpkg -i`，写入 `sentinelbridge.json`（0600），再 `launchctl bootout/bootstrap` 并打印状态与日志尾部；`--dry-run` 只打印命令。iOS 页右栏新增「一键安装与启动」卡片，按当前反连地址与 token 生成同一条命令，可一键复制。

`/api/ios/...` 的网页内下载没有做：安装包是构建产物且被 `.gitignore` 忽略，控制台不假设它存在；需要分发时把 `build/` 下的文件拷到目标机，或改用本脚本从构建机执行。


## 22. wss 与自动化（2026-10-22）

### 22.1 用 wss 替代 ws

可以，但只对**控制台自身端口**成立：控制台默认就是 HTTPS（自签），把设备地址写成 `wss://<控制台 IP>:<端口>/ws/ios` 即可；自签证书需要设备信任或 pin。

- 指纹：iOS 页「反连服务」卡片现在显示控制台证书的 SHA-256（服务端从 `options.tls.cert` 现算），点复制后填进 DAEMON 的 `pinnedCertSha256` 或 IPA 的「证书 SHA-256」输入框。
- 命令行取值：`openssl x509 -in ~/.sentinel/tls/cert.pem -outform der | shasum -a 256`，去掉冒号、小写。
- 独立监听现在也使用控制台 TLS，只提供 `wss://`；没有 TLS 的控制台不启动 iOS 监听。
- 不再有私网 `ws://` 例外；所有 iOS 连接都必须 wss。

### 22.2 deb-only 的依赖策略（IPA 已移除）

- 设备端只有 root daemon，没有 App/UserDefaults/自动连接界面；配置由 `setup` 页完成（控制台 wss 地址 + token），写入 `/var/jb/etc/sentinelbridge.json`（0600）。
- deb 只带 daemon，不带 tcpdump/appinst/frida-server：这些依赖按需安装。`scripts/install-ios.sh --with-deps` 会 best-effort `apt-get install tcpdump appinst`；frida-server 不在 apt 仓库，仍由 `ios_frida_setup` 推二进制。
- 没有 root 的 App-only 降级模式随 IPA 一起移除；非越狱设备只保留主机侧 IPA 静态分析。

## 23. 真机验收：iPhone 8 Plus（2026-10-22）

设备：`iPhone10,2`，iOS 16.7.12（Darwin 22.6.0），arm64，**rootless**（`/var/jb`，dpkg 架构 `iphoneos-arm64`），OpenSSH 可用，root 密码默认 alpine。

**安装与反连（真实控制台，非临时网关）**

```sh
packages/web/ios/scripts/install-ios.sh root@192.168.1.11 \
  --url wss://192.168.1.2:9945/ws/ios \
  --token ios_... --arch rootless
```

结果：deb 安装成功、`/var/jb/etc/sentinelbridge.json` 写入、LaunchDaemon 加载（PID 非 0），daemon 日志 `connected` + `hello accepted`；控制台 `ios.db` 中设备记录 `online=true`、model `iPhone10,2`、os `16.7.12`、form `rootless`、hasRoot true。**“安装 → 自启 → 反连主平台”首次在真机跑通。**

**协议与工具（第二个 daemon 实例 + 临时网关，避免打断真实反连）**

| 项目 | 结果 |
| --- | --- |
| `exec` | `id -u`=0，kernel 22.6.0，算术 42；daemon 以 root 运行 |
| `pull /etc/hosts` | 213 字节 |
| `push` + `pull` 回读 | 内容一致 |
| `apps_list system=true` | 176 个 App |
| `app_info com.apple.mobilesafari` | 路径、数据容器、bundleSize、URL scheme 正常 |
| `profiles_list` | `/var/MobileDevice/ProvisioningProfiles` 正常 |
| TCP 隧道 | `openTunnel` 成功，隧道内收到 `SSH-2.0-OpenSSH_9.7`，M3 frida 传输路径可用 |
| `tcpdump` | apt 安装 4.99.1 成功，`/var/jb/usr/bin/tcpdump` |
| `screencap` | **失败**：`_UICreateScreenUIImage` 返回 nil（daemon 无 UI 会话，iOS 16 真机常见）；已改为返回可操作错误 |

**已知限制**

- 真机 daemon 截屏不可用：需要 frida 在 SpringBoard 内截图，或宿主机 `idevicescreenshot`（USB）。`ios_screencap` 暂保留但会明确失败；是否从工具集移除待定。
- `frida-server` 不在该设备 apt 仓库（`apt-cache search frida` 为空），需按 `ios_frida_setup` 推 `/work/frida-server`。
- `appinst` 不在仓库，安装 IPA 需用 TrollStore/Sileo 另行安装。
- `--with-deps` 之前把 tcpdump 和 appinst 放在同一条 apt 命令里，appinst 缺失会连累 tcpdump；已改为逐个安装。


## 24. P0/P1 完成记录（2026-10-22）

### 24.1 服务端渗透 P0

- `ios_http_log`：frida 内建脚本 `ios_http_log` 在 NSURLSession / NSURLConnection 层记录 `SENTINEL_HTTP` JSON；工具解析后按项目写入 `captures.db`，源为 `ios_http_log:<app>`。覆盖 completion handler、delegate 的 `didReceiveData/didComplete`、下载任务、同步/异步 NSURLConnection；`filter` / `host` 可缩小范围，`maxBody` 默认 64KB，二进制 body 以 `base64:` 保留。
- pcap 入库：`ios_capture_pull` 在原有 tshark 摘要后额外跑 `tshark -r pcap -Y http -T json`，把明文 HTTP 按 `tcp.stream` 配对后写入证据库；`capture_import` 新增 `pcap` 格式，已有 pcap 可重放导入。HTTPS 仍由 `ios_http_log` 取明文（pcap 里只有 SNI/IP）。
- 测试：`test/ios-http-log.test.ts`（解析、合并、base64、ANSI、脚本语法）、`test/pcap-http.test.ts`（keep-alive 配对、缺响应、超大 body 截断）、`test/captures.test.ts`（`importEntries` 入库与检索）。

### 24.2 砸壳 P1

- 整包扫描：`ios-bundle.ts` 只读每个文件前 4 字节判断 Mach-O，再解析 arch/cryptid；覆盖 `Frameworks/`、`PlugIns/`、dylib，跳过符号链接。报告写入 `images / encryptedImages`。
- 对比与重扫：dump 后按 `manifest` 与扫描结果算 `missing`（应解未解），替换并重签后再扫 `afterImages`，仍为加密的写入 `stillEncrypted` 并逐条告警。
- 归档与校验：替换前把原 bundle 打成 `<name>-encrypted.ipa`，两个 IPA 都算 SHA-256；每条 dump 与 bundle 原文件大小比对，截断会告警；替换后每条二进制记录 before/after cryptid 和 SHA-256。
- 重签：dump 前用设备 `ldid -e` 读每个加密镜像的 entitlements；替换后把二进制推回设备，`ldid -S<ent>` 重签再拉回。没有 `ldid` 时明确告警并说明依赖 TrollStore/appinst。
- 回退与交付：frida 失败或没有 manifest 时探测设备 `bfdecrypt` 并回退；`verifyDevice` 在另一台在线设备上 push + `appinst`，再用 `app_info` 确认 cryptid 0，来源设备相同会拒绝。
- 测试：`test/ios-bundle.test.ts`（整包扫描、漏解列表）、`test/ios-decrypt-tool.test.ts`（前置失败路径）、`test/macho.test.ts`（thin/fat cryptid）。

### 24.3 已知边界

- 没有内建 MITM 代理/CA；`ios_http_log` 走 NSURLSession 层，不依赖代理，但 Flutter/Dart、部分 React Native 自建 BoringSSL 栈需要自定义 frida 脚本。
- `ios_ssl_bypass` 仍是通用 hook（SecTrustEvaluate/WithError + BoringSSL），对自比对证书/公钥的实现可能无效。
- `bfdecrypt` 未产出时仍回退失败；`bagbak` 需要 USB，`CrackerXI` 是 GUI，均未接入。
- `_CodeSignature/CodeResources` 不会随单二进制重签更新；能否安装取决于目标越狱的签名容忍度，`verifyDevice` 是最终判据。


## 25. 真机验收：iPhone 8 Plus 上的 P0/P1（2026-10-22）

设备：`root@192.168.1.11`，iPhone10,2，iOS 16.7.12，rootless（`/var/jb`），root 密码 `alpine`，OpenSSH 可用。测试使用独立 `ios.db`/token 与 `sentinel-ios-e2e` 容器，避免打断控制台真实项目；验收后把同一份源码构建的 daemon 装回 `/var/jb/usr/bin/sentinelbridged`（旧文件备份为 `sentinelbridged.bak`），launchd 重启后 `hello accepted`。

### 25.1 结果

| 项 | 结果 |
| --- | --- |
| `ios_app_info` | LANDrop（`app.landrop.landrop-flutter`）返回 arm64、`cryptid 1`；修复前同一台设备报「未知架构 / cryptid 0」 |
| `ios_http_log` | spawn TrollStore 后捕获 `GET https://api.github.com/repos/opa334/ldid/releases/latest`，工具解析并写入 `captures.db` 1 条 |
| `ios_capture_start` / `pull` | `en0`，BPF `tcp port 9960`；Safari 打开本机 HTTP 服务，pcap 1294 字节；tshark 解析 1 条 `GET /hello → 200` 并入库 |
| `ios_decrypt` | LANDrop 主二进制 `Runner` 1 → 0；`Runner` 原文件 355552 字节，dump 229376 字节，用原文件尾部补齐 126176 字节；原密文 IPA 与解密 IPA 都保留并算 SHA-256；Share Extension 未加载，报告 `missing`/`stillEncrypted` 为 `cryptid 1` |
| 产物校验 | 从解密 IPA 取出 `Payload/Runner.app/Runner`，`machoInfo` 为 arm64 / cryptid 0；原密文 IPA 中同一文件 cryptid 1 |

### 25.2 真机暴露并修复的问题

- Frida 17 移除了 `Module.findExportByName` 和 `Process.exit`：内建脚本统一走 `sentinelFindExport`，退出改用 C `exit()`；否则 `ios_decrypt_dump` 直接 `TypeError`。
- Mach-O 是 **little-endian**（thin64 磁盘字节 `cf fa ed fe`），原 TS/Swift 解析器按大端读 magic，导致 `app_info`/整包扫描全部漏报；现在两种字节序都支持，load command 按 slice 自身字节序读。
- daemon `posix_spawn` 只 dup2 了管道写端，没有关闭原始写端；后台 `tcpdump` 继承后，daemon 等 stdout EOF 一直等到请求超时。已在 file actions 里关闭 `outPipe[1]`/`errPipe[1]`。
- 设备没有 `pgrep`/`pkill`；抓包改为 pidfile（`/var/tmp/sentinel-capture.pid`）+ `kill -0`，启动/状态/停止都不再依赖这两个命令。
- 真实 tshark JSON 是嵌套协议对象、重复 header key 默认只保留最后一条、二进制 body 是冒号分隔 hex；已改为递归扁平化 + `--no-duplicate-keys` + hex 解码，并先判 response 再判 request（response 也带 `http.request.uri`，否则会生成幽灵请求）。

### 25.3 本次未覆盖

- Share Extension 是独立进程，主 App 的 dump 看不到；直接 `frida -f` 扩展 bundle id 也没有启动，仍需通过分享面板触发或用 UI 自动化。
- 设备没有 `ldid`、`bfdecrypt`、`appinst`，所以重签回退、bfdecrypt 回退、`verifyDevice` 第二台机安装都只跑了无设备路径/单元测试。
- 没有内建 MITM 代理/CA；`ios_http_log` 只覆盖 NSURLSession/NSURLConnection，Flutter/自建 BoringSSL 需自定义脚本。


## 26. deb-only token 配置（2026-10-22 实现）

### 26.1 用户路径

1. Sileo 添加源 `https://zgsfsec.github.io/sentinel-ios-repo/`，安装 SentinelBridge（rootful/rootless 由设备选择）。
2. 控制台「iOS 设备」页创建 token，点「显示/复制」拿到 `ios_...`，同时记下控制台证书 SHA-256。
3. iPhone Safari 打开 `http://127.0.0.1:9945/setup`。
4. 填控制台 wss 地址（如 `wss://console.example.com/ws/ios`）和 token，点「检测证书」；核对指纹后点「配对」。
5. 点「保存并连接」后控制页常驻；可实时连接、停止、重载，控制台设备列表出现该机。

SSH 回退仍保留：`scripts/install-ios.sh root@<IP> --url wss://... --token ...`。

### 26.2 服务端

- 不再有配对码表或公开 claim 路由；控制台只创建 token，操作员复制到设备 setup 页，与 Android 的地址 + token 操作一致。
- `ios_state` 不再包含 `pairing` 字段；iOS 页只显示 token 列表、wss 地址和证书指纹。
- 独立反连监听在控制台启用 TLS 时也使用 wss；`ConfigLoader` 拒绝任何 `ws://`。

### 26.3 设备端

- `ConfigLoader.context` 允许没有有效 URL/token 时启动 setup 模式；`--setup` 可强制进入。
- 大文件 pull 使用 `POST /api/ios/upload/<id>`：设备用 `URLSession.uploadTask(withStreamedRequest:)` 从 `InputStream` 流式上传，控制台边收边写临时文件；WebSocket 只传控制帧，避免 iOS jetsam。
- `SetupServer` 只绑 `127.0.0.1:9945`，提供 `/setup`、`/api/status`、`/api/setup/probe`、`/api/setup/save`、`/api/control/{start,stop,reload}`；保存 config 后不退出，页面每秒轮询状态，daemon 常驻。
- 自签证书：probe 读取叶证书 SHA-256 并显示；pair 请求用同一指纹做 TLS pin，指纹不匹配时不发送 token。
- `parseConsoleURL` 只接受 `https://` / `wss://`，`ConfigLoader` 同样只接受 `wss://`。
- `postinst` 不再在缺配置时退出，而是加载 daemon 并提示 Safari 打开 setup 页。

### 26.4 验证

- macOS 主机端到端：起测试控制台（自签 TLS）→ 创建 token → 启动 setup 模式 daemon → probe 得到指纹 → pair 写入 config；错误 token/错误指纹返回 400。
- 单元测试：token 创建/查找/删除/正常化；iOS 状态与 UI 类型检查通过。
- 8P 真机（2026-10-22）：通过。安装 0.1.7 rootless deb，删除旧配置后 launchd 进入 setup 模式；经 SSH 转发访问 `127.0.0.1:9945/setup`，用 `wss://192.168.1.2:9970/ws/ios` + token + 自签证书指纹写入配置；daemon 退出并由 launchd 重启，临时测试控制台 `hello accepted`；随后改为真实控制台 `wss://192.168.1.2:7777/ws/ios`，`last_seen` 正常更新；控制页常驻，`/api/control/stop` 后设备离线、`/api/control/start` 后重新在线。100MB 文件通过 HTTPS 流式上传成功（约 42s，控制台落盘 104857600 字节）；另用 SIGSTOP 暂停主 daemon，watchdog 在约 60s 内发现心跳过期并 `launchctl kickstart` 拉起，日志显示 `heartbeat stale (61s)`。
