package api

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// normalizeSocks5Proxy 校验并规范化一个 SOCKS5 出口地址。
//
// 只接受 SOCKS5：这里的代理是"这次发送的出口"，不是抓包用的 MITM，也不是系统
// 代理——目标站可能只有经它才可达，域名也由它解析（引擎把主机名原样交给代理，
// 即远程 DNS），所以 http 代理和 socks4 一律拒绝，并在报错里写明接受的写法。
//
// 接受三种输入：`socks5://host:port`、`socks5://user:password@host:port`、以及
// 只写 `host:port`（操作员常这么填）。返回统一成 `socks5://[user:pass@]host:port`，
// 凭据按 URL 编码保留，交给引擎解析。
//
// 地址是**容器视角**的：默认 host 网络下 127.0.0.1 就是宿主机；bridge 网络下
// 容器里的 127.0.0.1 是它自己，要填 host.docker.internal 或把代理放进容器。
func normalizeSocks5Proxy(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if !strings.Contains(value, "://") {
		value = "socks5://" + value
	}
	u, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("代理地址不合法: %v", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "socks5" && scheme != "socks5h" {
		return "", fmt.Errorf("只支持 SOCKS5 代理（socks5://[user:password@]host:port），收到 %q", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("代理地址缺少主机: %s", raw)
	}
	port := u.Port()
	if port == "" {
		port = "1080" // SOCKS5 的惯例端口
	}
	if number, err := strconv.Atoi(port); err != nil || number < 1 || number > 65535 {
		return "", fmt.Errorf("代理端口不合法: %s", port)
	}
	address := net.JoinHostPort(host, port)
	if u.User != nil {
		return "socks5://" + u.User.String() + "@" + address, nil
	}
	return "socks5://" + address, nil
}
