-- 0004: سجل الرسائل الموحد (وارد + صادر) — رقم الشركة: بشر أو AI
-- كل رسالة بتمر على الـ Worker بتتخزن هون قبل أي معالجة.

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,          -- in = من الزبون/السائق | out = من البوت/البشر عبر اللوحة
  chat_id TEXT NOT NULL,            -- JID (شخص @s.whatsapp.net / مجموعة @g.us)
  sender_phone TEXT NOT NULL,       -- رقم المرسل 9639.. | 'BOT' للصادر الآلي | رقم الأدمن للرد البشري
  text TEXT NOT NULL,
  intent TEXT,                      -- نية NLU للوارد (BOOK/CONFIRM/...) — NULL قبل الفهم
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_phone, id);

-- إعدادات وضع الشركة (تُضبط من اللوحة — قسم الإعدادات):
-- ai_enabled=1 الذكاء الاصطناعي مساعد فهم (افتراضي مفعّل إذا في مفتاح)
-- ai_chat=1 رد AI حر عند الرسائل غير المفهومة (افتراضي 0 — القوائم فقط)
-- paused_chats JSON array أرقام موقوف عنها البوت (الرد بشر من اللوحة فقط)
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('ai_enabled', '1'),
  ('ai_chat', '0'),
  ('paused_chats', '[]');
