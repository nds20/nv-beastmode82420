-- Shop 824 — Error Logs table for EXISTING databases (2026-11-10).
--
-- Adds the error_logs airlock table (see docs/ERROR_LOGS.md and
-- functions/api/_lib/errorLog.js): one row per captured failure —
-- server-side 5xx errors, client-reported browser failures, and
-- 824 Shield blocks — so any failure can be read back with its
-- actual error instead of guessed at. Facts only: NO request
-- bodies, NO headers, NO tokens or secrets are ever stored.
-- Retention is the newest 500 rows, pruned on write.
--
-- NOTE: applying this file is OPTIONAL. The table is also created
-- lazily at runtime (ensureErrorLogsTable in
-- functions/api/_lib/errorLog.js), so existing databases gain it
-- on the first captured error with no migration step. This file
-- documents the same change for operators who prefer explicit DDL.

CREATE TABLE IF NOT EXISTS error_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  request_id    TEXT,
  source        TEXT NOT NULL,
  method        TEXT,
  path          TEXT,
  status        INTEGER,
  error_name    TEXT,
  error_message TEXT,
  detail        TEXT,
  actor         TEXT,
  user_agent    TEXT
);
