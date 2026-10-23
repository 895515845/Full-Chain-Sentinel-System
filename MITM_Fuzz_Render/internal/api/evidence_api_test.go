package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chinaran404/replayd/internal/store"
)

// evidenceCall 调 /api/evidence，返回解析后的响应。
func evidenceCall(t *testing.T, ts *httptest.Server, token, query string) evidenceResponse {
	t.Helper()
	code, data := apiCall(t, ts, token, http.MethodGet, "/api/evidence?"+query, "")
	if code != http.StatusOK {
		t.Fatalf("evidence status = %d (%s)", code, data)
	}
	var out evidenceResponse
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("解析 evidence 响应: %v (%s)", err, data)
	}
	return out
}

func TestEvidenceDirectWhenFrameable(t *testing.T) {
	srv, ts, token := newTestServer(t)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<html><body>北京时间 12:00:00</body></html>")
	}))
	defer upstream.Close()

	out := evidenceCall(t, ts, token, "url="+upstream.URL+"/")

	if out.Mode != "direct" {
		t.Fatalf("允许内嵌时应为 direct, got %q (reason=%s)", out.Mode, out.Reason)
	}
	if out.Status != 200 || out.Size == 0 {
		t.Errorf("应带回抓取元信息: status=%d size=%d", out.Status, out.Size)
	}
	if out.FlowID == "" {
		t.Error("取证抓取应记入历史（flowId 为空）")
	}
	if out.LocalTime == "" || out.FetchedAt == "" {
		t.Error("应返回抓取时间与本地时间")
	}

	// 历史里能看到这条 flow，note 带 evidence 前缀
	flows, _, err := srv.store.ListFlows(context.Background(), store.Filter{})
	if err != nil || len(flows) != 1 {
		t.Fatalf("历史条数 = %d, err=%v", len(flows), err)
	}
	full, err := srv.store.GetFlow(context.Background(), flows[0].ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(full.Note, "evidence: ") || !strings.Contains(full.Note, "direct") {
		t.Errorf("note = %q, 应以 evidence: 开头并标注模式", full.Note)
	}
}

func TestEvidenceSnapshotWhenFramingForbidden(t *testing.T) {
	_, ts, token := newTestServer(t)

	page := `<html><head>
<meta http-equiv="X-Frame-Options" content="DENY">
<script>document.write("evil")</script>
<title>授时</title>
</head><body onload="evil()">
<h1>国家授时中心</h1><div onclick="evil()">2026-10-22 17:58:03</div>
<img src="/clock.png">
</body></html>`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'self'")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, page)
	}))
	defer upstream.Close()

	out := evidenceCall(t, ts, token, "url="+upstream.URL+"/sub/page.html")

	if out.Mode != "snapshot" {
		t.Fatalf("禁止内嵌时应为 snapshot, got %q", out.Mode)
	}
	if out.SnapshotURL == "" || !strings.HasPrefix(out.SnapshotURL, "/api/evidence/snapshot/") {
		t.Fatalf("应返回快照地址: %+v", out)
	}
	if out.Reason == "" {
		t.Error("应说明为什么不能内嵌")
	}

	// 拉取快照内容
	code, body := apiCall(t, ts, token, http.MethodGet, out.SnapshotURL, "")
	if code != http.StatusOK {
		t.Fatalf("快照状态 = %d", code)
	}
	s := string(body)
	if strings.Contains(s, "<script") || strings.Contains(s, "evil()") {
		t.Errorf("快照应剥离脚本:\n%s", s)
	}
	if strings.Contains(strings.ToLower(s), "onload=") || strings.Contains(strings.ToLower(s), "onclick=") {
		t.Errorf("快照应剥离内联事件:\n%s", s)
	}
	if !strings.Contains(s, `/clock.png`) {
		t.Errorf("相对资源应保留（配合 base 指向原站）:\n%s", s)
	}
	if !strings.Contains(s, upstream.URL) {
		t.Errorf("应注入指向原站的 base:\n%s", s)
	}
	if !strings.Contains(s, "国家授时中心") {
		t.Errorf("正文应保留:\n%s", s)
	}
}

func TestEvidenceSnapshotKeepsScriptsWhenAsked(t *testing.T) {
	_, ts, token := newTestServer(t)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head><script>tick()</script></head><body>clock</body></html>`)
	}))
	defer upstream.Close()

	out := evidenceCall(t, ts, token, "url="+upstream.URL+"/&allowScripts=1")
	if out.Mode != "snapshot" {
		t.Fatalf("mode = %q", out.Mode)
	}
	_, body := apiCall(t, ts, token, http.MethodGet, out.SnapshotURL, "")
	if !strings.Contains(string(body), "tick()") {
		t.Errorf("allowScripts=1 时应保留脚本:\n%s", body)
	}
}

func TestEvidenceExplicitDirectOverrides(t *testing.T) {
	_, ts, token := newTestServer(t)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		fmt.Fprint(w, "<html><body>blocked</body></html>")
	}))
	defer upstream.Close()

	out := evidenceCall(t, ts, token, "url="+upstream.URL+"/&mode=direct")
	if out.Mode != "direct" {
		t.Fatalf("显式 direct 应被尊重, got %q", out.Mode)
	}
}

func TestEvidenceNetworkErrorRecorded(t *testing.T) {
	srv, ts, token := newTestServer(t)

	out := evidenceCall(t, ts, token, "url=http://127.0.0.1:1/")
	if out.Mode != "error" || out.Error == nil {
		t.Fatalf("应返回 error 模式: %+v", out)
	}
	if out.FlowID == "" {
		t.Error("失败尝试也应记入历史（便于复盘）")
	}
	flows, _, _ := srv.store.ListFlows(context.Background(), store.Filter{})
	if len(flows) != 1 {
		t.Fatalf("历史条数 = %d", len(flows))
	}
}

func TestEvidenceValidation(t *testing.T) {
	_, ts, token := newTestServer(t)

	code, data := apiCall(t, ts, token, http.MethodGet, "/api/evidence", "")
	if code != http.StatusBadRequest {
		t.Errorf("缺 url 应 400, got %d", code)
	}

	code, data = apiCall(t, ts, token, http.MethodGet, "/api/evidence?url=ftp://a.test/x", "")
	if code != http.StatusBadRequest {
		t.Errorf("非 http(s) 应 400, got %d (%s)", code, data)
	}

	// 未鉴权
	code, _ = apiCall(t, ts, "", http.MethodGet, "/api/evidence?url=http://a.test/", "")
	if code != http.StatusUnauthorized {
		t.Errorf("未鉴权应 401, got %d", code)
	}
}

func TestEvidenceSources(t *testing.T) {
	_, ts, token := newTestServer(t)
	code, data := apiCall(t, ts, token, http.MethodGet, "/api/evidence/sources", "")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if !strings.Contains(string(data), "beijing-time.org") || !strings.Contains(string(data), "ntsc.ac.cn") {
		t.Errorf("预设列表不完整: %s", data)
	}
}

func TestEvidenceSnapshotExpired(t *testing.T) {
	_, ts, token := newTestServer(t)
	code, body := apiCall(t, ts, token, http.MethodGet, "/api/evidence/snapshot/ev_not_exist", "")
	if code != http.StatusNotFound {
		t.Fatalf("不存在的快照应 404, got %d", code)
	}
	if !strings.Contains(string(body), "快照已过期") {
		t.Errorf("应给出可读提示: %s", body)
	}
}
