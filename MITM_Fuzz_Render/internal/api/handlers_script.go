package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/chinaran404/replayd/internal/httpreplay"
	"github.com/chinaran404/replayd/internal/script"
	"github.com/chinaran404/replayd/internal/store"
)

/* -------------------------------------------------------------------------- */
/* CRUD                                                                        */
/* -------------------------------------------------------------------------- */

type scriptListResponse struct {
	Items []*store.Script `json:"items"`
}

func (s *Server) handleListScripts(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListScripts(r.Context(), "")
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "读取脚本列表失败", nil)
		return
	}
	if items == nil {
		items = []*store.Script{}
	}
	s.writeJSON(w, http.StatusOK, scriptListResponse{Items: items})
}

type createScriptRequest struct {
	Name    string       `json:"name"`
	Lang    string       `json:"lang"`
	Source  string       `json:"source"`
	Hooks   *store.Hooks `json:"hooks"`
	Enabled *bool        `json:"enabled"`
}

func (s *Server) handleCreateScript(w http.ResponseWriter, r *http.Request) {
	var in createScriptRequest
	if err := decodeJSONBody(r, &in); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法: "+err.Error(), nil)
		return
	}
	if in.Lang != "" && in.Lang != "js" {
		s.writeError(w, http.StatusUnprocessableEntity, "unsupported",
			"当前只支持 js 脚本（Python 将在 M3.5 提供）", nil)
		return
	}
	sc := &store.Script{Name: in.Name, Lang: in.Lang, Source: in.Source}
	if in.Hooks != nil {
		sc.Hooks = *in.Hooks
	}
	if err := s.store.InsertScript(r.Context(), sc); err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "创建脚本失败", nil)
		return
	}
	s.writeJSON(w, http.StatusCreated, sc)
}

func (s *Server) handleGetScript(w http.ResponseWriter, r *http.Request) {
	sc, err := s.store.GetScript(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "脚本不存在", nil)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "读取脚本失败", nil)
		return
	}
	s.writeJSON(w, http.StatusOK, sc)
}

type updateScriptRequest struct {
	Name      *string      `json:"name"`
	Source    *string      `json:"source"`
	Hooks     *store.Hooks `json:"hooks"`
	Enabled   *bool        `json:"enabled"`
	UpdatedAt *int64       `json:"updatedAt"`
}

func (s *Server) handleUpdateScript(w http.ResponseWriter, r *http.Request) {
	var in updateScriptRequest
	if err := decodeJSONBody(r, &in); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法: "+err.Error(), nil)
		return
	}
	// 未显式指定时默认三钩子全开（避免前端漏传导致脚本静默不生效）
	hooks := in.Hooks
	sc, err := s.store.UpdateScript(r.Context(), chi.URLParam(r, "id"), store.ScriptPatch{
		Name:     in.Name,
		Source:   in.Source,
		Hooks:    hooks,
		Enabled:  in.Enabled,
		Expected: in.UpdatedAt,
	})
	switch {
	case errors.Is(err, store.ErrNotFound):
		s.writeError(w, http.StatusNotFound, "not_found", "脚本不存在", nil)
		return
	case errors.Is(err, store.ErrConflict):
		s.writeError(w, http.StatusConflict, "conflict",
			"脚本已被其他窗口修改，请刷新后重试", nil)
		return
	case err != nil:
		s.writeError(w, http.StatusInternalServerError, "internal", "更新脚本失败", nil)
		return
	}
	s.writeJSON(w, http.StatusOK, sc)
}

func (s *Server) handleDeleteScript(w http.ResponseWriter, r *http.Request) {
	err := s.store.DeleteScript(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "脚本不存在", nil)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "删除脚本失败", nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListScriptRuns(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListScriptRuns(r.Context(), chi.URLParam(r, "id"), 50)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "读取执行记录失败", nil)
		return
	}
	if items == nil {
		items = []*store.ScriptRun{}
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

/* -------------------------------------------------------------------------- */
/* 试跑                                                                        */
/* -------------------------------------------------------------------------- */

type scriptTestRequest struct {
	Raw      string        `json:"raw"`
	Target   *replayTarget `json:"target"`
	Send     bool          `json:"send"`
	Response *struct {
		Status int    `json:"status"`
		Body   string `json:"body"`
	} `json:"response"`
	InsecureTLS bool `json:"insecureTLS"`
}

type scriptTestResponse struct {
	Request  *scriptRequestView  `json:"request,omitempty"`
	Response *scriptResponseView `json:"response,omitempty"`
	Result   *replayResponse     `json:"result,omitempty"`
	Script   *script.Output      `json:"script"`
}

type scriptRequestView struct {
	Raw string `json:"raw"`
	URL string `json:"url"`
}

type scriptResponseView struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// handleScriptTest 试跑脚本：默认只跑钩子（不联网），send=true 时完整发一次包。
func (s *Server) handleScriptTest(w http.ResponseWriter, r *http.Request) {
	sc, err := s.store.GetScript(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "脚本不存在", nil)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "读取脚本失败", nil)
		return
	}

	var in scriptTestRequest
	if err := decodeJSONBody(r, &in); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法: "+err.Error(), nil)
		return
	}

	// 构造脚本输入：有 raw 就解析它，否则用合成请求方便调试断言脚本
	raw := in.Raw
	if strings.TrimSpace(raw) == "" {
		raw = "GET / HTTP/1.1\r\nHost: example.test\r\n\r\n"
	}
	fallback := targetFromReplay(in.Target)
	parsed, perr := httpreplay.ParseRequest([]byte(raw), fallback)
	if perr != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "无法解析请求: "+perr.Error(), nil)
		return
	}

	// send=true 时复用完整重放路径（含脚本）
	if in.Send {
		res := s.doReplay(r.Context(), replayRequest{
			Raw:      raw,
			Target:   derefTarget(in.Target),
			Opts:     replayOptions{InsecureTLS: in.InsecureTLS},
			ScriptID: sc.ID,
		}, sc)
		s.writeJSON(w, http.StatusOK, scriptTestResponse{
			Request: &scriptRequestView{Raw: raw, URL: absURL(parsed.URL)},
			Result:  &res, Script: res.Script,
		})
		return
	}

	// 仅跑钩子
	sess, out := s.script.Start(r.Context(), script.Input{
		Source:  sc.Source,
		Hooks:   script.Hooks(sc.Hooks),
		Request: scriptRequestFromEngine(parsed),
		Timeout: script.DefaultTimeout,
		Vars:    map[string]string{},
	})
	resp := scriptTestResponse{Script: &out}
	if sess != nil {
		resp.Request = &scriptRequestView{Raw: out.Request.RawRequest(parsed.Target), URL: out.Request.URL}
		if out.Error == "" {
			sample := script.Response{Status: 200, Body: `{"ok":true}`}
			if in.Response != nil {
				sample = script.Response{Status: in.Response.Status, Body: in.Response.Body}
			}
			final := sess.Response(sample)
			resp.Script = &final
			resp.Response = &scriptResponseView{Status: sample.Status, Body: final.Response.Body}
		}
	}
	s.writeJSON(w, http.StatusOK, resp)
}

/* -------------------------------------------------------------------------- */
/* 与 httpreplay / store 的转换                                                */
/* -------------------------------------------------------------------------- */

func scriptRequestFromEngine(req *httpreplay.Request) script.Request {
	return script.Request{
		Method:  req.Method,
		URL:     absURL(req.URL),
		Body:    string(req.Body),
		Headers: scriptHeaders(req.Headers),
	}
}

func scriptResponseFromEngine(resp *httpreplay.Response) script.Response {
	if resp == nil {
		return script.Response{}
	}
	body := ""
	if utf8.Valid(resp.Body) {
		body = string(resp.Body)
	} else {
		body = strings.ToValidUTF8(string(resp.Body), "�")
	}
	return script.Response{
		Status:    resp.Status,
		Body:      body,
		Headers:   scriptHeaders(resp.Headers),
		Truncated: resp.Truncated,
	}
}

func scriptHeaders(headers []httpreplay.Header) []script.Header {
	out := make([]script.Header, 0, len(headers))
	for _, h := range headers {
		out = append(out, script.Header{Name: h.Name, Value: h.Value})
	}
	return out
}

func absURL(t httpreplay.Target) string {
	if t.Host == "" {
		return ""
	}
	scheme := t.Scheme
	if scheme == "" {
		scheme = "http"
	}
	port := ""
	defaultPort := (scheme == "http" && t.Port == 80) || (scheme == "https" && t.Port == 443)
	if t.Port > 0 && !defaultPort {
		port = ":" + itoa(t.Port)
	}
	path := t.Path
	if path == "" {
		path = "/"
	}
	return scheme + "://" + t.Host + port + path
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func targetFromReplay(t *replayTarget) httpreplay.Target {
	if t == nil || t.Host == "" {
		return httpreplay.Target{}
	}
	scheme := t.Scheme
	if scheme == "" {
		scheme = "http"
	}
	host, port := t.Host, t.Port
	// host 允许写成 "example.com:8443"
	if h, p, err := net.SplitHostPort(host); err == nil {
		host = h
		if n, perr := strconv.Atoi(p); perr == nil {
			port = n
		}
	}
	if port == 0 {
		if scheme == "https" {
			port = 443
		} else {
			port = 80
		}
	}
	return httpreplay.Target{Scheme: scheme, Host: host, Port: port}
}

func derefTarget(t *replayTarget) replayTarget {
	if t == nil {
		return replayTarget{}
	}
	return *t
}

// recordScriptRun 记录一次脚本执行（失败只记日志，不影响主流程）。
func (s *Server) recordScriptRun(ctx context.Context, scriptID, flowID string, out script.Output) {
	logs, _ := json.Marshal(out.Logs)
	run := &store.ScriptRun{
		ScriptID:   scriptID,
		FlowID:     flowID,
		OK:         out.Error == "",
		Logs:       logs,
		Error:      out.Error,
		DurationMS: out.DurationMS,
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := s.store.InsertScriptRun(ctx, run); err != nil {
		s.log.Warn("写入脚本执行记录失败", "err", err)
	}
}
