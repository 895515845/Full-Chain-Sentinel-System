package store

import "encoding/json"

// Header 保留原始名称大小写与顺序；不要用 map 替代。
type Header struct {
	N string `json:"n"`
	V string `json:"v"`
}

// Flow 是一条抓包或重放记录。
//
// ReqBody/RespBody/ReqRaw/RespRaw 只在 GetFlow(withBodies=true) 时填充，
// 其余场景为 nil（列表页不需要把大包搬进内存）。
type Flow struct {
	ID          string          `json:"id"`
	ProjectID   string          `json:"projectId"`
	Source      string          `json:"source"` // replay | proxy
	TS          int64           `json:"ts"`     // Unix 毫秒
	DurationMS  *int64          `json:"durationMs,omitempty"`
	Method      string          `json:"method"`
	Scheme      string          `json:"scheme"`
	Host        string          `json:"host"`
	Port        int             `json:"port"`
	Path        string          `json:"path"`
	Query       string          `json:"query,omitempty"`
	HTTPVersion string          `json:"httpVersion"`
	ReqHeaders  []Header        `json:"reqHeaders,omitempty"`
	ReqSize     int64           `json:"reqSize"`
	Status      *int            `json:"status,omitempty"`
	RespHeaders []Header        `json:"respHeaders,omitempty"`
	RespSize    int64           `json:"respSize"`
	TLS         json.RawMessage `json:"tls,omitempty"`
	Timings     json.RawMessage `json:"timings,omitempty"`
	Error       json.RawMessage `json:"error,omitempty"`
	Tags        []string        `json:"tags,omitempty"`
	Note        string          `json:"note,omitempty"`
	CreatedAt   int64           `json:"createdAt"`

	ReqBody  []byte `json:"-"`
	RespBody []byte `json:"-"`

	ReqRaw  []byte `json:"-"`
	RespRaw []byte `json:"-"`

	// 内部引用，不参与序列化。
	reqBodySHA  string
	reqRawSHA   string
	respBodySHA string
	respRawSHA  string
}

func marshalHeaders(h []Header) string {
	if len(h) == 0 {
		return "[]"
	}
	return marshalJSON(h)
}

func decodeHeaders(raw string) []Header {
	if raw == "" || raw == "null" {
		return nil
	}
	var h []Header
	if err := json.Unmarshal([]byte(raw), &h); err != nil {
		return nil
	}
	return h
}

func decodeTags(raw string) []string {
	if raw == "" || raw == "null" {
		return nil
	}
	var t []string
	if err := json.Unmarshal([]byte(raw), &t); err != nil {
		return nil
	}
	return t
}
