package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/chinaran404/replayd/internal/cert"
	"github.com/chinaran404/replayd/internal/config"
	"github.com/chinaran404/replayd/internal/eventbus"
	"github.com/chinaran404/replayd/internal/proxy"
	"github.com/chinaran404/replayd/internal/store"
)

func newTestServer(t *testing.T) (*Server, *httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	cfg := &config.Config{
		Listen:    "127.0.0.1:0",
		DataDir:   dir,
		Token:     "test-token-0123456789abcdef",
		Version:   "test",
		Commit:    "deadbeef",
		LogLevel:  "error",
		LogFormat: "text",
	}
	st, err := store.Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	bus := eventbus.New()
	ca, err := cert.Load(dir + "/ca")
	if err != nil {
		t.Fatalf("cert.Load: %v", err)
	}
	px := proxy.New(st, bus, ca, slog.New(slog.NewTextHandler(io.Discard, nil)))
	s := New(cfg, st, bus, slog.New(slog.NewTextHandler(io.Discard, nil)), px, ca)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts, cfg.Token
}

func getJSON(t *testing.T, client *http.Client, url string, dst any) *http.Response {
	t.Helper()
	resp, err := client.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if dst != nil {
		if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
			t.Fatalf("解析 %s 响应: %v", url, err)
		}
	}
	return resp
}

func TestHealthIsPublic(t *testing.T) {
	_, ts, _ := newTestServer(t)

	var body map[string]any
	resp := getJSON(t, ts.Client(), ts.URL+"/api/health", &body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if body["status"] != "ok" {
		t.Errorf("status = %v", body["status"])
	}
	if body["version"] != "test" {
		t.Errorf("version = %v", body["version"])
	}
	if body["authRequired"] != true {
		t.Errorf("authRequired = %v", body["authRequired"])
	}
	if _, ok := body["dataDir"]; !ok {
		t.Error("缺少 dataDir")
	}
}

func TestProtectedRequiresAuth(t *testing.T) {
	_, ts, _ := newTestServer(t)

	var body map[string]any
	resp := getJSON(t, ts.Client(), ts.URL+"/api/flows", &body)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	errObj, _ := body["error"].(map[string]any)
	if errObj["code"] != "unauthorized" {
		t.Errorf("error.code = %v", errObj["code"])
	}
}

func TestSessionFlow(t *testing.T) {
	_, ts, token := newTestServer(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	// 错误 token
	resp, err := client.Post(ts.URL+"/api/session", "application/json",
		strings.NewReader(`{"token":"wrong"}`))
	if err != nil {
		t.Fatalf("POST session: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("错误 token status = %d", resp.StatusCode)
	}

	// 正确 token
	resp, err = client.Post(ts.URL+"/api/session", "application/json",
		strings.NewReader(`{"token":"`+token+`"}`))
	if err != nil {
		t.Fatalf("POST session: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("正确 token status = %d, want 204", resp.StatusCode)
	}

	// cookie 生效
	var list map[string]any
	resp = getJSON(t, client, ts.URL+"/api/flows", &list)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("带 cookie 访问 flows status = %d", resp.StatusCode)
	}
	items, ok := list["items"].([]any)
	if !ok || len(items) != 0 {
		t.Errorf("items = %v", list["items"])
	}
}

func TestBearerAuth(t *testing.T) {
	_, ts, token := newTestServer(t)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/flows", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

func TestCSRFBlocksCrossOrigin(t *testing.T) {
	_, ts, token := newTestServer(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	// 先建立会话。
	resp, err := client.Post(ts.URL+"/api/session", "application/json",
		strings.NewReader(`{"token":"`+token+`"}`))
	if err != nil {
		t.Fatalf("建立会话: %v", err)
	}
	_ = resp.Body.Close()

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/flows/flw_x", nil)
	req.Header.Set("Origin", "http://evil.example")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("跨站写请求 status = %d, want 403", resp.StatusCode)
	}

	// 同源写请求应放行（这里因资源不存在返回 404，而不是 403）。
	req2, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/flows/flw_x", nil)
	req2.Header.Set("Origin", ts.URL)
	resp2, err := client.Do(req2)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Errorf("同源写请求 status = %d, want 404", resp2.StatusCode)
	}
}

func TestBootstrapTokenRedirect(t *testing.T) {
	_, ts, token := newTestServer(t)
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Get(ts.URL + "/?token=" + token)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want 302", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "/" {
		t.Errorf("Location = %q", loc)
	}
	var found bool
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie && c.Value == sessionValue(token) {
			found = true
		}
	}
	if !found {
		t.Error("未设置会话 cookie")
	}
}

func TestUnknownAPIReturnsJSON404(t *testing.T) {
	_, ts, token := newTestServer(t)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/nope", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}
}

func TestSPAFallback(t *testing.T) {
	_, ts, _ := newTestServer(t)
	resp, err := ts.Client().Get(ts.URL + "/history")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q", ct)
	}
}

func TestFlowsCRUD(t *testing.T) {
	srv, ts, token := newTestServer(t)
	ctx := context.Background()
	status := 200

	f := &store.Flow{
		Source: "replay", Method: "GET", Scheme: "https", Host: "example.com", Port: 443,
		Path: "/", Status: &status, ReqRaw: []byte("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"),
		RespRaw: []byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi"),
	}
	if err := srv.store.InsertFlow(ctx, f); err != nil {
		t.Fatalf("InsertFlow: %v", err)
	}

	client := &http.Client{}
	do := func(method, path string) (*http.Response, []byte) {
		t.Helper()
		req, _ := http.NewRequest(method, ts.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return resp, body
	}

	resp, body := do(http.MethodGet, "/api/flows")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d", resp.StatusCode)
	}
	var list flowListResponse
	if err := json.Unmarshal(body, &list); err != nil {
		t.Fatalf("解析列表: %v", err)
	}
	if len(list.Items) != 1 || list.Items[0].ID != f.ID {
		t.Fatalf("列表内容不符: %+v", list.Items)
	}

	resp, body = do(http.MethodGet, "/api/flows/"+f.ID+"?body=1")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("detail status = %d", resp.StatusCode)
	}
	if !strings.Contains(string(body), `"reqRaw":"GET / HTTP/1.1`) {
		t.Errorf("详情缺少 reqRaw: %s", body)
	}

	resp, _ = do(http.MethodDelete, "/api/flows/"+f.ID)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status = %d", resp.StatusCode)
	}
	resp, _ = do(http.MethodGet, "/api/flows/"+f.ID)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("删除后 status = %d, want 404", resp.StatusCode)
	}
}

func TestEventsWebSocket(t *testing.T) {
	_, ts, token := newTestServer(t)

	header := http.Header{}
	header.Set("Cookie", sessionCookie+"="+sessionValue(token))
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/events"
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("连接 WebSocket 失败 (status=%d): %v", status, err)
	}
	defer func() { _ = conn.Close() }()

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var ev eventbus.Event
	if err := conn.ReadJSON(&ev); err != nil {
		t.Fatalf("读取 hello 事件: %v", err)
	}
	if ev.Type != "hello" {
		t.Errorf("首个事件 type = %q, want hello", ev.Type)
	}
}

func TestLoginRateLimit(t *testing.T) {
	_, ts, _ := newTestServer(t)
	client := ts.Client()

	var last int
	for i := 0; i < 12; i++ {
		resp, err := client.Post(ts.URL+"/api/session", "application/json",
			strings.NewReader(`{"token":"wrong"}`))
		if err != nil {
			t.Fatalf("POST session: %v", err)
		}
		_ = resp.Body.Close()
		last = resp.StatusCode
	}
	if last != http.StatusTooManyRequests {
		t.Errorf("连续失败后的状态码 = %d, want 429", last)
	}
}
