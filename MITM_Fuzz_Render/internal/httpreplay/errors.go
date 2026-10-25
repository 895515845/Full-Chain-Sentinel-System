package httpreplay

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// Error 是引擎的统一错误：code 用于 UI 文案映射（docs/SPEC-HTTP.md §5）。
type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Detail    string `json:"detail,omitempty"`
	Retryable bool   `json:"retryable"`
}

func (e *Error) Error() string {
	if e.Detail != "" {
		return fmt.Sprintf("%s: %s", e.Message, e.Detail)
	}
	return e.Message
}

func errCode(code, msg string, retryable bool) *Error {
	return &Error{Code: code, Message: msg, Retryable: retryable}
}

// ClassifyError 供代理等外部模块复用错误分类。
func ClassifyError(err error, phase string) *Error {
	return classifyError(err, phase)
}

// classifyError 把底层错误翻译为统一错误码。
// phase: connect | tls | write | header | body | proxy
func classifyError(err error, phase string) *Error {
	if err == nil {
		return nil
	}
	if errors.Is(err, contextCanceled()) {
		return errCode("canceled", "已取消", true)
	}

	// 代理分支的错误要说"代理"：目标拒绝连接和代理连不上，对操作员是两件完全
	// 不同的事（改目标 or 改代理），共用一句话会把人指错方向。
	viaProxy := phase == "proxy"

	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		if viaProxy {
			return errCode("upstream_connect", "上游代理地址解析失败: "+dnsErr.Name, true)
		}
		return errCode("dns_failed", "域名解析失败: "+dnsErr.Name, true)
	}
	if errors.Is(err, errConnRefused()) {
		if viaProxy {
			return errCode("upstream_connect", "连接上游代理失败（端口未开放或代理未启动）: "+err.Error(), true)
		}
		return errCode("conn_refused", "目标拒绝连接（端口未开放或被防火墙拦截）", true)
	}
	if viaProxy && strings.Contains(strings.ToLower(err.Error()), "authentication") {
		return errCode("upstream_auth", "SOCKS5 认证失败（用户名或密码不对）: "+err.Error(), false)
	}

	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		switch phase {
		case "proxy":
			return errCode("upstream_connect", "连接上游代理超时", true)
		case "connect":
			return errCode("conn_timeout", "连接超时", true)
		case "tls":
			return errCode("tls_handshake", "TLS 握手超时", true)
		case "header":
			return errCode("header_timeout", "已发送请求，但对端未在期限内返回响应首字节", true)
		case "body":
			return errCode("body_timeout", "响应体读取超时", true)
		}
	}

	if isTLSVerifyError(err) {
		return errCode("tls_cert", "证书校验失败。若目标使用自签证书，请开启\"忽略证书校验\"", false)
	}
	if isTLSError(err) {
		return errCode("tls_handshake", "TLS 握手失败（可能是协议版本/套件/ALPN 不匹配）", true)
	}

	switch phase {
	case "connect":
		return errCode("conn_failed", "连接失败: "+err.Error(), true)
	case "tls":
		return errCode("tls_handshake", "TLS 握手失败: "+err.Error(), true)
	case "proxy":
		return errCode("upstream_connect", "上游代理连接失败: "+err.Error(), true)
	default:
		return errCode("internal", err.Error(), false)
	}
}

// ---------------------------------------------------------------- 上游代理

// parseProxy 解析 "http://user:pass@host:port" / "socks5://host:port"。
func parseProxy(raw string) (scheme, host string, userinfo *url.Userinfo, err error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", nil, fmt.Errorf("代理地址不合法: %v", err)
	}
	scheme = strings.ToLower(u.Scheme)
	if scheme == "" {
		scheme = "http"
	}
	if scheme != "http" && scheme != "https" && scheme != "socks5" {
		return "", "", nil, fmt.Errorf("不支持的代理协议 %q（支持 http/https/socks5）", u.Scheme)
	}
	host = u.Host
	if u.Port() == "" {
		if scheme == "https" || scheme == "socks5" {
			host = net.JoinHostPort(u.Hostname(), "443")
		} else {
			host = net.JoinHostPort(u.Hostname(), "80")
		}
	}
	return scheme, host, u.User, nil
}

// proxyAuthHeader 生成 Proxy-Authorization 头值。
func proxyAuthHeader(user *url.Userinfo) string {
	if user == nil {
		return ""
	}
	pass, _ := user.Password()
	token := user.Username() + ":" + pass
	return "Basic " + base64Std(token)
}

func hostPort(t Target) string {
	return net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
}
