package eventbus

import (
	"testing"
	"time"
)

func TestPublishSubscribe(t *testing.T) {
	b := New()
	ch, cancel := b.Subscribe(4)
	defer cancel()

	b.Publish("hello", map[string]any{"n": 1})

	select {
	case ev := <-ch:
		if ev.Type != "hello" {
			t.Errorf("Type = %q", ev.Type)
		}
		if ev.Seq != 1 {
			t.Errorf("Seq = %d, want 1", ev.Seq)
		}
		if ev.TS == "" {
			t.Error("TS 不应为空")
		}
	case <-time.After(time.Second):
		t.Fatal("未收到事件")
	}
}

func TestPublishNeverBlocks(t *testing.T) {
	b := New()
	_, cancel := b.Subscribe(1)
	defer cancel()

	// 订阅者从不消费，Publish 也不应阻塞。
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			b.Publish("flood", i)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish 被慢订阅者阻塞")
	}
}

func TestCancelStopsDelivery(t *testing.T) {
	b := New()
	ch, cancel := b.Subscribe(2)
	cancel()

	if b.Subscribers() != 0 {
		t.Errorf("取消后订阅者数 = %d", b.Subscribers())
	}
	b.Publish("x", nil)
	if _, ok := <-ch; ok {
		t.Error("取消后 channel 应已关闭")
	}
	// 重复 cancel 不应 panic。
	cancel()
}

func TestSeqMonotonic(t *testing.T) {
	b := New()
	ch, cancel := b.Subscribe(8)
	defer cancel()
	for i := 0; i < 3; i++ {
		b.Publish("e", i)
	}
	var last uint64
	for i := 0; i < 3; i++ {
		ev := <-ch
		if ev.Seq <= last {
			t.Errorf("Seq 非递增: %d 之后是 %d", last, ev.Seq)
		}
		last = ev.Seq
	}
}
