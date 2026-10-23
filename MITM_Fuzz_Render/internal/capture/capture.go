// Package capture 把 replayd 自己的界面渲染成图：无头浏览器打开 Repeater 页，
// 按给定数据包填编辑器 → 点发送 → 等响应与取证面板就绪 → 整窗截图。
//
// 与 internal/render 的区别：
//   - render 渲染的是"目标网站"的内容（用于看改包后的效果、取证面板内嵌时间源）；
//   - capture 截的是"replayd 自己的三栏页面"（请求 + 响应 + 取证），
//     产出可以直接交给裁判或作为演练留证的整窗截图。
package capture

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"time"

	"github.com/chinaran404/replayd/internal/browser"
	"github.com/chinaran404/replayd/internal/cdp"
)

const (
	defaultWidth    = 1600
	defaultHeight   = 1000
	defaultWaitMS   = 20_000
	defaultSettleMS = 1200
)

// Spec 是一次界面截图请求。
type Spec struct {
	// 数据包（全自动：会被填进请求编辑器并点发送）
	Raw         string `json:"raw"`
	Scheme      string `json:"scheme"`
	Host        string `json:"host"`
	Port        int    `json:"port,omitempty"`
	InsecureTLS bool   `json:"insecureTLS,omitempty"`
	ScriptID    string `json:"scriptId,omitempty"`

	// 取证面板
	EvidenceURL      string `json:"evidenceUrl,omitempty"`
	EvidenceAuto     string `json:"evidenceAuto,omitempty"`     // 0 | 30 | 60
	EvidenceMode     string `json:"evidenceMode,omitempty"`     // auto | direct | snapshot
	EvidenceSettleMS int    `json:"evidenceSettleMs,omitempty"` // 子框架就绪后的额外等待
	// EvidenceDetails：截图前是否展开面板头上的 ⓘ（界面默认收起，但无头截图里
	// 没法"悬停展开"，取证图需要带上来源/抓取时间/flowId，所以这里默认展开）。
	EvidenceDetails *bool `json:"evidenceDetails,omitempty"`
	HideEvidence    bool  `json:"hideEvidence,omitempty"`

	// Highlight 让调用方（尤其是 Agent）用"文本匹配"打高亮：
	// 它不需要知道字符偏移，只要给要框出来的片段即可。
	Highlight *HighlightSpec `json:"highlight,omitempty"`

	// 截图
	Width          int  `json:"width,omitempty"`
	Height         int  `json:"height,omitempty"`
	FullPage       bool `json:"fullPage,omitempty"`
	WaitTimeoutMS  int  `json:"waitTimeoutMs,omitempty"`
	SettleMS       int  `json:"settleMs,omitempty"`
	IncludeContent bool `json:"includeContent,omitempty"`
	// Send=false 时只截图不代发（保存当前界面状态）
	Send *bool `json:"send,omitempty"`
}

// HighlightSpec 用文本匹配打高亮（比字符偏移对调用方友好得多）。
type HighlightSpec struct {
	Request  []string `json:"request,omitempty"`
	Response []string `json:"response,omitempty"`
	Color    string   `json:"color,omitempty"` // yellow（默认）| green | red | blue
}

var highlightColorNames = map[string]bool{"yellow": true, "green": true, "red": true, "blue": true}

// Validate 校验高亮参数（API 层可提前用它返回 400）。
func (h *HighlightSpec) Validate() error { return h.normalize() }

func (h *HighlightSpec) normalize() error {
	if h.Color == "" {
		h.Color = "yellow"
	}
	if !highlightColorNames[h.Color] {
		return fmt.Errorf("capture: highlight.color 只支持 yellow/green/red/blue，收到 %s", h.Color)
	}
	if len(h.Request) > 20 || len(h.Response) > 20 {
		return errors.New("capture: highlight 每侧最多 20 个片段")
	}
	for _, list := range [][]string{h.Request, h.Response} {
		for _, pattern := range list {
			if strings.TrimSpace(pattern) == "" {
				return errors.New("capture: highlight 片段不能为空")
			}
			if len(pattern) > 200 {
				return errors.New("capture: 单个 highlight 片段不能超过 200 字符")
			}
		}
	}
	return nil
}

// Result 是截图结果：图 + 从 DOM 回读的文本（便于 Agent 直接读，不必看图）。
type Result struct {
	StatusLine        string   `json:"statusLine"`
	ResponseHeaders   string   `json:"responseHeaders"`
	ResponsePreview   string   `json:"responsePreview"`
	EvidenceMode      string   `json:"evidenceMode"`
	EvidenceWatermark string   `json:"evidenceWatermark"`
	EvidenceFrameURL  string   `json:"evidenceFrameUrl,omitempty"`
	EvidenceWarnings  []string `json:"evidenceWarnings,omitempty"`
	RequestSeen       string   `json:"requestSeen"`
	TargetSeen        string   `json:"targetSeen"`
	SendError         string   `json:"sendError,omitempty"`
	ConsoleErrors     []string `json:"consoleErrors,omitempty"`
	// HighlightsApplied 成功打上的片段；HighlightsMissing 是页面文本里没找到的片段
	HighlightsApplied []string `json:"highlightsApplied,omitempty"`
	HighlightsMissing []string `json:"highlightsMissing,omitempty"`

	ViewportPNG []byte `json:"-"`
	FullPNG     []byte `json:"-"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`

	SentMS     int64 `json:"sentMs"`
	EvidenceMS int64 `json:"evidenceMs"`
	TotalMS    int64 `json:"totalMs"`
}

// Capturer 复用同一个浏览器管理器。
type Capturer struct {
	manager *browser.Manager
	log     *slog.Logger
	// BaseURL 返回 replayd 自己的访问地址（含 scheme 与 host:port）。
	BaseURL func() string
	// Token 返回访问令牌（用于 ?token= 参数自动登录）。
	Token func() string
}

// New 创建截图器。
func New(manager *browser.Manager, log *slog.Logger, baseURL, token func() string) *Capturer {
	if log == nil {
		log = slog.Default()
	}
	return &Capturer{manager: manager, log: log, BaseURL: baseURL, Token: token}
}

// SelfURL 把监听地址转换成无头浏览器可访问的地址（0.0.0.0/:: → 127.0.0.1）。
func SelfURL(listen string) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "http://" + listen
	}
	switch host {
	case "", "0.0.0.0", "::", "[::]":
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func (s *Spec) applyDefaults() error {
	if strings.TrimSpace(s.Raw) == "" {
		return errors.New("capture: raw 不能为空（需要要发送的原始请求报文）")
	}
	if s.Scheme == "" {
		s.Scheme = "http"
	}
	if s.Scheme != "http" && s.Scheme != "https" {
		return fmt.Errorf("capture: scheme 只支持 http/https，收到 %s", s.Scheme)
	}
	if s.Width <= 0 {
		s.Width = defaultWidth
	}
	if s.Height <= 0 {
		s.Height = defaultHeight
	}
	if s.Width > 4096 {
		s.Width = 4096
	}
	if s.Height > 4096 {
		s.Height = 4096
	}
	if s.WaitTimeoutMS <= 0 {
		s.WaitTimeoutMS = defaultWaitMS
	}
	if s.SettleMS < 0 {
		s.SettleMS = 0
	} else if s.SettleMS == 0 {
		s.SettleMS = defaultSettleMS
	}
	if s.EvidenceMode == "" {
		// 截图场景默认快照：时间页由 replayd 服务端抓取后同源返回，
		// 一定能在截图里画出来（live 直嵌由调用方显式选 direct）。
		s.EvidenceMode = "snapshot"
	}
	switch s.EvidenceMode {
	case "auto", "direct", "snapshot":
	default:
		return fmt.Errorf("capture: evidenceMode 只支持 auto/direct/snapshot，收到 %s", s.EvidenceMode)
	}
	if s.Highlight != nil {
		if err := s.Highlight.normalize(); err != nil {
			return err
		}
	}
	if s.EvidenceSettleMS <= 0 {
		if s.EvidenceMode == "snapshot" {
			s.EvidenceSettleMS = 1500
		} else {
			s.EvidenceSettleMS = 7000 // 真实站点首屏绘制（无头冷启动更慢）需要时间
		}
	}
	return nil
}

func shouldSend(spec Spec) bool {
	return spec.Send == nil || *spec.Send
}

// Capture 执行一次"填包 → 发送 → 等取证 → 截图"。
func (c *Capturer) Capture(ctx context.Context, spec Spec) (*Result, error) {
	if err := spec.applyDefaults(); err != nil {
		return nil, err
	}
	start := time.Now()
	timeout := time.Duration(spec.WaitTimeoutMS)*time.Millisecond + 15*time.Second
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	out := &Result{Width: spec.Width, Height: spec.Height}

	client, err := c.manager.Client(ctx)
	if err != nil {
		return nil, err
	}

	// 打开自己的界面：独立上下文、不经 MITM 代理（代理会把回环流量也接管）
	contextID, err := c.manager.NewContext(ctx, "")
	if err != nil {
		return nil, err
	}
	defer c.manager.DisposeContext(context.Background(), contextID)

	var target cdp.CreateTargetResult
	if err := client.Call(ctx, "", "Target.createTarget",
		map[string]any{"url": "about:blank", "browserContextId": contextID}, &target); err != nil {
		return nil, fmt.Errorf("capture: 创建标签页失败: %w", err)
	}
	defer func() {
		_ = client.Call(context.Background(), "", "Target.closeTarget",
			map[string]any{"targetId": target.TargetID}, nil)
	}()

	var attached cdp.AttachResult
	if err := client.Call(ctx, "", "Target.attachToTarget",
		map[string]any{"targetId": target.TargetID, "flatten": true}, &attached); err != nil {
		return nil, fmt.Errorf("capture: 附加到标签页失败: %w", err)
	}
	session := attached.SessionID

	for _, domain := range []string{"Page.enable", "Runtime.enable"} {
		if err := client.Call(ctx, session, domain, nil, nil); err != nil {
			return nil, fmt.Errorf("capture: %s 失败: %w", domain, err)
		}
	}
	metrics := map[string]any{
		"width": spec.Width, "height": spec.Height, "deviceScaleFactor": 1, "mobile": false,
	}
	if err := client.Call(ctx, session, "Emulation.setDeviceMetricsOverride", metrics, nil); err != nil {
		return nil, fmt.Errorf("capture: 设置视口失败: %w", err)
	}

	// ---- 打开 Repeater 页（?token= 自动登录）----
	pageURL := strings.TrimRight(c.baseURL(), "/") + "/repeater"
	if token := c.token(); token != "" {
		pageURL += "?token=" + token
	}
	var nav struct {
		ErrorText string `json:"errorText"`
	}
	if err := client.Call(ctx, session, "Page.navigate", map[string]any{"url": pageURL}, &nav); err != nil {
		return nil, fmt.Errorf("capture: 打开界面失败: %w", err)
	}
	if nav.ErrorText != "" {
		return nil, fmt.Errorf("capture: 无法打开 replayd 界面: %s", nav.ErrorText)
	}
	if ok, err := c.waitFor(ctx, client, session, `[data-testid="repeater-request-editor"]`, spec.WaitTimeoutMS); err != nil {
		return nil, err
	} else if !ok {
		return nil, errors.New("capture: 等待请求编辑器超时（界面可能未加载或需要令牌）")
	}

	// ---- 确保取证面板可见 ----
	if !spec.HideEvidence {
		if err := c.ensureEvidenceVisible(ctx, client, session); err != nil {
			c.log.Warn("取证面板可见性处理失败", "err", err)
		}
	}

	// ---- 填包 ----
	if _, err := c.eval(ctx, client, session, fillScript(spec)); err != nil {
		return nil, fmt.Errorf("capture: 填写请求失败: %w", err)
	}

	// ---- 取证面板配置 + 刷新 ----
	evidenceStart := time.Now()
	if !spec.HideEvidence {
		if _, err := c.eval(ctx, client, session, evidenceScript(spec)); err != nil {
			c.log.Warn("配置取证面板失败", "err", err)
		}
	}

	// ---- 发送并等待响应 ----
	var sentMS int64
	if shouldSend(spec) {
		sendStart := time.Now()
		if _, err := c.eval(ctx, client, session, `(() => {
		  const btn = document.querySelector('[data-testid="repeater-send"]');
		  if (!btn) return 'no-send-button';
		  btn.click();
		  return 'clicked';
		})()`); err != nil {
			return nil, fmt.Errorf("capture: 点击发送失败: %w", err)
		}
		marker := `!!document.querySelector('[data-testid="repeater-response-headers"]') ||
		  !!document.querySelector('[data-testid="repeater-response-content"]') ||
		  !!document.querySelector('[data-testid="repeater-error"]')`
		if ok, err := c.waitForExpr(ctx, client, session, marker, spec.WaitTimeoutMS); err != nil {
			return nil, err
		} else if !ok {
			return nil, errors.New("capture: 等待响应超时")
		}
		sentMS = time.Since(sendStart).Milliseconds()
	}

	// ---- 按文本匹配打高亮（Agent 友好：不需要偏移）----
	if spec.Highlight != nil {
		applied, missing := c.applyHighlights(ctx, client, session, *spec.Highlight)
		out.HighlightsApplied = applied
		out.HighlightsMissing = missing
	}

	// ---- 等取证面板内容就绪：靠 frame tree 确认 iframe 真的在加载原站 ----
	var evidenceMS int64
	if !spec.HideEvidence {
		// 取证面板会把结果写进水印条；跨源 iframe 是 OOPIF（读不到内容、也不总在
		// frame tree 里），所以这里用"面板已有结果"作为主信号，再留一段绘制等待：
		// 实测真实授时站点首屏约 1-3s 画出来，给足 settle 才截得干净。
		panelExpr := `(() => {
		  const frameState = document.querySelector('[data-testid="evidence-frame-state"]');
		  const info = document.querySelector('[data-testid="evidence-info"]');
		  const hidden = document.querySelector('[data-testid="evidence-watermark"]');
		  const src = frameState ? (frameState.getAttribute('data-src') || '') : '';
		  const state = frameState ? (frameState.getAttribute('data-state') || '') : '';
		  // 优先读 ⓘ 的 data-summary（方案 C：详情默认收起，文本仍在属性里）
		  const summary = info ? (info.getAttribute('data-summary') || '') : (hidden ? hidden.textContent || '' : '');
		  const hasResult = info ? info.getAttribute('data-has-result') === '1' : summary.indexOf('来源') >= 0;
		  return JSON.stringify({ src: src, state: state, hasResult: hasResult, summary: summary });
		})()`

		waitMS := spec.WaitTimeoutMS
		if waitMS > 15000 {
			waitMS = 15000
		}
		deadline := time.Now().Add(time.Duration(waitMS) * time.Millisecond)
		loaded := false
		for {
			var raw string
			if err := c.evalJSON(ctx, client, session, panelExpr, &raw); err == nil {
				var probe struct {
					Src       string `json:"src"`
					State     string `json:"state"`
					HasResult bool   `json:"hasResult"`
					Summary   string `json:"summary"`
				}
				if json.Unmarshal([]byte(raw), &probe) == nil {
					if probe.Src != "" {
						out.EvidenceFrameURL = probe.Src
					}
					if probe.Summary != "" {
						out.EvidenceWatermark = probe.Summary
					}
					if probe.HasResult {
						loaded = probe.State == "loaded"
						break // 面板已拿到结果（iframe 或快照），进入绘制等待
					}
				}
			}
			if time.Now().After(deadline) {
				out.EvidenceWarnings = append(out.EvidenceWarnings,
					"取证面板在超时内没有拿到内容（截图里该区域可能为空）")
				c.log.Warn("取证面板未在超时内就绪", "url", spec.EvidenceURL)
				break
			}
			select {
			case <-ctx.Done():
			case <-time.After(250 * time.Millisecond):
			}
		}

		// 界面默认把详情收进 ⓘ；无头截图里没法悬停展开，所以这里显式点开
		wantDetails := spec.EvidenceDetails == nil || *spec.EvidenceDetails
		if _, err := c.eval(ctx, client, session, infoToggleScript(wantDetails)); err != nil {
			c.log.Warn("切换取证详情弹层失败", "err", err)
		}

		settle := spec.EvidenceSettleMS
		if loaded {
			settle = 800 // 面板明确报告 iframe 已加载，短暂等待即可
		}
		if settle > 0 {
			select {
			case <-ctx.Done():
			case <-time.After(time.Duration(settle) * time.Millisecond):
			}
		}
		evidenceMS = time.Since(evidenceStart).Milliseconds()
	}

	// 等页面稳定（字体、图片、iframe 内部渲染）
	if spec.SettleMS > 0 {
		select {
		case <-ctx.Done():
		case <-time.After(time.Duration(spec.SettleMS) * time.Millisecond):
		}
	}

	// ---- 回读文本证据 ----
	var dom struct {
		StatusLine        string `json:"statusLine"`
		Headers           string `json:"headers"`
		Body              string `json:"body"`
		EvidenceMode      string `json:"evidenceMode"`
		EvidenceWatermark string `json:"evidenceWatermark"`
		Request           string `json:"request"`
		Target            string `json:"target"`
		SendError         string `json:"sendError"`
	}
	if err := c.evalJSON(ctx, client, session, readScript(spec.IncludeContent), &dom); err != nil {
		c.log.Warn("回读界面文本失败", "err", err)
	}
	out.StatusLine = dom.StatusLine
	out.ResponseHeaders = dom.Headers
	out.ResponsePreview = dom.Body
	out.EvidenceMode = dom.EvidenceMode
	out.EvidenceWatermark = dom.EvidenceWatermark
	out.RequestSeen = dom.Request
	out.TargetSeen = dom.Target
	out.SendError = dom.SendError
	out.SentMS = sentMS
	out.EvidenceMS = evidenceMS
	out.ConsoleErrors = c.drainConsoleErrors()

	// ---- 截图（整窗）----
	viewportPNG, err := capture(ctx, client, session)
	if err != nil {
		return nil, fmt.Errorf("capture: 截图失败: %w", err)
	}
	out.ViewportPNG = viewportPNG

	if spec.FullPage {
		var layout cdp.LayoutMetrics
		if err := client.Call(ctx, session, "Page.getLayoutMetrics", nil, &layout); err == nil {
			if height := int(layout.CSSContentSize.Height); height > spec.Height {
				if height > 16000 {
					height = 16000
				}
				tall := map[string]any{"width": spec.Width, "height": height, "deviceScaleFactor": 1, "mobile": false}
				if err := client.Call(ctx, session, "Emulation.setDeviceMetricsOverride", tall, nil); err == nil {
					if fullPNG, cerr := capture(ctx, client, session); cerr == nil {
						out.FullPNG = fullPNG
					}
					_ = client.Call(ctx, session, "Emulation.setDeviceMetricsOverride", metrics, nil)
				}
			}
		}
	}

	out.TotalMS = time.Since(start).Milliseconds()
	return out, nil
}

/* -------------------------------------------------------------------------- */
/* 内部                                                                        */
/* -------------------------------------------------------------------------- */

func (c *Capturer) baseURL() string {
	if c.BaseURL == nil {
		return "http://127.0.0.1:8899"
	}
	return c.BaseURL()
}

func (c *Capturer) token() string {
	if c.Token == nil {
		return ""
	}
	return c.Token()
}

// applyHighlights 在请求编辑器与响应区里按文本匹配打高亮：
// 直接驱动界面本身（选中 → 点色点），因此高亮会走前端的持久化逻辑存到标签页上。
func (c *Capturer) applyHighlights(ctx context.Context, client *cdp.Client, session string, spec HighlightSpec) (applied, missing []string) {
	for _, pattern := range spec.Request {
		result, err := c.eval(ctx, client, session, requestHighlightScript(pattern, spec.Color))
		if err != nil {
			c.log.Warn("请求高亮失败", "pattern", pattern, "err", err)
			missing = append(missing, pattern)
			continue
		}
		if result == "ok" {
			applied = append(applied, "request:"+pattern)
		} else {
			missing = append(missing, "request:"+pattern+"("+result+")")
		}
	}
	for _, pattern := range spec.Response {
		result, err := c.eval(ctx, client, session, responseHighlightScript(pattern, spec.Color))
		if err != nil {
			c.log.Warn("响应高亮失败", "pattern", pattern, "err", err)
			missing = append(missing, pattern)
			continue
		}
		if result == "ok" {
			applied = append(applied, "response:"+pattern)
		} else {
			missing = append(missing, "response:"+pattern+"("+result+")")
		}
	}
	return applied, missing
}

// 用 JSON 编码片段，避免引号/反斜杠/中文在脚本里出问题。
func jsString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `""`
	}
	return string(encoded)
}

// infoToggleScript 按需展开/收起面板头上的取证详情弹层。
func infoToggleScript(expand bool) string {
	return fmt.Sprintf(`(async () => {
	  const btn = document.querySelector('[data-testid="evidence-info"]');
	  if (!btn) return 'no-info-button';
	  const open = btn.getAttribute('aria-expanded') === 'true';
	  if (%t !== open) btn.click();
	  await new Promise((r) => setTimeout(r, 250));
	  return 'ok';
	})()`, expand)
}

func requestHighlightScript(pattern, color string) string {
	return fmt.Sprintf(`(async () => {
	  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	  const ta = document.querySelector('[data-testid="repeater-request-editor"]');
	  if (!ta) return 'no-editor';
	  const value = ta.value || '';
	  const needle = %s;
	  const start = value.indexOf(needle);
	  if (start < 0) return 'not-found';
	  ta.focus();
	  ta.setSelectionRange(start, start + needle.length);
	  ta.dispatchEvent(new Event('select', { bubbles: true }));
	  ta.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
	  await sleep(300);
	  const dot = document.querySelector('[data-testid="highlight-color-%s"]');
	  if (!dot) return 'no-toolbar';
	  dot.click();
	  await sleep(300);
	  return 'ok';
	})()`, jsString(pattern), color)
}

func responseHighlightScript(pattern, color string) string {
	return fmt.Sprintf(`(async () => {
	  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	  const pre = document.querySelector('[data-testid="repeater-response-content"]');
	  if (!pre) return 'no-response';
	  const text = pre.textContent || '';
	  const needle = %s;
	  const start = text.indexOf(needle);
	  if (start < 0) return 'not-found';
	  const end = start + needle.length;
	  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
	  const range = document.createRange();
	  let acc = 0, node = walker.nextNode(), started = false, ended = false;
	  while (node) {
	    const len = (node.textContent || '').length;
	    if (!started && acc + len > start) { range.setStart(node, start - acc); started = true; }
	    if (started && !ended && acc + len >= end) { range.setEnd(node, end - acc); ended = true; break; }
	    acc += len;
	    node = walker.nextNode();
	  }
	  if (!started || !ended) return 'range-failed';
	  const sel = window.getSelection();
	  sel.removeAllRanges();
	  sel.addRange(range);
	  pre.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
	  await sleep(300);
	  const dot = document.querySelector('[data-testid="highlight-color-%s"]');
	  if (!dot) return 'no-toolbar';
	  dot.click();
	  await sleep(300);
	  return 'ok';
	})()`, jsString(pattern), color)
}

func (c *Capturer) ensureEvidenceVisible(ctx context.Context, client *cdp.Client, session string) error {
	script := `(() => {
	  const has = () => !!document.querySelector('[data-testid="evidence-panel"]');
	  if (has()) return 'visible';
	  const toggle = document.querySelector('[data-testid="evidence-toggle"]');
	  if (!toggle) return 'no-toggle';
	  toggle.click();
	  return has() ? 'shown' : 'clicked';
	})()`
	_, err := c.eval(ctx, client, session, script)
	return err
}

func (c *Capturer) waitFor(ctx context.Context, client *cdp.Client, session, selector string, timeoutMS int) (bool, error) {
	expr := fmt.Sprintf(`(async () => {
	  const deadline = Date.now() + %d;
	  while (Date.now() < deadline) {
	    if (document.querySelector(%q)) return true;
	    await new Promise((r) => setTimeout(r, 150));
	  }
	  return false;
	})()`, timeoutMS, selector)
	return c.waitForExpr(ctx, client, session, expr, timeoutMS)
}

func (c *Capturer) waitForExpr(ctx context.Context, client *cdp.Client, session, expr string, timeoutMS int) (bool, error) {
	deadline := time.Now().Add(time.Duration(timeoutMS)*time.Millisecond + 5*time.Second)
	for {
		var ok bool
		if err := c.evalJSON(ctx, client, session, expr, &ok); err == nil && ok {
			return true, nil
		}
		if time.Now().After(deadline) {
			return false, nil
		}
		select {
		case <-ctx.Done():
			return false, fmt.Errorf("capture: 等待超时: %w", ctx.Err())
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func (c *Capturer) eval(ctx context.Context, client *cdp.Client, session, expression string) (string, error) {
	var out string
	if err := c.evalJSON(ctx, client, session, expression, &out); err != nil {
		return "", err
	}
	return out, nil
}

func (c *Capturer) evalJSON(ctx context.Context, client *cdp.Client, session, expression string, out any) error {
	var res cdp.EvalResult
	if err := client.Call(ctx, session, "Runtime.evaluate", map[string]any{
		"expression": expression, "returnByValue": true, "awaitPromise": true,
	}, &res); err != nil {
		return err
	}
	if res.ExceptionDetails != nil {
		text := res.ExceptionDetails.Text
		if res.ExceptionDetails.Exception != nil {
			text = res.ExceptionDetails.Exception.Description
		}
		return fmt.Errorf("界面脚本异常: %s", text)
	}
	return res.UnmarshalValue(out)
}

// drainConsoleErrors 目前返回空（页面异常主要体现在 DOM 里）。
func (c *Capturer) drainConsoleErrors() []string { return nil }

func capture(ctx context.Context, client *cdp.Client, session string) ([]byte, error) {
	var shot cdp.ScreenshotResult
	if err := client.Call(ctx, session, "Page.captureScreenshot", map[string]any{
		"format": "png", "fromSurface": true,
	}, &shot); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(shot.Data)
}

func fillScript(spec Spec) string {
	host := spec.Host
	if spec.Port > 0 {
		host = net.JoinHostPort(spec.Host, fmt.Sprintf("%d", spec.Port))
	}
	return fmt.Sprintf(`(() => {
	  const setValue = (el, v) => {
	    if (!el) return false;
	    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
	    d.set.call(el, v);
	    el.dispatchEvent(new Event('input', { bubbles: true }));
	    return true;
	  };
	  const setSelect = (el, v) => {
	    if (!el) return false;
	    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
	    d.set.call(el, v);
	    el.dispatchEvent(new Event('change', { bubbles: true }));
	    return true;
	  };
	  const q = (s) => document.querySelector(s);
	  let steps = [];
	  steps.push('scheme:' + setSelect(q('[data-testid="repeater-scheme"]'), %q));
	  steps.push('host:' + setValue(q('[data-testid="repeater-host"]'), %q));
	  steps.push('raw:' + setValue(q('[data-testid="repeater-request-editor"]'), %q));
	  %s
	  return steps.join(' ');
	})()`, spec.Scheme, host, spec.Raw, scriptSelect(spec))
}

func scriptSelect(spec Spec) string {
	if spec.ScriptID == "" {
		return "steps.push('script:skipped');"
	}
	return fmt.Sprintf(`steps.push('script:' + setSelect(q('[data-testid="repeater-script"]'), %q));`, spec.ScriptID)
}

func evidenceScript(spec Spec) string {
	return fmt.Sprintf(`(() => {
	  const setValue = (el, v) => {
	    if (!el) return false;
	    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
	    d.set.call(el, v);
	    el.dispatchEvent(new Event('input', { bubbles: true }));
	    return true;
	  };
	  const setSelect = (el, v) => {
	    if (!el) return false;
	    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
	    d.set.call(el, v);
	    el.dispatchEvent(new Event('change', { bubbles: true }));
	    return true;
	  };
	  const q = (s) => document.querySelector(s);
	  if (%q !== '') setValue(q('[data-testid="evidence-url"]'), %q);
	  if (%q !== '') setSelect(q('[data-testid="evidence-auto"]'), %q);
	  if (%q !== '') setSelect(q('[data-testid="evidence-mode-select"]'), %q);
	  const refresh = q('[data-testid="evidence-refresh"]');
	  if (refresh) refresh.click();
	  return 'ok';
	})()`, spec.EvidenceURL, spec.EvidenceURL, spec.EvidenceAuto, spec.EvidenceAuto,
		spec.EvidenceMode, spec.EvidenceMode)
}

func readScript(includeContent bool) string {
	body := "''"
	if includeContent {
		body = "((document.querySelector('[data-testid=\"repeater-response-content\"]') || {}).innerText || '')"
	}
	return fmt.Sprintf(`(() => {
	  const t = (s) => { const el = document.querySelector(s); return el ? el.innerText : ''; };
	  const v = (s) => { const el = document.querySelector(s); return el && 'value' in el ? el.value : ''; };
	  return {
	    statusLine: t('[data-testid="repeater-status"]'),
	    headers: t('[data-testid="repeater-response-headers"]'),
	    body: %s,
	    evidenceMode: t('[data-testid="evidence-mode"]'),
	    evidenceWatermark: (() => {
	      const info = document.querySelector('[data-testid="evidence-info"]');
	      if (info) {
	        const summary = info.getAttribute('data-summary') || '';
	        if (summary) return summary;
	      }
	      const hidden = document.querySelector('[data-testid="evidence-watermark"]');
	      return hidden ? hidden.textContent || '' : '';
	    })(),
	    request: v('[data-testid="repeater-request-editor"]'),
	    target: t('[data-testid="repeater-target"]'),
	    sendError: t('[data-testid="repeater-error"]')
	  };
	})()`, body)
}
