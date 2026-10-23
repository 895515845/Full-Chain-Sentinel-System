-- 0001_init.sql — 初始 schema
-- 注意：迁移文件一经发布不可修改；结构变更请新增 000N_*.sql。

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  refcount   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE scripts (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  lang       TEXT NOT NULL CHECK (lang IN ('js','py')),
  source     TEXT NOT NULL DEFAULT '',
  hooks      TEXT NOT NULL DEFAULT '{"onRequest":false,"onResponse":false,"onAssert":false}',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tabs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  raw_request TEXT NOT NULL DEFAULT '',
  script_id   TEXT REFERENCES scripts(id) ON DELETE SET NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_tabs_project ON tabs(project_id, sort_order);

CREATE TABLE flows (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK (source IN ('replay','proxy')),
  ts             INTEGER NOT NULL,
  duration_ms    INTEGER,
  method         TEXT NOT NULL,
  scheme         TEXT NOT NULL,
  host           TEXT NOT NULL,
  port           INTEGER NOT NULL,
  path           TEXT NOT NULL,
  query          TEXT,
  http_version   TEXT,
  req_headers    TEXT NOT NULL,
  req_body_sha   TEXT REFERENCES blobs(sha256),
  req_size       INTEGER NOT NULL DEFAULT 0,
  req_raw_sha    TEXT REFERENCES blobs(sha256),
  status         INTEGER,
  resp_headers   TEXT,
  resp_body_sha  TEXT REFERENCES blobs(sha256),
  resp_size      INTEGER,
  resp_raw_sha   TEXT REFERENCES blobs(sha256),
  tls            TEXT,
  timings        TEXT,
  error          TEXT,
  tags           TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_flows_ts        ON flows(ts DESC, id DESC);
CREATE INDEX idx_flows_host_ts   ON flows(host, ts DESC);
CREATE INDEX idx_flows_status    ON flows(status) WHERE status IS NOT NULL;
CREATE INDEX idx_flows_source_ts ON flows(source, ts DESC);

CREATE TABLE script_runs (
  id          TEXT PRIMARY KEY,
  script_id   TEXT REFERENCES scripts(id) ON DELETE CASCADE,
  flow_id     TEXT REFERENCES flows(id) ON DELETE SET NULL,
  ok          INTEGER NOT NULL,
  logs        TEXT,
  error       TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_script_runs_script ON script_runs(script_id, created_at DESC);

CREATE TABLE settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
