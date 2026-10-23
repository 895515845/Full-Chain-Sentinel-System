package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/chinaran404/replayd/internal/capture"
	"github.com/chinaran404/replayd/internal/store"
)

// MCP（Model Context Protocol）over HTTP：Agent 用一次 POST /mcp 就能
// 完成握手与工具调用，无需 stdio 子进程。
//
// 端点：POST /mcp（Bearer 或会话 Cookie 鉴权）
// 方法：initialize / notifications/* / ping / tools/list / tools/call
// 传输：请求与响应都是 application/json（单个 JSON-RPC 响应）

const mcpProtocolVersion = "2025-06-18"

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type mcpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type mcpResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *mcpError       `json:"error,omitempty"`
}

type mcpContent struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

type mcpCallResult struct {
	Content []mcpContent `json:"content"`
	IsError bool         `json:"isError,omitempty"`
}

func textContent(text string) mcpContent {
	return mcpContent{Type: "text", Text: text}
}

func imageContent(png []byte) mcpContent {
	return mcpContent{Type: "image", Data: base64.StdEncoding.EncodeToString(png), MimeType: "image/png"}
}

// handleMCP 处理 JSON-RPC 请求。
func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		// 本实现不提供 SSE 流，规范允许返回 405
		s.writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "本 MCP 端点只支持 POST（无 SSE 流）", nil)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
	if err != nil {
		s.writeJSON(w, http.StatusBadRequest, mcpResponse{
			JSONRPC: "2.0", Error: &mcpError{Code: -32700, Message: "读取请求体失败"}})
		return
	}

	// 支持批量（规范允许，数组形式的 JSON-RPC）
	trimmed := strings.TrimSpace(string(body))
	if strings.HasPrefix(trimmed, "[") {
		var batch []mcpRequest
		if err := json.Unmarshal(body, &batch); err != nil {
			s.writeJSON(w, http.StatusBadRequest, mcpResponse{
				JSONRPC: "2.0", Error: &mcpError{Code: -32700, Message: "解析失败: " + err.Error()}})
			return
		}
		out := make([]mcpResponse, 0, len(batch))
		for _, req := range batch {
			if resp, ok := s.mcpHandle(r.Context(), req); ok {
				out = append(out, resp)
			}
		}
		if len(out) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		s.writeJSON(w, http.StatusOK, out)
		return
	}

	var req mcpRequest
	if err := json.Unmarshal(body, &req); err != nil {
		s.writeJSON(w, http.StatusBadRequest, mcpResponse{
			JSONRPC: "2.0", Error: &mcpError{Code: -32700, Message: "解析失败: " + err.Error()}})
		return
	}
	resp, ok := s.mcpHandle(r.Context(), req)
	if !ok {
		w.WriteHeader(http.StatusAccepted) // 通知类消息不需要响应
		return
	}
	s.writeJSON(w, http.StatusOK, resp)
}

// mcpHandle 分派单个消息；ok=false 表示这是通知（无响应）。
func (s *Server) mcpHandle(ctx context.Context, req mcpRequest) (mcpResponse, bool) {
	isNotification := len(req.ID) == 0 || string(req.ID) == "null"
	resp := mcpResponse{JSONRPC: "2.0", ID: req.ID}
	fail := func(code int, msg string) (mcpResponse, bool) {
		resp.Error = &mcpError{Code: code, Message: msg}
		return resp, !isNotification
	}

	switch req.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		version := params.ProtocolVersion
		if version == "" {
			version = mcpProtocolVersion
		}
		resp.Result = map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "replayd", "title": "replayd Web 发包重放工具", "version": "0.1.0"},
			"instructions": "replayd 提供 Web 请求重放、MITM 抓包与无头渲染。" +
				"render_url 会用真实无头浏览器渲染页面并返回截图与可读文本（能拿到 JS 执行后的结果，" +
				"这是纯 HTTP 抓取做不到的）。经 via_proxy 渲染时，页面子请求会走 replayd 的 MITM 代理并被抓包。",
		}
		return resp, !isNotification

	case "notifications/initialized", "notifications/cancelled", "notifications/progress":
		return resp, false

	case "ping":
		resp.Result = map[string]any{}
		return resp, !isNotification

	case "tools/list":
		resp.Result = map[string]any{"tools": s.mcpTools()}
		return resp, !isNotification

	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return fail(-32602, "tools/call 参数不合法: "+err.Error())
		}
		result := s.mcpCall(ctx, params.Name, params.Arguments)
		resp.Result = result
		return resp, !isNotification

	case "resources/list":
		resp.Result = map[string]any{"resources": []any{}}
		return resp, !isNotification

	case "prompts/list":
		resp.Result = map[string]any{"prompts": []any{}}
		return resp, !isNotification
	}
	return fail(-32601, "不支持的方法: "+req.Method)
}

// mcpTools 声明可用工具（JSON Schema）。
func (s *Server) mcpTools() []map[string]any {
	return []map[string]any{
		{
			"name":  "render_url",
			"title": "无头渲染页面",
			"description": "用无头浏览器打开 URL，返回渲染后的可读文本、无障碍树与 PNG 截图。" +
				"页面 JS 会真实执行，因此能看到动态内容；截图以 image 内容块返回，可直接交给多模态模型或人看。" +
				"渲染动作会记入抓包历史。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"url":                map[string]any{"type": "string", "description": "要渲染的 http/https 地址"},
					"viewport_width":     map[string]any{"type": "integer", "description": "视口宽度，默认 1440"},
					"viewport_height":    map[string]any{"type": "integer", "description": "视口高度，默认 900"},
					"full_page":          map[string]any{"type": "boolean", "description": "是否截整页，默认 true"},
					"wait_until":         map[string]any{"type": "string", "enum": []string{"load", "networkidle"}, "description": "等待策略，默认 load"},
					"timeout_ms":         map[string]any{"type": "integer", "description": "整体超时，默认 30000"},
					"text_limit":         map[string]any{"type": "integer", "description": "返回文本的长度上限，默认 200000"},
					"via_proxy":          map[string]any{"type": "boolean", "description": "true 则经 replayd 的 MITM 代理渲染（子请求会被抓包）"},
					"include_screenshot": map[string]any{"type": "boolean", "description": "是否把视口截图作为 image 内容返回，默认 true"},
					"include_a11y":       map[string]any{"type": "boolean", "description": "是否返回无障碍树，默认 true"},
				},
				"required": []string{"url"},
			},
		},
		{
			"name":  "capture_repeater",
			"title": "截图 replayd 的 Repeater 界面（请求 + 响应 + 取证）",
			"description": "把数据包交给 replayd：它会在自己的 Repeater 页里填好请求、点击发送、等响应与" +
				"北京时间取证面板加载完成，然后把**整个界面**截成 PNG 返回（image 内容块）。" +
				"这是给裁判看的那张\"结果 + 北京时间\"证据图。同时返回从界面回读的状态行、响应头、" +
				"取证水印等文本，Agent 不必看图也能判断结果。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"raw":              map[string]any{"type": "string", "description": "要填入并发送的原始 HTTP 请求报文"},
					"scheme":           map[string]any{"type": "string", "enum": []string{"http", "https"}, "description": "目标协议，默认 http"},
					"host":             map[string]any{"type": "string", "description": "目标主机（可含端口）"},
					"port":             map[string]any{"type": "integer", "description": "目标端口"},
					"insecure_tls":     map[string]any{"type": "boolean", "description": "跳过上游证书校验"},
					"evidence_url":     map[string]any{"type": "string", "description": "取证面板要显示的时间页，默认界面当前设定（beijing-time.org）"},
					"evidence_auto":    map[string]any{"type": "string", "enum": []string{"0", "30", "60"}, "description": "取证面板自动刷新秒数"},
					"hide_evidence":    map[string]any{"type": "boolean", "description": "true 则收起取证面板（只截请求+响应两栏）"},
					"evidence_details": map[string]any{"type": "boolean", "description": "截图时是否展开取证详情（来源/抓取时间/flowId），默认 true——界面默认收起，但证据图需要它"},
					"width":            map[string]any{"type": "integer", "description": "截图宽度，默认 1600"},
					"height":           map[string]any{"type": "integer", "description": "截图高度，默认 1000"},
					"full_page":        map[string]any{"type": "boolean", "description": "是否额外截整页"},
					"include_content":  map[string]any{"type": "boolean", "description": "文本里是否带上响应体预览"},
					"send":             map[string]any{"type": "boolean", "description": "false 则只截当前界面、不代发"},
					"wait_timeout_ms":  map[string]any{"type": "integer", "description": "等待响应与取证面板的超时，默认 20000"},
					"highlight_request": map[string]any{"type": "array", "items": map[string]any{"type": "string"},
						"description": "要在请求包里框出来的文本片段（按文本匹配，无需偏移），如 [\"Host:\", \"uid=10100\"]"},
					"highlight_response": map[string]any{"type": "array", "items": map[string]any{"type": "string"},
						"description": "要在响应体里框出来的文本片段，如 [\"role=admin\", \"token=\"]"},
					"highlight_color": map[string]any{"type": "string", "enum": []string{"yellow", "green", "red", "blue"},
						"description": "高亮颜色，默认 yellow"},
				},
				"required": []string{"raw"},
			},
		},
		{
			"name":        "render_status",
			"title":       "渲染能力状态",
			"description": "查看无头浏览器是否可用、来源、版本与产物统计。渲染报错时先用它排查。",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name":        "replay_request",
			"title":       "重放原始 HTTP 报文",
			"description": "提交一条原始 HTTP/1.1 请求（字节级保真发送），返回状态码、响应头与响应体文本。请求会记入抓包历史。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"raw":          map[string]any{"type": "string", "description": "原始请求报文，例如 GET / HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n"},
					"scheme":       map[string]any{"type": "string", "enum": []string{"http", "https"}, "description": "请求行为相对路径时的协议，默认 http"},
					"host":         map[string]any{"type": "string", "description": "目标主机（含端口可选），请求行/ Host 缺失时使用"},
					"port":         map[string]any{"type": "integer", "description": "目标端口"},
					"insecure_tls": map[string]any{"type": "boolean", "description": "跳过上游证书校验"},
					"body_limit":   map[string]any{"type": "integer", "description": "返回响应体文本的长度上限，默认 65536"},
				},
				"required": []string{"raw"},
			},
		},
		{
			"name":        "list_flows",
			"title":       "查看抓包历史",
			"description": "按主机/方法/关键字查询最近的抓包记录（含重放与渲染动作）。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"host":   map[string]any{"type": "string", "description": "按主机过滤（包含匹配）"},
					"method": map[string]any{"type": "string", "description": "按方法过滤，如 GET"},
					"search": map[string]any{"type": "string", "description": "按路径/URL 关键字搜索"},
					"limit":  map[string]any{"type": "integer", "description": "返回条数，默认 20，最大 200"},
				},
			},
		},
		{
			"name":        "get_flow",
			"title":       "读取单条抓包详情",
			"description": "按 flow id 读取完整请求/响应（可选择是否带响应体）。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"id":          map[string]any{"type": "string", "description": "flow id"},
					"with_bodies": map[string]any{"type": "boolean", "description": "是否返回请求/响应体，默认 false"},
				},
				"required": []string{"id"},
			},
		},
	}
}

func (s *Server) mcpCall(ctx context.Context, name string, args json.RawMessage) mcpCallResult {
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage("{}")
	}
	switch name {
	case "render_url":
		return s.mcpRender(ctx, args)
	case "capture_repeater":
		return s.mcpCaptureRepeater(ctx, args)
	case "render_status":
		return s.mcpRenderStatus(ctx)
	case "replay_request":
		return s.mcpReplay(ctx, args)
	case "list_flows":
		return s.mcpListFlows(ctx, args)
	case "get_flow":
		return s.mcpGetFlow(ctx, args)
	}
	return mcpCallResult{
		Content: []mcpContent{textContent("未知工具: " + name)},
		IsError: true,
	}
}

// handleMCPInfo 给设置页/Agent 提供接入信息（端点、令牌、工具清单、客户端片段）。
// 注意：返回完整令牌，因此与其余端点一样要求已鉴权。
func (s *Server) handleMCPInfo(w http.ResponseWriter, r *http.Request) {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		host = s.cfg.Listen
	}
	endpoint := scheme + "://" + host + "/mcp"

	type toolView struct {
		Name        string `json:"name"`
		Title       string `json:"title"`
		Description string `json:"description"`
	}
	tools := make([]toolView, 0, 8)
	for _, tool := range s.mcpTools() {
		name, _ := tool["name"].(string)
		title, _ := tool["title"].(string)
		desc, _ := tool["description"].(string)
		tools = append(tools, toolView{Name: name, Title: title, Description: desc})
	}

	cfgSnippet := map[string]any{
		"mcpServers": map[string]any{
			"replayd": map[string]any{
				"type":    "http",
				"url":     endpoint,
				"headers": map[string]any{"Authorization": "Bearer " + s.cfg.Token},
			},
		},
	}
	// 用原始字符串字面量，保证反斜杠续行与 JSON 引号原样保留
	curlExample := fmt.Sprintf(`curl -s -X POST %s \
  -H 'Authorization: Bearer %s' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"%s","clientInfo":{"name":"agent","version":"1"}}}'`,
		endpoint, s.cfg.Token, mcpProtocolVersion)

	s.writeJSON(w, http.StatusOK, map[string]any{
		"endpoint":        endpoint,
		"transport":       "http",
		"protocolVersion": mcpProtocolVersion,
		"auth":            "bearer",
		"token":           s.cfg.Token,
		"tools":           tools,
		"clientConfig":    cfgSnippet,
		"curlExample":     curlExample,
		"renderReady":     s.render != nil,
	})
}

/* -------------------------------------------------------------------------- */
/* 工具实现                                                                    */
/* -------------------------------------------------------------------------- */

func (s *Server) mcpRender(ctx context.Context, args json.RawMessage) mcpCallResult {
	var a struct {
		URL               string `json:"url"`
		ViewportWidth     int    `json:"viewport_width"`
		ViewportHeight    int    `json:"viewport_height"`
		FullPage          *bool  `json:"full_page"`
		WaitUntil         string `json:"wait_until"`
		TimeoutMS         int    `json:"timeout_ms"`
		TextLimit         int    `json:"text_limit"`
		ViaProxy          *bool  `json:"via_proxy"`
		IncludeScreenshot *bool  `json:"include_screenshot"`
		IncludeA11y       *bool  `json:"include_a11y"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return mcpCallResult{Content: []mcpContent{textContent("参数不合法: " + err.Error())}, IsError: true}
	}
	if s.render == nil {
		return mcpCallResult{Content: []mcpContent{textContent("本实例未启用渲染")}, IsError: true}
	}

	in := renderRequest{
		URL: a.URL, Width: a.ViewportWidth, Height: a.ViewportHeight,
		FullPage: a.FullPage, WaitUntil: a.WaitUntil, TimeoutMS: a.TimeoutMS,
		TextLimit: a.TextLimit, ViaProxy: a.ViaProxy,
	}
	spec, proxyURL, err := s.renderSpec(in)
	if err != nil {
		return mcpCallResult{Content: []mcpContent{textContent(err.Error())}, IsError: true}
	}
	if a.IncludeA11y != nil && !*a.IncludeA11y {
		spec.NoA11y = true
	}

	timeout := time.Duration(spec.TimeoutMS)*time.Millisecond + 30*time.Second
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	out, res := s.runRender(runCtx, in, spec, proxyURL, "")
	if out.Error != nil {
		return mcpCallResult{
			Content: []mcpContent{textContent(fmt.Sprintf("渲染失败（%s）：%s\n提示：可用 render_status 检查浏览器是否可用。",
				out.Error.Code, out.Error.Message))},
			IsError: true,
		}
	}

	var lines []string
	lines = append(lines,
		fmt.Sprintf("URL: %s", out.FinalURL),
		fmt.Sprintf("标题: %s", out.Title),
		fmt.Sprintf("主文档状态: %d", out.NavStatus),
		fmt.Sprintf("视口: %dx%d  内容高度: %d", out.Width, out.Height, out.ContentHeight),
		fmt.Sprintf("耗时: %dms（导航 %dms / 等待 %dms / 采图 %dms）",
			out.Timings.TotalMS, out.Timings.NavMS, out.Timings.WaitMS, out.Timings.CaptureMS),
	)
	if proxyURL != "" {
		lines = append(lines, "渲染流量经过 MITM 代理: "+proxyURL+"（子请求已抓包）")
	}
	if out.FlowID != "" {
		lines = append(lines, "已记入历史: "+out.FlowID)
	}
	if len(out.Screenshots) > 0 {
		var parts []string
		for key, view := range out.Screenshots {
			label := "视口"
			if key == "full" {
				label = "整页"
			}
			parts = append(parts, fmt.Sprintf("%s %s（%d KB，GET %s）", label, view.ArtifactID, view.Size/1024, view.URL))
		}
		lines = append(lines, "截图产物: "+strings.Join(parts, "；"))
	}
	if out.TextTruncated {
		lines = append(lines, "（文本已按 text_limit 截断）")
	}
	lines = append(lines, "", "=== 渲染后文本 ===", out.Text)
	if len(out.A11y) > 0 {
		lines = append(lines, "", "=== 无障碍树（前 40 项）===")
		for i, node := range out.A11y {
			if i >= 40 {
				lines = append(lines, fmt.Sprintf("… 其余 %d 项已省略", len(out.A11y)-40))
				break
			}
			name := node.Name
			if name == "" {
				name = node.Value
			}
			lines = append(lines, fmt.Sprintf("- [%s] %s", node.Role, name))
		}
	}

	content := []mcpContent{textContent(strings.Join(lines, "\n"))}
	includeShot := true
	if a.IncludeScreenshot != nil {
		includeShot = *a.IncludeScreenshot
	}
	if includeShot && res != nil && len(res.ViewportPNG) > 0 {
		if len(res.ViewportPNG) <= 4<<20 {
			content = append(content, imageContent(res.ViewportPNG))
		} else {
			content = append(content, textContent("（视口截图过大，未内联；请用截图产物地址下载）"))
		}
	}
	return mcpCallResult{Content: content}
}

func (s *Server) mcpCaptureRepeater(ctx context.Context, args json.RawMessage) mcpCallResult {
	var a struct {
		Raw               string   `json:"raw"`
		Scheme            string   `json:"scheme"`
		Host              string   `json:"host"`
		Port              int      `json:"port"`
		InsecureTLS       bool     `json:"insecure_tls"`
		EvidenceURL       string   `json:"evidence_url"`
		EvidenceAuto      string   `json:"evidence_auto"`
		HideEvidence      bool     `json:"hide_evidence"`
		EvidenceDetails   *bool    `json:"evidence_details"`
		Width             int      `json:"width"`
		Height            int      `json:"height"`
		FullPage          bool     `json:"full_page"`
		IncludeContent    bool     `json:"include_content"`
		Send              *bool    `json:"send"`
		WaitTimeoutMS     int      `json:"wait_timeout_ms"`
		HighlightRequest  []string `json:"highlight_request"`
		HighlightResponse []string `json:"highlight_response"`
		HighlightColor    string   `json:"highlight_color"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return mcpCallResult{Content: []mcpContent{textContent("参数不合法: " + err.Error())}, IsError: true}
	}
	if strings.TrimSpace(a.Raw) == "" {
		return mcpCallResult{Content: []mcpContent{textContent("raw 不能为空")}, IsError: true}
	}
	if s.capture == nil {
		return mcpCallResult{Content: []mcpContent{textContent("本实例未启用界面截图")}, IsError: true}
	}

	spec := capture.Spec{
		Raw:    strings.ReplaceAll(a.Raw, `\r\n`, "\r\n"),
		Scheme: a.Scheme, Host: a.Host, Port: a.Port,
		InsecureTLS: a.InsecureTLS,
		EvidenceURL: a.EvidenceURL, EvidenceAuto: a.EvidenceAuto, HideEvidence: a.HideEvidence,
		EvidenceDetails: a.EvidenceDetails,
		Width:           a.Width, Height: a.Height, FullPage: a.FullPage,
		IncludeContent: a.IncludeContent, Send: a.Send, WaitTimeoutMS: a.WaitTimeoutMS,
	}
	if len(a.HighlightRequest) > 0 || len(a.HighlightResponse) > 0 {
		color := a.HighlightColor
		if color == "" {
			color = "yellow"
		}
		spec.Highlight = &capture.HighlightSpec{
			Request: a.HighlightRequest, Response: a.HighlightResponse, Color: color,
		}
		if verr := spec.Highlight.Validate(); verr != nil {
			return mcpCallResult{Content: []mcpContent{textContent(verr.Error())}, IsError: true}
		}
	}
	runCtx, cancel := context.WithTimeout(ctx,
		time.Duration(a.WaitTimeoutMS)*time.Millisecond+45*time.Second)
	defer cancel()

	res, err := s.capture.Capture(runCtx, spec)
	if err != nil {
		return mcpCallResult{
			Content: []mcpContent{textContent("界面截图失败：" + err.Error() + "\n提示：可用 render_status 检查浏览器是否可用。")},
			IsError: true,
		}
	}

	var lines []string
	lines = append(lines,
		"已截取 replayd Repeater 界面（请求 + 响应 + 取证）",
		fmt.Sprintf("界面状态行: %s", valueOr(res.StatusLine, "—")),
		fmt.Sprintf("界面目标: %s", valueOr(res.TargetSeen, "—")),
		fmt.Sprintf("响应头: %s", strings.ReplaceAll(strings.TrimSpace(res.ResponseHeaders), "\n", " | ")),
		fmt.Sprintf("取证面板: %s", valueOr(res.EvidenceMode, "—")),
		fmt.Sprintf("取证水印: %s", strings.ReplaceAll(strings.TrimSpace(res.EvidenceWatermark), "\n", " ")),
		fmt.Sprintf("耗时: 发送 %dms / 取证 %dms / 合计 %dms", res.SentMS, res.EvidenceMS, res.TotalMS),
	)
	if res.SendError != "" {
		lines = append(lines, "发送报错: "+res.SendError)
	}
	if len(res.HighlightsApplied) > 0 {
		lines = append(lines, "已高亮: "+strings.Join(res.HighlightsApplied, "、"))
	}
	if len(res.HighlightsMissing) > 0 {
		lines = append(lines, "未找到（无法高亮）: "+strings.Join(res.HighlightsMissing, "、"))
	}
	if len(res.ResponsePreview) > 0 {
		preview := res.ResponsePreview
		if len(preview) > 4000 {
			preview = preview[:4000] + "\n…（已截断）"
		}
		lines = append(lines, "", "=== 响应体预览 ===", preview)
	}
	content := []mcpContent{textContent(strings.Join(lines, "\n"))}
	if len(res.ViewportPNG) > 0 && len(res.ViewportPNG) <= 6<<20 {
		content = append(content, imageContent(res.ViewportPNG))
	} else if len(res.ViewportPNG) > 6<<20 {
		content = append(content, textContent("（界面截图过大，未内联）"))
	}
	return mcpCallResult{Content: content}
}

func valueOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

func (s *Server) mcpRenderStatus(ctx context.Context) mcpCallResult {
	payload := map[string]any{}
	if s.browser != nil {
		st := s.browser.Status()
		payload["browser"] = map[string]any{
			"available": st.Available, "source": st.Source, "path": st.Path,
			"running": st.Running, "version": st.Version, "activeContexts": st.ActiveContext,
		}
		if !st.Available {
			payload["hint"] = "本机没有可用浏览器：设置 REPLAYD_CHROME_PATH，或调用 POST /api/render/browser/install 自动下载"
		}
	} else {
		payload["browser"] = map[string]any{"available": false}
	}
	payload["rendererReady"] = s.render != nil
	payload["activeJobs"] = s.jobs.active()
	if count, bytes, err := s.store.CountArtifacts(ctx); err == nil {
		payload["artifacts"] = map[string]any{"count": count, "bytes": bytes}
	}
	pretty, _ := json.MarshalIndent(payload, "", "  ")
	return mcpCallResult{Content: []mcpContent{textContent(string(pretty))}}
}

func (s *Server) mcpReplay(ctx context.Context, args json.RawMessage) mcpCallResult {
	var a struct {
		Raw         string `json:"raw"`
		Scheme      string `json:"scheme"`
		Host        string `json:"host"`
		Port        int    `json:"port"`
		InsecureTLS bool   `json:"insecure_tls"`
		BodyLimit   int    `json:"body_limit"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return mcpCallResult{Content: []mcpContent{textContent("参数不合法: " + err.Error())}, IsError: true}
	}
	if strings.TrimSpace(a.Raw) == "" {
		return mcpCallResult{Content: []mcpContent{textContent("raw 不能为空")}, IsError: true}
	}
	in := replayRequest{
		Raw: strings.ReplaceAll(a.Raw, `\r\n`, "\r\n"),
		Target: replayTarget{
			Scheme: a.Scheme, Host: a.Host, Port: a.Port,
		},
		Opts: replayOptions{InsecureTLS: a.InsecureTLS},
	}
	out := s.doReplay(ctx, in, nil)

	if out.Error != nil {
		return mcpCallResult{
			Content: []mcpContent{textContent(fmt.Sprintf("重放失败（%s）：%s", out.Error.Code, out.Error.Message))},
			IsError: true,
		}
	}
	var lines []string
	if out.Response != nil {
		lines = append(lines, fmt.Sprintf("%s %d %s", out.Response.Proto, out.Response.Status, out.Response.Reason))
		for _, h := range out.Response.Headers {
			lines = append(lines, fmt.Sprintf("%s: %s", h.Name, h.Value))
		}
		body := out.Response.BodyText
		if a.BodyLimit > 0 && len(body) > a.BodyLimit {
			body = body[:a.BodyLimit] + "\n…（已截断）"
		}
		if body != "" {
			lines = append(lines, "", body)
		}
	}
	lines = append(lines, "", fmt.Sprintf("耗时 %dms", out.DurationMS))
	if out.FlowID != "" {
		lines = append(lines, "已记入历史: "+out.FlowID)
	}
	return mcpCallResult{Content: []mcpContent{textContent(strings.Join(lines, "\n"))}}
}

func (s *Server) mcpListFlows(ctx context.Context, args json.RawMessage) mcpCallResult {
	var a struct {
		Host   string `json:"host"`
		Method string `json:"method"`
		Search string `json:"search"`
		Limit  int    `json:"limit"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return mcpCallResult{Content: []mcpContent{textContent("参数不合法: " + err.Error())}, IsError: true}
	}
	if a.Limit <= 0 || a.Limit > 200 {
		a.Limit = 20
	}
	flows, _, err := s.store.ListFlows(ctx, store.Filter{
		Host: a.Host, Method: a.Method, Search: a.Search, Limit: a.Limit,
	})
	if err != nil {
		return mcpCallResult{Content: []mcpContent{textContent("查询失败: " + err.Error())}, IsError: true}
	}
	if len(flows) == 0 {
		return mcpCallResult{Content: []mcpContent{textContent("没有匹配的抓包记录")}}
	}
	lines := []string{fmt.Sprintf("共 %d 条：", len(flows))}
	for _, f := range flows {
		status := "-"
		if f.Status != nil {
			status = fmt.Sprintf("%d", *f.Status)
		}
		tag := ""
		switch {
		case strings.HasPrefix(f.Note, "render:"):
			tag = " [渲染]"
		case strings.HasPrefix(f.Note, "evidence:"):
			tag = " [取证]"
		}
		lines = append(lines, fmt.Sprintf("- %s  %s %s://%s:%d%s → %s%s  (%s)",
			f.ID, f.Method, f.Scheme, f.Host, f.Port, f.Path, status, tag, f.Source))
	}
	return mcpCallResult{Content: []mcpContent{textContent(strings.Join(lines, "\n"))}}
}

func (s *Server) mcpGetFlow(ctx context.Context, args json.RawMessage) mcpCallResult {
	var a struct {
		ID         string `json:"id"`
		WithBodies bool   `json:"with_bodies"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return mcpCallResult{Content: []mcpContent{textContent("参数不合法: " + err.Error())}, IsError: true}
	}
	if a.ID == "" {
		return mcpCallResult{Content: []mcpContent{textContent("id 不能为空")}, IsError: true}
	}
	flow, err := s.store.GetFlow(ctx, a.ID, a.WithBodies)
	if err != nil {
		return mcpCallResult{Content: []mcpContent{textContent("读取失败: " + err.Error())}, IsError: true}
	}
	var lines []string
	status := 0
	if flow.Status != nil {
		status = *flow.Status
	}
	lines = append(lines,
		fmt.Sprintf("%s %s://%s:%d%s", flow.Method, flow.Scheme, flow.Host, flow.Port, flow.Path),
		fmt.Sprintf("状态: %d  来源: %s", status, flow.Source),
	)
	if flow.Note != "" {
		lines = append(lines, "备注: "+flow.Note)
	}
	if flow.RespBody != nil {
		body := string(flow.RespBody)
		if len(body) > 20000 {
			body = body[:20000] + "\n…（已截断）"
		}
		lines = append(lines, "", body)
	}
	return mcpCallResult{Content: []mcpContent{textContent(strings.Join(lines, "\n"))}}
}
