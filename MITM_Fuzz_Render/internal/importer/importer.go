// Package importer 把 curl 命令与 HAR 文件转换为 raw HTTP 请求文本。
//
// 转换是"尽力保真"：只翻译与报文相关的选项（方法/头/body/URL/认证），
// 其余选项（-s/-v/-L 等）忽略；无法表达的部分进 Warnings。
package importer

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// Result 是一次导入的产物。
type Result struct {
	Requests []Request `json:"requests"`
	Warnings []string  `json:"warnings,omitempty"`
}

// Request 是转换出的单条请求。
type Request struct {
	Raw     string   `json:"raw"`
	Method  string   `json:"method"`
	URL     string   `json:"url"`
	Body    string   `json:"-"`
	Headers []Header `json:"headers"`
	// InsecureTLS 来自 curl -k
	InsecureTLS bool `json:"insecureTLS"`
}

// Header 复用引擎的保序头模型。
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// FromCurl 解析一条 curl 命令。
//
// 支持：URL（位置参数或 --url）、-X/--request、-H/--header、-d/--data*/、
// -u/--user、-A/--user-agent、-e/--referer、-b/--cookie、--compressed、-k/--insecure。
// 其余选项忽略。
func FromCurl(cmd string) (*Result, error) {
	tokens, err := tokenize(cmd)
	if err != nil {
		return nil, err
	}
	if len(tokens) == 0 {
		return nil, fmt.Errorf("命令为空")
	}
	// 跳过程序名（curl / xcurl / 全路径）
	if !strings.HasPrefix(tokens[0], "-") {
		tokens = tokens[1:]
	}

	res := &Result{}
	r := Request{Method: ""}
	var dataParts []string
	var url string
	var user string

	pop := func(i *int) (string, bool) {
		if *i+1 >= len(tokens) {
			return "", false
		}
		*i++
		return tokens[*i], true
	}
	isFlag := func(v string) bool { return strings.HasPrefix(v, "-") && v != "-" }

	for i := 0; i < len(tokens); i++ {
		tok := tokens[i]
		arg := func() (string, bool) { return pop(&i) }

		switch {
		case tok == "--url":
			if v, ok := arg(); ok {
				url = v
			}
		case tok == "-X" || tok == "--request":
			if v, ok := arg(); ok {
				r.Method = strings.ToUpper(v)
			}
		case tok == "-H" || tok == "--header":
			if v, ok := arg(); ok {
				name, value, ok2 := strings.Cut(v, ":")
				if !ok2 {
					res.Warnings = append(res.Warnings, "无法解析头: "+v)
					continue
				}
				// curl 允许 "Name;" 发送空值头
				r.Headers = append(r.Headers, Header{
					Name:  strings.TrimSpace(name),
					Value: strings.TrimSpace(value),
				})
			}
		case tok == "-d" || tok == "--data" || tok == "--data-raw" ||
			tok == "--data-ascii" || tok == "--data-binary" || tok == "--data-urlencode":
			if v, ok := arg(); ok {
				if strings.HasPrefix(v, "@") {
					res.Warnings = append(res.Warnings, "curl 中的 @file 数据无法离线导入，已跳过: "+v)
					continue
				}
				dataParts = append(dataParts, v)
			}
		case tok == "-u" || tok == "--user":
			if v, ok := arg(); ok {
				user = v
			}
		case tok == "-A" || tok == "--user-agent":
			if v, ok := arg(); ok {
				r.Headers = append(r.Headers, Header{"User-Agent", v})
			}
		case tok == "-e" || tok == "--referer":
			if v, ok := arg(); ok {
				r.Headers = append(r.Headers, Header{"Referer", v})
			}
		case tok == "-b" || tok == "--cookie":
			if v, ok := arg(); ok && !strings.Contains(v, "=") == false {
				// 仅支持 "k=v; k2=v2" 形式；@file 忽略
				if !strings.HasPrefix(v, "@") {
					r.Headers = append(r.Headers, Header{"Cookie", v})
				}
			}
		case tok == "--compressed":
			r.Headers = append(r.Headers, Header{"Accept-Encoding", "gzip, deflate, br"})
		case tok == "-k" || tok == "--insecure":
			r.InsecureTLS = true
		case tok == "-" || isFlag(tok):
			// 带参数的未知选项：吃掉下一个 token，避免误认 URL
			switch tok {
			case "-o", "-O", "-m", "--max-time", "--connect-timeout",
				"-x", "--proxy", "-D", "--dump-header", "-c", "--cookie-jar",
				"--retry", "--resolve", "--cacert", "--cert", "--key":
				_, _ = arg()
			}
			// 其余忽略
		default:
			if strings.HasPrefix(tok, "http://") || strings.HasPrefix(tok, "https://") {
				url = tok
			}
		}
	}

	if url == "" {
		return nil, fmt.Errorf("命令中未找到 URL")
	}
	r.URL = url
	r.Body = strings.Join(dataParts, "&")

	scheme, host, port, path, perr := splitURL(url)
	if perr != nil {
		return nil, perr
	}
	r.Method = defaultMethod(r.Method, r.Body)

	// Host 头：用户没写就补
	if !hasHeader(r.Headers, "Host") {
		r.Headers = append(r.Headers, Header{"Host", hostPortHeader(scheme, host, port)})
	}
	if user != "" {
		r.Headers = append(r.Headers, Header{"Authorization",
			"Basic " + base64.StdEncoding.EncodeToString([]byte(user))})
	}
	if r.Body != "" && !hasHeader(r.Headers, "Content-Length") {
		r.Headers = append(r.Headers, Header{"Content-Length", strconv.Itoa(len(r.Body))})
	}

	r.Raw = buildRaw(r.Method, path, r.Headers, r.Body)
	res.Requests = append(res.Requests, r)
	return res, nil
}

// FromHAR 解析 HAR JSON，转换其中的请求（最多 limit 条）。
func FromHAR(content []byte, limit int) (*Result, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var har struct {
		Log struct {
			Entries []struct {
				Request struct {
					Method      string `json:"method"`
					URL         string `json:"url"`
					HTTPVersion string `json:"httpVersion"`
					Headers     []struct {
						Name  string `json:"name"`
						Value string `json:"value"`
					} `json:"headers"`
					PostData struct {
						Text string `json:"text"`
					} `json:"postData"`
				} `json:"request"`
			} `json:"entries"`
		} `json:"log"`
	}
	if err := json.Unmarshal(content, &har); err != nil {
		return nil, fmt.Errorf("HAR 解析失败: %v", err)
	}

	res := &Result{}
	entries := har.Log.Entries
	sort.SliceStable(entries, func(i, j int) bool { return false }) // 保持原顺序
	for _, e := range entries {
		if len(res.Requests) >= limit {
			res.Warnings = append(res.Warnings,
				fmt.Sprintf("HAR 共 %d 条，仅导入前 %d 条", len(entries), limit))
			break
		}
		req := e.Request
		scheme, host, port, path, err := splitURL(req.URL)
		if err != nil {
			res.Warnings = append(res.Warnings, "跳过无法解析的 URL: "+req.URL)
			continue
		}
		var headers []Header
		hasHost := false
		for _, h := range req.Headers {
			headers = append(headers, Header{Name: h.Name, Value: h.Value})
			if strings.EqualFold(h.Name, "Host") {
				hasHost = true
			}
		}
		if !hasHost {
			headers = append(headers, Header{"Host", hostPortHeader(scheme, host, port)})
		}
		body := req.PostData.Text
		if body != "" && !hasHeader(headers, "Content-Length") {
			headers = append(headers, Header{"Content-Length", strconv.Itoa(len(body))})
		}
		method := req.Method
		if method == "" {
			method = "GET"
		}
		r := Request{
			Method:  method,
			URL:     req.URL,
			Body:    body,
			Headers: headers,
		}
		r.Raw = buildRaw(method, path, headers, body)
		res.Requests = append(res.Requests, r)
	}
	if len(res.Requests) == 0 {
		return nil, fmt.Errorf("HAR 中没有可导入的请求")
	}
	return res, nil
}

// ---------------------------------------------------------------- 内部工具

// tokenize 支持 单引号 / 双引号 / 反斜杠转义 的 shell 风格分词。
func tokenize(cmd string) ([]string, error) {
	var tokens []string
	var cur strings.Builder
	started := false
	inSingle, inDouble := false, false

	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		switch {
		case inSingle:
			if c == '\'' {
				inSingle = false
			} else {
				cur.WriteByte(c)
			}
		case inDouble:
			if c == '"' {
				inDouble = false
			} else if c == '\\' && i+1 < len(cmd) {
				i++
				cur.WriteByte(cmd[i])
			} else {
				cur.WriteByte(c)
			}
		case c == '\'':
			inSingle = true
			started = true
		case c == '"':
			inDouble = true
			started = true
		case c == '\\' && i+1 < len(cmd):
			i++
			cur.WriteByte(cmd[i])
			started = true
		case c == ' ' || c == '\t' || c == '\n':
			if started {
				tokens = append(tokens, cur.String())
				cur.Reset()
				started = false
			}
		default:
			cur.WriteByte(c)
			started = true
		}
	}
	if inSingle || inDouble {
		return nil, fmt.Errorf("引号未闭合")
	}
	if started {
		tokens = append(tokens, cur.String())
	}
	return tokens, nil
}

func splitURL(raw string) (scheme, host string, port int, path string, err error) {
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	parsed, perr := url.Parse(raw)
	if perr != nil {
		return "", "", 0, "", perr
	}
	scheme = strings.ToLower(parsed.Scheme)
	host = parsed.Hostname()
	if p := parsed.Port(); p != "" {
		port, _ = strconv.Atoi(p)
	}
	if port == 0 {
		if scheme == "https" {
			port = 443
		} else {
			port = 80
		}
	}
	path = parsed.EscapedPath()
	if path == "" {
		path = "/"
	}
	if parsed.RawQuery != "" {
		path += "?" + parsed.RawQuery
	}
	return scheme, host, port, path, nil
}

func defaultMethod(m, body string) string {
	if m != "" {
		return m
	}
	if body != "" {
		return "POST"
	}
	return "GET"
}

func hasHeader(headers []Header, name string) bool {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			return true
		}
	}
	return false
}

func hostPortHeader(scheme, host string, port int) string {
	if (scheme == "http" && port == 80) || (scheme == "https" && port == 443) {
		return host
	}
	return host + ":" + strconv.Itoa(port)
}

func buildRaw(method, path string, headers []Header, body string) string {
	var b strings.Builder
	b.WriteString(method)
	b.WriteByte(' ')
	b.WriteString(path)
	b.WriteString(" HTTP/1.1\r\n")
	for _, h := range headers {
		b.WriteString(h.Name)
		b.WriteString(": ")
		b.WriteString(h.Value)
		b.WriteString("\r\n")
	}
	b.WriteString("\r\n")
	b.WriteString(body)
	return b.String()
}
