package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestScriptCRUD(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	sc := &Script{Name: "签名脚本", Source: "function onRequest(req){}"}
	if err := s.InsertScript(ctx, sc); err != nil {
		t.Fatalf("InsertScript: %v", err)
	}
	if sc.ID == "" || sc.Lang != "js" || !sc.Enabled {
		t.Fatalf("默认值不对: %+v", sc)
	}
	if !sc.Hooks.OnRequest || !sc.Hooks.OnAssert {
		t.Errorf("默认应三钩子全开: %+v", sc.Hooks)
	}

	// 读取
	got, err := s.GetScript(ctx, sc.ID)
	if err != nil {
		t.Fatalf("GetScript: %v", err)
	}
	if got.Name != "签名脚本" || got.Source != sc.Source {
		t.Errorf("内容不一致: %+v", got)
	}

	// 列表
	list, err := s.ListScripts(ctx, "")
	if err != nil || len(list) != 1 {
		t.Fatalf("ListScripts = %d, err=%v", len(list), err)
	}

	// 部分更新
	newName := "改名了"
	hooks := Hooks{OnRequest: true}
	updated, err := s.UpdateScript(ctx, sc.ID, ScriptPatch{Name: &newName, Hooks: &hooks})
	if err != nil {
		t.Fatalf("UpdateScript: %v", err)
	}
	if updated.Name != newName || updated.Hooks.OnAssert {
		t.Errorf("更新结果: %+v", updated)
	}
	if updated.UpdatedAt < got.UpdatedAt {
		t.Errorf("UpdatedAt 应递增: %d -> %d", got.UpdatedAt, updated.UpdatedAt)
	}

	// 删除
	if err := s.DeleteScript(ctx, sc.ID); err != nil {
		t.Fatalf("DeleteScript: %v", err)
	}
	if _, err := s.GetScript(ctx, sc.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("删除后应 ErrNotFound, got %v", err)
	}
}

func TestScriptOptimisticLock(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	sc := &Script{Name: "并发脚本"}
	if err := s.InsertScript(ctx, sc); err != nil {
		t.Fatal(err)
	}
	stale := sc.UpdatedAt
	name := "被抢先修改"
	if _, err := s.UpdateScript(ctx, sc.ID, ScriptPatch{Name: &name}); err != nil {
		t.Fatal(err)
	}
	// 用旧版本号更新 → 冲突
	other := "我的修改"
	if _, err := s.UpdateScript(ctx, sc.ID, ScriptPatch{Name: &other, Expected: &stale}); !errors.Is(err, ErrConflict) {
		t.Fatalf("应返回 ErrConflict, got %v", err)
	}
	// 用最新版本号 → 成功
	fresh, _ := s.GetScript(ctx, sc.ID)
	if _, err := s.UpdateScript(ctx, sc.ID, ScriptPatch{Name: &other, Expected: &fresh.UpdatedAt}); err != nil {
		t.Fatalf("最新版本号应成功: %v", err)
	}
}

func TestScriptRuns(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	sc := &Script{Name: "有记录的脚本"}
	if err := s.InsertScript(ctx, sc); err != nil {
		t.Fatal(err)
	}

	logs, _ := json.Marshal([]map[string]string{{"level": "info", "message": "signed ok"}})
	run := &ScriptRun{ScriptID: sc.ID, OK: true, Logs: logs, DurationMS: 12}
	if err := s.InsertScriptRun(ctx, run); err != nil {
		t.Fatalf("InsertScriptRun: %v", err)
	}
	if run.ID == "" || run.CreatedAt == 0 {
		t.Errorf("应回填 ID/CreatedAt: %+v", run)
	}
	if err := s.InsertScriptRun(ctx, &ScriptRun{ScriptID: sc.ID, OK: false, Error: "boom"}); err != nil {
		t.Fatal(err)
	}

	runs, err := s.ListScriptRuns(ctx, sc.ID, 10)
	if err != nil {
		t.Fatalf("ListScriptRuns: %v", err)
	}
	if len(runs) != 2 {
		t.Fatalf("应有 2 条记录, got %d", len(runs))
	}
	okCount := 0
	for _, r := range runs {
		if r.OK {
			okCount++
			if len(r.Logs) == 0 {
				t.Error("成功记录应带日志")
			}
		}
	}
	if okCount != 1 {
		t.Errorf("成功记录数 = %d, want 1", okCount)
	}

	// 删除脚本应级联删除执行记录
	if err := s.DeleteScript(ctx, sc.ID); err != nil {
		t.Fatal(err)
	}
	runs, _ = s.ListScriptRuns(ctx, sc.ID, 10)
	if len(runs) != 0 {
		t.Errorf("级联删除后应为 0 条, got %d", len(runs))
	}
}
