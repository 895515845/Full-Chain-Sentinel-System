-- 0002_artifacts.sql — 渲染/取证产物（截图、文本快照等）
-- 按产品决定：产物永久保留，只提供手动删除接口，不做自动清理。

CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  job_id       TEXT,
  kind         TEXT NOT NULL,              -- screenshot-viewport | screenshot-full | text | a11y | html
  content_type TEXT NOT NULL,
  blob_sha     TEXT NOT NULL REFERENCES blobs(sha256),
  size         INTEGER NOT NULL,
  meta         TEXT,                       -- JSON：宽高、来源 URL、job 信息等
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_created ON artifacts(created_at DESC);
CREATE INDEX idx_artifacts_kind    ON artifacts(kind, created_at DESC);
CREATE INDEX idx_artifacts_job     ON artifacts(job_id);
