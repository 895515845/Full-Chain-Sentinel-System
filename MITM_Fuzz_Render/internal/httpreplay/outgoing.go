package httpreplay

import (
	"net"
	"net/url"
	"strconv"
	"strings"
)

// buildOutgoing 计算实际要发送的字节：保真优先，仅在缺失时补必要头。
//
// 增补规则（docs/SPEC-HTTP.md §2.2）：
//   - 缺 Host → 补 Host；
//   - 缺 Connection → 补 close（一请求一连接）；
//   - 有 body 但既无 Content-Length 也无 Transfer-Encoding → 补 Content-Length
//     （否则服务端无法判定 body 边界，报文实际不可投递）。
func buildOutgoing(req *Request, opts Options) []byte {
	var extra []Header

	if !opts.DisableAutoHost {
		if _, ok := req.Header("Host"); !ok && req.URL.Host != "" {
			extra = append(extra, Header{Name: "Host", Value: hostHeaderFor(req.URL)})
		}
	}
	if !opts.DisableAutoCL && len(req.Body) > 0 {
		_, hasCL := req.Header("Content-Length")
		if !hasCL && !req.HasChunked() {
			extra = append(extra, Header{Name: "Content-Length", Value: strconv.Itoa(len(req.Body))})
		}
	}
	if !opts.DisableAutoClose {
		if _, ok := req.Header("Connection"); !ok {
			extra = append(extra, Header{Name: "Connection", Value: "close"})
		}
	}
	return RebuildWith(req, extra)
}

// hostHeaderFor 按规范生成 Host：默认端口不带上。
func hostHeaderFor(t Target) string {
	defaultPort := (t.Scheme == "http" && t.Port == 80) || (t.Scheme == "https" && t.Port == 443)
	if defaultPort {
		return t.Host
	}
	return net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
}

// absoluteForm 把请求行改写为绝对 URL（http-over-代理必需）。
// 仅改写请求行；头与 body 保持原样（保序、保大小写）。
func absoluteForm(req *Request) []byte {
	raw := Rebuild(req, "", "")
	abs := req.URL.Scheme + "://" + hostHeaderFor(req.URL)
	if req.URL.Path == "" {
		abs += "/"
	} else {
		abs += req.URL.Path
	}

	// 替换第一行中第二个 token（原始 target）
	first, rest, ok := strings.Cut(string(raw), "\n")
	if !ok {
		return raw
	}
	line := strings.TrimRight(first, "\r")
	parts := strings.SplitN(line, " ", 3)
	if len(parts) != 3 {
		return raw
	}
	var eol string
	if strings.HasSuffix(first, "\r\n") {
		eol = "\r\n"
	} else {
		eol = "\n"
	}
	newLine := parts[0] + " " + abs + " " + parts[2]
	return append([]byte(newLine+eol), []byte(rest)...)
}

// parseSimpleURL 解析 "https://example.com:8443/base" 形式的目标。
func parseSimpleURL(raw string) (Target, error) {
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return Target{}, err
	}
	if u.Host == "" {
		return Target{}, errInvalidHost
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return Target{}, errInvalidScheme
	}
	port := 0
	if p := u.Port(); p != "" {
		port, err = strconv.Atoi(p)
		if err != nil {
			return Target{}, errInvalidPort
		}
	} else if scheme == "https" {
		port = 443
	} else {
		port = 80
	}
	return Target{Scheme: scheme, Host: u.Hostname(), Port: port}, nil
}
