-- ربط السواقين بهوية واتساب المخفية (LID)
-- المشكلة: رسائل المجموعات تصل أحياناً بـ participant بصيغة @lid بلا senderPn،
-- فيصل الرقم الحقيقي مجهولاً ويفشل getDriverByPhone رغم أن السائق مسجل.
-- الحل: عمود lid يُتعلم تلقائياً عند كل رسالة محلولة، والمطابقة تصبح بالرقم أو بالـLID.
ALTER TABLE drivers ADD COLUMN lid TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_drivers_lid ON drivers(lid);
