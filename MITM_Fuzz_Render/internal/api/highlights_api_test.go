package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/chinaran404/replayd/internal/store"
)

func TestTabHighlightsAPI(t *testing.T) {
	srv, ts, token := newTestServer(t)
	ctx := context.Background()

	// 通过 API 建一个标签页
	code, data := apiCall(t, ts, token, http.MethodPost, "/api/tabs", `{"name":"高亮测试"}`)
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("建标签页 status = %d (%s)", code, data)
	}
	var tab store.Tab
	if err := json.Unmarshal(data, &tab); err != nil || tab.ID == "" {
		t.Fatalf("解析标签页失败: %s", data)
	}

	// 保存高亮（含一条非法项，应被丢弃）
	payload := `{
	  "request":[{"start":0,"end":3,"color":"yellow"},{"start":100,"end":50,"color":"red"}],
	  "response":{"raw":[{"start":10,"end":20,"color":"blue"}],"pretty":[],"bogusviewname_way_too_long":[]}
	}`
	code, data = apiCall(t, ts, token, http.MethodPut, "/api/tabs/"+tab.ID+"/highlights", payload)
	if code != http.StatusBadRequest {
		t.Fatalf("超长视图名应 400，实际 %d (%s)", code, data)
	}

	payload = `{
	  "request":[{"start":0,"end":3,"color":"yellow"},{"start":100,"end":50,"color":"red"}],
	  "response":{"raw":[{"start":10,"end":20,"color":"blue"}]}
	}`
	code, data = apiCall(t, ts, token, http.MethodPut, "/api/tabs/"+tab.ID+"/highlights", payload)
	if code != http.StatusOK {
		t.Fatalf("保存高亮 status = %d (%s)", code, data)
	}
	var saved store.Tab
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	got := string(saved.Highlights)
	if !strings.Contains(got, "yellow") || !strings.Contains(got, "blue") {
		t.Errorf("合法高亮应保存: %s", got)
	}
	if strings.Contains(got, "red") || strings.Contains(got, `"start":100`) {
		t.Errorf("非法高亮（end<start）应被丢弃: %s", got)
	}

	// 重新读取：模拟无头截图那种全新上下文
	code, data = apiCall(t, ts, token, http.MethodGet, "/api/tabs/"+tab.ID, "")
	if code != http.StatusOK || !strings.Contains(string(data), "yellow") {
		t.Errorf("重读应带高亮: %d %s", code, data)
	}
	stored, err := srv.store.GetTab(ctx, tab.ID)
	if err != nil || !strings.Contains(string(stored.Highlights), "blue") {
		t.Errorf("store 里应有高亮: %v %s", err, stored.Highlights)
	}

	// 清空
	code, data = apiCall(t, ts, token, http.MethodPut, "/api/tabs/"+tab.ID+"/highlights", `{}`)
	if code != http.StatusOK || strings.Contains(string(data), "yellow") {
		t.Errorf("清空失败: %d %s", code, data)
	}

	// 参数错误与鉴权
	code, _ = apiCall(t, ts, token, http.MethodPut, "/api/tabs/"+tab.ID+"/highlights", `{"request":[{"start":0,"end":1,"color":"pink"}]}`)
	if code != http.StatusOK {
		t.Errorf("非法颜色应被静默丢弃而不是报错，实际 %d", code)
	}
	code, _ = apiCall(t, ts, token, http.MethodPut, "/api/tabs/tab_missing/highlights", `{"request":[{"start":0,"end":1,"color":"red"}]}`)
	if code != http.StatusNotFound {
		t.Errorf("不存在的标签应 404，实际 %d", code)
	}
	code, _ = apiCall(t, ts, token, http.MethodPut, "/api/tabs/"+tab.ID+"/highlights", `{not json`)
	if code != http.StatusBadRequest {
		t.Errorf("非法 JSON 应 400，实际 %d", code)
	}
	code, _ = apiCall(t, ts, "", http.MethodPut, "/api/tabs/"+tab.ID+"/highlights", `{}`)
	if code != http.StatusUnauthorized {
		t.Errorf("未鉴权应 401，实际 %d", code)
	}
}
