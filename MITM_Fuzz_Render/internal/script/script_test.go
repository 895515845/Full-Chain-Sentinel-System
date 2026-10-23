package script

import (
	"context"
	"strings"
	"testing"
	"time"
)

func run(t *testing.T, src string, in Input) Output {
	t.Helper()
	in.Source = src
	if in.Hooks == (Hooks{}) {
		in.Hooks = DefaultHooks()
	}
	return New().Run(context.Background(), in)
}

func TestOnRequestMutatesHeadersAndBody(t *testing.T) {
	out := run(t, `
function onRequest(req, ctx) {
  ctx.log("signing", req.method, req.url);
  req.headers.set("X-Sign", "abc123");
  req.headers.add("X-Trace", "t1");
  req.body = req.body + "&signed=1";
}
`, Input{Request: Request{
		Method: "POST", URL: "http://api.test/login",
		Body:    "user=a",
		Headers: []Header{{Name: "Host", Value: "api.test"}, {Name: "Content-Type", Value: "application/x-www-form-urlencoded"}},
	}})

	if out.Error != "" {
		t.Fatalf("Error = %s", out.Error)
	}
	if got := headerValue(out.Request.Headers, "X-Sign"); got != "abc123" {
		t.Errorf("X-Sign = %q", got)
	}
	if got := headerValue(out.Request.Headers, "X-Trace"); got != "t1" {
		t.Errorf("X-Trace = %q", got)
	}
	if out.Request.Body != "user=a&signed=1" {
		t.Errorf("Body = %q", out.Request.Body)
	}
	if len(out.Logs) != 1 || !strings.Contains(out.Logs[0].Message, "signing POST") {
		t.Errorf("Logs = %+v", out.Logs)
	}
	if len(out.HooksRun) != 1 || out.HooksRun[0] != "onRequest" {
		t.Errorf("HooksRun = %v", out.HooksRun)
	}
}

func TestHeadersSemantics(t *testing.T) {
	out := run(t, `
function onRequest(req) {
  var h = req.headers;
  ctx.log("get:", h.get("x-a"));
  h.set("x-a", "2");           // 覆盖（大小写不敏感）
  h.add("x-b", "1");
  h.add("x-b", "2");
  ctx.log("all-b:", h.all().filter(function(e){return e.name.toLowerCase()==="x-b";}).length);
  h.remove("x-b");
  ctx.log("after-remove:", h.get("x-b") === "" ? "empty" : "still");
}
`, Input{Request: Request{Headers: []Header{{"x-a", "1"}}}})

	var bCount, afterRemove string
	for _, l := range out.Logs {
		if strings.HasPrefix(l.Message, "all-b:") {
			bCount = strings.TrimSpace(strings.TrimPrefix(l.Message, "all-b:"))
		}
		if strings.HasPrefix(l.Message, "after-remove:") {
			afterRemove = strings.TrimSpace(strings.TrimPrefix(l.Message, "after-remove:"))
		}
	}
	if bCount != "2" {
		t.Errorf("add 两次后应有 2 个 x-b, got %q (logs=%+v)", bCount, out.Logs)
	}
	if afterRemove != "empty" {
		t.Errorf("remove 后应取不到, got %q", afterRemove)
	}
	// set 覆盖且不产生重复
	count := 0
	for _, h := range out.Request.Headers {
		if strings.EqualFold(h.Name, "x-a") {
			count++
			if h.Value != "2" {
				t.Errorf("x-a = %q, want 2", h.Value)
			}
		}
	}
	if count != 1 {
		t.Errorf("x-a 应只剩 1 个, got %d", count)
	}
}

func TestOnResponseAndAssert(t *testing.T) {
	out := run(t, `
function onResponse(res) {
  res.body = res.body.replace("secret", "***");
}
function onAssert(req, res, ctx) {
  ctx.log("checking status", res.status);
  assert(res.status === 200, "期望 200，实际 " + res.status);
  return res.body.indexOf("***") >= 0;
}
`, Input{
		Request:  Request{Method: "GET", URL: "http://a.test/"},
		Response: &Response{Status: 200, Body: `{"token":"secret"}`, Headers: []Header{{"Content-Type", "application/json"}}},
	})

	if out.Error != "" {
		t.Fatalf("Error = %s", out.Error)
	}
	if out.Response == nil || !strings.Contains(out.Response.Body, "***") {
		t.Errorf("onResponse 未生效: %+v", out.Response)
	}
	if out.Assert == nil || !out.Assert.OK {
		t.Errorf("Assert = %+v", out.Assert)
	}
	if len(out.HooksRun) != 2 {
		t.Errorf("HooksRun = %v", out.HooksRun)
	}
}

func TestAssertFailure(t *testing.T) {
	out := run(t, `
function onAssert(req, res) {
  assert(res.status === 403, "越权检测：期望 403，实际 " + res.status);
}
`, Input{Request: Request{}, Response: &Response{Status: 200}})
	if out.Assert == nil || out.Assert.OK {
		t.Fatalf("Assert 应为失败: %+v", out.Assert)
	}
	if !strings.Contains(out.Assert.Message, "越权检测") {
		t.Errorf("Message = %q", out.Assert.Message)
	}
}

func TestTimeoutInterrupt(t *testing.T) {
	start := time.Now()
	out := run(t, `
function onRequest(req) {
  while (true) {}
}
`, Input{Request: Request{}, Timeout: 200 * time.Millisecond})

	if out.Error == "" || !strings.Contains(out.Error, "超时") {
		t.Fatalf("应报超时, got %q", out.Error)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("中断应迅速生效, 实际 %v", elapsed)
	}
}

func TestSyntaxErrorReported(t *testing.T) {
	out := run(t, "function onRequest(req) { this is not js }", Input{Request: Request{}})
	if out.Error == "" {
		t.Fatal("语法错误应被报告")
	}
	if !strings.Contains(out.Error, "语法错误") && !strings.Contains(out.Error, "运行时异常") {
		t.Errorf("Error = %q", out.Error)
	}
}

func TestRuntimeExceptionReported(t *testing.T) {
	out := run(t, `
function onRequest(req) {
  undefinedFunction();
}
`, Input{Request: Request{}})
	if !strings.Contains(out.Error, "onRequest") {
		t.Errorf("Error 应带钩子名: %q", out.Error)
	}
}

func TestHooksFlagsRespected(t *testing.T) {
	// OnRequest 关闭、其余开启（避免零值被辅助函数当作"未指定"）
	out := run(t, `
function onRequest(req) { req.headers.set("X-Touched", "1"); }
`, Input{
		Hooks:   Hooks{OnRequest: false, OnResponse: true, OnAssert: true},
		Request: Request{},
	})
	if headerValue(out.Request.Headers, "X-Touched") != "" {
		t.Error("onRequest 开关关闭时不应执行")
	}
	if len(out.HooksRun) != 0 {
		t.Errorf("HooksRun = %v", out.HooksRun)
	}
}

func TestMissingHookIsSkipped(t *testing.T) {
	out := run(t, `ctx.log("no hooks here");`, Input{
		Request:  Request{},
		Response: &Response{Status: 204},
	})
	if out.Error != "" {
		t.Fatalf("Error = %s", out.Error)
	}
	if len(out.HooksRun) != 0 {
		t.Errorf("HooksRun = %v", out.HooksRun)
	}
	if len(out.Logs) != 1 {
		t.Errorf("Logs = %+v", out.Logs)
	}
}

func TestHelpersKnownVectors(t *testing.T) {
	out := run(t, `
function onRequest(req, ctx) {
  ctx.log("sha256", helpers.sha256Hex("abc"));
  ctx.log("hmac", helpers.hmacSHA256Hex("key", "data"));
  ctx.log("b64", helpers.b64encode("你好"));
  ctx.log("b64round", helpers.b64decode(helpers.b64encode("round-trip")));
  ctx.log("url", helpers.urlencode("a b&c"));
  ctx.log("md5", helpers.md5Hex("abc"));
}
`, Input{Request: Request{}})

	want := map[string]string{
		"sha256":   "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		"hmac":     "5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0",
		"b64":      "5L2g5aW9",
		"b64round": "round-trip",
		"url":      "a+b%26c",
		"md5":      "900150983cd24fb0d6963f7d28e17f72",
	}
	for _, line := range out.Logs {
		parts := strings.SplitN(line.Message, " ", 2)
		if len(parts) != 2 {
			continue
		}
		if expected, ok := want[parts[0]]; ok && parts[1] != expected {
			t.Errorf("%s = %q, want %q", parts[0], parts[1], expected)
		}
	}
	if len(out.Logs) != len(want) {
		t.Errorf("日志条数 = %d, want %d (%+v)", len(out.Logs), len(want), out.Logs)
	}
}

func TestAESHelpers(t *testing.T) {
	out := run(t, `
function onRequest(req, ctx) {
  var key = helpers.b64encode("0123456789abcdef");      // 16 字节
  var iv  = helpers.b64encode("abcdef1234567890");       // 16 字节
  var enc = helpers.aesEncryptCBC(key, iv, "机密数据");
  ctx.log("roundtrip", helpers.aesDecryptCBC(key, iv, enc));
}
`, Input{Request: Request{}})
	if out.Error != "" {
		t.Fatalf("Error = %s", out.Error)
	}
	found := false
	for _, l := range out.Logs {
		if strings.HasPrefix(l.Message, "roundtrip ") && strings.HasSuffix(l.Message, "机密数据") {
			found = true
		}
	}
	if !found {
		t.Errorf("AES 往返失败: %+v", out.Logs)
	}
}

func TestAESBadPaddingThrows(t *testing.T) {
	out := run(t, `
function onRequest(req) {
  var key = helpers.b64encode("0123456789abcdef");
  var iv  = helpers.b64encode("abcdef1234567890");
  helpers.aesDecryptCBC(key, iv, helpers.b64encode("0123456789abcdef")); // 非法填充
}
`, Input{Request: Request{}})
	if !strings.Contains(out.Error, "onRequest") {
		t.Errorf("非法填充应抛异常并带钩子名: %q", out.Error)
	}
}

func TestVarsAndEnv(t *testing.T) {
	out := run(t, `
function onRequest(req, ctx) {
  ctx.vars.counter = String(Number(ctx.vars.counter || "0") + 1);
  ctx.log("env", ctx.env.MY_ENV);
  ctx.log("counter", ctx.vars.counter);
}
`, Input{
		Request: Request{},
		Vars:    map[string]string{"counter": "41"},
		Env:     map[string]string{"MY_ENV": "staging"},
	})
	if out.Error != "" {
		t.Fatalf("Error = %s", out.Error)
	}
	var sawEnv, sawCounter bool
	for _, l := range out.Logs {
		if l.Message == "env staging" {
			sawEnv = true
		}
		if l.Message == "counter 42" {
			sawCounter = true
		}
	}
	if !sawEnv || !sawCounter {
		t.Errorf("Logs = %+v", out.Logs)
	}
}

func TestLogCap(t *testing.T) {
	out := run(t, `
function onRequest(req, ctx) {
  for (var i = 0; i < 900; i++) { ctx.log("line " + i); }
}
`, Input{Request: Request{}})
	if len(out.Logs) != maxLogs {
		t.Errorf("日志应封顶 %d, got %d", maxLogs, len(out.Logs))
	}
}

func TestDurationReported(t *testing.T) {
	out := run(t, `function onRequest(req) { var x = 0; for (var i=0;i<1000;i++){x+=i;} }`,
		Input{Request: Request{}})
	if out.DurationMS < 0 {
		t.Errorf("DurationMS = %d", out.DurationMS)
	}
}

func TestCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out := New().Run(ctx, Input{
		Source:  `function onRequest(req) { while(true){} }`,
		Hooks:   DefaultHooks(),
		Request: Request{},
		Timeout: 5 * time.Second,
	})
	if out.Error == "" {
		t.Fatal("已取消的 ctx 应中断脚本")
	}
}

func headerValue(headers []Header, name string) string {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			return h.Value
		}
	}
	return ""
}
