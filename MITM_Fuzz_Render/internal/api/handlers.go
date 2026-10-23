package api

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/chinaran404/replayd/internal/store"
)

// ---------------------------------------------------------------- session

type sessionRequest struct {
	Token string `json:"token"`
}

func (s *Server) handleSessionState(w http.ResponseWriter, r *http.Request) {
	via := authVia("")
	if c, err := r.Cookie(sessionCookie); err == nil && s.sessionEqual(c.Value) {
		via = "cookie"
	}
	if via == "" {
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") &&
			s.tokenEqual(strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))) {
			via = "bearer"
		}
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": via != "",
		"via":           via,
	})
}

func (s *Server) handleSessionCreate(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !s.limiter.allow(ip) {
		s.writeError(w, http.StatusTooManyRequests, "rate_limited", "尝试过于频繁，请稍后再试", nil)
		return
	}

	var req sessionRequest
	if err := decodeJSONBody(r, &req); err != nil {
		s.limiter.failed(ip)
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法", err.Error())
		return
	}
	if !s.tokenEqual(strings.TrimSpace(req.Token)) {
		s.limiter.failed(ip)
		s.writeError(w, http.StatusUnauthorized, "unauthorized", "令牌无效", nil)
		return
	}
	s.limiter.succeeded(ip)
	http.SetCookie(w, s.newSessionCookie(r))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSessionDelete(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) newSessionCookie(r *http.Request) *http.Cookie {
	return &http.Cookie{
		Name:     sessionCookie,
		Value:    sessionValue(s.cfg.Token),
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(sessionTTL.Seconds()),
	}
}

// ---------------------------------------------------------------- flows

type flowListResponse struct {
	Items      []*store.Flow `json:"items"`
	NextCursor string        `json:"nextCursor,omitempty"`
	// Total 是当前筛选条件下的记录总数（忽略游标），HasMore 表示还有下一页。
	Total   int64 `json:"total"`
	HasMore bool  `json:"hasMore"`
}

func (s *Server) handleListFlows(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.Filter{
		Host:   q.Get("host"),
		Method: q.Get("method"),
		Source: q.Get("source"),
		Search: q.Get("q"),
		Cursor: q.Get("cursor"),
		Limit:  atoiDefault(q.Get("limit"), 50),
	}
	if v := q.Get("status"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Status = &n
		}
	}
	if v := q.Get("from"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			f.From = n
		}
	}
	if v := q.Get("to"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			f.To = n
		}
	}

	items, next, err := s.store.ListFlows(r.Context(), f)
	if err != nil {
		if strings.Contains(err.Error(), "游标") {
			s.writeError(w, http.StatusBadRequest, "bad_request", "分页游标不合法", nil)
			return
		}
		s.writeError(w, http.StatusInternalServerError, "internal", "读取抓包列表失败", nil)
		return
	}
	if items == nil {
		items = []*store.Flow{}
	}
	total, err := s.store.CountFlows(r.Context(), f)
	if err != nil {
		// 统计失败不影响列表可用，只退化为 0
		s.log.Warn("统计 flow 总数失败", "err", err)
	}
	s.writeJSON(w, http.StatusOK, flowListResponse{
		Items: items, NextCursor: next, Total: total, HasMore: next != "",
	})
}

func (s *Server) handleGetFlow(w http.ResponseWriter, r *http.Request) {
	flowID := chi.URLParam(r, "id")
	withBodies := r.URL.Query().Get("body") == "1"

	f, err := s.store.GetFlow(r.Context(), flowID, withBodies)
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "flow 不存在", flowID)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "读取 flow 失败", nil)
		return
	}

	resp := struct {
		*store.Flow
		Bodies *flowBodies `json:"bodies,omitempty"`
	}{Flow: f}
	if withBodies {
		resp.Bodies = newFlowBodies(f)
	}
	s.writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleDeleteFlow(w http.ResponseWriter, r *http.Request) {
	flowID := chi.URLParam(r, "id")
	err := s.store.DeleteFlow(r.Context(), flowID)
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "flow 不存在", flowID)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "删除 flow 失败", nil)
		return
	}
	s.bus.Publish("flow.deleted", map[string]string{"id": flowID})
	w.WriteHeader(http.StatusNoContent)
}

// handleFlowRaw 下载原始报文（?side=req|resp）。
func (s *Server) handleFlowRaw(w http.ResponseWriter, r *http.Request) {
	flowID := chi.URLParam(r, "id")
	f, err := s.store.GetFlow(r.Context(), flowID, true)
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "flow 不存在", flowID)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "读取 flow 失败", nil)
		return
	}

	side := r.URL.Query().Get("side")
	var data []byte
	name := "request"
	switch side {
	case "req":
		data = f.ReqRaw
	case "resp", "":
		data = f.RespRaw
		name = "response"
	default:
		s.writeError(w, http.StatusBadRequest, "bad_request", "side 只能是 req 或 resp", nil)
		return
	}

	ct := "text/plain; charset=utf-8"
	if !utf8.Valid(data) {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition",
		`attachment; filename="`+flowID+`-`+name+`.http"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// flowBodies 把原始字节转成前端可直接显示的形式：
// 合法 UTF-8 给文本，否则给 base64（避免 JSON 编码把二进制洗成替换字符）。
type flowBodies struct {
	ReqRaw      string `json:"reqRaw,omitempty"`
	RespRaw     string `json:"respRaw,omitempty"`
	ReqBody     string `json:"reqBody,omitempty"`
	RespBody    string `json:"respBody,omitempty"`
	ReqRawB64   string `json:"reqRawBase64,omitempty"`
	RespRawB64  string `json:"respRawBase64,omitempty"`
	ReqBodyB64  string `json:"reqBodyBase64,omitempty"`
	RespBodyB64 string `json:"respBodyBase64,omitempty"`
}

func newFlowBodies(f *store.Flow) *flowBodies {
	b := &flowBodies{}
	b.ReqRaw, b.ReqRawB64 = viewText(f.ReqRaw)
	b.RespRaw, b.RespRawB64 = viewText(f.RespRaw)
	b.ReqBody, b.ReqBodyB64 = viewText(f.ReqBody)
	b.RespBody, b.RespBodyB64 = viewText(f.RespBody)
	return b
}

func viewText(data []byte) (text, b64 string) {
	if len(data) == 0 {
		return "", ""
	}
	if utf8.Valid(data) {
		return string(data), ""
	}
	return "", base64.StdEncoding.EncodeToString(data)
}

// ---------------------------------------------------------------- misc

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}
