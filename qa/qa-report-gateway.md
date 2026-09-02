# تقرير QA شامل — بوابة واتساب (gateway.mjs)

- **التاريخ:** 2026-09-02
- **الفاحص:** claude-opus-5 عبر api.justwoker.icu (طلبين متوازيين + توليد طويل أول)
- **تحقق مستقل:** 11 ادعاءً رئيسياً طُابقها Hermes حرفياً على الكود الفعلي — كلها صحيحة ✅
- **الحكم المُجمَّع:** ❌ **لا** جاهز بوضعه الحالي — ⚠️ **نعم بشرط** تطبيق P0-1 + P0-2 + P0-3 (+P2-2) قبل الاقتران
- **الخطر الأكبر:** عند أي `/pair/*`، السوكت القديم بيفعّل reconnect جديد بعد 3 ثواني → سوكتان موازيان على نفس الجلسة → `Invalid account signature` → **حرق الاقتران الوحيد**

---

# الجزء الأول — الأهداف 1–6 بالتفصيل (فحص طويل كامل)

## أ) جدول النتائج

| # | الهدف | الحالة | الدليل (سطر تقريبي + اقتباس) |
|---|---|---|---|
| 1 | أمان HTTP | ❌ | ~L250 `return t === GATEWAY_TOKEN` (غير timing-safe) • ~L305 `let d=''; req.on('data',c=>(d+=c))` بلا حد • `JSON.parse(d)` داخل `on('end')` = **uncaught → موت العملية** • ~L335 `error: String(e)` • ~L342 `console.log(GATEWAY_TOKEN)` |
| 2 | الاقتران | ❌ | ~L293/L316 `try { sock.end() } catch {} sock=null` بلا `removeAllListeners` → حدث `close` القديم يصل ~L161 ويولّد سوكت ثانياً؛ `pairingCode/ExpiresAt` ما تُنظّف بعد 120s |
| 3 | إعادة الاتصال | ❌ | ~L161 `setTimeout(() => startWhatsApp(), 3000)`: بلا `.catch` (unhandledRejection)، بلا سقف/backoff، 403/440 تُعاد للأبد، و`pairPhone` يُفقد؛ + `qrTimeout: 20_000` (~L97) = محاولة تسجيل جديدة كل ~23s → rate-limit |
| 4 | messages.upsert | ⚠️ | ~L185 `.replace(/:/g,'')` تحوّل `963958794195:12` إلى `96395879419512`؛ لا `ephemeral/viewOnce/buttons`؛ لا dedupe على `key.id`؛ `@lid` بلا `senderPn` يُرسل LID كرقم |
| 5 | outbox | ❌ | ~L230 `m._tries = (m._tries ?? 0) + 1` على كائن جديد من الـ Worker كل دورة → **لا يبلغ 3 أبداً**، الفشل يُعاد كل 1.5s للأبد |
| 6 | موارد | ❌ | listeners سوكتات قديمة تبقى (تكرار webhook + `saveCreds` يعيد كتابة الجلسة بعد `rmSync`)؛ timer ~L127 ينادي `sock` **العالمي**؛ `lidMap` بلا سقف |

## ب) المشاكل والإصلاحات (الأحرّ أولاً)

**P1 (~L293,L316,L161) سوكتات متوازية تحرق اقتران الغد.** السوكت القديم لا تُزال مستمعاته → `close` يشغّل `startWhatsApp()` بعد 3s فوق سوكت الاقتران الجديد → `Invalid account signature` أو حظر.
```js
let gen = 0, pairTimer = null, reconnTimer = null, attempts = 0;
function killSock(){ clearTimeout(pairTimer); clearTimeout(reconnTimer);
  try { sock?.ev.removeAllListeners(); sock?.end(new Error('replaced')); } catch {} sock = null; gen++; }
// startWhatsApp: أول سطر
killSock(); const myGen = gen;
sock.ev.on('creds.update', c => { if (myGen === gen) return saveCreds(c); });
// أول سطر داخل connection.update و messages.upsert:
if (myGen !== gen) return;
// /pair/qr و /pair/code و /logout: استبدل كتلة sock.end() بـ:
killSock();
```

**P2 (~L305) انهيار الخدمة بـ body سيئ + DoS.**
```js
function readBody(req, max = 8192) { return new Promise((ok, no) => { let d = '';
  req.on('data', c => { d += c; if (d.length > max) { req.destroy(); no(new Error('big')); } });
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { no(new Error('json')); } });
  req.on('error', no); }); }
const body = await readBody(req).catch(() => null);
if (!body) { res.writeHead(400); res.end('{"error":"bad request"}'); return; }
```

**P3 (~L161,L97) حلقة تسجيل تحرق الحد اليومي.**
```js
qrTimeout: 60_000,
// مكان setTimeout(() => startWhatsApp(), 3000):
if ([401,403,440].includes(code) || ++attempts > 4) { state.connection='closed'; return; }
reconnTimer = setTimeout(() => startWhatsApp(pairPhone).catch(e => state.lastError = String(e)),
  Math.min(30_000, 3000 * 2 ** attempts));
// وعند connection==='open': attempts = 0;
```

**P4 (~L122,L127) طلب كود على سوكت خاطئ/قبل الجهوزية.**
```js
- if (pairPhone && !state.pairingCode && !state.pairingRequested) {
+ if (qr && pairPhone && !state.pairingCode && !state.pairingRequested) {
    state.pairingRequested = true; const s = sock;
-   setTimeout(async () => { const code = await sock.requestPairingCode(pairPhone);
+   pairTimer = setTimeout(async () => { if (myGen !== gen) return;
+     const code = await s.requestPairingCode(pairPhone);
      ...
+     setTimeout(() => { if (Date.now() >= state.pairingExpiresAt)
+       { state.pairingCode = null; state.pairingRequested = false; } }, 121_000).unref();
// وعند 'open': state.pairingPhone = state.pairingExpiresAt = null; state.pairingRequested = false;
```

**P5 (~L230) إعادة إرسال أبدية + بَرست يستفز الحظر.**
```js
const fails = new Map();
// نجاح: fails.delete(m.id);
// فشل:
const n = (fails.get(m.id) ?? 0) + 1; fails.set(m.id, n);
if (n >= 3) { fails.delete(m.id);
  await worker('/outbox/fail','POST',{ ids:[m.id], error:String(e) })
    .catch(() => worker('/outbox/ack','POST',{ ids:[m.id] })); }
// نهاية كل تكرار إرسال:
await new Promise(r => setTimeout(r, 400 + Math.random() * 400));
```

**P6 (~L185) رقم عميل مشوّه = حجز لمجهول.**
```js
- let senderPhone = senderJid.split('@')[0].replace(/:/g, '');
+ let senderPhone = senderJid.split('@')[0].split(':')[0];
+ if (senderJid.endsWith('@lid') && !m.key.senderPn) { log.warn({ senderJid }, 'lid بلا senderPn'); continue; }
```

**P7 (~L174) نصوص مفقودة + تكرار.**
```js
const c = m.message.ephemeralMessage?.message ?? m.message.viewOnceMessageV2?.message ?? m.message;
const text = c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption
  ?? c.buttonsResponseMessage?.selectedDisplayText ?? c.listResponseMessage?.title ?? '';
if (seen.has(m.key.id)) continue; seen.set(m.key.id, 1); if (seen.size > 2000) seen.clear();
```

**P8 (~L245,L335,L342,L264) أمان/تسريب.**
```js
import { timingSafeEqual } from 'node:crypto';
const eq=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
return GATEWAY_TOKEN.length >= 16 && eq(t, GATEWAY_TOKEN);
// 500: log.error({err:String(e)},'http'); res.end('{"error":"internal"}');
// احذف console.log(GATEWAY_TOKEN)
// /groups: if (!sock || state.connection!=='connected') { res.writeHead(409); res.end('{"error":"offline"}'); return; }
```

**P9 (~L192, نهاية الملف) نمو/انهيار.**
```js
if (lidMap.size > 5000) lidMap.delete(lidMap.keys().next().value);
process.on('unhandledRejection', e => log.error({ err: String(e) }, 'unhandledRejection'));
await startWhatsApp().catch(e => state.lastError = String(e));
```

## ج) التقييم النهاري

- **لا** — بحالته الحاضرة احتمال حرق المحاولة الوحيدة عالٍ (P1 يولّد سوكتاً موازياً بعد 3s من أي `/pair/*`، وP3 يعيد التسجيل كل ~23s).
- **نعم بشرط**: تطبيق P1 + P3 + P4 + P2 قبل التشغيل (≈20 دقيقة)، ثم اختبار جاف: `POST /pair/qr` ومراقبة `journalctl` — يجب ظهور **سوكت واحد** فقط ولا `startWhatsApp` ثانية.
- P5–P9 تُطبَّق بعد نجاح الاقتران (لا تمسّ المصافحة).

---

# الجزء الثاني — الأهداف 7–10 (قسم مقسّم 1: أمان/اقتران/إعادة اتصال/استقبال/إرسال/موارد)

## أ) جدول النتائج (7–10)

| # | الحالة | الدليل (سطر ≈ + اقتباس) | الإصلاح |
|---|---|---|---|
| 7 | ❌ | لا وجود لأي `process.on('SIGTERM'…)` في الملف؛ الملف ينتهي بـ `outboxLoop();` (~L353). السوكت لا يُغلق، و`saveCreds` قد يُقتل وسط كتابة `creds.json` | P0-2 |
| 8 | ❌ | `await startWhatsApp();` (~L352) توب-ليفل بلا `catch`؛ `setTimeout(() => startWhatsApp(), 3000)` (~L161) بلا `catch`؛ `JSON.parse(d \|\| '{}')` داخل `req.on('end')` (~L300) → uncaughtException؛ لا مُعالِج عام | P0-3, P2-1 |
| 9 | ⚠️ | مطبّق: `makeCacheableSignalKeyStore` (~L92)، `browser: ['Ubuntu','Chrome','20.0.04']` (~L101)، `syncFullHistory:false` + `shouldSyncHistoryMessage:()=>false` (~L98-99)، `if (!resp?.key?.id) throw` (~L223)، LID (~L180-195). **ناقص**: `creds.registered` غير مفحوص أبداً؛ `getMessage: async () => undefined` (~L100) | P1-1, P1-2 |
| 10 | ❌ كما هو | البند P0-1 يحرق المحاولة الوحيدة | انظر (ج) |

## ب) المشاكل من الأحرّ للأبسط

**P0-1 — سوكت زومبي يُولد سوكتاً ثانياً وسط الاقتران (~L161 + ~L283/~L305).** `/pair/qr` ينفّذ `sock.end()` → الـ listener القديم يستلم `code=undefined` → ليس `loggedOut` → بعد 3s ينده `startWhatsApp()` فيستبدل السوكت الجديد. نتيجة: سوكتان يكتبان نفس `SESSION_DIR` → `Invalid account signature` + احتراق الاقتران الوحيد. وأيضاً `pairPhone` يُفقد فيهبط لمسار QR.

```js
let gen = 0;
async function startWhatsApp(pairPhone = null, myGen = ++gen) {
  const { state: auth, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  if (myGen !== gen) return;                              // بعد await
  sock.ev.on('creds.update', (c) => { if (myGen === gen) return saveCreds(c); });
  // داخل connection.update، أول سطر:
  if (myGen !== gen) return;
  // بدل setTimeout(...startWhatsApp(), 3000):
  setTimeout(() => { if (myGen === gen && !shuttingDown)
    startWhatsApp(pairPhone).catch(e => state.lastError = String(e)); }, 3000);
}
// في /pair/qr و /pair/code و /logout قبل sock.end():  gen++;
```

**P0-2 — لا إغلاق نظيف (Goal 7).**

```js
let shuttingDown = false;
for (const s of ['SIGTERM','SIGINT']) process.on(s, () => {
  if (shuttingDown) return; shuttingDown = true; gen++;
  try { sock?.end(new Error('shutdown')); } catch {}
  server.close(); setTimeout(() => process.exit(0), 1500).unref();
});
// في outboxLoop: for (;;) { if (shuttingDown) return; ... }
```

**P0-3 — restart loop كل 5s (Goal 8).** فشل شبكة في `fetchLatestBaileysVersion()` عند الإقلاع = رفض غير مُعالَج → exit(1) → `Restart=always` → حلقة تحرق الاقتران.

```js
process.on('unhandledRejection', e => log.error({ err: String(e) }, 'unhandledRejection'));
process.on('uncaughtException',  e => log.error({ err: String(e) }, 'uncaughtException'));
let version; try { ({ version } = await fetchLatestBaileysVersion()); }
catch { version = [2, 3000, 1023223821]; }              // لا تُسقط الخدمة
startWhatsApp().catch(e => { state.lastError = String(e);
  setTimeout(() => startWhatsApp().catch(() => {}), 5000); });   // بدل await المجرّد
```

**P1-1 — «waiting for this message» (~L100).** `getMessage` يرجّع `undefined` دائماً → لا يمكن الرد على retry receipt.

```js
const sentStore = new Map();
getMessage: async (key) => sentStore.get(key.id)?.message,
// بعد نجاح الإرسال في outboxLoop:
sentStore.set(resp.key.id, resp);
if (sentStore.size > 400) sentStore.delete(sentStore.keys().next().value);
```

**P1-2 — `registered:false` (~L122).** الكود يطلب الكود من داخل `connection.update` بمؤقّت أعمى 3s وبلا فحص التسجيل. انقله بعد `makeWASocket` مباشرة واحذف الكتلة L122-139:

```js
if (pairPhone && !auth.creds.registered) {
  await new Promise(r => setTimeout(r, 4000));
  try { state.pairingCode = await sock.requestPairingCode(pairPhone);
        state.pairingPhone = pairPhone; state.pairingExpiresAt = Date.now() + 120_000;
        state.connection = 'waiting_scan'; console.log('🔢', state.pairingCode); }
  catch (e) { state.lastError = `pairing code: ${e}`; }
}
```

**P2-1 — إسقاط الخدمة بجسم JSON تالف (~L300):** `req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });`

**P2-2 — `qrTimeout: 20_000` (~L97):** تجديد QR كل 20s يضاعف الطلبات على حساب محدود المعدل → `qrTimeout: 60_000`.

**P3 — `m._tries` (~L230)** على كائن يُعاد جلبه كل دورة → إعادة إرسال أبدية لرسالة فاشلة؛ عدّاد الفشل يجب أن يكون `Map` بمفتاح `m.id`.

## ج) الحكم النهائي: **نعم بشرط** (كما هو الآن: **لا**)

1. تطبيق P0-1، P0-2، P0-3 حرفياً قبل التشغيل (P0-1 وحده كافٍ لحرق المحاولة).
2. systemd: `RestartSec=10`، `TimeoutStopSec=20`، `KillSignal=SIGTERM`، `Wants/After=network-online.target`.
3. قفل اقتران: رفض `/pair/*` بـ 409 إذا `state.connection !== 'closed'` — منع نقرة مزدوجة.
4. بعد أول `connection === 'open'`: `cp -a session session.bak` فوراً (تأمين ضد فساد لاحق).
5. اختبار المسار كاملاً برقم واتساب ثانوي اليوم — لا يُلمس الحساب المحدود إلا بعد نجاح التجربة.
6. لا تُعد تشغيل الخدمة أثناء انتظار المسح؛ `systemctl restart` = QR جديد = محاولة محروقة.

---

# ملحق: الأدلة من الفحص الطويل الأول (أهداف 1–7، توليد كامل انقطع عند 900 ثانية)

# تقرير QA — بوابة واتساب (gateway.mjs)

- المودل: claude-opus-5 (streaming) عبر api.justwoker.icu
- التاريخ: 2026-09-02
- الفاحص: Claude Opus 5 — فحص QA كامل وفق 9 أهداف محددة

# فحص QA — بوابة واتساب (Baileys) لبوت التاكسي

**نطاق التحقق:** قرأت الكود المُلصق فقط. لم أشغّل الخدمة ولم أفتح `node_modules/@whiskeysockets/baileys` (المسار الحالي `/` ولا يوجد المشروع هنا)، فأي ادّعاء يتعلق بسلوك داخلي لـ Baileys أشّرت عليه بـ «يحتاج تحقق ميداني». أرقام الأسطر محسوبة على النص المُلصق حيث `#!/usr/bin/env node` = سطر 1.

**النتيجة الأهم أولاً:** الكود بصيغته الحالية، وهو يعمل الآن على الـ VPS بجلسة فارغة، **يفتح محاولة اقتران جديدة مع واتساب كل ~100 ثانية بشكل لا نهائي** (السطر 345 + 97 + 161). هذا أرجح سبب لـ rate-limit الحالي على مستوى الحساب، وسيستمر بتعميقه طوال الليل. **أوقف الخدمة الآن** (`systemctl stop`) حتى تُطبَّق إصلاحات P0.

---

## أ) جدول النتائج

| # | الهدف | الحالة | الدليل (سطر + اقتباس) |
|---|---|---|---|
| 1 | أمان HTTP API | ❌ | 250 `return t === GATEWAY_TOKEN;` مقارنة غير timing-safe · 340 `console.log(\`🔑 GATEWAY_TOKEN: ${GATEWAY_TOKEN}\`)` سر في journald · 248 `url.searchParams.get('token')` توكن في سجلات nginx · 302‑304 `let d=''; req.on('data', c => (d += c))` بلا حد حجم وبلا `error` · 303 `JSON.parse(d \|\| '{}')` بلا try → **كراش الخدمة** · 334 `error: String(e)` تسريب داخلي · لا `nosniff`/`no-store` |
| 2 | منطق الاقتران | ❌ | 290/311 `sock.end()` ثم 292/313 `rmSync(SESSION_DIR)` والسوكت القديم لسّا يكتب creds · 104 `sock.ev.on('creds.update', saveCreds)` لا يُفصل أبداً · 127 `await sock.requestPairingCode(...)` داخل setTimeout يقرأ `sock` **العالمي** · 130/144 `pairingExpiresAt` لا يُصفّر أبداً بعد انتهاء الصلاحية (يُصفّر `pairingCode` فقط عند `open`) · 295 `await startWhatsApp()` داخل معالج HTTP يعلّق اللوحة |
| 3 | إعادة الاتصال | ❌ | 161 `setTimeout(() => startWhatsApp(), 3000)` بلا قفل ولا backoff ولا سقف → **سوكتات متوازية** · 152 فقط `loggedOut` معالَج؛ لا 440 connectionReplaced ولا 403 forbidden ولا 500 badSession ولا 411 mismatch · 515 restartRequired «يعمل بالحظ» عبر فرع else · 156‑159 التعليق يقول «امسحها» والكود لا يمسح |
| 4 | خط الاستقبال | ⚠️ | 167 `if (type !== 'notify') return;` يُسقط `append` · 174‑178 لا فك لـ `ephemeralMessage`/`viewOnce` → رسائل المحادثات المؤقتة تُهمَل صامتة · لا `locationMessage` (وهذا بوت تاكسي!) · 185 `.replace(/:/g,'')` **يدمج رقم الجهاز**: `963x:12` → `963x12` · 186 إذا `senderPn` مفقود يُرسَل رقم LID كرقم عميل · 168 لا dedupe → طلبيات مكرّرة |
| 5 | خط الإرسال | ❌ | 230 `m._tries = (m._tries ?? 0) + 1;` على كائن JSON جديد كل دورة → **العدّاد وهمي، والتعليق كذب** · لا ack للفاشل → إعادة أبدية كل 1.5s · 231 ack ناجح فقط · لا فاصل بين الرسائل (burst) |
| 6 | تسريب موارد | ⚠️ | 64 `const lidMap = new Map()` بلا سقف · 125 `setTimeout` للاقتران بلا `clearTimeout` · 161 مؤقتات إعادة يتيمة متعددة · السوكتات القديمة محفوظة بمراجع closures ومستمعاتها حيّة (المشكلة ليست تكرار listeners على نفس المُصدِر بل **مُصدِرات متعددة حيّة**) |
| 7 | إغلاق نظيف | ❌ | لا وجود لـ `SIGTERM`/`SIGINT` في الملف كله → systemd يقتل العملية