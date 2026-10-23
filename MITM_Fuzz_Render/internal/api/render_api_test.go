package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/chinaran404/replayd/internal/browser"
	"github.com/chinaran404/replayd/internal/store"
)

const renderTestPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>渲染页</title></head>
<body><h1>initial</h1><button aria-label="确定按钮">确定</button><div id="o"></div>
<script>document.querySelector('h1').textContent='JS渲染完成';document.getElementById('o').textContent='marker-99';</script>
</body></html>`

// enableRender 给测试服务器装上渲染能力；没有可用浏览器时跳过。
func enableRender(t *testing.T, srv *Server) {
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
	srv.EnableRender(mgr)
}

func newRenderTarget(t *testing.T) *httptest.Server {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, renderTestPage)
	}))
	t.Cleanup(upstream.Close)
	return upstream
}

func TestRenderAPI(t *testing.T) {
	srv, ts, token := newTestServer(t)
	enableRender(t, srv)
	upstream := newRenderTarget(t)

	body, _ := json.Marshal(map[string]any{"url": upstream.URL + "/", "waitUntil": "networkidle"})
	code, data := apiCall(t, ts, token, http.MethodPost, "/api/render", string(body))
	if code != http.StatusOK {
		t.Fatalf("status = %d (%s)", code, data)
	}
	var out renderResponse
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("解析: %v (%s)", err, data)
	}

	// 关键点：拿到的是 JS 执行后的结果
	if !strings.Contains(out.Text, "JS渲染完成") || !strings.Contains(out.Text, "marker-99") {
		t.Errorf("应是渲染后文本，实际:\n%s", out.Text)
	}
	if out.Title != "渲染页" || out.NavStatus != 200 {
		t.Errorf("title=%q status=%d", out.Title, out.NavStatus)
	}
	if len(out.A11y) == 0 {
		t.Error("应返回无障碍树")
	}
	if out.Screenshots["viewport"].ArtifactID == "" || out.Screenshots["full"].ArtifactID == "" {
		t.Fatalf("应返回视口与整页截图: %+v", out.Screenshots)
	}
	if out.FlowID == "" {
		t.Error("渲染动作应记入历史")
	}

	// 截图产物可下载且是 PNG
	code, png := apiCall(t, ts, token, http.MethodGet, out.Screenshots["full"].URL, "")
	if code != http.StatusOK {
		t.Fatalf("下载截图 status = %d", code)
	}
	if !bytes.HasPrefix(png, []byte{0x89, 'P', 'N', 'G'}) {
		t.Errorf("不是 PNG（%d 字节）", len(png))
	}

	// 历史里带 render: 备注
	flows, _, err := srv.store.ListFlows(t.Context(), store.Filter{})
	if err != nil || len(flows) != 1 {
		t.Fatalf("历史条数 = %d err=%v", len(flows), err)
	}
	full, err := srv.store.GetFlow(t.Context(), flows[0].ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(full.Note, "render: ") {
		t.Errorf("note = %q，应以 render: 开头", full.Note)
	}
}

func TestRenderAPIAsync(t *testing.T) {
	srv, ts, token := newTestServer(t)
	enableRender(t, srv)
	upstream := newRenderTarget(t)

	body, _ := json.Marshal(map[string]any{"url": upstream.URL + "/", "async": true})
	code, data := apiCall(t, ts, token, http.MethodPost, "/api/render", string(body))
	if code != http.StatusAccepted {
		t.Fatalf("异步应返回 202，实际 %d (%s)", code, data)
	}
	var accepted struct {
		JobID  string `json:"jobId"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(data, &accepted); err != nil || accepted.JobID == "" {
		t.Fatalf("应返回 jobId: %s", data)
	}

	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		code, data = apiCall(t, ts, token, http.MethodGet, "/api/render/jobs/"+accepted.JobID, "")
		if code != http.StatusOK {
			t.Fatalf("查询任务 status = %d", code)
		}
		var job renderJob
		if err := json.Unmarshal(data, &job); err != nil {
			t.Fatal(err)
		}
		switch job.Status {
		case "done":
			if job.Result == nil || !strings.Contains(job.Result.Text, "marker-99") {
				t.Fatalf("任务结果不对: %+v", job.Result)
			}
			return
		case "error":
			t.Fatalf("任务失败: %s", job.Error)
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatal("任务超时未完成")
}

func TestRenderAPIValidation(t *testing.T) {
	srv, ts, token := newTestServer(t)
	enableRender(t, srv)

	cases := []string{
		`{}`,
		`{"url":""}`,
		`{"url":"http://a.test/","waitUntil":"whenever"}`,
		`{"url":"ftp://a.test/"}`,
	}
	for _, payload := range cases {
		code, data := apiCall(t, ts, token, http.MethodPost, "/api/render", payload)
		if code != http.StatusBadRequest {
			t.Errorf("payload %s 应 400，实际 %d (%s)", payload, code, data)
		}
	}
	// viaProxy 未启动代理应报错而不是静默直连
	code, data := apiCall(t, ts, token, http.MethodPost, "/api/render", `{"url":"http://a.test/","viaProxy":true}`)
	if code != http.StatusBadRequest || !strings.Contains(string(data), "代理") {
		t.Errorf("viaProxy 未启动代理应 400 并说明原因: %d %s", code, data)
	}
}

func TestRenderStatusEndpoint(t *testing.T) {
	srv, ts, token := newTestServer(t)
	enableRender(t, srv)

	code, data := apiCall(t, ts, token, http.MethodGet, "/api/render/status", "")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	var out renderStatusResponse
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.Renderer || out.Browser["available"] != true {
		t.Errorf("浏览器应可用: %+v", out)
	}
	if out.Browser["path"] == nil || out.Browser["path"] == "" {
		t.Error("应报告浏览器路径")
	}
}

func TestRenderDisabledWithoutBrowserManager(t *testing.T) {
	_, ts, token := newTestServer(t)
	code, data := apiCall(t, ts, token, http.MethodPost, "/api/render", `{"url":"http://a.test/"}`)
	if code != http.StatusNotImplemented {
		t.Errorf("未启用渲染应 501，实际 %d (%s)", code, data)
	}
}

func TestArtifactsAPI(t *testing.T) {
	srv, ts, token := newTestServer(t)

	art := &store.Artifact{Kind: store.ArtifactScreenshotViewport, ContentType: "image/png"}
	data := append([]byte{0x89, 'P', 'N', 'G'}, bytes.Repeat([]byte{7}, 64)...)
	if err := srv.store.InsertArtifact(t.Context(), art, data); err != nil {
		t.Fatal(err)
	}

	code, body := apiCall(t, ts, token, http.MethodGet, "/api/artifacts", "")
	if code != http.StatusOK || !strings.Contains(string(body), art.ID) {
		t.Fatalf("列表应包含产物: %d %s", code, body)
	}

	code, got := apiCall(t, ts, token, http.MethodGet, "/api/artifacts/"+art.ID, "")
	if code != http.StatusOK || !bytes.Equal(got, data) {
		t.Fatalf("读取产物失败: %d, %d 字节", code, len(got))
	}

	code, _ = apiCall(t, ts, token, http.MethodGet, "/api/artifacts/art_missing", "")
	if code != http.StatusNotFound {
		t.Errorf("不存在的产物应 404，实际 %d", code)
	}

	code, _ = apiCall(t, ts, token, http.MethodDelete, "/api/artifacts/"+art.ID, "")
	if code != http.StatusNoContent {
		t.Errorf("删除应 204，实际 %d", code)
	}
	code, _ = apiCall(t, ts, token, http.MethodDelete, "/api/artifacts/"+art.ID, "")
	if code != http.StatusNotFound {
		t.Errorf("重复删除应 404，实际 %d", code)
	}

	// 未鉴权
	code, _ = apiCall(t, ts, "", http.MethodGet, "/api/artifacts", "")
	if code != http.StatusUnauthorized {
		t.Errorf("未鉴权应 401，实际 %d", code)
	}
}

/* -------------------------------------------------------------------------- */
/* MCP                                                                         */
/* -------------------------------------------------------------------------- */

// mcpCallRaw 发一次 MCP JSON-RPC 请求，返回 HTTP 状态与响应体。
func mcpCallRaw(t *testing.T, ts *httptest.Server, token, payload string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/mcp", strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

func TestMCPInitializeAndToolsList(t *testing.T) {
	_, ts, token := newTestServer(t)

	code, body := mcpCallRaw(t, ts, token,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"test","version":"1"}}}`)
	if code != http.StatusOK {
		t.Fatalf("initialize status = %d (%s)", code, body)
	}
	var resp struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
			Capabilities map[string]any `json:"capabilities"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Result.ProtocolVersion != "2025-06-18" || resp.Result.ServerInfo.Name != "replayd" {
		t.Errorf("握手结果不对: %s", body)
	}
	if _, ok := resp.Result.Capabilities["tools"]; !ok {
		t.Error("应声明 tools 能力")
	}

	// 通知不应有响应体
	code, body = mcpCallRaw(t, ts, token, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if code != http.StatusAccepted || len(body) != 0 {
		t.Errorf("通知应 202 空响应，实际 %d (%s)", code, body)
	}

	// tools/list
	code, body = mcpCallRaw(t, ts, token, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if code != http.StatusOK {
		t.Fatalf("tools/list status = %d", code)
	}
	var list struct {
		Result struct {
			Tools []struct {
				Name        string         `json:"name"`
				Description string         `json:"description"`
				InputSchema map[string]any `json:"inputSchema"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range list.Result.Tools {
		names[tool.Name] = true
		if tool.Description == "" || tool.InputSchema == nil {
			t.Errorf("工具 %s 缺少描述或 inputSchema", tool.Name)
		}
	}
	for _, want := range []string{"render_url", "render_status", "replay_request", "list_flows", "get_flow"} {
		if !names[want] {
			t.Errorf("缺少工具 %s（实际 %v）", want, names)
		}
	}
}

func TestMCPToolsCallWithoutBrowser(t *testing.T) {
	srv, ts, token := newTestServer(t)

	// render_status（无需浏览器）
	code, body := mcpCallRaw(t, ts, token,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"render_status","arguments":{}}}`)
	if code != http.StatusOK || !strings.Contains(string(body), "browser") {
		t.Fatalf("render_status 失败: %d %s", code, body)
	}
	var statusResp struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &statusResp); err != nil || len(statusResp.Result.Content) == 0 {
		t.Fatalf("render_status 响应不可解析: %s", body)
	}
	if !strings.Contains(statusResp.Result.Content[0].Text, `"rendererReady": false`) {
		t.Errorf("未启用渲染时应报 rendererReady=false: %s", statusResp.Result.Content[0].Text)
	}

	// list_flows：造一条历史再查
	status := 200
	seed := &store.Flow{
		Source: "replay", Method: "GET", Scheme: "https", Host: "seed.example", Port: 443,
		Path: "/", Status: &status,
	}
	if err := srv.store.InsertFlow(t.Context(), seed); err != nil {
		t.Fatal(err)
	}
	code, body = mcpCallRaw(t, ts, token,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_flows","arguments":{"limit":5}}}`)
	if code != http.StatusOK || !strings.Contains(string(body), "共 1 条") {
		t.Fatalf("list_flows 失败: %d %s", code, body)
	}

	// 未知工具
	code, body = mcpCallRaw(t, ts, token,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope","arguments":{}}}`)
	if code != http.StatusOK || !strings.Contains(string(body), "未知工具") {
		t.Errorf("未知工具应作为工具错误返回: %d %s", code, body)
	}
	if !strings.Contains(string(body), `"isError":true`) {
		t.Errorf("应带 isError=true: %s", body)
	}

	// 未鉴权
	code, _ = mcpCallRaw(t, ts, "", `{"jsonrpc":"2.0","id":6,"method":"tools/list"}`)
	if code != http.StatusUnauthorized {
		t.Errorf("未鉴权应 401，实际 %d", code)
	}
	// GET 不支持
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET /mcp 应 405，实际 %d", resp.StatusCode)
	}
}

func TestMCPRenderURL(t *testing.T) {
	srv, ts, token := newTestServer(t)
	enableRender(t, srv)
	upstream := newRenderTarget(t)

	payload := fmt.Sprintf(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"render_url","arguments":{"url":%q,"wait_until":"networkidle"}}}`, upstream.URL+"/")
	code, body := mcpCallRaw(t, ts, token, payload)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	var resp struct {
		Result struct {
			Content []struct {
				Type     string `json:"type"`
				Text     string `json:"text"`
				Data     string `json:"data"`
				MimeType string `json:"mimeType"`
			} `json:"content"`
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Result.IsError {
		t.Fatalf("渲染工具出错: %s", body)
	}
	var hasText, hasImage bool
	for _, item := range resp.Result.Content {
		switch item.Type {
		case "text":
			hasText = true
			if !strings.Contains(item.Text, "marker-99") || !strings.Contains(item.Text, "=== 渲染后文本 ===") {
				t.Errorf("文本内容块应包含渲染后文本: %s", item.Text[:min(len(item.Text), 400)])
			}
		case "image":
			hasImage = true
			if item.MimeType != "image/png" || len(item.Data) < 100 {
				t.Errorf("image 内容块不合法: mime=%s len=%d", item.MimeType, len(item.Data))
			}
		}
	}
	if !hasText || !hasImage {
		t.Errorf("应同时返回 text 与 image 内容块: %s", body[:min(len(body), 300)])
	}
}

func TestMCPReplayRequest(t *testing.T) {
	_, ts, token := newTestServer(t)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Server", "mcp-test")
		fmt.Fprint(w, "hello-from-target")
	}))
	defer upstream.Close()
	host := strings.TrimPrefix(upstream.URL, "http://")

	payload := fmt.Sprintf(`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"replay_request","arguments":{"raw":"GET / HTTP/1.1\r\nHost: %s\r\n\r\n","host":%q,"scheme":"http"}}}`,
		host, host)
	code, body := mcpCallRaw(t, ts, token, payload)
	if code != http.StatusOK {
		t.Fatalf("status = %d (%s)", code, body)
	}
	if !strings.Contains(string(body), "hello-from-target") || !strings.Contains(string(body), "X-Server: mcp-test") {
		t.Errorf("重放结果不完整: %s", body)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
