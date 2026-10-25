package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/chinaran404/replayd/internal/capture"
	"github.com/chinaran404/replayd/internal/httpreplay"
	"github.com/chinaran404/replayd/internal/store"
)

type captureRequest struct {
	Raw         string `json:"raw"`
	Scheme      string `json:"scheme"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	InsecureTLS bool   `json:"insecureTLS"`
	ScriptID    string `json:"scriptId"`

	EvidenceURL      string `json:"evidenceUrl,omitempty"`
	EvidenceAuto     string `json:"evidenceAuto,omitempty"`
	EvidenceMode     string `json:"evidenceMode,omitempty"`
	EvidenceSettleMS int    `json:"evidenceSettleMs,omitempty"`
	EvidenceDetails  *bool  `json:"evidenceDetails,omitempty"`
	HideEvidence     bool   `json:"hideEvidence,omitempty"`

	// Highlight：按文本匹配打高亮（Agent 不需要知道字符偏移）
	Highlight *capture.HighlightSpec `json:"highlight,omitempty"`

	Width          int   `json:"width,omitempty"`
	Height         int   `json:"height,omitempty"`
	FullPage       bool  `json:"fullPage,omitempty"`
	WaitTimeoutMS  int   `json:"waitTimeoutMs,omitempty"`
	SettleMS       int   `json:"settleMs,omitempty"`
	IncludeContent bool  `json:"includeContent,omitempty"`
	Send           *bool `json:"send,omitempty"`

	// UpstreamProxy：这次发送走这个 SOCKS5 出口（socks5://[user:pass@]host:port）。
	// 只作用于这一次发送，不是系统代理，也不经过截图用的浏览器。
	UpstreamProxy string `json:"upstreamProxy,omitempty"`
}

type captureTimings struct {
	SentMS     int64 `json:"sentMs"`
	EvidenceMS int64 `json:"evidenceMs"`
	TotalMS    int64 `json:"totalMs"`
}

type captureResponse struct {
	Status string `json:"status"`

	StatusLine        string   `json:"statusLine"`
	ResponseHeaders   string   `json:"responseHeaders"`
	ResponsePreview   string   `json:"responsePreview,omitempty"`
	EvidenceMode      string   `json:"evidenceMode"`
	EvidenceWatermark string   `json:"evidenceWatermark"`
	EvidenceFrameURL  string   `json:"evidenceFrameUrl,omitempty"`
	EvidenceWarnings  []string `json:"evidenceWarnings,omitempty"`
	RequestSeen       string   `json:"requestSeen"`
	TargetSeen        string   `json:"targetSeen"`
	SendError         string   `json:"sendError,omitempty"`
	HighlightsApplied []string `json:"highlightsApplied,omitempty"`
	HighlightsMissing []string `json:"highlightsMissing,omitempty"`

	// UpstreamProxy：回显实际生效的出口（规范化之后），便于审计与排查。
	UpstreamProxy string `json:"upstreamProxy,omitempty"`

	Screenshots map[string]artifactView `json:"screenshots,omitempty"`
	Timings     captureTimings          `json:"timings"`
	Width       int                     `json:"width,omitempty"`
	Height      int                     `json:"height,omitempty"`
	FlowID      string                  `json:"flowId,omitempty"`
	Error       *httpreplay.Error       `json:"error,omitempty"`
}

// handleCapture 截取 replayd 自己的 Repeater 界面（请求 + 响应 + 取证）。
func (s *Server) handleCapture(w http.ResponseWriter, r *http.Request) {
	var in captureRequest
	if err := decodeJSONBody(r, &in); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法: "+err.Error(), nil)
		return
	}
	proxy, err := normalizeSocks5Proxy(in.UpstreamProxy)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", err.Error(), nil)
		return
	}
	in.UpstreamProxy = proxy
	if strings.TrimSpace(in.Raw) == "" {
		s.writeError(w, http.StatusBadRequest, "bad_request", "raw 不能为空（需要要发送的原始请求报文）", nil)
		return
	}
	if s.capture == nil {
		s.writeError(w, http.StatusNotImplemented, "unsupported",
			"本实例未启用界面截图（浏览器管理器未初始化）", nil)
		return
	}
	if in.Scheme != "" && in.Scheme != "http" && in.Scheme != "https" {
		s.writeError(w, http.StatusBadRequest, "bad_request", "scheme 只支持 http/https", nil)
		return
	}
	if in.Highlight != nil {
		if err := in.Highlight.Validate(); err != nil {
			s.writeError(w, http.StatusBadRequest, "bad_request", err.Error(), nil)
			return
		}
	}
	// 只给报文时（Agent 的典型用法）目标得从报文里读：界面上的目标字段是分开的三个
	// 输入框，空着就点不动发送按钮，截图会一直等到超时。
	if in.Host == "" {
		if derived, ok := httpreplay.TargetFromRaw([]byte(in.Raw)); ok {
			in.Scheme, in.Host, in.Port = derived.Scheme, derived.Host, derived.Port
		}
	}

	startedMS := time.Now().UnixMilli()
	ctx, cancel := context.WithTimeout(r.Context(),
		time.Duration(in.WaitTimeoutMS)*time.Millisecond+45*time.Second)
	defer cancel()

	spec := capture.Spec{
		Raw: in.Raw, Scheme: in.Scheme, Host: in.Host, Port: in.Port,
		InsecureTLS: in.InsecureTLS, ScriptID: in.ScriptID,
		EvidenceURL: in.EvidenceURL, EvidenceAuto: in.EvidenceAuto,
		EvidenceMode: in.EvidenceMode, EvidenceSettleMS: in.EvidenceSettleMS,
		EvidenceDetails: in.EvidenceDetails,
		HideEvidence:    in.HideEvidence,
		Width:           in.Width, Height: in.Height, FullPage: in.FullPage,
		WaitTimeoutMS: in.WaitTimeoutMS, SettleMS: in.SettleMS,
		IncludeContent: in.IncludeContent, Send: in.Send, Highlight: in.Highlight,
		UpstreamProxy: in.UpstreamProxy,
	}
	res, err := s.capture.Capture(ctx, spec)
	if err != nil {
		code := "capture_failed"
		if errors.Is(err, context.DeadlineExceeded) {
			code = "timeout"
		}
		s.writeJSON(w, http.StatusOK, captureResponse{
			Status: "error",
			Error:  &httpreplay.Error{Code: code, Message: err.Error()},
		})
		return
	}

	out := captureResponse{
		Status:            "done",
		StatusLine:        res.StatusLine,
		ResponseHeaders:   res.ResponseHeaders,
		ResponsePreview:   res.ResponsePreview,
		EvidenceMode:      res.EvidenceMode,
		EvidenceWatermark: res.EvidenceWatermark,
		EvidenceFrameURL:  res.EvidenceFrameURL,
		EvidenceWarnings:  res.EvidenceWarnings,
		RequestSeen:       res.RequestSeen,
		TargetSeen:        res.TargetSeen,
		SendError:         res.SendError,
		HighlightsApplied: res.HighlightsApplied,
		HighlightsMissing: res.HighlightsMissing,
		UpstreamProxy:     in.UpstreamProxy,
		Width:             res.Width,
		Height:            res.Height,
		Timings: captureTimings{
			SentMS: res.SentMS, EvidenceMS: res.EvidenceMS, TotalMS: res.TotalMS,
		},
	}

	meta, _ := json.Marshal(map[string]any{
		"kind":       "ui-capture",
		"page":       "/repeater",
		"target":     in.Host,
		"width":      res.Width,
		"height":     res.Height,
		"statusLine": res.StatusLine,
	})
	shots := map[string]artifactView{}
	save := func(kind, key string, data []byte) {
		if len(data) == 0 {
			return
		}
		view, serr := s.saveArtifact(ctx, "", kind, "image/png", data, meta)
		if serr != nil {
			s.log.Warn("保存界面截图失败", "kind", kind, "err", serr)
			return
		}
		shots[key] = view
	}
	save(store.ArtifactScreenshotViewport, "viewport", res.ViewportPNG)
	save(store.ArtifactScreenshotFull, "full", res.FullPNG)
	if len(shots) > 0 {
		out.Screenshots = shots
	}

	// 界面里的发送本身会经 /api/replay 落一条 flow，这里把它找出来给 Agent
	if flowID := s.newestFlowSince(ctx, startedMS); flowID != "" {
		out.FlowID = flowID
	}
	s.writeJSON(w, http.StatusOK, out)
}

// newestFlowSince 找出指定时间之后最新的一条 flow（界面截图对应的那次发送）。
func (s *Server) newestFlowSince(ctx context.Context, sinceMS int64) string {
	flows, _, err := s.store.ListFlows(ctx, store.Filter{Limit: 1})
	if err != nil || len(flows) == 0 {
		return ""
	}
	if flows[0].TS < sinceMS-2000 {
		return ""
	}
	return flows[0].ID
}
