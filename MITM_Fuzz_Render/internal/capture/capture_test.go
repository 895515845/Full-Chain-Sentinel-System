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
