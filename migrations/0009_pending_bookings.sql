-- 0009: حجز معلق ناقص — الزبون قال «بدي روح ع القصور» (الوجه فقط)
-- نخزن الوجه ونطلب الجزء الناقص بس، ولما يجاوب نكمل الحجز بدون إعادة السؤال.
CREATE TABLE IF NOT EXISTS pending_bookings (
  chat_id TEXT PRIMARY KEY,          -- محادثة الزبون
  from_zone_id INTEGER REFERENCES zones(id),
  to_zone_id INTEGER REFERENCES zones(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
