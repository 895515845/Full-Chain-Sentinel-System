package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

type CallRecord struct {
	ID         string         `json:"id"`
	At         int64          `json:"at"`
	Tool       string         `json:"tool"`
	Target     string         `json:"target"`
	OK         bool           `json:"ok"`
	DurationMs int64          `json:"durationMs"`
	ResultSize int            `json:"resultSize"`
	Artifacts  []string       `json:"artifacts"`
	Error      string         `json:"error,omitempty"`
	Args       map[string]any `json:"args,omitempty"`
	Result     string         `json:"result,omitempty"`
}

type History struct {
	mu      sync.Mutex
	path    string
	records []CallRecord
}

const maxHistory = 200

func NewHistory(path string) *History {
	h := &History{path: path}
	raw, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(raw, &h.records)
	}
	if h.records == nil {
		h.records = []CallRecord{}
	}
	return h
}

func (h *History) Middleware() server.ToolHandlerMiddleware {
	return func(next server.ToolHandlerFunc) server.ToolHandlerFunc {
		return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			name := request.Params.Name
			if name == "list_calls" {
				return next(ctx, request)
			}
			started := time.Now()
			result, err := next(ctx, request)
			record := CallRecord{
				ID:         time.Now().Format("20060102150405.000000000"),
				At:         started.UnixMilli(),
				Tool:       name,
				OK:         err == nil && (result == nil || !result.IsError),
				DurationMs: time.Since(started).Milliseconds(),
				Args:       redactArgs(request.GetArguments()),
				Artifacts:  []string{},
			}
			record.Target = targetOf(name, request.GetArguments())
			if err != nil {
				record.Error = truncate(err.Error(), 2000)
			}
			if result != nil {
				text := textOfResult(result)
				record.Result = truncate(text, 12000)
				record.ResultSize = len(text)
				if result.IsError && record.Error == "" {
					record.Error = truncate(text, 2000)
				}
				record.Artifacts = findArtifacts(text)
			}
			h.append(record)
			return result, err
		}
	}
}

func (h *History) append(record CallRecord) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append([]CallRecord{record}, h.records...)
	if len(h.records) > maxHistory {
		h.records = h.records[:maxHistory]
	}
	h.saveLocked()
}

func (h *History) List(limit int) []CallRecord {
	h.mu.Lock()
	defer h.mu.Unlock()
	if limit <= 0 || limit > maxHistory {
		limit = maxHistory
	}
	out := make([]CallRecord, 0, limit)
	for _, record := range h.records {
		if len(out) >= limit {
			break
		}
		out = append(out, record)
	}
	return out
}

func (h *History) saveLocked() {
	if h.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(h.path), 0o755); err != nil {
		return
	}
	raw, err := json.Marshal(h.records)
	if err != nil {
		return
	}
	temp := h.path + ".tmp"
	if err := os.WriteFile(temp, raw, 0o600); err != nil {
		return
	}
	_ = os.Rename(temp, h.path)
}

func textOfResult(result *mcp.CallToolResult) string {
	parts := make([]string, 0, len(result.Content))
	for _, content := range result.Content {
		if text, ok := content.(mcp.TextContent); ok {
			parts = append(parts, text.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func targetOf(name string, args map[string]any) string {
	get := func(keys ...string) string {
		for _, key := range keys {
			if value, ok := args[key]; ok {
				if text, ok := value.(string); ok && text != "" {
					return text
				}
			}
		}
		return ""
	}
	switch name {
	case "chains_generate":
		return strings.TrimSpace(get("payload") + " · " + get("chain"))
	case "chains_generate_preset":
		return strings.TrimSpace(get("preset_id") + " · " + get("payload"))
	case "chains_describe":
		return get("key")
	case "chains_services":
		return strings.TrimSpace(get("action") + " " + get("service"))
	case "chains_exec":
		if raw, ok := args["cli_args"].([]any); ok {
			parts := make([]string, 0, len(raw))
			for _, item := range raw {
				parts = append(parts, stringify(item))
			}
			return truncate(strings.Join(parts, " "), 300)
		}
	case "chains_validate_chain":
		return truncate(get("chain"), 300)
	}
	return ""
}

func redactArgs(args map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range args {
		lower := strings.ToLower(key)
		if strings.Contains(lower, "token") || strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.Contains(lower, "passwd") {
			out[key] = "***"
			continue
		}
		out[key] = value
	}
	return out
}

func findArtifacts(text string) []string {
	var payload any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return []string{}
	}
	seen := map[string]bool{}
	out := []string{}
	var walk func(value any)
	walk = func(value any) {
		switch typed := value.(type) {
		case map[string]any:
			for key, child := range typed {
				if (key == "out" || key == "artifact" || key == "path") && child != nil {
					text := stringify(child)
					if strings.Contains(text, "/artifacts/") && !seen[text] {
						seen[text] = true
						out = append(out, text)
					}
				}
				walk(child)
			}
		case []any:
			for _, child := range typed {
				walk(child)
			}
		}
	}
	walk(payload)
	sort.Strings(out)
	return out
}

func stringify(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	default:
		raw, _ := json.Marshal(typed)
		return string(raw)
	}
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
