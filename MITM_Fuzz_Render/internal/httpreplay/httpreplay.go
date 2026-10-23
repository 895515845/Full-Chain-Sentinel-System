// Package httpreplay 实现字节级保真的 raw HTTP/1.1 重放引擎。
//
// 设计原则（docs/SPEC-HTTP.md）：
//   - P1 字节保真：header 顺序、大小写、重复头按原文发出，不排序不合并；
//   - P2 零隐式行为：不自动跟随重定向、不自动解压、不自动重试、不复用连接；
//   - P4 raw 与视图分离：永远保留原始字节，解析只产生视图。
//
// 解析是"宽容"的：畸形请求仍可发送（这是安全测试的基本需求），
// 无法解析的部分降级为 Warning 而不是错误。
package httpreplay

import (
	"bytes"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// Warning 是解析阶段的非致命问题；请求仍会发送。
type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Header 保留原始名称大小写与出现顺序。
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Target 是请求最终发往的地址。
type Target struct {
	Scheme string `json:"scheme"`
	Host   string `json:"host"`
	Port   int    `json:"port"`
	Path   string `json:"path,omitempty"`
}

// Request 是解析后的请求视图；Raw 永远是权威数据。
type Request struct {
	Raw      []byte    `json:"-"`
	Method   string    `json:"method"`
	Target   string    `json:"target"`
	Proto    string    `json:"proto"`
	Headers  []Header  `json:"headers,omitempty"`
	Body     []byte    `json:"-"`
	Warnings []Warning `json:"warnings,omitempty"`
	URL      Target    `json:"url"`
}

// ContentLength 返回 Content-Length 头的值；缺失或非法返回 -1。
func (r *Request) ContentLength() int {
	return headerInt(r.Headers, "Content-Length", -1)
}

// HasChunked 判断是否声明了 chunked 传输编码。
func (r *Request) HasChunked() bool {
	for _, h := range r.Headers {
		if strings.EqualFold(h.Name, "Transfer-Encoding") &&
			strings.Contains(strings.ToLower(h.Value), "chunked") {
			return true
		}
	}
	return false
}

// Header 返回第一个匹配头的值（大小写不敏感）。
func (r *Request) Header(name string) (string, bool) {
	for _, h := range r.Headers {
		if strings.EqualFold(h.Name, name) {
			return h.Value, true
		}
	}
	return "", false
}

func headerInt(headers []Header, name string, def int) int {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			if n, err := strconv.Atoi(strings.TrimSpace(h.Value)); err == nil {
				return n
			}
			return def
		}
	}
	return def
}

// ParseRequest 解析原始请求文本。
//
// fallback 用于 origin-form（`/path?a=1`）请求行：此时 scheme/host/port 取自
// fallback。解析永不因畸形而失败——只有连"发往哪里"都无法确定时才返回错误。
func ParseRequest(raw []byte, fallback Target) (*Request, error) {
	req := &Request{Raw: raw}

	head, body := splitHead(raw)
	lines := splitLines(head)
	if len(lines) == 0 || len(bytes.TrimSpace(lines[0])) == 0 {
		return nil, fmt.Errorf("请求为空")
	}

	// ---- 请求行 ----
	parts := strings.Fields(string(lines[0]))
	switch len(parts) {
	case 2:
		req.Method, req.Target = parts[0], parts[1]
		req.Proto = "HTTP/1.1"
		req.Warnings = append(req.Warnings, Warning{
			Code:    "no_proto",
			Message: "请求行缺少 HTTP 版本，已按 HTTP/1.1 处理",
		})
	case 3:
		req.Method, req.Target, req.Proto = parts[0], parts[1], parts[2]
	default:
		// 极端畸形（例如含多余空格的 target）：尽力取首尾。
		if len(parts) > 3 {
			req.Method = parts[0]
			req.Target = parts[1]
			req.Proto = parts[len(parts)-1]
			req.Warnings = append(req.Warnings, Warning{
				Code:    "odd_request_line",
				Message: "请求行格式异常（空格数量超出预期），按首尾解析",
			})
		} else {
			return nil, fmt.Errorf("无法解析请求行: %q", truncate(string(lines[0]), 80))
		}
	}

	// ---- 头部 ----
	var last *Header
	for _, ln := range lines[1:] {
		line := string(ln)
		if line == "" {
			continue
		}
		// obs-fold：以空白开头的折行，追加到上一个头的值。
		if line[0] == ' ' || line[0] == '\t' {
			if last != nil {
				last.Value += " " + strings.TrimSpace(line)
				req.Warnings = append(req.Warnings, Warning{
					Code:    "obs_fold",
					Message: fmt.Sprintf("检测到折行头（%s），已合并但原文保留", last.Name),
				})
				continue
			}
			req.Warnings = append(req.Warnings, Warning{
				Code:    "malformed_header",
				Message: fmt.Sprintf("以空白开头的孤立行被跳过: %q", truncate(line, 40)),
			})
			continue
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(name) == "" {
			req.Warnings = append(req.Warnings, Warning{
				Code:    "malformed_header",
				Message: fmt.Sprintf("缺少冒号或头名为空，该行仍按原文发送: %q", truncate(line, 40)),
			})
			continue
		}
		// 注意：保留 value 的前导空格之后的内容（RFC 允许 OWS）。
		h := Header{Name: name, Value: strings.TrimLeft(value, " \t")}
		req.Headers = append(req.Headers, h)
		last = &req.Headers[len(req.Headers)-1]
	}

	// ---- body ----
	req.Body = body

	// ---- framing 警告 ----
	if req.HasChunked() && req.ContentLength() >= 0 {
		req.Warnings = append(req.Warnings, Warning{
			Code:    "te_and_cl",
			Message: "同时存在 Transfer-Encoding: chunked 与 Content-Length，按原文发送（可能被用于走私测试）",
		})
	}
	if cl := req.ContentLength(); cl >= 0 && len(body) != cl {
		req.Warnings = append(req.Warnings, Warning{
			Code:    "cl_mismatch",
			Message: fmt.Sprintf("Content-Length=%d 与实际 body 长度 %d 不一致，按原文发送", cl, len(body)),
		})
	}

	// ---- 目标解析 ----
	// 解析失败不阻塞解析阶段（原始报文仍然合法），
	// "发往哪里"由 Send 在发送前校验并报 bad_request。
	resolved, rerr := resolveTarget(req, fallback)
	if rerr != nil {
		req.Warnings = append(req.Warnings, Warning{
			Code:    "unresolved_target",
			Message: rerr.Error(),
		})
	} else {
		req.URL = resolved
	}
	return req, nil
}

// resolveTarget 把请求行解析为绝对目标。
func resolveTarget(req *Request, fallback Target) (Target, error) {
	t := req.Target
	switch {
	case strings.HasPrefix(t, "http://") || strings.HasPrefix(t, "https://"):
		u, err := url.Parse(t)
		if err != nil {
			return Target{}, fmt.Errorf("无法解析绝对地址 %q: %v", t, err)
		}
		port := 0
		if p := u.Port(); p != "" {
			port, err = strconv.Atoi(p)
			if err != nil {
				return Target{}, fmt.Errorf("端口不合法: %q", p)
			}
		} else if u.Scheme == "https" {
			port = 443
		} else {
			port = 80
		}
		path := u.Path
		if path == "" {
			path = "/"
		}
		if u.RawQuery != "" {
			path += "?" + u.RawQuery
		}
		return Target{Scheme: u.Scheme, Host: u.Hostname(), Port: port, Path: path}, nil

	case strings.EqualFold(req.Method, "CONNECT"):
		host, portStr, err := net.SplitHostPort(t)
		if err != nil {
			return Target{}, fmt.Errorf("CONNECT 目标必须是 host:port: %q", t)
		}
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return Target{}, fmt.Errorf("CONNECT 端口不合法: %q", portStr)
		}
		return Target{Scheme: "https", Host: host, Port: port}, nil

	case t == "*":
		if fallback.Host == "" {
			return Target{}, fmt.Errorf("asterisk-form 需要提供目标 host")
		}
		return withFallback(fallback, "*"), nil

	default:
		// origin-form / authority-form（对 http 代理）
		if fallback.Host == "" {
			return Target{}, fmt.Errorf("请求行 %q 未包含主机信息，需要提供目标地址", truncate(t, 60))
		}
		return withFallback(fallback, t), nil
	}
}

// TargetFromRaw 从报文本身推断目标地址。
//
// 调用方常常只给一个数据包：Repeater 界面自带目标字段，而 Agent 或 curl 往往只写
// 报文。absolute-form / CONNECT 的请求行自带目标；origin-form（`GET /admin`）则只
// 有 Host 头能说明去处，此时按 443 → https、其余 → http 推断协议。
func TargetFromRaw(raw []byte) (Target, bool) {
	if parsed, err := ParseRequest(raw, Target{}); err == nil && parsed.URL.Host != "" {
		return parsed.URL, true
	}
	host := hostHeader(raw)
	if host == "" {
		return Target{}, false
	}
	name, portStr, err := net.SplitHostPort(host)
	if err != nil {
		// 没有端口（或裸 IPv6）：整个值就是主机名，端口留待按协议取默认值。
		name, portStr = host, ""
	}
	target := Target{Scheme: "http", Host: name, Port: 80}
	if portStr != "" {
		if p, perr := strconv.Atoi(portStr); perr == nil && p > 0 {
			target.Port = p
		}
	}
	if target.Port == 443 {
		target.Scheme = "https"
	}
	return target, true
}

// hostHeader 取 Host 头的值（大小写不敏感），只看头部。
func hostHeader(raw []byte) string {
	head, _ := splitHead(raw)
	for _, line := range splitLines(head) {
		name, value, ok := strings.Cut(string(line), ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(name), "Host") {
			continue
		}
		return strings.TrimSpace(value)
	}
	return ""
}

func withFallback(fallback Target, path string) Target {
	out := fallback
	if out.Scheme == "" {
		out.Scheme = "http"
	}
	if out.Port == 0 {
		if out.Scheme == "https" {
			out.Port = 443
		} else {
			out.Port = 80
		}
	}
	out.Path = path
	return out
}

// splitHead 按第一个空行切出头与 body，兼容 \r\n\r\n 与 \n\n（裸 LF）。
func splitHead(raw []byte) (head, body []byte) {
	if i := bytes.Index(raw, []byte("\r\n\r\n")); i >= 0 {
		return raw[:i], raw[i+4:]
	}
	if i := bytes.Index(raw, []byte("\n\n")); i >= 0 {
		return raw[:i], raw[i+2:]
	}
	return raw, nil
}

// splitLines 按 \n 切分并去掉行尾 \r。
func splitLines(head []byte) [][]byte {
	var lines [][]byte
	for _, ln := range bytes.Split(head, []byte("\n")) {
		lines = append(lines, bytes.TrimSuffix(ln, []byte("\r")))
	}
	return lines
}

// Rebuild 重建请求字节（Host/Connection 兼容入口）。
func Rebuild(req *Request, addHost, addConnection string) []byte {
	var extra []Header
	if addHost != "" {
		extra = append(extra, Header{Name: "Host", Value: addHost})
	}
	if addConnection != "" {
		extra = append(extra, Header{Name: "Connection", Value: addConnection})
	}
	return RebuildWith(req, extra)
}

// RebuildWith 重建请求字节：保持原有头部顺序，仅在末尾追加 extra。
// extra 为空时返回原文（保证字节级保真）。
func RebuildWith(req *Request, extra []Header) []byte {
	if len(extra) == 0 {
		return req.Raw
	}

	head, body := splitHead(req.Raw)
	var b bytes.Buffer
	lines := splitLines(head)

	// 尊重原文换行风格：原文用裸 LF 时增补行也用 LF。
	eol := "\r\n"
	if !bytes.Contains(req.Raw, []byte("\r\n")) && bytes.Contains(req.Raw, []byte("\n")) {
		eol = "\n"
	}

	b.Write(lines[0])
	b.WriteString(eol)
	for _, ln := range lines[1:] {
		b.Write(ln)
		b.WriteString(eol)
	}
	for _, h := range extra {
		b.WriteString(h.Name + ": " + h.Value + eol)
	}
	b.WriteString(eol)
	b.Write(body)
	return b.Bytes()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
