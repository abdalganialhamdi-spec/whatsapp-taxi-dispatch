# 01 — Revive Roadmap

خط سير إحياء بوت التكسي من الحالة الحالية (فشل صامت كامل) حتى أول رحلة حقيقية.
**قاعدة حاكمة:** رقم الـ bridge لا يُلمس، ومجلد `gateway/session` الرسمي لا يُمسح إلا بطلب صريح — الاقتران الجديد يذهب إلى مجلد جلسة منفصل.
**بوابة حاكمة ثانية:** لا تُجرِّب أي اقتران قبل إنهاء المرحلة 1؛ محاولات الاقتران محدودة عند واتساب وحرقها بكود مكسور أغلى من الوقت.

الرموز المستخدمة: الخدمة `taxi-gateway`، الـ Worker `taxi-worker`، قاعدة D1 `taxi-db`، البوابة محلياً `http://127.0.0.1:8787`، عبر الويب `https://almaih.cloud/g`.

---

## المرحلة 0 — تجميد وحفظ (30 دقيقة)

**S0.1 — نسخة احتياطية من الجلسة الحالية**
- الهدف: حماية أغلى أصل عندك قبل أي تعديل.
- الأمر:
```bash
sudo systemctl stop taxi-gateway
sudo mkdir -p /root/backups && sudo chmod 700 /root/backups
sudo tar -czf /root/backups/session-$(date +%F-%H%M).tgz -C /opt/taxi-bot gateway/session
sudo tar -tzf /root/backups/session-$(date +%F-%H%M).tgz | head
```
- التحقق: الأرشيف يحتوي `creds.json` وحجمه > 0.
- لو فشل: لا تكمل. `ls -la /opt/taxi-bot/gateway/session` وتأكد من المسار الحقيقي في unit file: `systemctl cat taxi-gateway`.

**S0.2 — نسخة من D1 + snapshot للسكيما**
- الأمر:
```bash
npx wrangler d1 export taxi-db --remote --output=./backups/d1-$(date +%F).sql
npx wrangler d1 execute taxi-db --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```
- التحقق: ملف SQL فيه `CREATE TABLE rides` و`outbox`.
- لو فشل: `npx wrangler whoami` وتأكد من `database_id` في `wrangler.toml`.

**S0.3 — فصل الأسرار (يعالج P1-15 بوابة / P1-1 worker)**
- الهدف: `GATEWAY_TOKEN ≠ ADMIN_KEY` قبل أي نشر.
- الأمر:
```bash
openssl rand -hex 32           # للبوابة
npx wrangler secret put GATEWAY_TOKEN
# على الـ VPS: أضِف GATEWAY_TOKEN=<same> إلى /etc/taxi-gateway.env ثم chmod 600
```
- التحقق: `grep -c GATEWAY_TOKEN /etc/taxi-gateway.env` = 1، والقيمة نفسها في الجهتين، ولا تساوي `ADMIN_KEY`.
- لو فشل: لا تنشر. أضف في البوابة عند الإقلاع: `if (!GATEWAY_TOKEN || GATEWAY_TOKEN === ADMIN_KEY || GATEWAY_TOKEN.length < 16) process.exit(1)`.

---

## المرحلة 1 — إصلاح P0 في البوابة (ساعة) — بدون هذا لا شيء يعمل

**S1.1 — P0-1: `gen` يُزاد مرتين**
- الإجراء: في `startWhatsApp`، احذف `gen++` الأولى واجعلها `killSock(); const myGen = gen;`.
- التحقق: بعد إعادة التشغيل، `state.connection` يتحرك من `initializing` إلى `connecting/waiting_scan` — هذا هو الدليل الوحيد المقبول.
- لو بقي `initializing`: أضف log مؤقتاً بعد `useMultiFileAuthState` يطبع `{myGen, gen}`؛ لازم يكونا متساويين.

**S1.2 — P0-2: تعريف `worker()`**
```js
async function worker(path, method = 'GET', body) {
  const res = await fetch(WORKER_URL + path, {
    method,
    headers: { 'x-gateway-token': GATEWAY_TOKEN, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`worker ${path} ${res.status}`);
  return res.status === 204 ? null : res.json();
}
```

**S1.3 — إصلاحات مانعة للاقتران (تُنفَّذ الآن لا لاحقاً)**
- P1-10: `/^[1-9]\d{7,14}$/` بدل `/^9\d{8,14}$/` — بدونها كل رقم سيم جديدة أو Cloud API قد يُرفض بـ 400.
- P1-11: `/pair/*` لا يمسح الجلسة إلا `state.connection === 'closed'` **و** `body.force === true`.
- P1-12: `await Promise.race([sock.logout(), new Promise(r=>setTimeout(r,5000))]).catch(()=>{})`.
- P1-2 + P1-1: أضف `msgId: m.key.id, ts: Number(m.messageTimestamp)` إلى payload الـ webhook، وانقل `seenIds.set` لبعد نجاح الاستدعاء.
- P1-3: `if (type !== 'notify') return;` + تجاهل `ts*1000 < startedAt - 300000`.
- P2-9: `const num = (v,d)=> Number.isFinite(Number(v)) ? Number(v) : d;` لكل env رقمي.
- مسار جلسة منفصل للحساب الجديد: `SESSION_DIR=/opt/taxi-bot/gateway/session-b` في env — الجلسة القديمة تبقى كما هي.

**S1.4 — تشغيل والتحقق**
```bash
node --check /opt/taxi-bot/gateway.mjs
sudo systemctl restart taxi-gateway && sleep 3
systemctl is-active taxi-gateway
curl -s -H "x-gateway-token: $GATEWAY_TOKEN" http://127.0.0.1:8787/status | jq
journalctl -u taxi-gateway -n 60 --no-pager
```
- التحقق: `/status` يرجّع JSON، والحالة ليست `initializing`، ولا وجود لـ `ReferenceError: worker`.
- لو فشل: `EADDRINUSE` → `ss -ltnp | grep 8787`؛ 401 → التوكن في الهيدر لا في `?token=`؛ crash-loop → `journalctl -u taxi-gateway -p err`.

---

## المرحلة 2 — إصلاح P0 في الـ Worker + ترحيل D1 (2–3 ساعات)

**S2.1 — ترحيل السكيما (idempotency + قفل outbox + فهارس)**
`migrations/0002_revive.sql`:
```sql
CREATE TABLE IF NOT EXISTS inbound_seen (msg_id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
ALTER TABLE rides  ADD COLUMN dispatch_group_jid TEXT;
ALTER TABLE outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_outbox_claim  ON outbox(status, locked_until);
CREATE INDEX IF NOT EXISTS ix_rides_status  ON rides(status);
CREATE INDEX IF NOT EXISTS ix_rides_client  ON rides(client_phone, status);
CREATE INDEX IF NOT EXISTS ix_rides_driver  ON rides(driver_id, status);
CREATE INDEX IF NOT EXISTS ix_drivers_phone ON drivers(phone);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fares_pair ON fixed_fares(from_zone_id, to_zone_id);
```
```bash
npx wrangler d1 execute taxi-db --local  --file=./migrations/0002_revive.sql
npx wrangler d1 execute taxi-db --remote --file=./migrations/0002_revive.sql
npx wrangler d1 execute taxi-db --remote --command "PRAGMA table_info(outbox);"
```
- لو فشل `ux_fares_pair`: عندك تعرفات مكرّرة — `SELECT from_zone_id,to_zone_id,COUNT(*) FROM fixed_fares GROUP BY 1,2 HAVING COUNT(*)>1;` واحذف الأقدم ثم أعد.

**S2.2 — إصلاحات الكود (بالترتيب)**
1. P0-1: `checkGatewayAuth` على `POST /webhook/whatsapp` قبل قراءة الـ body.
2. P0-7: بوابة idempotency: `INSERT OR IGNORE INTO inbound_seen(msg_id,ts)`؛ إذا `meta.changes === 0` → `200 {dedup:true}`. وكل `IllegalTransition` يرجّع 200 لا 500.
3. P0-3/P0-4: احذف `'اك'` و`'لا'`؛ استخدم حدود كلمة `(^|\s)لا(\s|$)`، ورتّب ACCEPT قبل DECLINE، وCONFIRM/BOOK قبل CANCEL.
4. P0-5: `computeFare` يرجّع `source:'NONE'` إذا الحزام خارج المفاتيح أو السعر ≤ 0.
5. P0-9: `price.toLocaleString('en-US') + ' ل.س'` + تدوير السعر لأقرب 500 قبل التخزين.
6. P0-2: `UPDATE rides SET status='ASSIGNED',driver_id=? WHERE id=? AND status='DISPATCHING'` والاعتماد على `meta.changes===1`.
7. P0-6: خزّن `dispatch_group_jid` عند DISPATCHING واستعلم عليه.
8. P0-8: `env.DB.batch([...])` لتحديث الحالة + إدراج outbox معاً، وفشل صريح إذا `drivers_group_jid` مفقود.
9. P1-2: رفض مبكر إذا `msg.chatId !== settings.drivers_group_jid`.
10. P1-7 + P1-10: تحويل `[٠-٩]` إلى ASCII في `normalizeArabic`، و`normalizePhone` عند كل قراءة/كتابة.
11. P1-3: `try/catch` حول switch يرجّع رسالة عربية ودّية.

**S2.3 — اختبارات وحدة قبل النشر (P1-15)**
```bash
npx vitest run
```
حالات إلزامية: `بدي تكسي`→BOOK · `اكيد`→CONFIRM · `الكي الطلب`→CANCEL · `وصلت خلاص`→ARRIVED · `قبلت ١٢`→ACCEPT/id=12 · حزام 4→`NONE` · `formatSYP(12500)`→`12,500 ل.س`.
- لو لا يوجد إطار اختبار: `npm i -D vitest` وأنشئ `test/nlu.spec.ts` جدولي. **لا تنشر قبل أن تمر هذه السبع.**

**S2.4 — النشر والتحقق**
```bash
npx wrangler deploy --dry-run
npx wrangler deploy
npx wrangler tail --format=pretty &
# 1) webhook بلا توكن = 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://taxi-worker.workers.dev/webhook/whatsapp -d '{}'
# 2) رسالة تجربة كاملة
curl -s -X POST https://taxi-worker.workers.dev/webhook/whatsapp \
 -H "x-gateway-token: $GATEWAY_TOKEN" -H 'content-type: application/json' \
 -d '{"chatId":"963900000000@s.whatsapp.net","senderPhone":"963900000000","text":"بدي تكسي من المزة للشعلان","isGroup":false,"msgId":"T-1","ts":1757000000}' | jq
# 3) نفس الطلب مرة ثانية = dedup
npx wrangler d1 execute taxi-db --remote --command \
 "SELECT id,status,fare FROM rides ORDER BY id DESC LIMIT 3; SELECT COUNT(*) pend FROM outbox WHERE status='PENDING';"
```
- التحقق: 401 للأول، رحلة **واحدة** بسعر > 0، صف outbox واحد فيه سعر مكتوب بالكامل (`12,500`) لا «13 ألف».
- لو `fare=0` → P0-5 غير مطبّق أو جدول zones فيه belt NULL. لو رحلتان → بوابة idempotency غير فعّالة.
- نظّف: `DELETE FROM rides WHERE client_phone='963900000000'; DELETE FROM inbound_seen WHERE msg_id LIKE 'T-%';`

---

## المرحلة 3 — الحد الأدنى للوحة (ساعة)

**S3.1 — منع تلف الجلسة من اللوحة (P0-5 لوحة)**
- الإجراء: `let busy=false` + `btn.disabled=true` حول `pairQR/pairCode`، ورد `409` من البوابة إذا الحالة `initializing|connecting|pairingRequested`.
- التحقق: دبل-كليك على «اقتران» يُنتج طلباً واحداً في `journalctl`.

**S3.2 — حذف حلقة الـ reload (P1-7 لوحة)**
- الإجراء: امنع كل `location.reload()` من مسار الـ polling؛ حدّث DOM موضعياً. أضف `if(document.hidden) return;` وbackoff 4s→30s وAbortSignal 3s.
- التحقق: افتح اللوحة 3 دقائق واكتب رقماً في `#pairPhone` — لا يُمحى.
- لو استمر: هذا يمنع الاقتران بالرقم تماماً؛ اقترن مؤقتاً بـ `curl` من الـ VPS.

**S3.3 — escaping شامل (P0-1/2/3 لوحة)**
- الإجراء: دالة `esc()` على كل تعبير مُدرج، whitelist لـ `driver.status`، تحقق `state.qr.startsWith('data:image/')` و`/^\d{4,12}$/` للكود، ونقل التوكن من `?token=`/`?key=` إلى الهيدر.
- التحقق: أدرج سائقاً باسم `<img src=x onerror=alert(1)>` ثم افحص «مصدر الصفحة»: يجب أن يظهر `&lt;img`. احذف السائق بعدها.

---

## نقطة القرار — أ (سيم جديدة) أم ب (Cloud API test number)

| المعيار | أ: سيم جديدة + Baileys | ب: Cloud API test number |
|---|---|---|
| مجموعات واتساب | مدعومة (قلب التوزيع الحالي) | **غير مدعومة نهائياً** |
| تعديل كود مطلوب | صفر معماري | adapter + تحويل التوزيع من مجموعة إلى رسائل فردية |
| المستقبلون | بلا حد | 5 أرقام مُتحقَّقة فقط |
| حرية النص | كاملة | نص حر داخل نافذة 24 ساعة فقط، وإلا قوالب |
| الكلفة/الوقت | ثمن سيم + ~ساعة | مجاني + 3–5 ساعات تطوير |
| الاستقرار | حظر محتمل عند سلوك spam | توكن مؤقت يُنتهي كل 24 ساعة |

**قاعدة الاختيار:** إذا كانت السيم متاحة داخل 24 ساعة → **أ** بلا تفكير، لأن `handleGroup` و`drivers_group_jid` هما العمود الفقري للنظام، وباء تُلغي المجموعات وتفرض إعادة تصميم التوزيع.
اختر **ب** فقط إذا: السيم غير ممكنة هذا الأسبوع، **و** تقبل تجربة مغلقة بـ 5 أرقام، **و** توافق على تحويل التوزيع إلى رسائل فردية للسائقين. عملياً: أ للإطلاق، ب كمسار موازٍ لاحقاً كقناة رسمية.

---

## المرحلة 4أ — مسار السيم الجديدة

**S4A.1 — تحضير الحساب**
- الإجراء: سيم جديدة في هاتف احتياطي → تثبيت واتساب → تحقق OTP → اسم العرض «تكسي …». الهاتف يبقى موصولاً بالإنترنت (الجهاز الأساسي شرط لبقاء الأجهزة المرتبطة).
- التحقق: ترسل رسالة من الرقم الجديد لرقمك الشخصي وتصل.

**S4A.2 — مجموعة السواقين**
- الإجراء: أنشئ مجموعة من الرقم الجديد، أضف السواقين، ثبّت قواعد الرد (`قبلت <رقم>`، `وصلت`، `بلشت`، `خلصت`).
- الأمر لاستخراج الـ JID بعد الاقتران: أرسل رسالة في المجموعة ثم
```bash
journalctl -u taxi-gateway -f | grep '@g.us'
```

**S4A.3 — الاقتران بالكود (لا QR على سيرفر بعيد)**
```bash
curl -s -X POST http://127.0.0.1:8787/pair/code \
 -H "x-gateway-token: $GATEWAY_TOKEN" -H 'content-type: application/json' \
 -d '{"phone":"963XXXXXXXXX"}' | jq
```
ثم على الهاتف: WhatsApp → Linked devices → Link with phone number → أدخل الكود.
- التحقق:
```bash
curl -s -H "x-gateway-token: $GATEWAY_TOKEN" http://127.0.0.1:8787/status | jq '.connection,.user'
ls -la /opt/taxi-bot/gateway/session-b/creds.json
```
المطلوب: `connected` + `user` فيه الرقم الجديد + `creds.json` موجود.
- لو فشل: 400 → regex (S1.3). 409 → انتظر عودة الحالة `closed`. الكود لا يُقبل → انتهت الـ 60 ثانية، أعد **مرة واحدة**، وبحد أقصى محاولتان كل 10 دقائق. `515` بعد الاقتران طبيعي (إعادة تشغيل فورية). `401/403/440` → **لا تمسح أي جلسة**، توقف وراجع.

**S4A.4 — تثبيت الخدمة**
```ini
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=5
[Service]
Restart=always
RestartSec=10
EnvironmentFile=/etc/taxi-gateway.env
```
```bash
sudo systemctl daemon-reload && sudo systemctl restart taxi-gateway && sudo systemctl enable taxi-gateway
systemctl is-enabled taxi-gateway && systemctl is-active taxi-gateway
```

---

## المرحلة 4ب — مسار Cloud API test number

**S4B.1 — التحضير:** Meta App → WhatsApp → Test number؛ سجّل `PHONE_NUMBER_ID`، توكن مؤقت (24h)، وأضف حتى 5 أرقام مستقبلة مع تحقّق OTP.
**S4B.2 — إرسال تجربة:**
```bash
curl -s "https://graph.facebook.com/v21.0/$PHONE_NUMBER_ID/messages" \
 -H "Authorization: Bearer $CLOUD_TOKEN" -H 'content-type: application/json' \
 -d '{"messaging_product":"whatsapp","to":"963XXXXXXXXX","type":"template","template":{"name":"hello_world","language":{"code":"en_US"}}}' | jq
```
- التحقق: `messages[0].id` في الرد + وصول الرسالة.
- لو `131030` → الرقم غير مضاف للقائمة. لو خطأ نافذة 24 ساعة → لازم العميل يبدأ المحادثة أو استخدم قالباً.

**S4B.3 — نقطة الويبهوك في الـ Worker:** `GET /webhook/cloud` يرجّع `hub.challenge` عند تطابق `hub.verify_token`، و`POST` يتحقق من `X-Hub-Signature-256` (HMAC-SHA256 بـ App Secret) ثم يحوّل:
`{chatId: wa_id+'@s.whatsapp.net', senderPhone: normalizePhone(wa_id), text: messages[0].text.body, isGroup:false, msgId: messages[0].id, ts: messages[0].timestamp}` — نفس مسار المحرّك تماماً.
```bash
curl -s "https://taxi-worker.workers.dev/webhook/cloud?hub.mode=subscribe&hub.verify_token=$VERIFY&hub.challenge=12345"
```
- التحقق: يرجّع `12345` بالضبط، ولوحة Meta تقول Verified.
**S4B.4 — التوزيع بلا مجموعات:** استبدل النشر في `drivers_group_jid` بحلقة على `drivers WHERE status='AVAILABLE'` (≤5 أرقام تجربة) + `dispatch_group_jid = 'DIRECT'`. **قيد صريح:** أول قبول يفوز عبر نفس القفل التفاؤلي (P0-2).

---

## المرحلة 5 — تهيئة البيانات (30 دقيقة)

```bash
npx wrangler d1 execute taxi-db --remote --command \
 "INSERT OR REPLACE INTO settings(key,value) VALUES('drivers_group_jid','1203XXXXXXXXXXX@g.us'),('bot_enabled','1');"
npx wrangler d1 execute taxi-db --remote --command \
 "SELECT id,name,belt,active FROM zones; SELECT id,name,phone,status,commission_pct FROM drivers WHERE active=1;"
```
- التحقق: كل zone له `belt` ضمن 1–3 وليس NULL، وكل سائق `commission_pct` ليست NULL، و`aliases` JSON صالح لكل صف.
- لو صف aliases تالف: أصلحه الآن — صف واحد تالف يوقف الردود لكل المستخدمين (P1-13).

---

## المرحلة 6 — بروفة E2E قبل العملاء (ساعة)

استخدم مجموعة تجربة + رقمك الشخصي كعميل (**ليس رقم الـ bridge**) وسائقاً متعاوناً.

| الخطوة | الرسالة | المتوقع |
|---|---|---|
| 1 | «بدي تكسي من المزة للشعلان» | سعر واضح بالأرقام الكاملة |
| 2 | «اكيد» | «عم نرسل طلبك» + نشر في المجموعة (لا إلغاء!) |
| 3 | سائق: «قبلت 12» | تأكيد للسائق + بيانات السائق للعميل |
| 4 | سائق ثانٍ: «قبلت 12» فوراً | «الرحلة مأخوذة» — اختبار الـ race |
| 5 | «وصلت» ثم «بلشت» ثم «خلصت» | ARRIVED→IN_RIDE→DONE + «حصة الشركة» |
| 6 | «وصلت» بعد DONE | رد ودّي، لا 500 |

```bash
npx wrangler d1 execute taxi-db --remote --command \
 "SELECT id,status,fare,driver_id,dispatch_group_jid FROM rides ORDER BY id DESC LIMIT 2;
  SELECT status,COUNT(*) FROM outbox GROUP BY status;
  SELECT id,status FROM drivers WHERE active=1;"
```
- التحقق: رحلة واحدة DONE، لا صف outbox PENDING أقدم من 60 ثانية، السائق رجع `AVAILABLE`.
- لو تجمّدت خطوة: `npx wrangler tail` + `journalctl -u taxi-gateway -f` بالتوازي؛ صفوف PENDING متراكمة = البوابة لا تسحب (تحقق `WORKER_URL` والتوكن). ردود بلا إرسال = فشل `resolveJid` (P1-14: خزّن `jidNormalizedUser`).
- بعد النجاح: `DELETE FROM rides WHERE id IN (...)` لصفوف التجربة فقط.

---

## المرحلة 7 — أول رحلة حقيقية

**قائمة Go/No-Go:** `/status`=connected · اختبارات NLU خضراء · `drivers_group_jid` مضبوط · لا سعر 0 في آخر 10 رحلات تجربة · `bot_enabled=1` · نسخة D1 اليوم موجودة · السواقون تلقّوا تعليمات الصياغة.

**التشغيل:** أعلن في المجموعة «البوت شغال — جرّبوا»، وراقب أول 60 دقيقة بشاشتين: `npx wrangler tail` و`journalctl -u taxi-gateway -f`.

**مراقبة دورية (تُثبَّت الآن):**
```bash
*/5 * * * * curl -fsS -H "x-gateway-token: $TOKEN" http://127.0.0.1:8787/status \
 | jq -e '.connection=="connected"' >/dev/null || logger -t taxi "GATEWAY DOWN"
```

**الرجوع للخلف (rollback):**
```bash
npx wrangler deployments list && npx wrangler rollback   # الـ Worker
npx wrangler d1 execute taxi-db --remote --command "UPDATE settings SET value='0' WHERE key='bot_enabled';"  # kill switch
sudo systemctl stop taxi-gateway   # آخر خيار — الطلبات تبقى في D1
```
لا تمسح الجلسة في أي سيناريو رجوع.

---

## المرحلة 8 — تصليب ما بعد الإطلاق (بالترتيب)

- **الأسبوع 1:** P1-1/P1-4 بوابة (retry + persistent queue، ack بعد كل ≤5) · P1-5/P1-6 (فحص `state.connection` داخل الحلقة + watchdog على `lastActivityAt`) · P1-7 (استثناء 408/428/515 من العدّاد) · P1-8/P1-9 (تنبيه `/gateway/alert` + `process.exit(1)`) · P1-11 worker (claim/lock للـ outbox عبر `UPDATE … RETURNING`).
- **الأسبوع 2:** P1-13 (adaptive polling 1.5s→30s — يوفّر نصف حصة Cloudflare) · P1-12 worker (cron + EXPIRED لـ NEW/DISPATCHING) · P1-5/P1-6 worker (توقيت +03:00 وتوحيد `unixepoch()`) · P1-14 (throttle/cache لطبقة AI) · P1-16 (نقل `BELT_BASE` إلى settings).
- **الأسبوع 3:** بقية P2 (CSP ورؤوس أمان اللوحة، تنظيف outbox، LRU للـ lidMap، `onWhatsApp()` قبل أول إرسال، observability + Analytics Engine).