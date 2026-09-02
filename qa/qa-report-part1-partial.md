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