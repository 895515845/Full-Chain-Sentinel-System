package api

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/chinaran404/replayd/internal/store"
)

// 高亮颜色与数量上限（防止前端/Agent 塞进超大 JSON）。
var highlightColors = map[string]bool{"yellow": true, "green": true, "red": true, "blue": true}

const (
	maxHighlights      = 300
	maxHighlightJSON   = 64 << 10
	maxHighlightOffset = 8 << 20 // 单条高亮的偏移上限（8MB 文本足够）
)

type highlightItem struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Color string `json:"color"`
}

// highlightsPayload 是请求/响应高亮的存储结构。
// response 按视图（raw/pretty/hex）分别存，因为不同视图的文本偏移不同。
type highlightsPayload struct {
	Request  []highlightItem            `json:"request,omitempty"`
	Response map[string][]highlightItem `json:"response,omitempty"`
}

// normalize 校验并归一化：排序、去重叠、丢弃非法项。
func (p *highlightsPayload) normalize() error {
	p.Request = normalizeHighlights(p.Request)
	if len(p.Request) == 0 {
		p.Request = nil
	}
	if len(p.Response) > 0 {
		cleaned := make(map[string][]highlightItem, len(p.Response))
		for view, items := range p.Response {
			view = strings.TrimSpace(view)
			if view == "" || len(view) > 16 {
				return &highlightError{"response 的视图名不合法: " + view}
			}
			if normalized := normalizeHighlights(items); len(normalized) > 0 {
				cleaned[view] = normalized
			}
		}
		p.Response = cleaned
		if len(cleaned) == 0 {
			p.Response = nil
		}
	}
	if len(p.Request)+countHighlights(p.Response) > maxHighlights {
		return &highlightError{"高亮数量超过上限（300 条）"}
	}
	return nil
}

func (p *highlightsPayload) empty() bool {
	return len(p.Request) == 0 && len(p.Response) == 0
}

type highlightError struct{ msg string }

func (e *highlightError) Error() string { return e.msg }

// normalizeHighlights 排序并丢弃非法/重叠项（保留先出现的那个）。
func normalizeHighlights(items []highlightItem) []highlightItem {
	out := make([]highlightItem, 0, len(items))
	for _, item := range items {
		if item.Start < 0 || item.End <= item.Start || item.End > maxHighlightOffset {
			continue
		}
		if !highlightColors[item.Color] {
			continue
		}
		out = append(out, item)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	filtered := out[:0]
	lastEnd := -1
	for _, item := range out {
		if item.Start < lastEnd {
			continue // 与上一条重叠，丢弃
		}
		filtered = append(filtered, item)
		lastEnd = item.End
	}
	return filtered
}

func countHighlights(m map[string][]highlightItem) int {
	total := 0
	for _, items := range m {
		total += len(items)
	}
	return total
}

// handlePutTabHighlights 覆盖保存标签页的请求/响应高亮。
// 放服务端（而不是浏览器 localStorage）是为了让 /api/capture 的无头截图也能带上高亮。
func (s *Server) handlePutTabHighlights(w http.ResponseWriter, r *http.Request) {
	tabID := chi.URLParam(r, "id")
	body, err := io.ReadAll(io.LimitReader(r.Body, maxHighlightJSON+1))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "读取请求体失败", nil)
		return
	}
	if len(body) > maxHighlightJSON {
		s.writeError(w, http.StatusBadRequest, "bad_request", "高亮数据过大（上限 64KB）", nil)
		return
	}

	// 空体或 {} 视为清空
	payload := highlightsPayload{}
	trimmed := strings.TrimSpace(string(body))
	if trimmed != "" && trimmed != "{}" && trimmed != "null" {
		decoder := json.NewDecoder(strings.NewReader(trimmed))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			s.writeError(w, http.StatusBadRequest, "bad_request", "高亮数据不合法: "+err.Error(), nil)
			return
		}
	}
	if err := payload.normalize(); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", err.Error(), nil)
		return
	}

	stored := ""
	if !payload.empty() {
		encoded, err := json.Marshal(payload)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, "internal", "序列化高亮失败", nil)
			return
		}
		stored = string(encoded)
	}

	tab, err := s.store.UpdateTabHighlights(r.Context(), tabID, stored)
	if err == store.ErrNotFound {
		s.writeError(w, http.StatusNotFound, "not_found", "标签页不存在", nil)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "保存高亮失败", nil)
		return
	}
	s.writeJSON(w, http.StatusOK, tab)
}
