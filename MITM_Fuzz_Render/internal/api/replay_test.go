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

func TestReplayRoundTrip(t *testing.T) {
	srv, ts, token := newTestServer(t)

	// 目标服务：固定回 JSON
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ping" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("X-Echo", r.Header.Get("X-Marker"))
		fmt.Fprint(w, `{"pong":true}`)
	}))
	defer upstream.Close()

	body := `{
		"raw": "GET /ping HTTP/1.1\r\nHost: whatever\r\nX-Marker: m1\r\n\r\n",
		"target": {"scheme": "http", "host": "` + strings.TrimPrefix(upstream.URL, "http://") + `"},
		"save": true
	}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/replay", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("POST /api/replay: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	var out struct {
		FlowID  string `json:"flowId"`
		Request struct {
			URL struct {
				Host string `json:"host"`
			} `json:"url"`
		} `json:"request"`
		Response *struct {
			Status   int    `json:"status"`
			BodyText string `json:"bodyText"`
			Headers  []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"headers"`
		} `json:"response"`
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
		Timings struct {
			TotalMS int64 `json:"totalMs"`
		} `json:"timings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("解析响应: %v", err)
	}
	if out.Error != nil {
		t.Fatalf("引擎错误: %+v", out.Error)
	}
	if out.FlowID == "" {
		t.Fatal("save=true 时应返回 flowId")
	}
	if out.Response == nil || out.Response.Status != 200 {
		t.Fatalf("Response = %+v", out.Response)
	}
	if !strings.Contains(out.Response.BodyText, `"pong":true`) {
		t.Errorf("BodyText = %q", out.Response.BodyText)
	}
	echoed := false
	for _, h := range out.Response.Headers {
		if h.Name == "X-Echo" && h.Value == "m1" {
			echoed = true
		}
	}
	if !echoed {
		t.Error("请求头 X-Marker 应到达上游")
	}

	// 已落库且出现在历史里
	flows, _, err := srv.store.ListFlows(context.Background(), store.Filter{Source: "replay"})
	if err != nil {
		t.Fatalf("ListFlows: %v", err)
	}
	if len(flows) != 1 || flows[0].ID != out.FlowID {
		t.Fatalf("历史条数 = %d, flowId 不符", len(flows))
	}
	if flows[0].Method != "GET" || flows[0].Path != "/ping" {
		t.Errorf("flow 元数据: %+v", flows[0])
	}
}

func TestReplayBadRequest(t *testing.T) {
	_, ts, token := newTestServer(t)
	client := ts.Client()

	post := func(body string) *http.Response {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/replay", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("POST: %v", err)
		}
		return resp
	}

	// 缺 raw → 400
	resp := post(`{}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("缺 raw status = %d, want 400", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 既没有 target 字段、报文里也没有 Host 头 → 无从确定去处，引擎层报 bad_request
	resp = post(`{"raw": "GET / HTTP/1.1\r\n\r\n"}`)
	if resp.StatusCode != http.StatusOK {
		t.Errorf("引擎错误应以 200 返回, got %d", resp.StatusCode)
	}
	var out struct {
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("解析: %v", err)
	}
	_ = resp.Body.Close()
	if out.Error == nil || out.Error.Code != "bad_request" {
		t.Errorf("Error = %+v, want bad_request", out.Error)
	}

	// 只有报文（带 Host 头）也要能发出去：目标从 Host 头推断，失败发生在连接阶段而不是
	// 参数校验阶段。1 端口不监听得太可能，所以断言"不是 bad_request"而不是具体错误码。
	resp = post(`{"raw": "GET / HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n"}`)
	var derived struct {
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&derived); err != nil {
		t.Fatalf("解析: %v", err)
	}
	_ = resp.Body.Close()
	if derived.Error == nil || derived.Error.Code == "bad_request" {
		t.Errorf("Host 头应被当作目标，Error = %+v", derived.Error)
	}
}

func TestReplayAuthRequired(t *testing.T) {
	_, ts, _ := newTestServer(t)
	resp, err := ts.Client().Post(ts.URL+"/api/replay", "application/json",
		strings.NewReader(`{"raw":"GET / HTTP/1.1\r\n\r\n"}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", resp.StatusCode)
	}
}

func TestTabsCRUD(t *testing.T) {
	_, ts, token := newTestServer(t)
	client := ts.Client()
	do := func(method, path, body string) (*http.Response, []byte) {
		t.Helper()
		var rd *strings.Reader
		if body == "" {
			rd = strings.NewReader("")
		} else {
			rd = strings.NewReader(body)
		}
		req, _ := http.NewRequest(method, ts.URL+path, rd)
		req.Header.Set("Authorization", "Bearer "+token)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		data := readAll(t, resp)
		return resp, data
	}

	// 创建（空 body 也要成功）
	resp, data := do(http.MethodPost, "/api/tabs", "")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create status = %d (%s)", resp.StatusCode, data)
	}
	var tab store.Tab
	if err := json.Unmarshal(data, &tab); err != nil {
		t.Fatalf("解析 tab: %v", err)
	}
	if tab.ID == "" {
		t.Fatal("应生成 tab id")
	}

	// 更新
	resp, data = do(http.MethodPatch, "/api/tabs/"+tab.ID,
		`{"rawRequest":"GET /x HTTP/1.1\r\nHost: a\r\n\r\n","name":"调试页"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("patch status = %d (%s)", resp.StatusCode, data)
	}
	var updated store.Tab
	_ = json.Unmarshal(data, &updated)
	if updated.RawRequest != "GET /x HTTP/1.1\r\nHost: a\r\n\r\n" || updated.Name != "调试页" {
		t.Errorf("更新结果: %+v", updated)
	}

	// 读取 & 列表
	resp, data = do(http.MethodGet, "/api/tabs/"+tab.ID, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get status = %d", resp.StatusCode)
	}
	resp, data = do(http.MethodGet, "/api/tabs", "")
	var list struct {
		Items []*store.Tab `json:"items"`
	}
	_ = json.Unmarshal(data, &list)
	if len(list.Items) != 1 {
		t.Fatalf("列表 = %d 项", len(list.Items))
	}

	// 删除后 404
	resp, _ = do(http.MethodDelete, "/api/tabs/"+tab.ID, "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status = %d", resp.StatusCode)
	}
	resp, _ = do(http.MethodGet, "/api/tabs/"+tab.ID, "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("删除后 get status = %d", resp.StatusCode)
	}
}

func readAll(t *testing.T, resp *http.Response) []byte {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 2048)
	for {
		n, err := resp.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			break
		}
	}
	return buf
}

func TestImportCurl(t *testing.T) {
	srv, ts, token := newTestServer(t)

	body := `{"format":"curl","content":"curl 'http://example.com/api/x' -H 'X-A: 1' -d 'k=v'"}`
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/import", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("POST /api/import: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	var out struct {
		Tabs []*store.Tab `json:"tabs"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("解析: %v", err)
	}
	if len(out.Tabs) != 1 {
		t.Fatalf("应创建 1 个 tab, got %d", len(out.Tabs))
	}
	if !strings.Contains(out.Tabs[0].RawRequest, "POST /api/x") {
		t.Errorf("RawRequest = %q", out.Tabs[0].RawRequest)
	}

	tabs, err := srv.store.ListTabs(context.Background(), "")
	if err != nil || len(tabs) != 1 {
		t.Fatalf("tabs 落库 = %d, err=%v", len(tabs), err)
	}
}

func TestImportBadFormat(t *testing.T) {
	_, ts, token := newTestServer(t)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/import",
		strings.NewReader(`{"format":"postman","content":"x"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}
