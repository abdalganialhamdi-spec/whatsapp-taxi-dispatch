-- قاعدة بيانات D1 — بوت تكسي واتساب
-- SQLite dialect (D1)

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  aliases TEXT DEFAULT '[]',   -- JSON array من الأسماء البديلة
  belt INTEGER NOT NULL DEFAULT 1  -- 1 مدينة، 2 ضواحي، 3 ريف
);

CREATE TABLE IF NOT EXISTS fixed_fares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_zone_id INTEGER NOT NULL REFERENCES zones(id),
  to_zone_id INTEGER NOT NULL REFERENCES zones(id),
  price INTEGER NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,      -- 9639XXXXXXXX بدون +
  name TEXT NOT NULL,
  car TEXT DEFAULT '',
  plate TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OFFLINE',  -- AVAILABLE | BUSY | OFFLINE
  commission_pct INTEGER NOT NULL DEFAULT 10,
  group_jid TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clients (
  phone TEXT PRIMARY KEY,          -- 9639XXXXXXXX
  name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_phone TEXT NOT NULL,
  from_zone_id INTEGER REFERENCES zones(id),
  to_zone_id INTEGER REFERENCES zones(id),
  from_text TEXT DEFAULT '',
  to_text TEXT DEFAULT '',
  price INTEGER,
  status TEXT NOT NULL DEFAULT 'NEW',
  driver_id INTEGER REFERENCES drivers(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_at TEXT,
  done_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_rides_client ON rides(client_phone, status);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id, assigned_at);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS events (          -- سجل تدقيق بسيط
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER,
  actor TEXT,        -- client:9639.. | driver:12 | system
  action TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- بيانات أولية: أحياء حماة الرئيسية (نموذج مختصر — الأدمن يكمل الباقي)
INSERT OR IGNORE INTO zones (id, name, aliases, belt) VALUES
 (1,  'طريق حلب',        '["شارع حلب","دوار حلب"]', 1),
 (2,  'المخيم',          '["عند المخيم","المخيم القديم"]', 1),
 (3,  'الصابونية',       '["عند الصابونية"]', 1),
 (4,  'جنوب الثكنة',     '["الثكنة الجنوبي","الثكنة"]', 1),
 (5,  'الحاضر',          '["عند الحاضر"]', 1),
 (6,  'العدسة',          '["عند العدسة"]', 1),
 (7,  'الدبله',          '["عند الدبله"]', 1),
 (8,  'القمقومية',       '["القلعة","عند القلعة"]', 1),
 (9,  'كفر الطون',       '["كفرطون"]', 1),
 (10, 'عين الباشا',      '["عنباشا"]', 1),
 (11, 'الحمرا',          '', 1),
 (12, 'الغاب',           '["الغاب الشرقي"]', 2),
 (13, 'محردة',           '["محرده"]', 2),
 (14, 'كفرنبودة',        '["كفر نبوده"]', 2),
 (15, 'سلمية',           '["سلميه"]', 2),
 (16, 'عين حلاقيم',      '', 3);

-- تعاريف يدوية نموذجية (تنطبق قبل أي حساب)
INSERT OR IGNORE INTO fixed_fares (from_zone_id, to_zone_id, price, note) VALUES
 (1, 2,  15000,  'طريق حلب ↔ المخيم'),
 (3, 4,  50000,  'الصابونية ↔ جنوب الثكنة');
