# مراجعة QA — `gateway.mjs`

## نقاط القوة (سطران)
عزل الأجيال (`gen`) + guard في كل handler + منع الـ auto-reconnect على `401/403/440` تصميم صحيح ضد الـ parallel sockets واستنزاف حدّ الاقتران، و`makeCacheableSignalKeyStore` + `version fallback` قرارات ناضجة.
استخراج النص متعدد الطبقات، رفض `@lid` بدون `senderPn`، binding على `127.0.0.1`، `timingSafeEqual`، وحدّ حجم الـ body — أساس أمني/تشغيلي جيد.

---

## P0 — البوت لا يعمل إطلاقاً بالشكل الحالي

**P0-1 — `gen` يُزاد مرتين ⇒ `startWhatsApp` تخرج قبل إنشاء السوكت** — `gateway.mjs:~123-128`
- الوصف: `gen++; const myGen = gen; killSock();` و`killSock()` تنتهي بـ `gen++` أيضاً ⇒ بعد `await useMultiFileAuthState` يكون `myGen === gen - 1` دائماً، فيُنفَّذ `if (myGen !== gen) return;` في 100% من الحالات (بما فيها `/pair/qr` و`/pair/code`).
- الأثر: لا socket، لا QR، لا pairing code، `state.connection` يبقى `initializing` للأبد، والـ outbox معلّق — فشل صامت تماماً بلا أي error log.
- الإصلاح: `killSock(); const myGen = gen;` (حذف `gen++` الأول والاعتماد على زيادة `killSock` فقط).

**P0-2 — الدالة `worker()` غير معرّفة في الملف** — `gateway.mjs:~285, ~318, ~342, ~347`
- الوصف: تُستدعى في 4 مواضع (`/webhook/whatsapp`, `/outbox/pending`, `/outbox/ack`, `/outbox/fail`) ولا يوجد لها تعريف ولا import ⇒ `ReferenceError`، ومبتلَع داخل `try/catch` في الحالتين (`webhook failed` / `outbox poll failed`). (إن كانت مقصوصة من اللصق، فالملاحظات التالية تنطبق على تنفيذها.)
- الأثر: صفر رسائل تصل الـ Worker وصفر ردود تُرسل — البوابة تبدو "شغالة" في الـ logs.
- الإصلاح: تعريف `async function worker(path, method='GET', body)` بـ `fetch(WORKER_URL+path, { method, headers:{'x-admin-key':ADMIN_KEY,'content-type':'application/json'}, body: body&&JSON.stringify(body), signal: AbortSignal.timeout(10_000) })` + رفض عند `!res.ok`.

---

## P1 — فقدان رسائل، تكرار طلبات، أو توقف يحتاج تدخل بشري

**P1-1 — الـ dedupe يُسجَّل قبل نجاح الـ webhook** — `gateway.mjs:~265`
- الوصف: `seenIds.set(m.key.id, 1)` قبل `await worker('/webhook/whatsapp')`، ولا retry ولا persistent queue عند الفشل.
- الأثر: أي فشل شبكة/5xx = طلب تكسي يُفقد نهائياً (حتى لو أعاد واتساب التوصيل، سيُرفض كمكرر).
- الإصلاح: نقل `seenIds.set` بعد نجاح الاستدعاء، مع retry/backoff قصير + persistent queue على القرص للفاشل.

**P1-2 — payload الـ webhook بلا `msgId`/`timestamp`** — `gateway.mjs:~286`
- الوصف: يُرسل `{chatId, senderPhone, text, isGroup}` فقط ⇒ لا مفتاح idempotency على جهة الـ Worker، والـ dedupe in-memory يُصفَّر مع كل restart.
- الأثر: بعد أي restart/re-delivery تُنشأ رحلات مكرّرة على نفس الرسالة.
- الإصلاح: إضافة `msgId: m.key.id, ts: Number(m.messageTimestamp)` واستخدامه كـ unique key في D1/KV.

**P1-3 — قبول `type === 'append'` وعدم فلترة الرسائل القديمة** — `gateway.mjs:~245`
- الوصف: `append` يحمل رسائل مُلحقة/قديمة، ولا يوجد أي شرط على `m.messageTimestamp` مقابل زمن إقلاع العملية أو نافذة زمنية.
- الأثر: بعد انقطاع، الـ offline queue بالكامل يُعالَج كأوامر جديدة ⇒ سيل رحلات وهمية.
- الإصلاح: `if (type !== 'notify') return;` + تجاهل ما `messageTimestamp*1000 < startedAt - 5*60_000`.

**P1-4 — `ack` يحدث بعد نهاية الـ batch فقط** — `gateway.mjs:~340`
- الوصف: تُجمع `sent[]` طوال الدفعة ثم يُنادى `/outbox/ack` مرة واحدة؛ crash/انقطاع في المنتصف يفقد كل التأكيدات.
- الأثر: رسائل وصلت للعميل فعلاً تُعاد في الـ poll التالي ⇒ تكرار مزعج + مخاطرة spam/ban.
- الإصلاح: `ack` بعد كل رسالة أو chunks صغيرة (≤5) بدل نهاية الدفعة.

**P1-5 — فشل الإرسال أثناء الانقطاع يستهلك عدّاد الـ 3 محاولات فوراً** — `gateway.mjs:~322-336`
- الوصف: الحلقة تفحص `shuttingDown` فقط ولا تفحص `state.connection` داخل الـ loop؛ عند سقوط الوصلة تفشل كل رسائل الدفعة تِباعاً، وثلاث دفعات = `fail` نهائي.
- الأثر: رسائل صحيحة تُوسم فشلاً دائماً بسبب مشكلة اتصال عابرة، ولا تمييز بين transient و permanent (`not-on-whatsapp`).
- الإصلاح: `if (state.connection !== 'connected') break;` داخل الـ loop + عدم تصعيد العدّاد إلا لأخطاء permanent.

**P1-6 — لا watchdog لحالة "open لكن ميت"** — `gateway.mjs:~200, ~318`
- الوصف: `state.connection === 'connected'` هو المصدر الوحيد للحقيقة؛ Baileys قد يبقى `open` مع WS ميت أو stalled بلا `close`.
- الأثر: الـ outbox يستمر بالإرسال إلى العدم، وكل الرسائل تُوسم فشلاً (مع P1-5) دون أي تنبيه.
- الإصلاح: تعقّب `lastActivityAt` (أي event/إرسال ناجح) وإجبار `startWhatsApp()` إذا تجاوز الخمول ~5 دقائق.

**P1-7 — `attempts` لا يتراجع، وانتهاء صلاحية QR/515 يستهلكه** — `gateway.mjs:~78, ~215-238`
- الوصف: يُصفَّر فقط على `open`. `qrTimeout: 60s` يولّد `close` (408) بعد كل QR غير ممسوح، و`515 restartRequired` بعد الاقتران يُحتسب أيضاً؛ 4 انقطاعات عابرة موزّعة على أيام = توقف نهائي.
- الأثر: مسح QR بطيء أو ليلة فيها 5 rehandshakes ⇒ `closed` صامت حتى تدخّل بشري؛ و515 يتأخر 6s+ ويقضم الميزانية.
- الإصلاح: استثناء `408/428/515` من العدّاد (إعادة فورية لـ 515) وتصفير `attempts` بعد كل ~10 دقائق اتصال مستقر.

**P1-8 — لا إشعار عند التوقف النهائي** — `gateway.mjs:~222`
- الوصف: عند `fatal`/تجاوز المحاولات يُطبع log محلي فقط؛ لا push للـ Worker ولا للوحة.
- الأثر: البوت ميت والطلبات تتراكم دون أن يعلم أحد حتى يشتكي عميل.
- الإصلاح: `worker('/gateway/alert','POST',{state:'closed',code})` عند الخروج من مسار الـ fatal.

**P1-9 — `uncaughtException` يُبتلَع** — `gateway.mjs:~500`
- الوصف: تسجيل فقط ومتابعة التنفيذ في حالة غير معروفة (سوكت نصف ميت، حلقة outbox متوقفة).
- الأثر: zombie process يمرّ من فحوصات systemd بينما الخدمة معطّلة.
- الإصلاح: log ثم `process.exit(1)` مع `RestartSec=10` + `StartLimitBurst` في الـ unit بدل الابتلاع.

**P1-10 — regex الهاتف يقبل أرقاماً تبدأ بـ 9 فقط** — `gateway.mjs:~437`
- الوصف: `/^9\d{8,14}$/` يرفض 1 (US)، 20 (EG)، 49 (DE)، 44 (UK)… وهذا يصطدم مباشرة بخطة "سيم جديدة / Cloud API test number".
- الأثر: `/pair/code` يفشل بـ 400 على أرقام صحيحة تماماً.
- الإصلاح: `/^[1-9]\d{7,14}$/` (E.164 بلا `+`).

**P1-11 — `/pair/*` يمسح الجلسة إلا إذا كانت `connected`** — `gateway.mjs:~412-420`
- الوصف: الحماية تفحص `connected` فقط؛ أثناء `reconnecting`/`connecting` (شبكة عابرة) يُنفَّذ `rmSync(SESSION_DIR)` على creds سليمة.
- الأثر: خسارة جلسة صحيحة وإجبار اقتران جديد — الأغلى شيء في ظرفكم الحالي.
- الإصلاح: السماح فقط عند `state.connection === 'closed'` أو مع `body.force === true` صريح.

**P1-12 — `await sock?.logout()` بلا timeout** — `gateway.mjs:~470`
- الوصف: على سوكت ميت قد يعلّق `logout()` لدقائق قبل `killSock()` والمسح.
- الأثر: طلب اللوحة يتجمّد/يـtimeout والحالة تبقى غير متّسقة (جلسة قديمة موجودة).
- الإصلاح: `await Promise.race([sock.logout(), new Promise(r=>setTimeout(r,5000))]).catch(()=>{})`.

**P1-13 — `POLL_MS=1500` مقابل حدود/فاتورة Cloudflare** — `gateway.mjs:~64, ~352`
- الوصف: polling ثابت = ~57,600 request/يوم لـ `/outbox/pending` وحده (Free tier = 100k/يوم) قبل حساب webhook/ack، وكل poll غالباً يمس D1/KV.
- الأثر: استهلاك أكثر من نصف الحصة على no-op، وخطر 429/تجاوز في أوقات الذروة.
- الإصلاح: adaptive polling (1.5s بعد نشاط، تصاعدياً حتى 15-30s عند الخمول) أو long-poll/Durable Object WebSocket.

**P1-14 — تعلّم LID مع لاحقة الجهاز `:N`** — `gateway.mjs:~275-280`
- الوصف: `learnLid(senderPhone, senderJid)` يخزّن الـ JID كما هو، وقد يحمل `:12@lid`؛ `resolveJid` يُرجعه للإرسال.
- الأثر: إرسال إلى device-specific JID ⇒ فشل أو تسليم لجهاز واحد فقط.
- الإصلاح: تخزين `jidNormalizedUser(senderJid)` (أو `split(':')[0]+'@lid'`).

**P1-15 — `GATEWAY_TOKEN` افتراضياً = `ADMIN_KEY`** — `gateway.mjs:~62`
- الوصف: نفس السر يحمي لوحة الإدارة المحلية و admin API للـ Worker.
- الأثر: تسريب توكن اللوحة (query string/logs/proxy) = تحكم كامل بالـ Worker.
- الإصلاح: إلزام `GATEWAY_TOKEN` منفصلاً و`process.exit(1)` إذا ساوى `ADMIN_KEY`.

---

## P2 — صلابة/نظافة (سطر لكل مشكلة: الوصف → الأثر → الإصلاح)

1. `~115` — `sock.ev.removeAllListeners()` يمسح أيضاً مستمعي Baileys الداخليين → سلوك غير معرّف أثناء الإغلاق → إزالة موجّهة لأحداثك فقط (`ev.off(event, handler)`).
2. `~145` — لا `msgRetryCounterCache` → دورات retry/`Bad MAC` وفشل فك تشفير متكرر → تمرير `NodeCache` كـ `msgRetryCounterCache`.
3. `~144` — `printQRInTerminal` مهجور في Baileys ≥6.6 → تحذيرات ضجيج → حذف الخيار.
4. `~211` — `state.connection='connecting'` غير موثّق في العقد أعلى الملف ويُطمس `waiting_scan` بعد ظهور QR → اللوحة تُخفي QR صالحاً → عدم الكتابة فوق `waiting_scan` وتوثيق القيمة.
5. `~165, ~104` — `state.pairingRequested` غير معرّف في literal الـ state ولا يظهر في `/status` → اللوحة تعيد النقر أثناء طلب جارٍ → إضافته للـ literal ولخرج `/status`.
6. `~198` — `state.qr` لا يُلغى بعد انتهاء صلاحيته (60s) → عرض QR ميت للمستخدم → تصفيره بمؤقت أو تجاهله في اللوحة عند `qrAgeSec > 55`.
7. `~360` — قبول التوكن من `?token=` → تسريب في access logs/سجلات الـ shell → header فقط.
8. `~490` — لا `server.on('error')` → `EADDRINUSE` يُبتلع بمعالج uncaught واللوحة ميتة بصمت → `server.on('error', e => { log.fatal(e); process.exit(1); })`.
9. `~63-64` — `Number(env)` بلا تحقق → `NaN` ⇒ `setTimeout(NaN)` = حلقة 1ms تهاجم الـ Worker → `Number.isFinite(x) ? x : default`.
10. `~366` — `GATEWAY_TOKEN.length >= 16` يُرجع 401 لكل شيء بصمت لو كان السر قصيراً → "اللوحة معطلة بلا سبب" → فحص الطول عند الإقلاع مع `exit(1)` ورسالة واضحة.
11. `~219` — قائمة `fatal` تفوّت `411 multideviceMismatch` و`500 badSession` → إعادة محاولات عبثية بجلسة تالفة → إضافتهما للقائمة.
12. `~268` — `seenIds.clear()` عند 2000 يُلغي نافذة الـ dedupe كاملة → تكرار مباشرة بعد التصفير → حذف FIFO للأقدم + TTL (~10 دقائق).
13. `~313` — `failCounts` بلا تنظيف/تحديد حجم ويُصفَّر عند restart → نمو غير محدود + إعادة محاولة أبدية لرسالة سامّة → عدّاد محاولات مخزّن في الـ Worker مع حجم أقصى محلي.
14. `~255` — فلترة `status@broadcast` فقط → معالجة broadcast/newsletter وأي مجموعة عشوائية → تجاهل `@broadcast`/`@newsletter` + allowlist لمجموعات معروفة.
15. `~325` — `if (!resp?.key?.id) throw` قد يرمي على رسالة أُرسلت فعلاً → إعادة إرسال مكرّرة → اعتماد الاستثناء الحقيقي فقط كإشارة فشل.
16. `~95` — `resolveJid` يُطبَّق على `@g.us` أيضاً → احتمال تحويل خاطئ لمعرّف مجموعة → التطبيق فقط على `@s.whatsapp.net`.
17. `~320` — لا `onWhatsApp()` قبل الإرسال لأرقام جديدة → إرسال لأرقام غير موجودة = إشارة سيئة للحساب → فحص مُخزَّن (cache) قبل أول إرسال.
18. `~416, ~473` — `rmSync` على مجلد الجلسة بينما كتابات `saveCreds` قد تكون في الطريق، وكتابات `useMultiFileAuthState` غير atomic → `creds.json` تالف عند `SIGKILL` → انتظار flush/إغلاق قبل المسح + كتابة tmp+rename.
19. `~330` — `log.info({to: m.chat_id})` يسجّل أرقام العملاء (PII) واختلاط `console.log` مع pino → سجلات غير قابلة للتحليل + تخزين بيانات شخصية → hashing/تقصير الرقم واستخدام pino فقط.
20. `~318` — `/outbox/pending` بلا `limit` → دفعة ضخمة تحتجز الحلقة دقائق (400-800ms/رسالة) وتؤجّل الـ ack → `?limit=20`.
21. `~178` — `requestPairingCode` بعد `setTimeout(4000)` ثابت → هشّ على شبكة بطيئة (السوكت غير جاهز) → استدعاؤه عند أول `connection.update` يحمل `qr`.
22. `~183` — مؤقّت انتهاء صلاحية الكود غير مُتعقَّب/لا يُلغى في `killSock` → timers متسرّبة عبر الأجيال → تخزينه في متغيّر ومسحه مع البقية.
23. `~90` — إخلاء `lidMap` بالإدراج (FIFO) لا LRU، و`set` لا يُحدّث الترتيب → إخراج mapping نشط بعد 5000 → تحديث الترتيب عند القراءة أو استخدام مكتبة LRU.