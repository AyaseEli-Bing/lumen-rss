/**
 * 数据层：SQLite（node:sqlite 内置模块，零外部依赖）
 *
 * 一致性设计要点：
 * 1. 单连接 + 同步 API：Node 单线程下，任何一段同步的「读-改-写」都不会被其它请求插入，
 *    天然避免竞态；配合 BEGIN IMMEDIATE 事务，保证多表写入原子生效。
 * 2. WAL 日志模式 + busy_timeout：崩溃后可恢复，且不会因为外部读取而失败。
 * 3. UNIQUE 约束兜底：folders.name、feeds.url、articles(feed_id, guid) 三层唯一，
 *    即使上层逻辑出现重复请求，数据库层面也不会产生脏数据。
 * 4. 用户态字段（read / starred）与抓取态字段分离，抓取更新语句永不触碰用户态字段。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  collapsed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
  id              TEXT PRIMARY KEY,
  url             TEXT NOT NULL UNIQUE,
  site_url        TEXT,
  title           TEXT NOT NULL DEFAULT '',
  custom_title    TEXT,
  description     TEXT,
  icon_url        TEXT,
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  interval_min    INTEGER NOT NULL DEFAULT 30,
  enabled         INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  etag            TEXT,
  last_modified   TEXT,
  last_fetched_at INTEGER,
  last_success_at INTEGER,
  next_fetch_at   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'idle',
  error_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feeds_folder ON feeds(folder_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_feeds_due    ON feeds(enabled, next_fetch_at);

CREATE TABLE IF NOT EXISTS articles (
  id            TEXT PRIMARY KEY,
  feed_id       TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid          TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  link          TEXT,
  author        TEXT,
  summary       TEXT,
  content_html  TEXT,
  search_blob   TEXT NOT NULL DEFAULT '',
  published_at  INTEGER NOT NULL DEFAULT 0,
  fetched_at    INTEGER NOT NULL,
  read          INTEGER NOT NULL DEFAULT 0,
  starred       INTEGER NOT NULL DEFAULT 0,
  read_at       INTEGER,
  starred_at    INTEGER,
  UNIQUE(feed_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_art_feed_time ON articles(feed_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_art_time      ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_art_read      ON articles(read, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_art_starred   ON articles(starred, published_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id    TEXT,
  started_at INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  new_count  INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  message    TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_time ON refresh_log(started_at DESC);
`;

const DEFAULT_SETTINGS = {
  global_refresh_min: 30,
  max_concurrency: 6,
  per_host_concurrency: 2,
  request_timeout_ms: 20000,
  max_response_bytes: 8 * 1024 * 1024,
  mark_read_on_open: 1,
  show_full_content: 1,
  theme: 'auto'
};

export function createDatabase(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const stmt = (sql) => db.prepare(sql);

  /** 事务包装：fn 必须是同步函数（保证不会被 await 打断）。 */
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始错误 */ }
      throw err;
    }
  };

  /** 批量事务：把数组分块写入，避免单个超长事务阻塞其它写入。 */
  const txBatch = (rows, size, fn) => {
    let applied = 0;
    for (let i = 0; i < rows.length; i += size) {
      applied += tx(() => {
        let n = 0;
        for (const row of rows.slice(i, i + size)) n += fn(row) || 0;
        return n;
      });
    }
    return applied;
  };

  const api = {
    raw: db,
    stmt,
    tx,
    txBatch,
    close: () => db.close(),

    getSetting(key) {
      const row = stmt('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row) return DEFAULT_SETTINGS[key] ?? null;
      try { return JSON.parse(row.value); } catch { return row.value; }
    },

    setSetting(key, value) {
      stmt('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value));
      return value;
    },

    allSettings() {
      const out = { ...DEFAULT_SETTINGS };
      for (const row of stmt('SELECT key, value FROM settings').all()) {
        try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
      }
      return out;
    },

    /** 把变更提交到磁盘（WAL checkpoint），便于备份与迁移。 */
    checkpoint() {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
    }
  };

  return api;
}

export function defaultDbPath(dataDir) {
  return join(dataDir, 'lumen.sqlite');
}
