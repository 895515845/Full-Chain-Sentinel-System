// Package evidence 支撑「时间取证」面板：判定目标能否被内嵌，不能内嵌时
// 把抓到的页面改写成可安全展示的同源快照。
//
// 设计要点：
//   - Frameable 只看目标自己的 X-Frame-Options / CSP frame-ancestors，
//     因为我们是从 127.0.0.1 这个"第三方源"去内嵌，SAMEORIGIN 同样视为不允许；
//   - Rewrite 使用 golang.org/x/net/html 做真实 DOM 改写（而不是正则）：
//     剥离 <script>、内联 on* 事件、javascript: URL，移除会干扰嵌入的 meta，
//     并注入 <base> 让图片/CSS 仍从原站加载；
//   - 快照放内存 LRU（有 TTL），因为它只是"取证展示"的临时产物，不落库。
package evidence

import (
	"bytes"
	"fmt"
	"net/http"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// MaxSnapshotBytes 是单个快照保留的最大字节数。
const MaxSnapshotBytes = 4 << 20

// Frameable 判断目标是否允许被我们的页面内嵌。
// 返回 (是否允许, 不允许的原因)。
func Frameable(h http.Header) (bool, string) {
	if v := strings.TrimSpace(h.Get("X-Frame-Options")); v != "" {
		up := strings.ToUpper(v)
		switch {
		case strings.Contains(up, "DENY"):
			return false, "X-Frame-Options: " + v
		case strings.Contains(up, "SAMEORIGIN"):
			return false, "X-Frame-Options: " + v + "（跨源不可嵌入）"
		case strings.Contains(up, "ALLOW-FROM"):
			return false, "X-Frame-Options: " + v + "（ALLOW-FROM 已废弃）"
		}
	}
	if csp := h.Get("Content-Security-Policy"); csp != "" {
		for _, directive := range strings.Split(csp, ";") {
			d := strings.TrimSpace(directive)
			if len(d) < len("frame-ancestors") || !strings.EqualFold(d[:len("frame-ancestors")], "frame-ancestors") {
				continue
			}
			value := strings.TrimSpace(d[len("frame-ancestors"):])
			if value == "" {
				return false, "CSP frame-ancestors 为空（等价 'none'）"
			}
			allowed := false
			for _, src := range strings.Fields(value) {
				if src == "*" || strings.HasPrefix(src, "http://127.0.0.1") || strings.HasPrefix(src, "http://localhost") {
					allowed = true
					break
				}
			}
			if !allowed {
				return false, "CSP frame-ancestors " + value
			}
		}
	}
	return true, ""
}

// Rewrite 把抓到的 HTML 改写成快照。
//
// keepScripts=false 时会剥离脚本与一切可执行入口；true 时保留脚本，
// 但调用方必须用 sandbox="allow-scripts"（且不给 allow-same-origin）来隔离。
func Rewrite(body []byte, baseURL string, keepScripts bool) ([]byte, error) {
	doc, err := html.Parse(bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("evidence: 解析 HTML 失败: %w", err)
	}

	dropped := 0
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for child := n.FirstChild; child != nil; {
			next := child.NextSibling
			if child.Type == html.ElementNode {
				switch strings.ToLower(child.Data) {
				case "script":
					if !keepScripts {
						n.RemoveChild(child)
						dropped++
						child = next
						continue
					}
				case "base":
					// 原有 base 一律移除，最后统一注入，保证相对路径指向目标站
					n.RemoveChild(child)
					child = next
					continue
				case "meta":
					if isBlockingMeta(child) {
						n.RemoveChild(child)
						child = next
						continue
					}
				}
				if !keepScripts {
					stripHandlers(child)
				}
			}
			walk(child)
			child = next
		}
	}
	walk(doc)
	_ = dropped

	injectBase(doc, baseURL)

	var buf bytes.Buffer
	if err := html.Render(&buf, doc); err != nil {
		return nil, fmt.Errorf("evidence: 序列化 HTML 失败: %w", err)
	}
	return buf.Bytes(), nil
}

// isBlockingMeta 识别会阻止/干扰内嵌的 meta。
func isBlockingMeta(n *html.Node) bool {
	var httpEquiv string
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, "http-equiv") {
			httpEquiv = strings.ToLower(strings.TrimSpace(a.Val))
		}
	}
	switch httpEquiv {
	case "content-security-policy", "x-frame-options":
		return true
	}
	return false
}

// stripHandlers 去掉内联事件与 javascript: 伪协议（keepScripts=false 时）。
func stripHandlers(n *html.Node) {
	kept := n.Attr[:0]
	for _, a := range n.Attr {
		key := strings.ToLower(a.Key)
		if strings.HasPrefix(key, "on") {
			continue
		}
		val := strings.ToLower(strings.TrimSpace(a.Val))
		val = strings.ReplaceAll(val, "\t", "")
		val = strings.ReplaceAll(val, "\n", "")
		if strings.HasPrefix(val, "javascript:") {
			continue
		}
		kept = append(kept, a)
	}
	n.Attr = kept
}

// injectBase 在 <head> 最前面插入 <base href>；没有 head 就创建。
func injectBase(doc *html.Node, baseURL string) {
	if baseURL == "" {
		return
	}
	base := &html.Node{
		Type: html.ElementNode,
		Data: "base",
		Attr: []html.Attribute{{Key: "href", Val: baseURL}},
	}
	head := findElement(doc, "head")
	if head == nil {
		htmlNode := findElement(doc, "html")
		if htmlNode == nil {
			return
		}
		head = &html.Node{Type: html.ElementNode, Data: "head"}
		htmlNode.InsertBefore(head, htmlNode.FirstChild)
	}
	head.InsertBefore(base, head.FirstChild)
}

func findElement(n *html.Node, name string) *html.Node {
	if n.Type == html.ElementNode && strings.EqualFold(n.Data, name) {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if found := findElement(c, name); found != nil {
			return found
		}
	}
	return nil
}

/* -------------------------------------------------------------------------- */
/* 快照缓存                                                                    */
/* -------------------------------------------------------------------------- */

// Snapshot 是一份可直接展示的快照。
type Snapshot struct {
	ID          string
	SourceURL   string
	ContentType string
	Body        []byte
	Status      int
	FetchedAt   time.Time
	Truncated   bool
}

// Cache 是带 TTL 的 LRU 快照缓存。
type Cache struct {
	max int
	ttl time.Duration
	m   map[string]*entry
	now func() time.Time
	seq uint64
}

type entry struct {
	snap *Snapshot
	used uint64
}

// NewCache 创建缓存；max<=0 时默认 16 项。
func NewCache(max int, ttl time.Duration) *Cache {
	if max <= 0 {
		max = 16
	}
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	return &Cache{max: max, ttl: ttl, m: make(map[string]*entry), now: time.Now}
}

// Put 存入快照并返回其 ID。
func (c *Cache) Put(s *Snapshot) string {
	c.seq++
	if s.ID == "" {
		s.ID = fmt.Sprintf("ev_%d_%d", c.now().UnixNano(), c.seq)
	}
	if len(s.Body) > MaxSnapshotBytes {
		s.Body = s.Body[:MaxSnapshotBytes]
		s.Truncated = true
	}
	c.m[s.ID] = &entry{snap: s, used: c.seq}
	c.evict()
	return s.ID
}

// Get 读取快照；过期视为不存在。
func (c *Cache) Get(id string) (*Snapshot, bool) {
	e, ok := c.m[id]
	if !ok {
		return nil, false
	}
	if c.now().Sub(e.snap.FetchedAt) > c.ttl {
		delete(c.m, id)
		return nil, false
	}
	c.seq++
	e.used = c.seq
	return e.snap, true
}

func (c *Cache) evict() {
	for len(c.m) > c.max {
		var oldestID string
		var oldest uint64
		first := true
		for id, e := range c.m {
			if first || e.used < oldest {
				oldestID, oldest, first = id, e.used, false
			}
		}
		delete(c.m, oldestID)
	}
}
