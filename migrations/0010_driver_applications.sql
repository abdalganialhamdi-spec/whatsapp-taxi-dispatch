-- 0010: دورة تقديم السواقين + أدوار الإدارة
-- غريب → بدي صير سائق → جمع بيانات → موافقة المدير → تسجيل + إضافة للمجموعة
CREATE TABLE IF NOT EXISTS driver_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,       -- 9639XXXXXXXX
  name TEXT DEFAULT '',
  car TEXT DEFAULT '',
  plate TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('manager_phone', ''),            -- المدير: الموافقات (على أرض الواقع)
  ('drivers_group_invite', '');      -- رابط دعوة المجموعة (fallback للإضافة المباشرة)

-- 0011: سجل مشاكل المشرف الخلفي
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,        -- STUCK_RIDE | SEND_FAIL | LID_UNKNOWN | DROPPED_CONV | CANCEL_AFTER_ASSIGN | AI_FAIL
  severity TEXT NOT NULL,    -- high | med | low
  detail TEXT NOT NULL,
  ref_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- new | acked | fixed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, kind);
