-- 0008: روتين الزبائن — تعلّم تلقائي من المشاوير المنفذة
-- كل مشوار DONE بيزيد عدّاد نمط (زبون، من، إلى، يوم الأسبوع، الساعة)
-- حتى يصير عند البوت «ذاكرة روتين»: عميل أ كل يوم الساعة ٧ من البيت للدوام.
-- يوم العطل/الاستثناء ما ينحفظ كقاعدة — الـ AI يسأل الزبون للتأكيد لما يذكر يوماً مختلفاً.

CREATE TABLE IF NOT EXISTS client_routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,                 -- 9639XXXXXXXX
  from_zone_id INTEGER NOT NULL REFERENCES zones(id),
  to_zone_id INTEGER NOT NULL REFERENCES zones(id),
  dow INTEGER,                         -- 0=الأحد .. 6=السبت، NULL = كل يوم
  hour INTEGER NOT NULL,               -- 0-23 (بتوقيت سوريا)
  hits INTEGER NOT NULL DEFAULT 1,     -- كم مرة تكرر هالنمط
  last_at TEXT,                        -- آخر مرة انفذ
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(phone, from_zone_id, to_zone_id, dow, hour)
);

CREATE INDEX IF NOT EXISTS idx_routines_phone ON client_routines(phone, hits DESC);
