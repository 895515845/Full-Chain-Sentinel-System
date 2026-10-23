package cdp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeCDP 起一个假的 DevTools 端点，用于验证客户端的收发与事件分发。
func fakeCDP(t *testing.T) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		for {
			var msg Message
			if err := conn.ReadJSON(&msg); err != nil {
				return
			}
			switch msg.Method {
			case "Test.echo":
				result, _ := json.Marshal(map[string]any{"session": msg.SessionID, "params": json.RawMessage(msg.Params)})
				reply := Message{ID: msg.ID, SessionID: msg.SessionID, Result: result}
				if err := conn.WriteJSON(reply); err != nil {
					return
				}
			case "Test.fail":
				reply := Message{ID: msg.ID, Error: &Error{Code: -32000, Message: "嘣", Data: "详情"}}
				if err := conn.WriteJSON(reply); err != nil {
					return
				}
			case "Test.withEvent":
				// 先推事件，再回结果
				_ = conn.WriteJSON(Message{Method: "Page.loadEventFired", SessionID: msg.SessionID,
					Params: json.RawMessage(`{"timestamp":123}`)})
				_ = conn.WriteJSON(Message{ID: msg.ID, SessionID: msg.SessionID,
					Result: json.RawMessage(`{"ok":true}`)})
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func dialFake(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, wsURL)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestCallResultAndSession(t *testing.T) {
	client := dialFake(t, fakeCDP(t))

	var out struct {
		Session string          `json:"session"`
		Params  json.RawMessage `json:"params"`
	}
	ctx := context.Background()
	if err := client.Call(ctx, "SESS-1", "Test.echo", map[string]any{"a": 1}, &out); err != nil {
		t.Fatalf("Call: %v", err)
	}
	if out.Session != "SESS-1" {
		t.Errorf("sessionId 未透传: %q", out.Session)
	}
	if !strings.Contains(string(out.Params), `"a":1`) {
		t.Errorf("params 未透传: %s", out.Params)
	}

	// 不需要返回值的命令
	if err := client.Call(ctx, "SESS-1", "Test.echo", nil, nil); err != nil {
		t.Errorf("out=nil 也应工作: %v", err)
	}
}

func TestCallErrorPropagation(t *testing.T) {
	client := dialFake(t, fakeCDP(t))
	err := client.Call(context.Background(), "", "Test.fail", nil, nil)
	if err == nil {
		t.Fatal("应返回错误")
	}
	var cdpErr *Error
	if !strings.Contains(err.Error(), "嘣") || !strings.Contains(err.Error(), "详情") {
		t.Errorf("错误信息不完整: %v", err)
	}
	_ = cdpErr
}

func TestEventHandler(t *testing.T) {
	client := dialFake(t, fakeCDP(t))

	var (
		mu     sync.Mutex
		events []string
	)
	done := make(chan struct{})
	client.On("Page.loadEventFired", func(msg Message) {
		mu.Lock()
		events = append(events, msg.Method+":"+msg.SessionID)
		mu.Unlock()
		close(done)
	})

	if err := client.Call(context.Background(), "SESS-9", "Test.withEvent", nil, nil); err != nil {
		t.Fatalf("Call: %v", err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("未收到事件")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 1 || events[0] != "Page.loadEventFired:SESS-9" {
		t.Errorf("事件分发不对: %v", events)
	}
}

func TestConcurrentCalls(t *testing.T) {
	client := dialFake(t, fakeCDP(t))
	ctx := context.Background()

	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			var out struct {
				Params json.RawMessage `json:"params"`
			}
			if err := client.Call(ctx, "", "Test.echo", map[string]any{"n": n}, &out); err != nil {
				errs <- err
				return
			}
			var echoed struct {
				N int `json:"n"`
			}
			if err := json.Unmarshal(out.Params, &echoed); err != nil || echoed.N != n {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("并发调用出错: %v", err)
		}
	}
}

func TestCallAfterCloseAndTimeout(t *testing.T) {
	srv := fakeCDP(t)
	client := dialFake(t, srv)

	// 超时：用一个不存在的命令（假服务器不回），验证 ctx 生效
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if err := client.Call(ctx, "", "Test.nobodyAnswers", nil, nil); err == nil {
		t.Error("应因超时报错")
	}

	// 关闭后调用应立刻失败
	_ = client.Close()
	select {
	case <-client.Closed():
	case <-time.After(2 * time.Second):
		t.Fatal("关闭后 Closed() 应关闭")
	}
	if err := client.Call(context.Background(), "", "Test.echo", nil, nil); err == nil {
		t.Error("关闭后调用应报错")
	}
}

func TestAXTreeFlatten(t *testing.T) {
	raw := `{"nodes":[
	  {"nodeId":"1","role":{"value":"RootWebArea"},"name":{"value":"页面"}},
	  {"nodeId":"2","ignored":true,"role":{"value":"generic"}},
	  {"nodeId":"3","role":{"value":"button"},"name":{"value":"提交"},"childIds":["4"]},
	  {"nodeId":"4","role":{"value":"generic"}},
	  {"nodeId":"5","role":{"value":"textbox"},"value":{"value":"admin"}}
	]}`
	var tree AXTreeResult
	if err := json.Unmarshal([]byte(raw), &tree); err != nil {
		t.Fatal(err)
	}
	nodes := tree.Flatten(10)
	// ignored 与「无语义的 generic」应被过滤，只留 3 个有意义的节点
	if len(nodes) != 3 {
		t.Fatalf("扁平化后 %d 个节点, want 3: %+v", len(nodes), nodes)
	}
	if nodes[1].Role != "button" || nodes[1].Name != "提交" {
		t.Errorf("按钮节点不对: %+v", nodes[1])
	}
	if nodes[2].Role != "textbox" || nodes[2].Value != "admin" {
		t.Errorf("输入框节点不对: %+v", nodes[2])
	}
}
