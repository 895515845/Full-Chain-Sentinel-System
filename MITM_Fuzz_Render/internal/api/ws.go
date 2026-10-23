package api

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/chinaran404/replayd/internal/eventbus"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 8192,
	CheckOrigin:     func(r *http.Request) bool { return sameOrigin(r) },
}

// handleEvents 建立事件推送连接：先发 hello，然后持续推送总线事件并保活。
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.log.Warn("WebSocket 升级失败", "err", err)
		return
	}
	defer func() { _ = conn.Close() }()

	now := time.Now().Format("2006-01-02T15:04:05.000Z07:00")
	if err := conn.WriteJSON(eventbus.Event{
		Type: "hello",
		Seq:  0,
		TS:   now,
		Data: map[string]any{
			"serverTime": now,
			"version":    s.cfg.Version,
		},
	}); err != nil {
		return
	}

	ch, cancel := s.bus.Subscribe(256)
	defer cancel()

	var once sync.Once
	done := make(chan struct{})
	stop := func() { once.Do(func() { close(done) }) }

	// 读循环只用于探测断开与响应 pong；客户端无需发送业务消息。
	go func() {
		defer stop()
		conn.SetReadLimit(4096)
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		conn.SetPongHandler(func(string) error {
			return conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()

	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(ev); err != nil {
				return
			}
		case <-ping.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-done:
			return
		case <-r.Context().Done():
			return
		}
	}
}
