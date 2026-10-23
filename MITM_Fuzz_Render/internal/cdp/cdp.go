// Package cdp 是极简的 Chrome DevTools Protocol 客户端。
//
// 只做三件事：发命令、收结果、分发事件——足够驱动无头浏览器做渲染，
// 不引入 Playwright 之类的重依赖（WebSocket 用已有的 gorilla/websocket）。
//
// 会话模型采用 CDP 的 "flat" 模式：连到浏览器级 WebSocket 后，
// 用 Target.attachToTarget(flatten=true) 拿到 sessionId，之后所有页面命令
// 都带上 sessionId 走同一条连接。
package cdp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Error 是 CDP 返回的结构化错误。
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data,omitempty"`
}

func (e *Error) Error() string {
	if e.Data != "" {
		return fmt.Sprintf("cdp: %s (%d): %s", e.Message, e.Code, e.Data)
	}
	return fmt.Sprintf("cdp: %s (%d)", e.Message, e.Code)
}

// Message 是 CDP 的一条报文（命令/响应/事件三合一）。
type Message struct {
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *Error          `json:"error,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
}

// EventHandler 接收事件；handler 内不要阻塞太久，否则会拖慢读循环。
type EventHandler func(Message)

// Client 是一条 CDP 连接。
type Client struct {
	conn *websocket.Conn

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan Message
	events  map[string][]EventHandler
	any     []EventHandler

	closeOnce sync.Once
	closed    chan struct{}
	readErr   atomic.Value // error
}

// Dial 连接浏览器级 WebSocket 端点。
func Dial(ctx context.Context, wsURL string) (*Client, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, resp, err := dialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		return nil, fmt.Errorf("cdp: 连接 %s 失败 (HTTP %d): %w", wsURL, status, err)
	}
	conn.SetReadLimit(64 << 20) // 截图 base64 可能很大
	c := &Client{
		conn:    conn,
		pending: make(map[int64]chan Message),
		events:  make(map[string][]EventHandler),
		closed:  make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

// Closed 在连接关闭后关闭。
func (c *Client) Closed() <-chan struct{} { return c.closed }

// Err 返回读循环的终止原因（正常关闭时为 nil）。
func (c *Client) Err() error {
	if v := c.readErr.Load(); v != nil {
		if err, ok := v.(error); ok {
			return err
		}
	}
	return nil
}

func (c *Client) readLoop() {
	defer c.closeWith(nil)
	for {
		var msg Message
		if err := c.conn.ReadJSON(&msg); err != nil {
			c.closeWith(err)
			return
		}
		if msg.ID != 0 {
			c.mu.Lock()
			ch, ok := c.pending[msg.ID]
			if ok {
				delete(c.pending, msg.ID)
			}
			c.mu.Unlock()
			if ok {
				ch <- msg // 缓冲为 1，不会阻塞
			}
			continue
		}
		// 事件
		c.mu.Lock()
		handlers := append([]EventHandler{}, c.events[msg.Method]...)
		anyHandlers := append([]EventHandler{}, c.any...)
		c.mu.Unlock()
		for _, h := range handlers {
			h(msg)
		}
		for _, h := range anyHandlers {
			h(msg)
		}
	}
}

func (c *Client) closeWith(err error) {
	c.closeOnce.Do(func() {
		if err != nil && !errors.Is(err, websocket.ErrCloseSent) {
			c.readErr.Store(err)
		}
		_ = c.conn.Close()
		close(c.closed)
		c.mu.Lock()
		for id, ch := range c.pending {
			close(ch)
			delete(c.pending, id)
		}
		c.mu.Unlock()
	})
}

// Close 主动关闭连接。
func (c *Client) Close() error {
	c.closeWith(nil)
	return nil
}

// On 订阅事件（method 为 CDP 方法名，如 "Page.loadEventFired"）。
func (c *Client) On(method string, handler EventHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events[method] = append(c.events[method], handler)
}

// OnAny 订阅所有事件（调试用）。
func (c *Client) OnAny(handler EventHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.any = append(c.any, handler)
}

// Call 发送会话级命令（sessionID 为空即浏览器级命令）。
func (c *Client) Call(ctx context.Context, sessionID, method string, params any, out any) error {
	id := atomic.AddInt64(&c.nextID, 1)
	msg := Message{ID: id, Method: method, SessionID: sessionID}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			return fmt.Errorf("cdp: 序列化 %s 参数失败: %w", method, err)
		}
		msg.Params = raw
	}

	ch := make(chan Message, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()

	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.mu.Lock()
	writeErr := c.conn.WriteMessage(websocket.TextMessage, payload)
	c.mu.Unlock()
	if writeErr != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return fmt.Errorf("cdp: 发送 %s 失败: %w", method, writeErr)
	}

	select {
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return fmt.Errorf("cdp: %s 超时: %w", method, ctx.Err())
	case <-c.closed:
		return fmt.Errorf("cdp: 连接已关闭（%s）: %w", method, c.Err())
	case resp, ok := <-ch:
		if !ok {
			return fmt.Errorf("cdp: 连接在等待 %s 响应时关闭: %w", method, c.Err())
		}
		if resp.Error != nil {
			return resp.Error
		}
		if out != nil && len(resp.Result) > 0 {
			if err := json.Unmarshal(resp.Result, out); err != nil {
				return fmt.Errorf("cdp: 解析 %s 响应失败: %w", method, err)
			}
		}
		return nil
	}
}

/* -------------------------------------------------------------------------- */
/* 常用结构体                                                                  */
/* -------------------------------------------------------------------------- */

// CreateBrowserContextResult 是 Target.createBrowserContext 的返回。
type CreateBrowserContextResult struct {
	BrowserContextID string `json:"browserContextId"`
}

// CreateTargetResult 是 Target.createTarget 的返回。
type CreateTargetResult struct {
	TargetID string `json:"targetId"`
}

// AttachResult 是 Target.attachToTarget 的返回。
type AttachResult struct {
	SessionID string `json:"sessionId"`
}

// LayoutMetrics 是 Page.getLayoutMetrics 的返回（只取需要的字段）。
type LayoutMetrics struct {
	CSSContentSize struct {
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	} `json:"cssContentSize"`
	CSSLayoutViewport struct {
		ClientWidth  float64 `json:"clientWidth"`
		ClientHeight float64 `json:"clientHeight"`
	} `json:"cssLayoutViewport"`
}

// ScreenshotResult 是 Page.captureScreenshot 的返回。
type ScreenshotResult struct {
	Data string `json:"data"` // base64 PNG
}

// EvalResult 是 Runtime.evaluate 的返回。
type EvalResult struct {
	Result struct {
		Type  string          `json:"type"`
		Value json.RawMessage `json:"value"`
	} `json:"result"`
	ExceptionDetails *struct {
		Text      string `json:"text"`
		Exception *struct {
			Description string `json:"description"`
		} `json:"exception"`
	} `json:"exceptionDetails"`
}

// UnmarshalValue 把 evaluate 的结果反序列化到 out。
func (r *EvalResult) UnmarshalValue(out any) error {
	if r == nil || len(r.Result.Value) == 0 {
		return errors.New("cdp: evaluate 无返回值")
	}
	return json.Unmarshal(r.Result.Value, out)
}

// AXNode 是 Accessibility.getFullAXTree 的节点（裁剪为便于 Agent 阅读的字段）。
type AXNode struct {
	NodeID      string   `json:"nodeId"`
	Ignored     bool     `json:"ignored"`
	Role        string   `json:"role"`
	Name        string   `json:"name"`
	Value       string   `json:"value,omitempty"`
	Description string   `json:"description,omitempty"`
	ChildIDs    []string `json:"childIds,omitempty"`
}

// AXTreeResult 是 Accessibility.getFullAXTree 的返回。
type AXTreeResult struct {
	Nodes []struct {
		NodeID  string `json:"nodeId"`
		Ignored bool   `json:"ignored"`
		Role    *struct {
			Value string `json:"value"`
		} `json:"role"`
		Name *struct {
			Value string `json:"value"`
		} `json:"name"`
		Value *struct {
			Value any `json:"value"`
		} `json:"value"`
		Description *struct {
			Value string `json:"value"`
		} `json:"description"`
		ChildIDs []string `json:"childIds"`
	} `json:"nodes"`
}

// Flatten 把原始 AX 树裁剪成 Agent 友好的扁平列表（去掉 ignored 与空节点）。
func (r *AXTreeResult) Flatten(limit int) []AXNode {
	if limit <= 0 {
		limit = 300
	}
	out := make([]AXNode, 0, len(r.Nodes))
	for _, n := range r.Nodes {
		if n.Ignored {
			continue
		}
		node := AXNode{NodeID: n.NodeID, ChildIDs: n.ChildIDs}
		if n.Role != nil {
			node.Role = n.Role.Value
		}
		if n.Name != nil {
			node.Name = n.Name.Value
		}
		if n.Description != nil {
			node.Description = n.Description.Value
		}
		if n.Value != nil {
			switch v := n.Value.Value.(type) {
			case string:
				node.Value = v
			default:
				if b, err := json.Marshal(v); err == nil {
					node.Value = string(b)
				}
			}
		}
		if node.Role == "" || node.Role == "none" || node.Role == "generic" {
			if node.Name == "" && node.Value == "" {
				continue // 无语义的容器节点，跳过
			}
		}
		out = append(out, node)
		if len(out) >= limit {
			break
		}
	}
	return out
}
