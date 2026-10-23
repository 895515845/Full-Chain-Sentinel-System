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

// ErrConflict 表示乐观锁冲突（资源已被他人修改）。
var ErrConflict = errors.New("store: 资源已被修改")

// Hooks 声明脚本启用的钩子。
type Hooks struct {
	OnRequest  bool `json:"onRequest"`
	OnResponse bool `json:"onResponse"`
	OnAssert   bool `json:"onAssert"`
}

// AllHooks 返回三个钩子全开。
func AllHooks() Hooks { return Hooks{OnRequest: true, OnResponse: true, OnAssert: true} }

// Script 是一段可复用的脚本。
type Script struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
	Lang      string `json:"lang"` // js（M3.5 起支持 py）
	Source    string `json:"source"`
	Hooks     Hooks  `json:"hooks"`
	Enabled   bool   `json:"enabled"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

// ScriptRun 记录一次脚本执行。
type ScriptRun struct {
	ID         string          `json:"id"`
	ScriptID   string          `json:"scriptId"`
	FlowID     string          `json:"flowId,omitempty"`
	OK         bool            `json:"ok"`
	Logs       json.RawMessage `json:"logs,omitempty"`
	Error      string          `json:"error,omitempty"`
	DurationMS int64           `json:"durationMs"`
	CreatedAt  int64           `json:"createdAt"`
}

/* -------------------------------------------------------------------------- */
/* scripts                                                                     */
/* -------------------------------------------------------------------------- */

// ListScripts 按更新时间倒序返回脚本。
func (s *Store) ListScripts(ctx context.Context, projectID string) ([]*Script, error) {
	if projectID == "" {
		pid, err := s.DefaultProjectID(ctx)
		if err != nil {
			return nil, err
		}
		projectID = pid
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, project_id, name, lang, source, hooks, enabled,
		created_at, updated_at FROM scripts WHERE project_id = ? ORDER BY updated_at DESC`, projectID)
	if err != nil {
		return nil, fmt.Errorf("store: 查询脚本失败: %w", err)
	}
	defer rows.Close()

	var out []*Script
	for rows.Next() {
		sc, err := scanScript(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

// GetScript 读取单个脚本。
func (s *Store) GetScript(ctx context.Context, scriptID string) (*Script, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, project_id, name, lang, source, hooks, enabled,
		created_at, updated_at FROM scripts WHERE id = ?`, scriptID)
	sc, err := scanScript(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return sc, err
}

// InsertScript 新建脚本并回填 ID / 时间戳。
func (s *Store) InsertScript(ctx context.Context, sc *Script) error {
	if sc.ID == "" {
		sc.ID = id.New("scr")
	}
	if sc.Lang == "" {
		sc.Lang = "js"
	}
	if sc.Name == "" {
		sc.Name = "未命名脚本"
	}
	if sc.Hooks == (Hooks{}) {
		sc.Hooks = AllHooks()
	}
	now := s.now().UnixMilli()
	if sc.CreatedAt == 0 {
		sc.CreatedAt = now
	}
	sc.UpdatedAt = now
	if sc.ProjectID == "" {
		pid, err := s.DefaultProjectID(ctx)
		if err != nil {
			return err
		}
		sc.ProjectID = pid
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.db.ExecContext(ctx, `INSERT INTO scripts
		(id, project_id, name, lang, source, hooks, enabled, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?)`,
		sc.ID, sc.ProjectID, sc.Name, sc.Lang, sc.Source, marshalHooks(sc.Hooks),
		boolToInt(true) /* 新建默认启用 */, sc.CreatedAt, sc.UpdatedAt)
	if err != nil {
		return fmt.Errorf("store: 写入脚本失败: %w", err)
	}
	sc.Enabled = true
	return nil
}

// ScriptPatch 是脚本的部分更新；nil 表示不改。
type ScriptPatch struct {
	Name     *string
	Source   *string
	Hooks    *Hooks
	Enabled  *bool
	Expected *int64 // 乐观锁：客户端持有的 updatedAt
}

// UpdateScript 应用部分更新；带 Expected 时校验版本。
func (s *Store) UpdateScript(ctx context.Context, scriptID string, patch ScriptPatch) (*Script, error) {
	current, err := s.GetScript(ctx, scriptID)
	if err != nil {
		return nil, err
	}
	if patch.Expected != nil && *patch.Expected != current.UpdatedAt {
		return nil, ErrConflict
	}

	// 时间戳必须严格递增，否则同一毫秒内的两次更新会让乐观锁失效
	next := s.now().UnixMilli()
	if next <= current.UpdatedAt {
		next = current.UpdatedAt + 1
	}
	sets := []string{"updated_at = ?"}
	args := []any{next}
	if patch.Name != nil {
		sets = append(sets, "name = ?")
		args = append(args, *patch.Name)
	}
	if patch.Source != nil {
		sets = append(sets, "source = ?")
		args = append(args, *patch.Source)
	}
	if patch.Hooks != nil {
		sets = append(sets, "hooks = ?")
		args = append(args, marshalHooks(*patch.Hooks))
	}
	if patch.Enabled != nil {
		sets = append(sets, "enabled = ?")
		args = append(args, boolToInt(*patch.Enabled))
	}
	args = append(args, scriptID)

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	res, err := s.db.ExecContext(ctx, `UPDATE scripts SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("store: 更新脚本失败: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return s.GetScript(ctx, scriptID)
}

// DeleteScript 删除脚本及其执行记录（外键级联）。
func (s *Store) DeleteScript(ctx context.Context, scriptID string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	res, err := s.db.ExecContext(ctx, `DELETE FROM scripts WHERE id = ?`, scriptID)
	if err != nil {
		return fmt.Errorf("store: 删除脚本失败: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

/* -------------------------------------------------------------------------- */
/* script_runs                                                                 */
/* -------------------------------------------------------------------------- */

// InsertScriptRun 记录一次执行（失败不影响主流程，由调用方决定是否忽略错误）。
func (s *Store) InsertScriptRun(ctx context.Context, run *ScriptRun) error {
	if run.ID == "" {
		run.ID = id.New("run")
	}
	if run.CreatedAt == 0 {
		run.CreatedAt = s.now().UnixMilli()
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.db.ExecContext(ctx, `INSERT INTO script_runs
		(id, script_id, flow_id, ok, logs, error, duration_ms, created_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		run.ID, nullIfEmpty(run.ScriptID), nullIfEmpty(run.FlowID), boolToInt(run.OK),
		nullIfEmpty(string(run.Logs)), nullIfEmpty(run.Error), run.DurationMS, run.CreatedAt)
	if err != nil {
		return fmt.Errorf("store: 写入脚本执行记录失败: %w", err)
	}
	return nil
}

// ListScriptRuns 返回某脚本最近 limit 次执行。
func (s *Store) ListScriptRuns(ctx context.Context, scriptID string, limit int) ([]*ScriptRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, COALESCE(script_id,''), COALESCE(flow_id,''),
		ok, COALESCE(logs,''), COALESCE(error,''), COALESCE(duration_ms,0), created_at
		FROM script_runs WHERE script_id = ? ORDER BY created_at DESC LIMIT ?`, scriptID, limit)
	if err != nil {
		return nil, fmt.Errorf("store: 查询脚本执行记录失败: %w", err)
	}
	defer rows.Close()

	var out []*ScriptRun
	for rows.Next() {
		var (
			run  ScriptRun
			ok   int
			logs string
		)
		if err := rows.Scan(&run.ID, &run.ScriptID, &run.FlowID, &ok, &logs, &run.Error,
			&run.DurationMS, &run.CreatedAt); err != nil {
			return nil, fmt.Errorf("store: 解析脚本执行记录失败: %w", err)
		}
		run.OK = ok != 0
		if logs != "" {
			run.Logs = json.RawMessage(logs)
		}
		out = append(out, &run)
	}
	return out, rows.Err()
}

/* -------------------------------------------------------------------------- */
/* 内部                                                                        */
/* -------------------------------------------------------------------------- */

func scanScript(sc scanner) (*Script, error) {
	var (
		out     Script
		hooks   string
		enabled int
	)
	if err := sc.Scan(&out.ID, &out.ProjectID, &out.Name, &out.Lang, &out.Source, &hooks,
		&enabled, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.Enabled = enabled != 0
	out.Hooks = unmarshalHooks(hooks)
	return &out, nil
}

func marshalHooks(h Hooks) string {
	b, err := json.Marshal(h)
	if err != nil {
		return `{"onRequest":true,"onResponse":true,"onAssert":true}`
	}
	return string(b)
}

func unmarshalHooks(raw string) Hooks {
	if strings.TrimSpace(raw) == "" {
		return AllHooks()
	}
	var h Hooks
	if err := json.Unmarshal([]byte(raw), &h); err != nil {
		return AllHooks()
	}
	return h
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
