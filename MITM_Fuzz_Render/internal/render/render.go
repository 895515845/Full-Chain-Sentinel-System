// Package render 用无头浏览器渲染一个 URL，产出 Agent 可消费的结果：
// 整页/视口 PNG、可读文本、无障碍树。
//
// 实现要点：
//   - 每个任务一个独立 BrowserContext（隔离 cookie/缓存），可整体走 MITM 代理；
//   - 等待策略用轮询（document.readyState + 资源数稳定）而不是事件订阅，
//     避免长连接上事件处理器反复注册造成泄漏；
//   - 主文档 HTTP 状态来自 PerformanceNavigationTiming.responseStatus。
package render

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/chinaran404/replayd/internal/browser"
	"github.com/chinaran404/replayd/internal/cdp"
)

const (
	defaultWidth     = 1440
	defaultHeight    = 900
	defaultTimeout   = 30 * time.Second
	maxContentHeight = 16000 // 整页截图的高度上限，防止超大页面打爆内存
	pollInterval     = 150 * time.Millisecond
	networkIdleQuiet = 750 * time.Millisecond
)

// Spec 是一次渲染请求。
type Spec struct {
	URL          string  `json:"url"`
	Width        int     `json:"width"`
	Height       int     `json:"height"`
	FullPage     *bool   `json:"fullPage,omitempty"`
	WaitUntil    string  `json:"waitUntil,omitempty"` // load | networkidle（默认 load）
	TimeoutMS    int     `json:"timeoutMs,omitempty"`
	ViaProxy     string  `json:"viaProxy,omitempty"` // 例如 http://127.0.0.1:8898
	TextLimit    int     `json:"textLimit,omitempty"`
	Scale        float64 `json:"scale,omitempty"`
	NoScreenshot bool    `json:"noScreenshot,omitempty"`
	NoA11y       bool    `json:"noA11y,omitempty"`
}

// Timings 记录各阶段耗时（毫秒）。
type Timings struct {
	ContextMS int64 `json:"contextMs"`
	NavMS     int64 `json:"navMs"`
	WaitMS    int64 `json:"waitMs"`
	CaptureMS int64 `json:"captureMs"`
	TotalMS   int64 `json:"totalMs"`
}

// Result 是一次渲染的产物。
type Result struct {
	URL           string       `json:"url"`
	FinalURL      string       `json:"finalUrl"`
	Title         string       `json:"title"`
	NavStatus     int          `json:"navStatus"`
	Text          string       `json:"text"`
	TextTruncated bool         `json:"textTruncated,omitempty"`
	A11y          []cdp.AXNode `json:"a11y,omitempty"`
	ViewportPNG   []byte       `json:"-"`
	FullPNG       []byte       `json:"-"`
	Width         int          `json:"width"`
	Height        int          `json:"height"`
	ContentHeight int          `json:"contentHeight"`
	Timings       Timings      `json:"timings"`
}

// Renderer 复用同一个浏览器管理器。
type Renderer struct {
	manager *browser.Manager
	log     *slog.Logger
}

// New 创建渲染器。
func New(manager *browser.Manager, log *slog.Logger) *Renderer {
	if log == nil {
		log = slog.Default()
	}
	return &Renderer{manager: manager, log: log}
}

// Manager 暴露底层浏览器管理器（用于状态查询与安装）。
func (r *Renderer) Manager() *browser.Manager { return r.manager }

func (s *Spec) applyDefaults() error {
	s.URL = strings.TrimSpace(s.URL)
	if s.URL == "" {
		return errors.New("render: url 不能为空")
	}
	if !strings.Contains(s.URL, "://") {
		s.URL = "https://" + s.URL
	}
	parsed, err := url.Parse(s.URL)
	if err != nil || parsed.Host == "" {
		return fmt.Errorf("render: url 不合法: %s", s.URL)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("render: 只支持 http/https，收到 %s", parsed.Scheme)
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
	if s.Scale <= 0 {
		s.Scale = 1
	}
	if s.WaitUntil == "" {
		s.WaitUntil = "load"
	}
	if s.WaitUntil != "load" && s.WaitUntil != "networkidle" {
		return fmt.Errorf("render: waitUntil 只支持 load | networkidle，收到 %s", s.WaitUntil)
	}
	if s.TimeoutMS <= 0 {
		s.TimeoutMS = int(defaultTimeout / time.Millisecond)
	}
	if s.TextLimit <= 0 {
		s.TextLimit = 200_000
	}
	return nil
}

// Render 渲染一个页面。
func (r *Renderer) Render(ctx context.Context, spec Spec) (*Result, error) {
	if err := spec.applyDefaults(); err != nil {
		return nil, err
	}
	start := time.Now()
	timeout := time.Duration(spec.TimeoutMS) * time.Millisecond
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	client, err := r.manager.Client(ctx)
	if err != nil {
		return nil, err
	}

	// ---- 独立的浏览器上下文 ----
	tContext := time.Now()
	contextID, err := r.manager.NewContext(ctx, spec.ViaProxy)
	if err != nil {
		return nil, err
	}
	defer r.manager.DisposeContext(context.Background(), contextID)

	// ---- 建标签页并挂上 flat 会话 ----
	var target cdp.CreateTargetResult
	if err := client.Call(ctx, "", "Target.createTarget",
		map[string]any{"url": "about:blank", "browserContextId": contextID}, &target); err != nil {
		return nil, fmt.Errorf("render: 创建标签页失败: %w", err)
	}
	defer func() {
		_ = client.Call(context.Background(), "", "Target.closeTarget",
			map[string]any{"targetId": target.TargetID}, nil)
	}()

	var attached cdp.AttachResult
	if err := client.Call(ctx, "", "Target.attachToTarget",
		map[string]any{"targetId": target.TargetID, "flatten": true}, &attached); err != nil {
		return nil, fmt.Errorf("render: 附加到标签页失败: %w", err)
	}
	session := attached.SessionID

	for _, domain := range []string{"Page.enable", "Runtime.enable"} {
		if err := client.Call(ctx, session, domain, nil, nil); err != nil {
			return nil, fmt.Errorf("render: %s 失败: %w", domain, err)
		}
	}
	metrics := map[string]any{
		"width": spec.Width, "height": spec.Height,
		"deviceScaleFactor": spec.Scale, "mobile": false,
	}
	if err := client.Call(ctx, session, "Emulation.setDeviceMetricsOverride", metrics, nil); err != nil {
		return nil, fmt.Errorf("render: 设置视口失败: %w", err)
	}
	result := &Result{URL: spec.URL, Width: spec.Width, Height: spec.Height}
	result.Timings.ContextMS = msSince(tContext)

	// ---- 导航 ----
	tNav := time.Now()
	var nav struct {
		FrameID   string `json:"frameId"`
		ErrorText string `json:"errorText"`
	}
	if err := client.Call(ctx, session, "Page.navigate",
		map[string]any{"url": spec.URL}, &nav); err != nil {
		return nil, fmt.Errorf("render: 导航失败: %w", err)
	}
	if nav.ErrorText != "" {
		return nil, fmt.Errorf("render: 无法打开页面: %s", nav.ErrorText)
	}

	// ---- 等待加载 / 网络空闲 ----
	tWait := time.Now()
	if err := r.waitReady(ctx, client, session, spec.WaitUntil); err != nil {
		// 超时也尽量把当前页面状态取回来（部分站点长连接会导致永不 idle）
		r.log.Warn("等待页面就绪超时，返回当前状态", "url", spec.URL, "err", err)
	}
	result.Timings.NavMS = msSince(tNav)
	result.Timings.WaitMS = msSince(tWait)

	// ---- 取文本与元信息 ----
	var meta struct {
		Title     string `json:"title"`
		Href      string `json:"href"`
		Text      string `json:"text"`
		NavStatus int    `json:"navStatus"`
	}
	const metaExpr = `(() => {
	  const nav = (performance.getEntriesByType('navigation') || [])[0] || {};
	  return {
	    title: document.title || '',
	    href: location.href,
	    text: document.body ? document.body.innerText : '',
	    navStatus: nav.responseStatus || 0
	  };
	})()`
	if err := evalJSON(ctx, client, session, metaExpr, &meta); err != nil {
		r.log.Warn("读取页面文本失败", "err", err)
	}
	result.Title = meta.Title
	result.FinalURL = meta.Href
	result.NavStatus = meta.NavStatus
	if len(meta.Text) > spec.TextLimit {
		result.Text = meta.Text[:spec.TextLimit]
		result.TextTruncated = true
	} else {
		result.Text = meta.Text
	}

	// ---- 无障碍树 ----
	if !spec.NoA11y {
		var tree cdp.AXTreeResult
		if err := client.Call(ctx, session, "Accessibility.getFullAXTree", nil, &tree); err != nil {
			r.log.Warn("读取无障碍树失败", "err", err)
		} else {
			result.A11y = tree.Flatten(300)
		}
	}

	// ---- 截图 ----
	tCapture := time.Now()
	if !spec.NoScreenshot {
		viewportPNG, err := capture(ctx, client, session)
		if err != nil {
			return nil, fmt.Errorf("render: 视口截图失败: %w", err)
		}
		result.ViewportPNG = viewportPNG

		fullPage := true
		if spec.FullPage != nil {
			fullPage = *spec.FullPage
		}
		if fullPage {
			var layout cdp.LayoutMetrics
			if err := client.Call(ctx, session, "Page.getLayoutMetrics", nil, &layout); err != nil {
				r.log.Warn("读取页面尺寸失败", "err", err)
			}
			contentHeight := int(layout.CSSContentSize.Height)
			if contentHeight <= 0 {
				contentHeight = spec.Height
			}
			result.ContentHeight = contentHeight

			captureHeight := contentHeight
			if captureHeight > maxContentHeight {
				captureHeight = maxContentHeight
			}
			// headless 下最稳的整页截法：把视口拉高到内容高度再截，最后恢复
			tall := map[string]any{
				"width": spec.Width, "height": captureHeight,
				"deviceScaleFactor": spec.Scale, "mobile": false,
			}
			if err := client.Call(ctx, session, "Emulation.setDeviceMetricsOverride", tall, nil); err == nil {
				if fullPNG, cerr := capture(ctx, client, session); cerr == nil {
					result.FullPNG = fullPNG
				} else {
					r.log.Warn("整页截图失败，已跳过", "err", cerr)
				}
				_ = client.Call(ctx, session, "Emulation.setDeviceMetricsOverride", metrics, nil)
			}
		}
	}
	result.Timings.CaptureMS = msSince(tCapture)
	result.Timings.TotalMS = msSince(start)
	return result, nil
}

// waitReady 轮询页面就绪状态。
func (r *Renderer) waitReady(ctx context.Context, client *cdp.Client, session, waitUntil string) error {
	const stateExpr = `(() => {
	  const res = performance.getEntriesByType('resource') || [];
	  return { readyState: document.readyState, resources: res.length };
	})()`

	lastResources := -1
	stableSince := time.Now()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("等待页面就绪超时: %w", ctx.Err())
		default:
		}

		var state struct {
			ReadyState string `json:"readyState"`
			Resources  int    `json:"resources"`
		}
		if err := evalJSON(ctx, client, session, stateExpr, &state); err == nil {
			if state.ReadyState == "complete" {
				if waitUntil != "networkidle" {
					return nil
				}
				if state.Resources != lastResources {
					lastResources = state.Resources
					stableSince = time.Now()
				} else if time.Since(stableSince) >= networkIdleQuiet {
					return nil
				}
			} else {
				stableSince = time.Now()
			}
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("等待页面就绪超时: %w", ctx.Err())
		case <-time.After(pollInterval):
		}
	}
}

// capture 截取当前视口（整页由调用方先把视口拉高实现）。
func capture(ctx context.Context, client *cdp.Client, session string) ([]byte, error) {
	var shot cdp.ScreenshotResult
	if err := client.Call(ctx, session, "Page.captureScreenshot", map[string]any{
		"format":      "png",
		"fromSurface": true,
	}, &shot); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(shot.Data)
}

func evalJSON(ctx context.Context, client *cdp.Client, session, expression string, out any) error {
	var res cdp.EvalResult
	if err := client.Call(ctx, session, "Runtime.evaluate", map[string]any{
		"expression":    expression,
		"returnByValue": true,
		"awaitPromise":  true,
	}, &res); err != nil {
		return err
	}
	if res.ExceptionDetails != nil {
		desc := res.ExceptionDetails.Text
		if res.ExceptionDetails.Exception != nil {
			desc = res.ExceptionDetails.Exception.Description
		}
		return fmt.Errorf("页面脚本异常: %s", desc)
	}
	return res.UnmarshalValue(out)
}

func msSince(t time.Time) int64 { return time.Since(t).Milliseconds() }
