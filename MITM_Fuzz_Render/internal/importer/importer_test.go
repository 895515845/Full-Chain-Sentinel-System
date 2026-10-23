package importer

import (
	"strings"
	"testing"
)

func TestCurlBasic(t *testing.T) {
	res, err := FromCurl(`curl 'http://example.com/api/x?a=1' -H 'User-Agent: req/1' -H 'X-Token: abc'`)
	if err != nil {
		t.Fatalf("FromCurl: %v", err)
	}
	r := res.Requests[0]
	if r.Method != "GET" || r.URL != "http://example.com/api/x?a=1" {
		t.Errorf("method/url = %s / %s", r.Method, r.URL)
	}
	want := "GET /api/x?a=1 HTTP/1.1\r\nUser-Agent: req/1\r\nX-Token: abc\r\nHost: example.com\r\n\r\n"
	if r.Raw != want {
		t.Errorf("Raw = %q\nwant %q", r.Raw, want)
	}
}

func TestCurlPostData(t *testing.T) {
	res, err := FromCurl(`curl -X POST https://api.test/login -d 'user=a' -d 'pass=b' -H 'Content-Type: application/json'`)
	if err != nil {
		t.Fatalf("FromCurl: %v", err)
	}
	r := res.Requests[0]
	if r.Method != "POST" {
		t.Errorf("Method = %s", r.Method)
	}
	if r.Body != "user=a&pass=b" {
		t.Errorf("Body = %q", r.Body)
	}
	if !strings.Contains(r.Raw, "Content-Length: 13") {
		t.Errorf("应自动补 Content-Length: %q", r.Raw)
	}
	if !strings.HasPrefix(r.Raw, "POST /login HTTP/1.1\r\n") {
		t.Errorf("请求行错误: %q", r.Raw[:40])
	}
}

func TestCurlMethodDefaultsToPostWhenData(t *testing.T) {
	res, err := FromCurl(`curl http://a.test/submit --data 'x=1'`)
	if err != nil {
		t.Fatalf("FromCurl: %v", err)
	}
	if res.Requests[0].Method != "POST" {
		t.Errorf("Method = %s, want POST", res.Requests[0].Method)
	}
}

func TestCurlUserAndQuotes(t *testing.T) {
	res, err := FromCurl(`curl -u admin:s3cret "https://a.test/admin" -k`)
	if err != nil {
		t.Fatalf("FromCurl: %v", err)
	}
	r := res.Requests[0]
	if !strings.Contains(r.Raw, "Authorization: Basic YWRtaW46czNjcmV0") {
		t.Errorf("应包含 Basic 认证头: %q", r.Raw)
	}
	if !r.InsecureTLS {
		t.Error("-k 应映射 InsecureTLS")
	}
	if !strings.HasPrefix(r.Raw, "GET /admin") {
		t.Errorf("Raw = %q", r.Raw)
	}
}

func TestCurlDataRawAndFlags(t *testing.T) {
	res, err := FromCurl(`curl -s -v -L 'http://a.test/x' --data-raw '{"a":1}' --compressed --max-time 5`)
	if err != nil {
		t.Fatalf("FromCurl: %v", err)
	}
	r := res.Requests[0]
	if r.Body != `{"a":1}` {
		t.Errorf("Body = %q", r.Body)
	}
	if !strings.Contains(r.Raw, "Accept-Encoding: gzip, deflate, br") {
		t.Errorf("--compressed 未生效: %q", r.Raw)
	}
}

func TestCurlMissingURL(t *testing.T) {
	if _, err := FromCurl(`curl -X GET -H 'A: b'`); err == nil {
		t.Fatal("无 URL 应报错")
	}
}

func TestCurlUnclosedQuote(t *testing.T) {
	if _, err := FromCurl(`curl 'http://a.test`); err == nil {
		t.Fatal("引号未闭合应报错")
	}
}

func TestCurlAtFileSkipped(t *testing.T) {
	res, err := FromCurl(`curl http://a.test -d @payload.json`)
	if err != nil {
		t.Fatalf("FromCurl: %v", err)
	}
	if res.Requests[0].Body != "" {
		t.Errorf("@file 应跳过, Body = %q", res.Requests[0].Body)
	}
	if len(res.Warnings) == 0 {
		t.Error("应产生警告")
	}
}

func TestFromHAR(t *testing.T) {
	har := `{"log":{"entries":[
		{"request":{"method":"POST","url":"https://api.test/v1?a=b","httpVersion":"HTTP/1.1",
		 "headers":[{"name":"Content-Type","value":"application/json"}],
		 "postData":{"text":"{\"k\":1}"}}},
		{"request":{"method":"GET","url":"http://other.test/"}}
	]}}`
	res, err := FromHAR([]byte(har), 10)
	if err != nil {
		t.Fatalf("FromHAR: %v", err)
	}
	if len(res.Requests) != 2 {
		t.Fatalf("导入条数 = %d", len(res.Requests))
	}
	first := res.Requests[0]
	if first.Method != "POST" || first.Body != `{"k":1}` {
		t.Errorf("第一条 = %+v", first)
	}
	if !strings.Contains(first.Raw, "Host: api.test") {
		t.Errorf("应补 Host: %q", first.Raw)
	}
	if !strings.Contains(first.Raw, "Content-Length: 7") {
		t.Errorf("应补 Content-Length: %q", first.Raw)
	}
	if res.Requests[1].Method != "GET" {
		t.Errorf("第二条 = %+v", res.Requests[1])
	}
}

func TestFromHALError(t *testing.T) {
	if _, err := FromHAR([]byte("not-json"), 10); err == nil {
		t.Fatal("非法 JSON 应报错")
	}
	if _, err := FromHAR([]byte(`{"log":{"entries":[]}}`), 10); err == nil {
		t.Fatal("空 entries 应报错")
	}
}
