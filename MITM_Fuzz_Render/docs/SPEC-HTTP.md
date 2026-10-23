# SPEC · Raw HTTP 引擎

> 归属模块：`internal/httpreplay`
> 状态：v1.0（M1 实现依据）
> 一句话：**这个引擎存在的唯一理由是"用户写什么字节，线上就发什么字节"**。任何隐式改写都是 bug。

---

## 1. 设计原则

| # | 原则 | 推论 |
|---|---|---|
| P1 | 字节保真 | header 顺序、名称大小写、重复头、空白、非法字符一律按原文发出；不排序、不去重、不规范化 |
| P2 | 零隐式行为 | 不自动跟随重定向、不自动存/带 Cookie、不自动加 `User-Agent`、不自动压缩、不自动重试、不复用连接 |
| P3 | 错误可解释 | 每个失败都映射到固定错误码 + 面向用户的中文说明 + 可重试标记 |
| P4 | 原始与视图分离 | 永远保存 raw bytes；解码/格式化只发生在展示层，且可关闭 |
| P5 | 一套解析器两用 | 重放（客户端角色）与 MITM（服务端角色）共用，通过 `Mode` 切换宽松度 |

**明确不做**：HTTP/2 帧级重放（M5 仅代理侧转译）、HTTP/3、WebSocket 帧级重放、连接池。重放默认**一请求一连接**（`Connection: close`），与 Burp Repeater 行为一致。

---

## 2. 输入模型

用户编辑的是一段**原始请求文本**：

```
<request-line>\r\n
<header-name>: <value>\r\n
...
\r\n
<body>
```

### 2.1 解析规则

| 场景 | 行为 |
|---|---|
| 换行 | 接受 `\r\n` 与裸 `\n`；**发送时按用户原文**（raw 模式不改写）。结构化编辑器产出一律 CRLF |
| 首行 | 必须匹配 `^([!#$%&'*+\-.^_`\|~0-9A-Za-z]+) (\S+) (HTTP/\d\.\d)$`；方法允许自定义 token（如 `FOO`） |
| request-target | 支持 origin-form（`/a?b`）、absolute-form（`http://h/a`）、authority-form（`CONNECT h:443`）、asterisk-form（`OPTIONS *`） |
| 头名 | 允许任意可见 ASCII 且不含 `:` 与空白；含空白/控制字符 → 标记 `warning: header_name`，**仍发送** |
| 头值 | 保留前后空白；空值合法（`X-Foo:`）；obs-fold（折行续行）按原样发送并标记 `warning: obs_fold` |
| 重复头 | 按出现顺序保留，不合并（`Set-Cookie`、自定义头必须如此） |
| 空行 | 第一个空行即 header 结束；其后全部算 body |
| 无 body | 允许完全没有空行（只有请求行+头） |

### 2.2 Body 与 framing 决策

按优先级判定，**用户显式写的头永远优先**：

| 条件 | 发送方式 | 备注 |
|---|---|---|
| 头含 `Transfer-Encoding: chunked` | 用户 body 视为已编码原文，原样发送 | 若同时有 `Content-Length` → `warning: te_and_cl`，仍照发 |
| 头含 `Content-Length` | 原样发送 body；**不按 CL 截断**（用户可能故意发短/长包） | 长度不符 → `warning: cl_mismatch`，照发 |
| 两者都没有且有 body | 默认自动补 `Content-Length`（可在设置关闭） | 关闭后按"读到 EOF"发送 |
| 两者都没有且无 body | 直接空行结束 | — |

### 2.3 解析失败策略

- **结构化视图**解析失败 → 报错，不发送。
- **Raw 视图**始终可发送：解析器尽力提取首行与目标；无法确定目标时按"粘贴的 URL + 默认 GET"兜底，并在 UI 提示 `raw_fallback`。

---

## 3. 发送流程

```
输入文本
  → 解析（宽容）→ 目标解析(scheme/host/port) → 连接（可选上游代理）
  → 可选 TLS（SNI / 版本 / 校验开关 / ALPN http/1.1 / 客户端证书）
  → 写入原始字节（一次 write，避免拆包）
  → 读取响应（三段超时）
  → 解析响应 + 保留 raw
  → 落库（元数据 + blob）
```

### 3.1 目标解析

| 输入 | 推导 |
|---|---|
| absolute-form | 用其中的 scheme/host/port，忽略连接配置里的 host |
| origin-form + 当前 tab 的 host/scheme/port | 用 tab 配置 |
| authority-form（CONNECT） | 只允许在代理模式 |
| 缺端口 | http→80、https→443；非默认端口必须显式 |

**Host 头**：缺失时自动补 `Host: <host>[:port]`（非默认端口带上），可在设置关闭；用户写了就原样发（允许故意不匹配）。

### 3.2 连接与 TLS

| 项 | 默认 | 可配 |
|---|---|---|
| `Connection` | 自动补 `close`（若用户没写） | 开/关；关则读到 EOF 依赖响应侧 |
| DNS | 系统解析，超时 5s | 可指定 `--resolve host:port:ip` 强制 IP（打内网/绕过 DNS） |
| TCP | `KeepAlive` 关，`NoDelay` 开 | — |
| TLS 最低版本 | 1.2（默认 1.3 优先） | 锁定 1.2 / 1.3 |
| 证书校验 | **默认校验**；不安全开关需显式打开并红色警示 | 开/关 |
| SNI | 默认 = host | 可覆盖（虚拟主机测试） |
| ALPN | `http/1.1` | 可关闭（`--no-alpn`） |
| 客户端证书 | 无 | mTLS（M5） |

### 3.3 上游链路

- 直连（默认）
- 上游 HTTP 代理（`http://user:pass@host:port`）：绝对形式转发
- SOCKS5（`socks5://user:pass@host:port`）：TCP 层代理后照常 TLS
- 链路错误单独归类为 `upstream_*`，不与目标侧错误混淆

### 3.4 超时与取消

| 阶段 | 默认 | 说明 |
|---|---|---|
| 连接（含 DNS） | 10s | |
| 首字节 | 30s | 到 status-line 第一字节 |
| 整体 | 120s | 含 body |
| 取消 | 立即 | UI 取消 → 关闭 socket → 结果标记 `canceled`，已收到部分仍落库并标记 `partial` |

无自动重试。用户点"再发一次"即新请求、新 flow。

---

## 4. 响应解析

| 项 | 规则 |
|---|---|
| status-line | `HTTP/1.1 200 OK` / `HTTP/1.1 200` / 非标准 `ICY 200 OK` 均接受；版本与 reason 可缺 |
| headers | 同请求规则（保序、重复保留、裸 LF 容忍）；> 100 头或单头 > 64KB → 截断展示并标记 |
| body framing | ① `Transfer-Encoding: chunked` → 解 chunk（含 chunk extension 与 trailer）② `Content-Length` → 读 N 字节 ③ 否则读到 EOF |
| 提前断开 | 少读/多读均不报错，标记 `truncated` / `overlong`，raw 全留 |
| Content-Encoding | 展示层解码 gzip/deflate/br/zstd（可开关）；**raw 永不覆盖**；解码失败只影响 Pretty 视图 |
| 字符集 | 依次尝试：头部 charset → UTF-8 校验 → GB18030 → latin-1 兜底；解码失败单元格显示 `�`，切 Hex 可看原始字节 |
| 大小 | 默认单边上限 64MB；超过则流式写 blob，内存只留前 2MB 预览 |
| 100-continue | 自动跳过 1xx 中间响应，保留在 raw 中 |

---

## 5. 错误模型

| code | 触发 | UI 文案 | 可重试 |
|---|---|---|---|
| `dns_failed` | 域名解析失败 | 域名解析失败：{host} | 是 |
| `conn_refused` | 端口拒绝 | 目标拒绝连接（端口未开放或被防火墙拦截） | 是 |
| `conn_timeout` | 连接超时 | 连接超时（{ms}ms） | 是 |
| `tls_handshake` | 握手失败 | TLS 握手失败：{detail}（可能是协议版本/套件不匹配） | 是 |
| `tls_cert` | 证书校验失败 | 证书校验失败：{detail}。若目标是自签，请开启"忽略证书校验" | 是 |
| `tls_alpn` | ALPN 协商失败 | ALPN 协商失败，服务端可能只支持 h2 | 是 |
| `header_timeout` | 30s 未收到状态行 | 已发送，但 {ms}ms 内未收到响应首字节 | 是 |
| `body_timeout` | body 读取超时 | 响应体读取超时 | 是 |
| `protocol` | 响应无法解析为 HTTP | 响应不是合法 HTTP：{snippet}（可能连错端口/服务） | 是 |
| `upstream_connect` | 上游代理失败 | 上游代理连接失败 | 是 |
| `upstream_auth` | 代理 407 | 上游代理认证失败 | 否 |
| `canceled` | 用户取消 | 已取消 | 是 |
| `too_large` | 超上限 | 响应超过 {limit}，已截断保存 | 否 |

> 所有错误都返回 `{code, message, detail?, retryable}`，且保留已发送的 raw 请求与已收到的 raw 响应（若有）。

---

## 6. 与 MITM 的关系

| 维度 | Replay（客户端角色） | MITM（服务端角色） |
|---|---|---|
| 宽松度 | 严格按用户文本 | 宽松：容忍客户端各种怪写法 |
| 目标 | 文本中推导 | 由 CONNECT / Host 决定 |
| 失败处置 | 报错给用户 | 回 `502` 给客户端，flow 标 `proxy_error` |
| 落库 | 必落 | 必落（含 TLS 元信息） |
| 复用解析器 | ✅ `ParseRequest(mode)` | ✅ 同左 |

代理侧额外记录：`tls_json{sni, version, cipher, alpn, client_cert?}`、`connect_target`、`bypassed`（隧道直通）。

---

## 7. 保真度测试矩阵（M1 必过）

| ID | 用例 | 期望 |
|---|---|---|
| T01 | 自定义 header 大小写与顺序 `x-a: 1` / `X-B: 2` / `x-a: 3` | 线上字节完全一致，顺序不变 |
| T02 | 重复 `Cookie` 头两行 | 两行原样发送，不被合并 |
| T03 | 请求行用自定义方法 `FOO /x HTTP/1.1` | 服务端收到 `FOO` |
| T04 | 只有请求行 + 头，无空行 | 正常发送，服务端按无 body 处理 |
| T05 | `Content-Length: 999` 但 body 只有 3 字节 | 照发（服务端会等待/超时），UI 有 `cl_mismatch` 警告 |
| T06 | 手工 chunked body | 原样发送，服务端正确解码 |
| T07 | 裸 LF 换行的请求 | 原样发送（很多服务端接受） |
| T08 | 响应 `Content-Length` 偏大、服务端提前断开 | 标记 `truncated`，保留已收到内容，不报错 |
| T09 | 响应 gzip，用户看 Raw | Raw 为压缩字节（Hex 可见），Pretty 为解压文本 |
| T10 | 响应体是 GBK 中文 | 自动识别并正确显示；Hex 视图可切 |
| T11 | 响应含 `Transfer-Encoding: chunked` + trailer | 正确解码，trailer 在 Headers 视图可见 |
| T12 | 目标只支持 h2（ALPN 失败） | 错误码 `tls_alpn` + 明确提示 |
| T13 | 自签证书 + 未开忽略校验 | `tls_cert`，提示如何开启 |
| T14 | 上游 SOCKS5 代理 | 经代理发出，错误归类为 `upstream_*` |
| T15 | 超 64MB 响应 | 流式落盘，UI 可打开前 2MB 预览，标记 `too_large` |

---

## 8. 数据结构（与 store 的契约）

```go
type Request struct {
    Raw       []byte      // 原始字节（权威）
    Method    string
    Target    string      // 原始 request-target
    Proto     string      // HTTP/1.1
    Headers   []Header    // 保序，Name/Value 原文
    Body      []byte
    Warnings  []Warning   // code + 可读说明
    TargetURL TargetURL   // scheme/host/port/path
}

type Response struct {
    Raw        []byte
    Proto      string
    Status     int
    Reason     string
    Headers    []Header
    Body       []byte    // 解码前原始 body（与 framing 解包后）
    Truncated  bool
    TLS        *TLSInfo
    Timings    Timings   // dns/connect/tls/ttfb/total
}

type Result struct {
    Request  Request
    Response *Response
    Err      *Error
    Timings  Timings
}
```

`Headers []Header` 而非 `map`，是为了保序与重复；JSON 落库时序列化为 `[{n,v},...]`。
