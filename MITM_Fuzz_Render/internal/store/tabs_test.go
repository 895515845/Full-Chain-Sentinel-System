package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestTabHighlightsRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	tab := &Tab{Name: "高亮标签", RawRequest: "GET / HTTP/1.1\r\n\r\n"}
	if err := s.InsertTab(ctx, tab); err != nil {
		t.Fatalf("InsertTab: %v", err)
	}
	if len(tab.Highlights) != 0 {
		t.Errorf("新标签不应有高亮: %s", tab.Highlights)
	}

	payload := `{"request":[{"start":0,"end":3,"color":"yellow"}],"response":{"raw":[{"start":9,"end":15,"color":"green"}]}}`
	updated, err := s.UpdateTabHighlights(ctx, tab.ID, payload)
	if err != nil {
		t.Fatalf("UpdateTabHighlights: %v", err)
	}
	if !json.Valid(updated.Highlights) || !strings.Contains(string(updated.Highlights), "yellow") {
		t.Errorf("高亮未保存: %s", updated.Highlights)
	}

	// 重新读取（模拟另一次请求/无头截图那种全新上下文）
	got, err := s.GetTab(ctx, tab.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got.Highlights), `"end":15`) {
		t.Errorf("重读高亮不一致: %s", got.Highlights)
	}
	list, err := s.ListTabs(ctx, "")
	if err != nil || len(list) != 1 {
		t.Fatalf("ListTabs = %d, err=%v", len(list), err)
	}
	if !strings.Contains(string(list[0].Highlights), "green") {
		t.Errorf("列表里的高亮丢失: %s", list[0].Highlights)
	}

	// 清空
	cleared, err := s.UpdateTabHighlights(ctx, tab.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(cleared.Highlights) != 0 {
		t.Errorf("清空后不应有高亮: %s", cleared.Highlights)
	}

	if _, err := s.UpdateTabHighlights(ctx, "tab_missing", payload); !errors.Is(err, ErrNotFound) {
		t.Errorf("不存在的标签应 ErrNotFound, got %v", err)
	}
}
