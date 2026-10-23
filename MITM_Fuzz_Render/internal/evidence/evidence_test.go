package evidence

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestFrameable(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		want    bool
	}{
		{"无限制", nil, true},
		{"XFO DENY", map[string]string{"X-Frame-Options": "DENY"}, false},
		{"XFO SAMEORIGIN", map[string]string{"X-Frame-Options": "SAMEORIGIN"}, false},
		{"XFO 小写 sameorigin", map[string]string{"X-Frame-Options": "sameorigin"}, false},
		{"CSP frame-ancestors self", map[string]string{"Content-Security-Policy": "default-src 'self'; frame-ancestors 'self'"}, false},
		{"CSP frame-ancestors none", map[string]string{"Content-Security-Policy": "frame-ancestors 'none'"}, false},
		{"CSP frame-ancestors 允许本机", map[string]string{"Content-Security-Policy": "frame-ancestors http://127.0.0.1:8899"}, true},
		{"CSP frame-ancestors *", map[string]string{"Content-Security-Policy": "frame-ancestors *"}, true},
		{"CSP 其他指令不影响", map[string]string{"Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := http.Header{}
			for k, v := range tc.headers {
				h.Set(k, v)
			}
			got, reason := Frameable(h)
			if got != tc.want {
				t.Errorf("Frameable = %v (%s), want %v", got, reason, tc.want)
			}
			if !got && reason == "" {
				t.Error("不允许时应给出原因")
			}
		})
	}
}

func TestRewriteStripsScriptsAndHandlers(t *testing.T) {
	body := []byte(`<html><head>
<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'self'">
<base href="https://wrong.example/">
<title>时间</title>
<script>alert('x')</script>
<script src="/a.js"></script>
</head><body onload="evil()">
<div onclick="evil()">北京时间 <span onclick="evil2()">12:00</span></div>
<a href="javascript:evil()">链接</a>
<img src="/clock.png" onerror="evil3()">
</body></html>`)

	out, err := Rewrite(body, "https://time.example/beijing/", false)
	if err != nil {
		t.Fatalf("Rewrite: %v", err)
	}
	s := string(out)

	if strings.Contains(s, "<script") || strings.Contains(s, "alert(") || strings.Contains(s, "/a.js") {
		t.Errorf("脚本应被剥离:\n%s", s)
	}
	if strings.Contains(strings.ToLower(s), "onload=") || strings.Contains(strings.ToLower(s), "onclick=") || strings.Contains(strings.ToLower(s), "onerror=") {
		t.Errorf("内联事件应被剥离:\n%s", s)
	}
	if strings.Contains(strings.ToLower(s), "javascript:") {
		t.Errorf("javascript: 伪协议应被剥离:\n%s", s)
	}
	if strings.Contains(strings.ToLower(s), "http-equiv") && strings.Contains(strings.ToLower(s), "content-security-policy") {
		t.Errorf("meta CSP 应被移除:\n%s", s)
	}
	// base 必须是我们注入的目标站地址，且原 base 已移除
	if !strings.Contains(s, `<base href="https://time.example/beijing/"/>`) &&
		!strings.Contains(s, `<base href="https://time.example/beijing/">`) {
		t.Errorf("应注入目标站 base:\n%s", s)
	}
	if strings.Contains(s, "wrong.example") {
		t.Errorf("原 base 应被移除:\n%s", s)
	}
	// 内容仍在
	if !strings.Contains(s, "北京时间") || !strings.Contains(s, "/clock.png") {
		t.Errorf("正文与相对资源应保留:\n%s", s)
	}
}

func TestRewriteAggressiveModeKeepsScripts(t *testing.T) {
	body := []byte(`<html><head><script>tick()</script></head><body onload="tick()">ok</body></html>`)
	out, err := Rewrite(body, "https://time.example/", true)
	if err != nil {
		t.Fatalf("Rewrite: %v", err)
	}
	s := string(out)
	if !strings.Contains(s, "tick()") {
		t.Errorf("keepScripts=true 时应保留脚本:\n%s", s)
	}
	// 即便保留脚本，仍要注入 base（相对资源才可用）
	if !strings.Contains(s, `https://time.example/`) {
		t.Errorf("应注入 base:\n%s", s)
	}
}

func TestRewriteWithoutHead(t *testing.T) {
	out, err := Rewrite([]byte(`<p>no head here</p>`), "https://a.example/x/", false)
	if err != nil {
		t.Fatalf("Rewrite: %v", err)
	}
	if !strings.Contains(string(out), "https://a.example/x/") {
		t.Errorf("无 head 时应创建并注入 base:\n%s", out)
	}
}

func TestCacheLRUAndTTL(t *testing.T) {
	now := time.Now()
	c := NewCache(2, 100*time.Millisecond)
	c.now = func() time.Time { return now }

	id1 := c.Put(&Snapshot{SourceURL: "a", Body: []byte("A"), FetchedAt: c.now()})
	c.Put(&Snapshot{SourceURL: "b", Body: []byte("B"), FetchedAt: c.now()})
	if _, ok := c.Get(id1); !ok {
		t.Fatal("应命中 a")
	}
	// 插入第三条：应淘汰最久未使用的（b，因为刚刚访问过 a）
	id3 := c.Put(&Snapshot{SourceURL: "c", Body: []byte("C"), FetchedAt: c.now()})
	if _, ok := c.Get(id1); !ok {
		t.Error("a 刚被访问，不应被淘汰")
	}
	if _, ok := c.Get(id3); !ok {
		t.Error("c 应存在")
	}

	// TTL 过期
	now = now.Add(200 * time.Millisecond)
	if _, ok := c.Get(id3); ok {
		t.Error("超过 TTL 应视为不存在")
	}
}

func TestCacheTruncatesHugeBody(t *testing.T) {
	c := NewCache(4, time.Minute)
	big := make([]byte, MaxSnapshotBytes+1024)
	id := c.Put(&Snapshot{SourceURL: "big", Body: big, FetchedAt: c.now()})
	snap, ok := c.Get(id)
	if !ok {
		t.Fatal("应命中")
	}
	if !snap.Truncated || len(snap.Body) != MaxSnapshotBytes {
		t.Errorf("超大快照应被截断: len=%d truncated=%v", len(snap.Body), snap.Truncated)
	}
}
