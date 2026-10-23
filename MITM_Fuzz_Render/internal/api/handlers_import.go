package api

import (
	"fmt"
	"net/http"

	"github.com/chinaran404/replayd/internal/importer"
	"github.com/chinaran404/replayd/internal/store"
)

type importRequest struct {
	Format     string `json:"format"` // curl | har
	Content    string `json:"content"`
	CreateTabs *bool  `json:"createTabs"` // 默认 true
}

type importedRequestView struct {
	Raw    string `json:"raw"`
	Method string `json:"method"`
	URL    string `json:"url"`
}

type importResponse struct {
	Tabs     []*store.Tab          `json:"tabs"`
	Requests []importedRequestView `json:"requests"`
	Warnings []string              `json:"warnings,omitempty"`
}

// handleImport 把 curl 命令 / HAR 转换为 raw 请求并（默认）创建为 Repeater 标签页。
func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	var in importRequest
	if err := decodeJSONBody(r, &in); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法: "+err.Error(), nil)
		return
	}
	if in.Content == "" {
		s.writeError(w, http.StatusBadRequest, "bad_request", "content 不能为空", nil)
		return
	}

	var (
		res *importer.Result
		err error
	)
	switch in.Format {
	case "curl":
		res, err = importer.FromCurl(in.Content)
	case "har":
		res, err = importer.FromHAR([]byte(in.Content), 50)
	default:
		s.writeError(w, http.StatusBadRequest, "bad_request",
			fmt.Sprintf("未知格式 %q（支持 curl | har）", in.Format), nil)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", err.Error(), nil)
		return
	}

	out := importResponse{Warnings: res.Warnings}
	for _, req := range res.Requests {
		out.Requests = append(out.Requests, importedRequestView{
			Raw: req.Raw, Method: req.Method, URL: req.URL,
		})
	}

	if in.CreateTabs == nil || *in.CreateTabs {
		for i, req := range res.Requests {
			name := req.Method + " " + shortLabel(req.URL)
			if len(res.Requests) > 1 {
				name = fmt.Sprintf("%s #%d", name, i+1)
			}
			tab := &store.Tab{Name: name, RawRequest: req.Raw}
			if err := s.store.InsertTab(r.Context(), tab); err == nil {
				out.Tabs = append(out.Tabs, tab)
			}
		}
	}
	if out.Tabs == nil {
		out.Tabs = []*store.Tab{}
	}
	s.writeJSON(w, http.StatusOK, out)
}

func shortLabel(rawURL string) string {
	// 去掉 scheme，保留 host/path，最长 60 字符
	for _, prefix := range []string{"https://", "http://"} {
		if len(rawURL) > len(prefix) && rawURL[:len(prefix)] == prefix {
			rawURL = rawURL[len(prefix):]
			break
		}
	}
	if len(rawURL) > 60 {
		rawURL = rawURL[:60] + "…"
	}
	return rawURL
}
