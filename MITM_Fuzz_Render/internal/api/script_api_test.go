package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/chinaran404/replayd/internal/store"
)

// apiCall 发一个带 Bearer 的 JSON 请求，返回状态码与原始响应体。
func apiCall(t *testing.T, ts *httptest.Server, token, method, path, body string) (int, []byte) {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, ts.URL+path, reader)
	req.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	data := make([]byte, 0, 4096)
	buf := make([]byte, 2048)
	for {
		n, rerr := resp.Body.Read(buf)
		data = append(data, buf[:n]...)
		if rerr != nil {
			break
		}
	}
	return resp.StatusCode, data
}

func TestScriptsCRUD(t *testing.T) {
	_, ts, token := newTestServer(t)

	// 创建
	code, data := apiCall(t, ts, token, http.MethodPost, "/api/scripts",
		`{"name":"签名脚本","source":"function onRequest(req){req.headers.set(\"X-A\",\"1\");}"}`)
	if code != http.StatusCreated {
		t.Fatalf("create status = %d (%s)", code, data)
	}
	var sc store.Script
	if err := json.Unmarshal(data, &sc); err != nil {
		t.Fatalf("解析: %v", err)
	}
	if sc.ID == "" || sc.Lang != "js" || !sc.Hooks.OnRequest || !sc.Hooks.OnAssert {
		t.Fatalf("默认值不对: %+v", sc)
	}

	// 不支持的语言
	code, _ = apiCall(t, ts, token, http.MethodPost, "/api/scripts", `{"name":"py","lang":"py"}`)
	if code != http.StatusUnprocessableEntity {
		t.Errorf("py 脚本应 422, got %d", code)
	}

	// 更新（带版本号）
	body := fmt.Sprintf(`{"source":"function onRequest(req){req.headers.set(\"X-A\",\"2\");}","name":"改名","updatedAt":%d}`, sc.UpdatedAt)
	code, data = apiCall(t, ts, token, http.MethodPut, "/api/scripts/"+sc.ID, body)
	if code != http.StatusOK {
		t.Fatalf("update status = %d (%s)", code, data)
	}
	var updated store.Script
	_ = json.Unmarshal(data, &updated)
	if updated.Name != "改名" || !strings.Contains(updated.Source, `"2"`) {
		t.Errorf("更新结果: %+v", updated)
	}

	// 过期版本号 → 409
	stale := fmt.Sprintf(`{"name":"stale","updatedAt":%d}`, sc.UpdatedAt)
	code, _ = apiCall(t, ts, token, http.MethodPut, "/api/scripts/"+sc.ID, stale)
	if code != http.StatusConflict {
		t.Errorf("过期版本应 409, got %d", code)
	}

	// 列表 + 删除
	code, data = apiCall(t, ts, token, http.MethodGet, "/api/scripts", "")
	if code != http.StatusOK || !strings.Contains(string(data), "改名") {
		t.Errorf("列表: %d %s", code, data)
	}
	code, _ = apiCall(t, ts, token, http.MethodDelete, "/api/scripts/"+sc.ID, "")
	if code != http.StatusNoContent {
		t.Fatalf("delete status = %d", code)
	}
	code, _ = apiCall(t, ts, token, http.MethodGet, "/api/scripts/"+sc.ID, "")
	if code != http.StatusNotFound {
		t.Errorf("删除后应 404, got %d", code)
	}
}

func TestReplayWithSigningScript(t *testing.T) {
	srv, ts, token := newTestServer(t)

	var sawSign, sawBody atomic.Value
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawSign.Store(r.Header.Get("X-Sign"))
		body := make([]byte, 64)
		n, _ := r.Body.Read(body)
		sawBody.Store(string(body[:n]))
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer upstream.Close()

	source := `
function onRequest(req, ctx) {
  var sign = helpers.hmacSHA256Hex("s3cret", req.body);
  req.headers.set("X-Sign", sign);
  ctx.log("signed", sign);
}
function onAssert(req, res, ctx) {
  assert(res.status === 200, "期望 200");
  return res.body.indexOf("ok") >= 0;
}`
	code, data := apiCall(t, ts, token, http.MethodPost, "/api/scripts",
		fmt.Sprintf(`{"name":"HMAC 签名","source":%s}`, jsonString(source)))
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, data)
	}
	var sc store.Script
	_ = json.Unmarshal(data, &sc)

	host := strings.TrimPrefix(upstream.URL, "http://")
	code, data = apiCall(t, ts, token, http.MethodPost, "/api/replay",
		fmt.Sprintf(`{"raw":"POST /sign HTTP/1.1\r\nHost: x\r\n\r\nuser=a","target":{"scheme":"http","host":%q},"scriptId":%q}`,
			host, sc.ID))
	if code != http.StatusOK {
		t.Fatalf("replay: %d %s", code, data)
	}
	var out replayResponse
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("解析: %v", err)
	}
	if out.Error != nil {
		t.Fatalf("Error = %+v", out.Error)
	}
	if out.Script == nil {
		t.Fatal("应返回脚本结果")
	}
	if out.Script.Error != "" {
		t.Fatalf("脚本错误: %s", out.Script.Error)
	}
	wantSign := hmacHex("s3cret", "user=a")
	if got, _ := sawSign.Load().(string); got != wantSign {
		t.Errorf("上游收到 X-Sign = %q, want %q", got, wantSign)
	}
	if got, _ := sawBody.Load().(string); got != "user=a" {
		t.Errorf("上游收到 body = %q", got)
	}
	if out.Script.Assert == nil || !out.Script.Assert.OK {
		t.Errorf("断言应通过: %+v", out.Script.Assert)
	}
	if len(out.Script.Logs) == 0 {
		t.Error("应有日志")
	}
	if out.Script.DurationMS < 0 {
		t.Errorf("DurationMS = %d", out.Script.DurationMS)
	}

	// 执行记录落库
	code, data = apiCall(t, ts, token, http.MethodGet, "/api/scripts/"+sc.ID+"/runs", "")
	if code != http.StatusOK {
		t.Fatalf("runs: %d", code)
	}
	var runs struct {
		Items []store.ScriptRun `json:"items"`
	}
	_ = json.Unmarshal(data, &runs)
	if len(runs.Items) != 1 || !runs.Items[0].OK {
		t.Errorf("执行记录: %+v", runs.Items)
	}
	if runs.Items[0].FlowID == "" {
		t.Error("执行记录应关联 flowId")
	}
	_ = srv
}

func TestScriptErrorAbortsSend(t *testing.T) {
	srv, ts, token := newTestServer(t)

	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	defer upstream.Close()

	code, data := apiCall(t, ts, token, http.MethodPost, "/api/scripts",
		`{"name":"会炸的脚本","source":"function onRequest(req){ throw new Error(\"签名密钥缺失\"); }"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	var sc store.Script
	_ = json.Unmarshal(data, &sc)

	host := strings.TrimPrefix(upstream.URL, "http://")
	code, data = apiCall(t, ts, token, http.MethodPost, "/api/replay",
		fmt.Sprintf(`{"raw":"GET / HTTP/1.1\r\nHost: x\r\n\r\n","target":{"scheme":"http","host":%q},"scriptId":%q}`,
			host, sc.ID))
	if code != http.StatusOK {
		t.Fatalf("replay status = %d", code)
	}
	var out replayResponse
	_ = json.Unmarshal(data, &out)
	if out.Error == nil || out.Error.Code != "script_error" {
		t.Fatalf("应返回 script_error, got %+v", out.Error)
	}
	if !strings.Contains(out.Error.Message, "签名密钥缺失") {
		t.Errorf("错误信息应包含脚本异常: %q", out.Error.Message)
	}
	if hits.Load() != 0 {
		t.Error("脚本失败时不应发出请求")
	}
	flows, _, _ := srv.store.ListFlows(context.Background(), store.Filter{})
	if len(flows) != 0 {
		t.Errorf("不应产生 flow, got %d", len(flows))
	}
}

func TestScriptAssertFailureSurfaced(t *testing.T) {
	_, ts, token := newTestServer(t)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	code, data := apiCall(t, ts, token, http.MethodPost, "/api/scripts",
		`{"name":"越权断言","source":"function onAssert(req,res){ assert(res.status === 403, \"越权检测：期望 403，实际 \" + res.status); }"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	var sc store.Script
	_ = json.Unmarshal(data, &sc)

	host := strings.TrimPrefix(upstream.URL, "http://")
	_, data = apiCall(t, ts, token, http.MethodPost, "/api/replay",
		fmt.Sprintf(`{"raw":"GET /admin HTTP/1.1\r\nHost: x\r\n\r\n","target":{"scheme":"http","host":%q},"scriptId":%q}`,
			host, sc.ID))
	var out replayResponse
	_ = json.Unmarshal(data, &out)
	if out.Error != nil {
		t.Fatalf("断言失败不应变成引擎错误: %+v", out.Error)
	}
	if out.Script == nil || out.Script.Assert == nil || out.Script.Assert.OK {
		t.Fatalf("断言应为失败: %+v", out.Script)
	}
	if !strings.Contains(out.Script.Assert.Message, "越权检测") {
		t.Errorf("断言信息: %q", out.Script.Assert.Message)
	}
	if out.Response == nil || out.Response.Status != 200 {
		t.Error("仍应返回上游响应")
	}
}

func TestScriptTestEndpoint(t *testing.T) {
	_, ts, token := newTestServer(t)

	code, data := apiCall(t, ts, token, http.MethodPost, "/api/scripts",
		`{"name":"试跑脚本","source":"function onRequest(req,ctx){ req.headers.set(\"X-Debug\",\"1\"); ctx.log(\"touched\"); }"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	var sc store.Script
	_ = json.Unmarshal(data, &sc)

	// 仅跑钩子（不联网）
	code, data = apiCall(t, ts, token, http.MethodPost, "/api/scripts/"+sc.ID+"/test",
		`{"raw":"GET /demo HTTP/1.1\r\nHost: example.test\r\n\r\n"}`)
	if code != http.StatusOK {
		t.Fatalf("test status = %d (%s)", code, data)
	}
	var out scriptTestResponse
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("解析: %v", err)
	}
	if out.Request == nil || !strings.Contains(out.Request.Raw, "X-Debug: 1") {
		t.Fatalf("试跑应返回被脚本改过的请求: %+v", out.Request)
	}
	if out.Script == nil || len(out.Script.Logs) == 0 {
		t.Errorf("应有日志: %+v", out.Script)
	}

	// send=true：真发一次
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Debug") != "1" {
			t.Errorf("上游未收到脚本加的头")
		}
		fmt.Fprint(w, "sent-by-test")
	}))
	defer upstream.Close()
	host := strings.TrimPrefix(upstream.URL, "http://")
	code, data = apiCall(t, ts, token, http.MethodPost, "/api/scripts/"+sc.ID+"/test",
		fmt.Sprintf(`{"raw":"GET /net HTTP/1.1\r\nHost: x\r\n\r\n","target":{"scheme":"http","host":%q},"send":true}`,
			host))
	if code != http.StatusOK {
		t.Fatalf("send test status = %d (%s)", code, data)
	}
	if !strings.Contains(string(data), "sent-by-test") {
		t.Errorf("应包含上游响应: %s", data)
	}
}

func TestScriptDisabledNotRun(t *testing.T) {
	_, ts, token := newTestServer(t)

	code, data := apiCall(t, ts, token, http.MethodPost, "/api/scripts",
		`{"name":"停用脚本","source":"function onRequest(req){ req.headers.set(\"X-Should-Not\"; }"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d (%s)", code, data)
	}
	var sc store.Script
	_ = json.Unmarshal(data, &sc)

	off := false
	code, data = apiCall(t, ts, token, http.MethodPut, "/api/scripts/"+sc.ID,
		fmt.Sprintf(`{"enabled":%t}`, off))
	if code != http.StatusOK {
		t.Fatalf("disable: %d (%s)", code, data)
	}

	code, data = apiCall(t, ts, token, http.MethodPost, "/api/replay",
		fmt.Sprintf(`{"raw":"GET / HTTP/1.1\r\nHost: x\r\n\r\n","target":{"scheme":"http","host":"127.0.0.1","port":1},"scriptId":%q}`,
			sc.ID))
	if code != http.StatusOK {
		t.Fatalf("replay: %d", code)
	}
	var out replayResponse
	_ = json.Unmarshal(data, &out)
	if out.Error == nil || out.Error.Code != "script_disabled" {
		t.Errorf("停用脚本应返回 script_disabled, got %+v", out.Error)
	}
}

/* -------------------------------------------------------------------------- */

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func hmacHex(key, data string) string {
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}
