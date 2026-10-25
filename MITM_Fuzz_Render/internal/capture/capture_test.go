package capture

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
)

func TestSelfURL(t *testing.T) {
	cases := map[string]string{
		"127.0.0.1:8899": "http://127.0.0.1:8899",
		"0.0.0.0:8899":   "http://127.0.0.1:8899",
		"[::]:8899":      "http://127.0.0.1:8899",
		":8899":          "http://127.0.0.1:8899",
	}
	for in, want := range cases {
		if got := SelfURL(in); got != want {
			t.Errorf("SelfURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSpecValidation(t *testing.T) {
	c := New(nil, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, nil)
	ctx := context.Background()

	if _, err := c.Capture(ctx, Spec{}); err == nil || !strings.Contains(err.Error(), "raw") {
		t.Errorf("缺少 raw 应报错, got %v", err)
	}
	if _, err := c.Capture(ctx, Spec{Raw: "GET / HTTP/1.1\r\n\r\n", Scheme: "ftp"}); err == nil {
		t.Error("非 http(s) 应报错")
	}
	if _, err := c.Capture(ctx, Spec{Raw: "GET / HTTP/1.1\r\n\r\n", EvidenceMode: "weird"}); err == nil {
		t.Error("非法 evidenceMode 应报错")
	}
}

func TestSendDefault(t *testing.T) {
	if !shouldSend(Spec{}) {
		t.Error("默认应代发")
	}
	no := false
	if shouldSend(Spec{Send: &no}) {
		t.Error("Send=false 时不应代发")
	}
}

func TestFillScriptCarriesUpstreamProxy(t *testing.T) {
	spec := Spec{
		Raw: "GET / HTTP/1.1\r\nHost: x\r\n\r\n", Scheme: "http", Host: "x",
		UpstreamProxy: "socks5://alice:s3cret@127.0.0.1:1080",
	}
	script := fillScript(spec)
	if !strings.Contains(script, `data-testid="repeater-upstream-proxy"`) {
		t.Errorf("要求代理时应填界面上的代理框: %s", script)
	}
	if !strings.Contains(script, "socks5://alice:s3cret@127.0.0.1:1080") {
		t.Errorf("脚本里没有代理地址: %s", script)
	}

	// 没要求代理时不应碰那个框，但仍要报告 skipped（Capture 用它判断界面版本）。
	plain := fillScript(Spec{Raw: "GET / HTTP/1.1\r\nHost: x\r\n\r\n", Scheme: "http", Host: "x"})
	if strings.Contains(plain, "repeater-upstream-proxy") {
		t.Errorf("没有代理时不应填代理框: %s", plain)
	}
	if !strings.Contains(plain, "proxy:skipped") {
		t.Errorf("没有代理时应标记 proxy:skipped: %s", plain)
	}
}
