package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/chinaran404/replayd/internal/id"
)

// Tab 是 Repeater 的持久化标签页。
type Tab struct {
	ID         string `json:"id"`
	ProjectID  string `json:"projectId"`
	Name       string `json:"name"`
	RawRequest string `json:"rawRequest"`
	ScriptID   string `json:"scriptId,omitempty"`
	// Highlights 是高亮标记的 JSON（请求 + 各视图的响应），由前端生成、服务端原样保存。
	Highlights json.RawMessage `json:"highlights,omitempty"`
	SortOrder  int             `json:"sortOrder"`
	CreatedAt  int64           `json:"createdAt"`
	UpdatedAt  int64           `json:"updatedAt"`
}

// ListTabs 按排序返回项目下的全部标签页。
func (s *Store) ListTabs(ctx context.Context, projectID string) ([]*Tab, error) {
	if projectID == "" {
		pid, err := s.DefaultProjectID(ctx)
		if err != nil {
			return nil, err
		}
		projectID = pid
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, project_id, name, raw_request, COALESCE(highlights, ''),
		COALESCE(script_id,''), sort_order, created_at, updated_at
		FROM tabs WHERE project_id = ? ORDER BY sort_order, created_at`, projectID)
	if err != nil {
		return nil, fmt.Errorf("store: 查询标签页失败: %w", err)
	}
	defer rows.Close()

	var out []*Tab
	for rows.Next() {
		t := &Tab{}
		var highlights string
		if err := rows.Scan(&t.ID, &t.ProjectID, &t.Name, &t.RawRequest, &highlights,
			&t.ScriptID, &t.SortOrder, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("store: 解析标签页失败: %w", err)
		}
		if highlights != "" && json.Valid([]byte(highlights)) {
			t.Highlights = json.RawMessage(highlights)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetTab 读取单个标签页。
func (s *Store) GetTab(ctx context.Context, tabID string) (*Tab, error) {
	t := &Tab{}
	var highlights string
	err := s.db.QueryRowContext(ctx, `SELECT id, project_id, name, raw_request, COALESCE(highlights, ''),
		COALESCE(script_id,''), sort_order, created_at, updated_at
		FROM tabs WHERE id = ?`, tabID).
		Scan(&t.ID, &t.ProjectID, &t.Name, &t.RawRequest, &highlights,
			&t.ScriptID, &t.SortOrder, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: 读取标签页失败: %w", err)
	}
	if highlights != "" && json.Valid([]byte(highlights)) {
		t.Highlights = json.RawMessage(highlights)
	}
	return t, nil
}

// InsertTab 新建标签页；ID 与时间戳为空时自动填充。
func (s *Store) InsertTab(ctx context.Context, t *Tab) error {
	if t.ID == "" {
		t.ID = id.New("tab")
	}
	now := s.now().UnixMilli()
	if t.CreatedAt == 0 {
		t.CreatedAt = now
	}
	t.UpdatedAt = now
	if t.ProjectID == "" {
		pid, err := s.DefaultProjectID(ctx)
		if err != nil {
			return err
		}
		t.ProjectID = pid
	}
	if t.Name == "" {
		t.Name = "未命名"
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.db.ExecContext(ctx, `INSERT INTO tabs
		(id, project_id, name, raw_request, script_id, sort_order, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		t.ID, t.ProjectID, t.Name, t.RawRequest, nullIfEmpty(t.ScriptID),
		t.SortOrder, t.CreatedAt, t.UpdatedAt)
	if err != nil {
		return fmt.Errorf("store: 写入标签页失败: %w", err)
	}
	return nil
}

// UpdateTabHighlights 覆盖保存标签页的高亮标记（JSON 原样存储）。
func (s *Store) UpdateTabHighlights(ctx context.Context, tabID, highlights string) (*Tab, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	res, err := s.db.ExecContext(ctx,
		`UPDATE tabs SET highlights = ?, updated_at = ? WHERE id = ?`,
		nullIfEmpty(highlights), s.now().UnixMilli(), tabID)
	if err != nil {
		return nil, fmt.Errorf("store: 保存高亮失败: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return s.GetTab(ctx, tabID)
}

// TabPatch 是部分更新；nil 字段保持不变。
type TabPatch struct {
	Name       *string
	RawRequest *string
	ScriptID   *string // 空字符串表示清除
}

// UpdateTab 应用部分更新并返回新值。
func (s *Store) UpdateTab(ctx context.Context, tabID string, patch TabPatch) (*Tab, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	next := s.now().UnixMilli()
	sets := []string{"updated_at = ?"}
	args := []any{next}
	if patch.Name != nil {
		sets = append(sets, "name = ?")
		args = append(args, *patch.Name)
	}
	if patch.RawRequest != nil {
		sets = append(sets, "raw_request = ?")
		args = append(args, *patch.RawRequest)
	}
	if patch.ScriptID != nil {
		sets = append(sets, "script_id = ?")
		args = append(args, nullIfEmpty(*patch.ScriptID))
	}
	args = append(args, tabID)

	res, err := s.db.ExecContext(ctx,
		`UPDATE tabs SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("store: 更新标签页失败: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return s.GetTab(ctx, tabID)
}

// DeleteTab 删除标签页。
func (s *Store) DeleteTab(ctx context.Context, tabID string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	res, err := s.db.ExecContext(ctx, `DELETE FROM tabs WHERE id = ?`, tabID)
	if err != nil {
		return fmt.Errorf("store: 删除标签页失败: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
