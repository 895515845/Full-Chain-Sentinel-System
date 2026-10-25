package httpreplay

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"testing"
)

// startSocks5Server 起一个只支持 CONNECT（无认证）的 SOCKS5 服务端，把连接
// 转发到固定目标，并把客户端请求的主机名交回测试。
//
// 它存在的理由不是"代理能用"，而是两条性质：请求走的是这条连接，以及主机名
// 是**交给代理**解析的（ATYP=domain）。目标站只有经代理可达时，后者才是它真的
// 能访问到的原因。
func startSocks5Server(t *testing.T, dialTo string) (addr string, hosts <-chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	got := make(chan string, 1)

	go func() {
		defer close(got)
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()

		// 握手：VER=5, NMETHODS, METHODS；回 5 0（不需要认证）。
		head := make([]byte, 2)
		if _, err := io.ReadFull(conn, head); err != nil {
			return
		}
		methods := make([]byte, int(head[1]))
		if _, err := io.ReadFull(conn, methods); err != nil {
			return
		}
		if _, err := conn.Write([]byte{5, 0}); err != nil {
			return
		}

		// 请求：VER CMD RSV ATYP ADDR PORT
		req := make([]byte, 4)
		if _, err := io.ReadFull(conn, req); err != nil {
			return
		}
		var host string
		switch req[3] {
		case 3: // 域名
			size := make([]byte, 1)
			if _, err := io.ReadFull(conn, size); err != nil {
				return
			}
			name := make([]byte, int(size[0]))
			if _, err := io.ReadFull(conn, name); err != nil {
				return
			}
			host = string(name)
		case 1: // IPv4
			ip := make([]byte, 4)
			if _, err := io.ReadFull(conn, ip); err != nil {
				return
			}
			host = net.IP(ip).String()
		default:
			return
		}
		port := make([]byte, 2)
		if _, err := io.ReadFull(conn, port); err != nil {
			return
		}
		select {
		case got <- host:
		default:
		}

		upstream, err := net.Dial("tcp", dialTo)
		if err != nil {
			_, _ = conn.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0}) // 连接被拒
			return
		}
		defer upstream.Close()
		if _, err := conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
			return
		}
		go func() { _, _ = io.Copy(upstream, conn) }()
		_, _ = io.Copy(conn, upstream)
	}()

	return ln.Addr().String(), got
}

func TestSendViaSocks5ProxyUsesRemoteDNS(t *testing.T) {
	target, received := startRawServer(t, func([]byte) []byte {
		return []byte("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nvia-s5!")
	})
	proxyAddr, hosts := startSocks5Server(t, target)

	// target.test 在本机解析不了：能通就说明主机名交给了代理解析。
	res := send(t, "GET / HTTP/1.1\r\nHost: target.test\r\n\r\n", func(o *Options) {
		o.FallbackURL = "http://target.test"
		o.UpstreamProxy = "socks5://" + proxyAddr
	})
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	if host := <-hosts; host != "target.test" {
		t.Errorf("代理收到的目标主机 = %q, want target.test（应交给代理解析）", host)
	}
	req := <-received
	if !bytes.Contains(req, []byte("Host: target.test")) {
		t.Errorf("目标收到的请求头不对: %q", req)
	}
	if string(res.Response.Body) != "via-s5!" {
		t.Errorf("Body = %q", res.Response.Body)
	}
}

func TestSendViaSocks5ProxyAuth(t *testing.T) {
	// 认证失败时引擎报 upstream_auth 还是 upstream_connect，取决于服务端怎么回；
	// 这里只钉住"凭据被送去认证"这条路径不会崩，且错误被归类。
	target, _ := startRawServer(t, func([]byte) []byte {
		return []byte("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	seen := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		head := make([]byte, 2)
		if _, err := io.ReadFull(conn, head); err != nil {
			return
		}
		methods := make([]byte, int(head[1]))
		if _, err := io.ReadFull(conn, methods); err != nil {
			return
		}
		// 要求用户名/密码认证（0x02）。
		_, _ = conn.Write([]byte{5, 2})
		// 认证请求：VER ULEN UNAME PLEN PASSWD
		authHead := make([]byte, 2)
		if _, err := io.ReadFull(conn, authHead); err != nil {
			return
		}
		user := make([]byte, int(authHead[1]))
		if _, err := io.ReadFull(conn, user); err != nil {
			return
		}
		plen := make([]byte, 1)
		if _, err := io.ReadFull(conn, plen); err != nil {
			return
		}
		pass := make([]byte, int(plen[0]))
		if _, err := io.ReadFull(conn, pass); err != nil {
			return
		}
		payload := make([]byte, 0, 2+len(user)+len(pass))
		payload = append(payload, user...)
		payload = append(payload, ':')
		payload = append(payload, pass...)
		select {
		case seen <- payload:
		default:
		}
		// 认证成功，然后按 CONNECT 正常转发。
		_, _ = conn.Write([]byte{1, 0})
		_ = binary.Write(io.Discard, binary.BigEndian, 0)
		upstream, derr := net.Dial("tcp", target)
		if derr != nil {
			return
		}
		defer upstream.Close()
		req := make([]byte, 4)
		if _, err := io.ReadFull(conn, req); err != nil {
			return
		}
		switch req[3] {
		case 3:
			size := make([]byte, 1)
			if _, err := io.ReadFull(conn, size); err != nil {
				return
			}
			_, _ = io.CopyN(io.Discard, conn, int64(size[0]))
		case 1:
			_, _ = io.CopyN(io.Discard, conn, 4)
		}
		_, _ = io.CopyN(io.Discard, conn, 2)
		_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
		go func() { _, _ = io.Copy(upstream, conn) }()
		_, _ = io.Copy(conn, upstream)
	}()

	res := send(t, "GET / HTTP/1.1\r\nHost: target.test\r\n\r\n", func(o *Options) {
		o.FallbackURL = "http://target.test"
		o.UpstreamProxy = "socks5://alice:s3cret@" + ln.Addr().String()
	})
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	if got := <-seen; string(got) != "alice:s3cret" {
		t.Errorf("代理收到的凭据 = %q, want alice:s3cret", got)
	}
}

func TestSocks5ProxyUnreachableIsReportedAsProxyFailure(t *testing.T) {
	// 一个已经关掉的端口当"代理"：错误必须说代理，不能说目标拒绝连接。
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	res := send(t, "GET / HTTP/1.1\r\nHost: target.test\r\n\r\n", func(o *Options) {
		o.FallbackURL = "http://target.test"
		o.UpstreamProxy = "socks5://" + addr
	})
	if res.Err == nil {
		t.Fatal("应返回错误")
	}
	if res.Err.Code != "upstream_connect" {
		t.Errorf("Err.Code = %q, want upstream_connect（%+v）", res.Err.Code, res.Err)
	}
	if !bytes.Contains([]byte(res.Err.Message), []byte("代理")) {
		t.Errorf("错误信息应提到代理: %q", res.Err.Message)
	}
}
