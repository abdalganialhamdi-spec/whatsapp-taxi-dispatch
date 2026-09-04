-- 0002: idempotency للرسائل الواردة (dedupe على مستوى الـ Worker)
CREATE TABLE IF NOT EXISTS processed_messages (
  msg_id     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_processed_created ON processed_messages (created_at);
