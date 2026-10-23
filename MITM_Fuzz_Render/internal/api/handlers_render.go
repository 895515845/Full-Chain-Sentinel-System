package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/chinaran404/replayd/internal/cdp"
	"github.com/chinaran404/replayd/internal/httpreplay"
	"github.com/chinaran404/replayd/internal/render"
	"github.com/chinaran404/replayd/internal/store"
)

/* -------------------------------------------------------------------------- */
/* 任务登记表（内存，产物才落盘）                                              */
/* -------------------------------------------------------------------------- */

const renderJobPrefix = "rjob_"
const maxRenderJobs = 100

type renderJob struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"`   // render | install
	Status     string          `json:"status"` // pending | running | done | error
	URL        string          `json:"url,omitempty"`
	CreatedAt  int64           `json:"createdAt"`
	StartedAt  int64           `json:"startedAt,omitempty"`
	FinishedAt int64           `json:"finishedAt,omitempty"`
	Progress   []string        `json:"progress,omitempty"`
	Result     *renderResponse `json:"result,omitempty"`
	Error      string          `json:"error,omitempty"`
}

type jobRegistry struct {
	mu    sync.Mutex
	seq   int64
	items map[string]*renderJob
	order []string
}

func newJobRegistry() *jobRegistry {
	return &jobRegistry{items: make(map[string]*renderJob)}
}

func (r *jobRegistry) create(kind, target string) *renderJob {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	job := &renderJob{
		ID:        fmt.Sprintf("%s%d_%d", renderJobPrefix, time.Now().UnixNano(), r.seq),
		Kind:      kind,
		Status:    "pending",
		URL:       target,
		CreatedAt: time.Now().UnixMilli(),
	}
	r.items[job.ID] = job
	r.order = append(r.order, job.ID)
	for len(r.order) > maxRenderJobs {
		oldest := r.order[0]
		r.order = r.order[1:]
		delete(r.items, oldest)
	}
	return job
}

func (r *jobRegistry) update(id string, fn func(*renderJob)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if job, ok := r.items[id]; ok {
		fn(job)
	}
}

func (r *jobRegistry) get(id string) (*renderJob, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	job, ok := r.items[id]
	if !ok {
		return nil, false
	}
	snapshot := *job
	if job.Progress != nil {
		snapshot.Progress = append([]string{}, job.Progress...)
	}
	return &snapshot, true
}

func (r *jobRegistry) list(limit int) []*renderJob {
	r.mu.Lock()
	defer r.mu.Unlock()
	if limit <= 0 || limit > maxRenderJobs {
		limit = 20
	}
	out := make([]*renderJob, 0, limit)
	for i := len(r.order) - 1; i >= 0 && len(out) < limit; i-- {
		if job, ok := r.items[r.order[i]]; ok {
			out = append(out, job)
		}
	}
	return out
}

func (r *jobRegistry) active() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, job := range r.items {
		if job.Status == "pending" || job.Status == "running" {
			n++
		}
	}
	return n
}

/* -------------------------------------------------------------------------- */
/* 请求/响应模型                                                               */
/* -------------------------------------------------------------------------- */

type renderRequest struct {
	URL          string  `json:"url"`
	Width        int     `json:"width"`
	Height       int     `json:"height"`
	FullPage     *bool   `json:"fullPage,omitempty"`
	WaitUntil    string  `json:"waitUntil,omitempty"`
	TimeoutMS    int     `json:"timeoutMs,omitempty"`
	TextLimit    int     `json:"textLimit,omitempty"`
	Scale        float64 `json:"scale,omitempty"`
	NoScreenshot bool    `json:"noScreenshot,omitempty"`
	NoA11y       bool    `json:"noA11y,omitempty"`

	// ViaProxy：经 replayd 自己的 MITM 代理渲染，子请求会被抓包（需代理已启动）
	ViaProxy *bool `json:"viaProxy,omitempty"`
	// ProxyURL：自定义上游代理（优先级高于 ViaProxy）
	ProxyURL string `json:"proxyUrl,omitempty"`

	Async  bool  `json:"async,omitempty"`
	Record *bool `json:"record,omitempty"` // 默认 true：记入抓包历史
}

type artifactView struct {
	ArtifactID  string `json:"artifactId"`
	URL         string `json:"url"`
	Kind        string `json:"kind"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
}

type renderResponse struct {
	JobID         string                  `json:"jobId,omitempty"`
	Status        string                  `json:"status"`
	URL           string                  `json:"url"`
	FinalURL      string                  `json:"finalUrl"`
	Title         string                  `json:"title"`
	NavStatus     int                     `json:"navStatus"`
	Text          string                  `json:"text,omitempty"`
	TextTruncated bool                    `json:"textTruncated,omitempty"`
	A11y          []cdp.AXNode            `json:"a11y,omitempty"`
	Screenshots   map[string]artifactView `json:"screenshots,omitempty"`
	Timings       render.Timings          `json:"timings"`
	FlowID        string                  `json:"flowId,omitempty"`
	Width         int                     `json:"width,omitempty"`
	Height        int                     `json:"height,omitempty"`
	ContentHeight int                     `json:"contentHeight,omitempty"`
	Error         *httpreplay.Error       `json:"error,omitempty"`
}

/* -------------------------------------------------------------------------- */
/* 处理器                                                                      */
/* -------------------------------------------------------------------------- */

// handleRender 渲染一个 URL。默认同步返回；async=true 时返回 jobId 轮询。
func (s *Server) handleRender(w http.ResponseWriter, r *http.Request) {
	var in renderRequest
	if err := decodeJSONBody(r, &in); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法: "+err.Error(), nil)
		return
	}
	if strings.TrimSpace(in.URL) == "" {
		s.writeError(w, http.StatusBadRequest, "bad_request", "url 不能为空", nil)
		return
	}
	if s.render == nil || s.browser == nil {
		s.writeError(w, http.StatusNotImplemented, "unsupported", "本实例未启用渲染（浏览器管理器未初始化）", nil)
		return
	}

	spec, proxyURL, err := s.renderSpec(in)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", err.Error(), nil)
		return
	}

	if in.Async {
		job := s.jobs.create("render", in.URL)
		s.jobs.update(job.ID, func(j *renderJob) { j.Status = "running"; j.StartedAt = time.Now().UnixMilli() })
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(spec.TimeoutMS)*time.Millisecond+30*time.Second)
			defer cancel()
			out, _ := s.runRender(ctx, in, spec, proxyURL, job.ID)
			s.jobs.update(job.ID, func(j *renderJob) {
				j.FinishedAt = time.Now().UnixMilli()
				if out.Error != nil {
					j.Status = "error"
					j.Error = out.Error.Message
				} else {
					j.Status = "done"
				}
				j.Result = out
			})
		}()
		s.writeJSON(w, http.StatusAccepted, map[string]any{
			"jobId": job.ID, "status": "running", "poll": "/api/render/jobs/" + job.ID,
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(spec.TimeoutMS)*time.Millisecond+30*time.Second)
	defer cancel()
	out, _ := s.runRender(ctx, in, spec, proxyURL, "")
	s.writeJSON(w, http.StatusOK, out)
}

// renderSpec 把 API 参数翻译成渲染参数。
func (s *Server) renderSpec(in renderRequest) (render.Spec, string, error) {
	raw := strings.TrimSpace(in.URL)
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return render.Spec{}, "", fmt.Errorf("url 不合法: %s", in.URL)
	}
	if scheme := strings.ToLower(parsed.Scheme); scheme != "http" && scheme != "https" {
		return render.Spec{}, "", fmt.Errorf("只支持 http/https，收到 %s", parsed.Scheme)
	}
	if in.WaitUntil != "" && in.WaitUntil != "load" && in.WaitUntil != "networkidle" {
		return render.Spec{}, "", fmt.Errorf("waitUntil 只支持 load | networkidle，收到 %s", in.WaitUntil)
	}

	spec := render.Spec{
		URL:          raw,
		Width:        in.Width,
		Height:       in.Height,
		FullPage:     in.FullPage,
		WaitUntil:    in.WaitUntil,
		TimeoutMS:    in.TimeoutMS,
		TextLimit:    in.TextLimit,
		Scale:        in.Scale,
		NoScreenshot: in.NoScreenshot,
		NoA11y:       in.NoA11y,
	}
	proxyURL := strings.TrimSpace(in.ProxyURL)
	if proxyURL == "" && in.ViaProxy != nil && *in.ViaProxy {
		if s.proxy == nil || !s.proxy.Status().Running {
			return spec, "", errors.New("viaProxy=true 需要先启动 MITM 代理（POST /api/proxy/start）")
		}
		listen := s.proxy.Status().Listen
		if listen == "" {
			listen = s.cfg.ProxyListen
		}
		proxyURL = "http://" + listen
	}
	spec.ViaProxy = proxyURL
	return spec, proxyURL, nil
}

// runRender 执行渲染、落产物、按需记入历史。
func (s *Server) runRender(ctx context.Context, in renderRequest, spec render.Spec, proxyURL, jobID string) (*renderResponse, *render.Result) {
	out := &renderResponse{JobID: jobID, Status: "done", URL: in.URL}

	res, err := s.render.Render(ctx, spec)
	if err != nil {
		code := "render_failed"
		if errors.Is(err, context.DeadlineExceeded) {
			code = "timeout"
		}
		out.Status = "error"
		out.Error = &httpreplay.Error{Code: code, Message: err.Error()}
		return out, nil
	}

	out.FinalURL = res.FinalURL
	out.Title = res.Title
	out.NavStatus = res.NavStatus
	out.Text = res.Text
	out.TextTruncated = res.TextTruncated
	out.A11y = res.A11y
	out.Timings = res.Timings
	out.Width = res.Width
	out.Height = res.Height
	out.ContentHeight = res.ContentHeight

	meta, _ := json.Marshal(map[string]any{
		"url": res.URL, "finalUrl": res.FinalURL, "title": res.Title,
		"width": res.Width, "height": res.Height, "contentHeight": res.ContentHeight,
		"viaProxy": proxyURL,
	})
	shots := map[string]artifactView{}
	save := func(kind string, data []byte, width, height int) {
		if len(data) == 0 {
			return
		}
		view, err := s.saveArtifact(ctx, jobID, kind, "image/png", data, meta)
		if err != nil {
			s.log.Warn("保存截图失败", "kind", kind, "err", err)
			return
		}
		view2 := view
		view2.Size = int64(len(data))
		_ = width
		_ = height
		key := "viewport"
		if kind == store.ArtifactScreenshotFull {
			key = "full"
		}
		shots[key] = view2
	}
	save(store.ArtifactScreenshotViewport, res.ViewportPNG, res.Width, res.Height)
	save(store.ArtifactScreenshotFull, res.FullPNG, res.Width, res.ContentHeight)
	if len(shots) > 0 {
		out.Screenshots = shots
	}

	if in.Record == nil || *in.Record {
		out.FlowID = s.recordRenderFlow(ctx, res, proxyURL)
	}
	return out, res
}

// saveArtifact 写入产物并给出可下载地址。
func (s *Server) saveArtifact(ctx context.Context, jobID, kind, contentType string, data []byte, meta []byte) (artifactView, error) {
	art := &store.Artifact{JobID: jobID, Kind: kind, ContentType: contentType, Meta: meta}
	saveCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := s.store.InsertArtifact(saveCtx, art, data); err != nil {
		return artifactView{}, err
	}
	return artifactView{
		ArtifactID:  art.ID,
		URL:         "/api/artifacts/" + art.ID,
		Kind:        art.Kind,
		ContentType: art.ContentType,
		Size:        art.Size,
	}, nil
}

// recordRenderFlow 把"Agent 渲染了某页"记成一条 flow（note 前缀 render:）。
func (s *Server) recordRenderFlow(ctx context.Context, res *render.Result, proxyURL string) string {
	parsed, err := url.Parse(res.FinalURL)
	if err != nil || parsed.Host == "" {
		return ""
	}
	port := 80
	scheme := strings.ToLower(parsed.Scheme)
	if scheme == "https" {
		port = 443
	}
	if p := parsed.Port(); p != "" {
		if n, perr := strconv.Atoi(p); perr == nil {
			port = n
		}
	}
	path := parsed.Path
	if path == "" {
		path = "/"
	}
	reqRaw := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: replayd-render\r\nConnection: close\r\n\r\n",
		parsed.RequestURI(), parsed.Host)
	status := res.NavStatus
	duration := res.Timings.TotalMS
	note := "render: " + res.URL
	if proxyURL != "" {
		note += " · via " + proxyURL
	}
	flow := &store.Flow{
		Source:      "replay",
		Method:      "GET",
		Scheme:      scheme,
		Host:        parsed.Hostname(),
		Port:        port,
		Path:        path,
		Query:       parsed.RawQuery,
		HTTPVersion: "HTTP/1.1",
		ReqHeaders:  []store.Header{{N: "Host", V: parsed.Host}},
		ReqRaw:      []byte(reqRaw),
		Status:      &status,
		RespBody:    []byte(res.Text),
		RespSize:    int64(len(res.Text)),
		Note:        note,
		DurationMS:  &duration,
	}
	saveCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := s.store.InsertFlow(saveCtx, flow); err != nil {
		s.log.Warn("渲染记入历史失败", "err", err)
		return ""
	}
	s.bus.Publish("flow.new", map[string]any{
		"id": flow.ID, "source": "replay", "method": "GET",
		"scheme": flow.Scheme, "host": flow.Host, "port": flow.Port,
		"path": flow.Path, "status": status, "ts": flow.TS,
		"durationMs": duration, "render": true,
	})
	return flow.ID
}

/* -------------------------------------------------------------------------- */
/* 任务与状态查询                                                              */
/* -------------------------------------------------------------------------- */

func (s *Server) handleRenderJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.jobs.get(chi.URLParam(r, "id"))
	if !ok {
		s.writeError(w, http.StatusNotFound, "not_found", "任务不存在或已被淘汰（仅保留最近 100 个）", nil)
		return
	}
	s.writeJSON(w, http.StatusOK, job)
}

func (s *Server) handleRenderJobs(w http.ResponseWriter, r *http.Request) {
	limit := atoiDefault(r.URL.Query().Get("limit"), 20)
	s.writeJSON(w, http.StatusOK, map[string]any{"items": s.jobs.list(limit)})
}

type renderStatusResponse struct {
	Browser   map[string]any `json:"browser"`
	Renderer  bool           `json:"rendererReady"`
	ActiveJob int            `json:"activeJobs"`
	Artifacts struct {
		Count int64 `json:"count"`
		Bytes int64 `json:"bytes"`
	} `json:"artifacts"`
	Hint string `json:"hint,omitempty"`
}

func (s *Server) handleRenderStatus(w http.ResponseWriter, r *http.Request) {
	var out renderStatusResponse
	if s.browser != nil {
		st := s.browser.Status()
		out.Browser = map[string]any{
			"available":      st.Available,
			"source":         st.Source,
			"path":           st.Path,
			"running":        st.Running,
			"version":        st.Version,
			"idleSeconds":    st.IdleSeconds,
			"activeContexts": st.ActiveContext,
		}
		if !st.Available {
			out.Hint = "本机没有可用浏览器：设置 REPLAYD_CHROME_PATH，或 POST /api/render/browser/install 自动下载 chromium-headless-shell"
		}
	} else {
		out.Browser = map[string]any{"available": false}
		out.Hint = "本实例未启用渲染"
	}
	out.Renderer = s.render != nil
	out.ActiveJob = s.jobs.active()
	if count, bytes, err := s.store.CountArtifacts(r.Context()); err == nil {
		out.Artifacts.Count = count
		out.Artifacts.Bytes = bytes
	}
	s.writeJSON(w, http.StatusOK, out)
}

// handleBrowserInstall 下载浏览器（默认异步，进度写进任务）。
func (s *Server) handleBrowserInstall(w http.ResponseWriter, r *http.Request) {
	if s.browser == nil {
		s.writeError(w, http.StatusNotImplemented, "unsupported", "本实例未启用渲染", nil)
		return
	}
	var in struct {
		Async bool `json:"async"`
	}
	_ = decodeJSONBody(r, &in)

	if !in.Async {
		in.Async = true // 下载可能上百 MB，默认异步更稳
	}
	job := s.jobs.create("install", "")
	s.jobs.update(job.ID, func(j *renderJob) { j.Status = "running"; j.StartedAt = time.Now().UnixMilli() })
	go func() {
		progress := func(msg string) {
			s.jobs.update(job.ID, func(j *renderJob) {
				j.Progress = append(j.Progress, msg)
				if len(j.Progress) > 200 {
					j.Progress = j.Progress[len(j.Progress)-200:]
				}
			})
		}
		path, err := s.browser.Install(context.Background(), progress)
		s.jobs.update(job.ID, func(j *renderJob) {
			j.FinishedAt = time.Now().UnixMilli()
			if err != nil {
				j.Status = "error"
				j.Error = err.Error()
				return
			}
			j.Status = "done"
			j.Progress = append(j.Progress, "可用浏览器："+path)
		})
	}()
	s.writeJSON(w, http.StatusAccepted, map[string]any{
		"jobId": job.ID, "status": "running", "poll": "/api/render/jobs/" + job.ID,
	})
}

/* -------------------------------------------------------------------------- */
/* 产物端点                                                                    */
/* -------------------------------------------------------------------------- */

func (s *Server) handleListArtifacts(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListArtifacts(r.Context(), r.URL.Query().Get("kind"), atoiDefault(r.URL.Query().Get("limit"), 50))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "读取产物列表失败", nil)
		return
	}
	if items == nil {
		items = []*store.Artifact{}
	}
	views := make([]map[string]any, 0, len(items))
	for _, item := range items {
		views = append(views, map[string]any{
			"id": item.ID, "jobId": item.JobID, "kind": item.Kind,
			"contentType": item.ContentType, "size": item.Size,
			"url": "/api/artifacts/" + item.ID, "createdAt": item.CreatedAt,
			"meta": item.Meta,
		})
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"items": views})
}

func (s *Server) handleGetArtifact(w http.ResponseWriter, r *http.Request) {
	art, data, err := s.store.GetArtifact(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "产物不存在", nil)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "读取产物失败", nil)
		return
	}
	w.Header().Set("Content-Type", art.ContentType)
	w.Header().Set("Content-Length", strconv.FormatInt(int64(len(data)), 10))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s%s"`, art.ID, extensionFor(art.ContentType)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) handleDeleteArtifact(w http.ResponseWriter, r *http.Request) {
	err := s.store.DeleteArtifact(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "产物不存在", nil)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "删除产物失败", nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func extensionFor(contentType string) string {
	switch {
	case strings.Contains(contentType, "png"):
		return ".png"
	case strings.Contains(contentType, "json"):
		return ".json"
	case strings.Contains(contentType, "html"):
		return ".html"
	default:
		return ".txt"
	}
}
