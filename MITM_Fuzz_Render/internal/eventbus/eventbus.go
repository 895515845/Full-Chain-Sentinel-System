// Package eventbus 是进程内的事件广播器，供 WebSocket 推送使用。
//
// 语义：
//   - Publish 永不阻塞：订阅者缓冲满时丢弃该事件（慢客户端不应拖垮服务）；
//   - Subscribe 返回的 cancel 必须调用，否则泄漏；
//   - Seq 单调递增，客户端可据此判断是否丢事件。
package eventbus

import (
	"sync"
	"sync/atomic"
	"time"
)

// Event 是推送给前端的事件信封。
type Event struct {
	Type string `json:"type"`
	Seq  uint64 `json:"seq"`
	TS   string `json:"ts"`
	Data any    `json:"data,omitempty"`
}

// Broker 维护订阅者集合。
type Broker struct {
	mu   sync.RWMutex
	subs map[chan Event]struct{}
	seq  atomic.Uint64
	now  func() time.Time
}

// New 创建 Broker。
func New() *Broker {
	return &Broker{
		subs: make(map[chan Event]struct{}),
		now:  time.Now,
	}
}

// Subscribe 注册一个订阅者；buf 为缓冲深度（建议 256）。
func (b *Broker) Subscribe(buf int) (<-chan Event, func()) {
	if buf < 1 {
		buf = 1
	}
	ch := make(chan Event, buf)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			b.mu.Lock()
			if _, ok := b.subs[ch]; ok {
				delete(b.subs, ch)
				close(ch)
			}
			b.mu.Unlock()
		})
	}
	return ch, cancel
}

// Publish 广播一条事件；data 会被编码进 Event.Data。
func (b *Broker) Publish(typ string, data any) {
	ev := Event{
		Type: typ,
		Seq:  b.seq.Add(1),
		TS:   b.now().Format("2006-01-02T15:04:05.000Z07:00"),
		Data: data,
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subs {
		select {
		case ch <- ev:
		default:
			// 丢弃：该客户端已落后，继续推送只会放大延迟。
		}
	}
}

// Subscribers 返回当前订阅者数量（用于诊断）。
func (b *Broker) Subscribers() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}
