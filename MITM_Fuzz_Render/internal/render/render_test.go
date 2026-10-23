package render

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/chinaran404/replayd/internal/browser"
)

// newTestRenderer 在没有可用浏览器时跳过测试。
func newTestRenderer(t *testing.T) *Renderer {
	t.Helper()
	dataDir := t.TempDir()
	if _, _, err := browser.Resolve(dataDir); err != nil {
		t.Skipf("跳过：本机没有可用浏览器（%v）", err)
	}
	mgr := browser.New(browser.Options{
		DataDir:     dataDir,
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		IdleTimeout: time.Minute,
	})
	t.Cleanup(mgr.Close)
	return New(mgr, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestRenderLocalPage(t *testing.T) {
	renderer := newTestRenderer(t)

	page := `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>渲染测试页</title></head>
<body>
  <h1 id="h">初始标题</h1>
  <button id="btn" aria-label="提交按钮">提交</button>
  <div id="out">等待脚本…</div>
  <script>
    document.getElementById('h').textContent = 'JS 已执行 ✓';
    document.getElementById('out').textContent = 'marker-42';
  </script>
</body></html>`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, page)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	res, err := renderer.Render(ctx, Spec{URL: srv.URL + "/page", WaitUntil: "networkidle"})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}

	// JS 执行了 → 文本里能看到脚本写入的内容（这是"无头渲染"与"直接抓 HTML"的本质区别）
	if !strings.Contains(res.Text, "JS 已执行") || !strings.Contains(res.Text, "marker-42") {
		t.Errorf("渲染文本里没有脚本写入的内容：\n%s", res.Text)
	}
	if res.Title != "渲染测试页" {
		t.Errorf("Title = %q", res.Title)
	}
	if res.NavStatus != 200 {
		t.Errorf("NavStatus = %d, want 200", res.NavStatus)
	}
	if !strings.HasPrefix(res.FinalURL, srv.URL) {
		t.Errorf("FinalURL = %q", res.FinalURL)
	}

	// 无障碍树里应能找到一个名为「提交」的按钮
	foundBtn := false
	for _, node := range res.A11y {
		if node.Role == "button" && strings.Contains(node.Name, "提交") {
			foundBtn = true
		}
	}
	if !foundBtn {
		t.Errorf("无障碍树里没找到按钮节点（共 %d 个节点）", len(res.A11y))
	}

	// 截图必须是合法 PNG
	if len(res.ViewportPNG) == 0 || !bytes.HasPrefix(res.ViewportPNG, []byte{0x89, 'P', 'N', 'G'}) {
		t.Errorf("视口截图不是 PNG（%d 字节）", len(res.ViewportPNG))
	}
	if len(res.FullPNG) == 0 || !bytes.HasPrefix(res.FullPNG, []byte{0x89, 'P', 'N', 'G'}) {
		t.Errorf("整页截图不是 PNG（%d 字节）", len(res.FullPNG))
	}
	if res.Timings.TotalMS <= 0 {
		t.Errorf("Timings = %+v", res.Timings)
	}
	t.Logf("渲染成功：text=%d 字 a11y=%d 节点 视口截图=%dKB 整页=%dKB 耗时=%dms status=%d",
		len(res.Text), len(res.A11y), len(res.ViewportPNG)/1024, len(res.FullPNG)/1024, res.Timings.TotalMS, res.NavStatus)
}

func TestRenderValidation(t *testing.T) {
	renderer := New(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx := context.Background()

	cases := []struct {
		name string
		spec Spec
	}{
		{"空 URL", Spec{}},
		{"非 http 协议", Spec{URL: "ftp://a.test/x"}},
		{"非法 waitUntil", Spec{URL: "http://a.test/", WaitUntil: "whatever"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := renderer.Render(ctx, tc.spec); err == nil {
				t.Fatal("应返回错误")
			}
		})
	}
}

func TestRenderLargePageTruncatesText(t *testing.T) {
	renderer := newTestRenderer(t)

	big := strings.Repeat("北京时间 ", 5000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, "<html><body><div>%s</div></body></html>", big)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	res, err := renderer.Render(ctx, Spec{URL: srv.URL, TextLimit: 2000})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !res.TextTruncated {
		t.Error("超过 textLimit 应标记截断")
	}
	if len(res.Text) > 2000 {
		t.Errorf("文本长度 = %d, 应 ≤ 2000", len(res.Text))
	}
}

func TestRenderNoScreenshotOption(t *testing.T) {
	renderer := newTestRenderer(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<html><body><p>只取文本</p></body></html>")
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	res, err := renderer.Render(ctx, Spec{URL: srv.URL, NoScreenshot: true, NoA11y: true})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if len(res.ViewportPNG) != 0 || len(res.FullPNG) != 0 {
		t.Error("NoScreenshot=true 时不应有截图")
	}
	if len(res.A11y) != 0 {
		t.Error("NoA11y=true 时不应有无障碍树")
	}
	if !strings.Contains(res.Text, "只取文本") {
		t.Errorf("Text = %q", res.Text)
	}
}

func TestRenderBadHost(t *testing.T) {
	renderer := newTestRenderer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	_, err := renderer.Render(ctx, Spec{URL: "http://this-host-does-not-exist.invalid/"})
	if err == nil {
		t.Fatal("不存在的主机应报错")
	}
	t.Logf("预期错误: %v", err)
}
