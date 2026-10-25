package api

import "testing"

func TestNormalizeSocks5Proxy(t *testing.T) {
	accept := map[string]string{
		"socks5://127.0.0.1:1080":      "socks5://127.0.0.1:1080",
		"  127.0.0.1:7890  ":           "socks5://127.0.0.1:7890",
		"proxy.corp:1080":              "socks5://proxy.corp:1080",
		"socks5h://10.0.0.2:1080":      "socks5://10.0.0.2:1080",
		"socks5://alice:p%40ss@h:1080": "socks5://alice:p%40ss@h:1080",
		"socks5://alice:s3cret@h:1080": "socks5://alice:s3cret@h:1080",
		"socks5://[::1]:1080":          "socks5://[::1]:1080",
		"socks5://proxy.corp":          "socks5://proxy.corp:1080", // SOCKS5 惯例端口
		"":                             "",
	}
	for in, want := range accept {
		got, err := normalizeSocks5Proxy(in)
		if err != nil {
			t.Errorf("normalizeSocks5Proxy(%q) 报错: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("normalizeSocks5Proxy(%q) = %q, want %q", in, got, want)
		}
	}

	reject := []string{
		"http://127.0.0.1:8080",   // 只支持 SOCKS5
		"socks4://127.0.0.1:1080", // 只支持 SOCKS5
		"https://proxy.corp:443",
		"socks5://:1080",   // 没有主机
		"socks5://h:0",     // 端口非法
		"socks5://h:70000", // 端口越界
		"socks5://h:abc",
	}
	for _, in := range reject {
		if got, err := normalizeSocks5Proxy(in); err == nil {
			t.Errorf("normalizeSocks5Proxy(%q) = %q，应报错", in, got)
		}
	}
}
