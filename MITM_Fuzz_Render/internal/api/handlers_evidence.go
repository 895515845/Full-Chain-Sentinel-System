package api

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/chinaran404/replayd/internal/evidence"
	"github.com/chinaran404/replayd/internal/httpreplay"
)

// evidenceNotePrefix 让历史列表能识别"这条 flow 是取证抓取"。
const evidenceNotePrefix = "evidence: "

// evidenceSource 是预设的时间源。
type evidenceSource struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	URL   string `json:"url"`
	Note  string `json:"note,omitempty"`
}

func evidenceSources() []evidenceSource {
	return []evidenceSource{
		{Key: "beijing-time", Label: "beijing-time.org（北京时间）", URL: "https://www.beijing-time.org/", Note: "允许内嵌"},
		{Key: "bjtime", Label: "bjtime.cn（北京时间）", URL: "https://bjtime.cn/", Note: "允许内嵌"},
		{Key: "timeis", Label: "time.is/Beijing", URL: "https://time.is/Beijing", Note: "拒绝内嵌 → 服务端快照"},
		{Key: "ntsc", Label: "国家授时中心 ntsc.ac.cn", URL: "https://www.ntsc.ac.cn/", Note: "拒绝内嵌 → 服务端快照"},
		{Key: "timeapi", Label: "timeapi.io（Asia/Shanghai JSON）", URL: "https://timeapi.io/api/Time/current/zone?timeZone=Asia/Shanghai", Note: "JSON 文本"},
	}
}

type evidenceResponse struct {
	Mode        string             `json:"mode"` // direct | snapshot | error
	URL         string             `json:"url"`
	Reason      string             `json:"reason,omitempty"`
	Status      int                `json:"status,omitempty"`
	ContentType string             `json:"contentType,omitempty"`
	Size        int                `json:"size,omitempty"`
	FetchedAt   string             `json:"fetchedAt"`
	LocalTime   string             `json:"localTime"`
	LocalZone   string             `json:"localZone"`
	FlowID      string             `json:"flowId,omitempty"`
	SnapshotID  string             `json:"snapshotId,omitempty"`
	SnapshotURL string             `json:"snapshotUrl,omitempty"`
	Truncated   bool               `json:"truncated,omitempty"`
	Timings     httpreplay.Timings `json:"timings"`
	Error       *httpreplay.Error  `json:"error,omitempty"`
}

// handleEvidenceSources 返回预设时间源（Agent 也可读取）。
func (s *Server) handleEvidenceSources(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]any{"items": evidenceSources()})
}

// handleEvidence 抓取取证页面：
//   - mode=auto（默认）：目标允许内嵌 → direct（前端用真实 iframe 指向原站）；
//     否则服务端抓一次并改写成同源快照，返回 snapshotUrl；
//   - 无论哪种模式，抓取动作都会记入抓包历史（note 前缀 evidence:）。
func (s *Server) handleEvidence(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rawURL := strings.TrimSpace(q.Get("url"))
	if rawURL == "" {
		s.writeError(w, http.StatusBadRequest, "bad_request", "缺少 url 参数", nil)
		return
	}
	if !strings.Contains(rawURL, "://") {
		rawURL = "https://" + rawURL
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		s.writeError(w, http.StatusBadRequest, "bad_request", "url 不合法: "+rawURL, nil)
		return
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		s.writeError(w, http.StatusBadRequest, "bad_request", "只支持 http/https", nil)
		return
	}
	port := 0
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
	target := httpreplay.Target{Scheme: scheme, Host: parsed.Hostname(), Port: port}

	mode := strings.ToLower(strings.TrimSpace(q.Get("mode")))
	if mode == "" {
		mode = "auto"
	}
	allowScripts := q.Get("allowScripts") == "1" || strings.EqualFold(q.Get("allowScripts"), "true")
	insecure := q.Get("insecure") == "1" || strings.EqualFold(q.Get("insecure"), "true")
	record := q.Get("record") != "0"

	now := time.Now()
	out := evidenceResponse{
		URL:       parsed.String(),
		FetchedAt: now.Format(time.RFC3339),
		LocalTime: now.Format("2006-01-02 15:04:05"),
		LocalZone: now.Format("MST"),
	}

	path := parsed.RequestURI()
	if path == "" {
		path = "/"
	}
	raw := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + evidenceHostHeader(target) + "\r\n" +
		"User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36\r\n" +
		"Accept: text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8\r\n" +
		"Accept-Language: zh-CN,zh;q=0.9,en;q=0.8\r\n" +
		"Connection: close\r\n\r\n"

	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()

	res := s.replay.Send(ctx, []byte(raw), httpreplay.Options{
		FallbackURL: scheme + "://" + net.JoinHostPort(target.Host, strconv.Itoa(target.Port)),
		InsecureTLS: insecure,
	})
	out.Timings = res.Timings

	if res.Err != nil {
		out.Mode = "error"
		out.Error = res.Err
		if record && res.Request != nil {
			out.FlowID = s.recordEvidenceFlow(r.Context(), parsed.String(), "error", res)
		}
		s.writeJSON(w, http.StatusOK, out)
		return
	}

	if res.Response == nil {
		out.Mode = "error"
		out.Error = &httpreplay.Error{Code: "protocol", Message: "目标未返回可解析的响应"}
		if record {
			out.FlowID = s.recordEvidenceFlow(r.Context(), parsed.String(), "error", res)
		}
		s.writeJSON(w, http.StatusOK, out)
		return
	}

	frameable, reason := evidence.Frameable(toHeader(res.Response.Headers))
	out.Reason = reason
	out.Status = res.Response.Status
	out.Size = len(res.Response.Body)
	out.Truncated = res.Response.Truncated

	useDirect := false
	switch mode {
	case "direct":
		useDirect = true
	case "snapshot":
		useDirect = false
	default: // auto
		useDirect = frameable
	}

	if useDirect {
		out.Mode = "direct"
	} else {
		out.Mode = "snapshot"
		contentType := headerValue(res.Response.Headers, "Content-Type")
		body := res.Response.Body
		if strings.Contains(strings.ToLower(contentType), "html") {
			rewritten, rerr := evidence.Rewrite(body, evidenceBaseURL(parsed), allowScripts)
			if rerr == nil {
				body = rewritten
			} else {
				s.log.Warn("快照改写失败，返回原文", "err", rerr)
			}
		}
		snap := &evidence.Snapshot{
			SourceURL:   parsed.String(),
			ContentType: contentType,
			Body:        body,
			Status:      out.Status,
			FetchedAt:   now,
			Truncated:   res.Response.Truncated,
		}
		id := s.evidence.Put(snap)
		out.SnapshotID = id
		out.SnapshotURL = "/api/evidence/snapshot/" + id
		out.ContentType = contentType
	}

	if record {
		out.FlowID = s.recordEvidenceFlow(r.Context(), parsed.String(), out.Mode, res)
	}
	s.writeJSON(w, http.StatusOK, out)
}

// handleEvidenceSnapshot 提供快照内容（同源，iframe 直接加载）。
func (s *Server) handleEvidenceSnapshot(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	snap, ok := s.evidence.Get(id)
	if !ok {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">` +
			`<body style="font-family:system-ui;background:#0b0f14;color:#94a3b8;padding:24px">` +
			`<p>快照已过期或不存在，请在取证面板点「刷新」重新抓取。</p></body></html>`))
		return
	}
	contentType := snap.ContentType
	if contentType == "" {
		contentType = "text/html; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Replayd-Mode", "snapshot")
	w.Header().Set("X-Replayd-Source", snap.SourceURL)
	w.Header().Set("X-Replayd-Fetched-At", snap.FetchedAt.Format(time.RFC3339))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(snap.Body)
}

/* -------------------------------------------------------------------------- */
/* 内部                                                                        */
/* -------------------------------------------------------------------------- */

// recordEvidenceFlow 把"访问时间页"记成一条 flow，并广播事件。
func (s *Server) recordEvidenceFlow(ctx context.Context, sourceURL, mode string, res httpreplay.Result) string {
	if res.Request == nil || res.Request.URL.Host == "" {
		return ""
	}
	flow := flowFromResult(res)
	flow.Note = evidenceNotePrefix + sourceURL + " · " + mode
	saveCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := s.store.InsertFlow(saveCtx, flow); err != nil {
		s.log.Warn("取证抓取落库失败", "err", err)
		return ""
	}
	s.bus.Publish("flow.new", map[string]any{
		"id": flow.ID, "source": "replay", "method": flow.Method,
		"scheme": flow.Scheme, "host": flow.Host, "port": flow.Port,
		"path": flow.Path, "status": flow.Status, "ts": flow.TS,
		"durationMs": flow.DurationMS, "evidence": true,
	})
	return flow.ID
}

func toHeader(headers []httpreplay.Header) http.Header {
	h := http.Header{}
	for _, item := range headers {
		h.Add(item.Name, item.Value)
	}
	return h
}

func headerValue(headers []httpreplay.Header, name string) string {
	if v, ok := httpreplay.HeaderIn(headers, name); ok {
		return v
	}
	return ""
}

// evidenceBaseURL 用于 <base href>：文件类路径回退到目录，其余保持原样。
func evidenceBaseURL(u *url.URL) string {
	base := *u
	base.RawQuery = ""
	base.Fragment = ""
	if !strings.HasSuffix(base.Path, "/") {
		if i := strings.LastIndex(base.Path, "/"); i >= 0 {
			base.Path = base.Path[:i+1]
		} else {
			base.Path = "/"
		}
	}
	return base.String()
}

func evidenceHostHeader(t httpreplay.Target) string {
	if (t.Scheme == "http" && t.Port == 80) || (t.Scheme == "https" && t.Port == 443) {
		return t.Host
	}
	return net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
}
