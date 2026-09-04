# مراجعة QA — WhatsApp Taxi Dispatch Worker

## P0 — حرجة (أمن / مال / فقدان بيانات)

**P0-1 — `worker.ts` → `POST /webhook/whatsapp`**
لا يوجد أي auth على الـ webhook، عكس `/outbox/*` التي تتحقق من `checkGatewayAuth`. و`senderPhone` يُؤخذ كما هو من الـ body.
الأثر: أي شخص على الإنترنت يقدر ينتحل رقم أي زبون أو سائق — يلغي رحلات الآخرين، يقبل رحلات كسائق، ويغيّر حالات الرحلة. اختراق كامل للنظام.
الإصلاح: `if (!(await checkGatewayAuth(request, env))) return json({error:'unauthorized'},401)` قبل معالجة الـ body.

**P0-2 — `engine.ts` → `handleGroup` + `repo.ts` → `updateRideStatus`**
قراءة الحالة (`status !== 'DISPATCHING'`) ثم التحديث في عمليتين منفصلتين، والـ UPDATE بلا شرط على الحالة (check-then-act race).
الأثر: سائقان يكتبان «قبلت 12» بنفس اللحظة → كلاهما يستلم تأكيد، والزبون يستلم بيانات سائقين مختلفين، والـ FSM يُخترق.
الإصلاح: `UPDATE rides SET status='ASSIGNED',driver_id=? WHERE id=? AND status='DISPATCHING'` والاعتماد على `res.meta.changes === 1` كقفل تفاؤلي.

**P0-3 — `nlu.ts` → `CANCEL_PATTERNS` (النمط `'اك'`)**
مطابقة substring على مقطعين فقط: «بدي **تاك**سي» و«**اك**يد» يحتويان `اك`، وCANCEL يُفحص قبل BOOK وCONFIRM.
الأثر: أشهر جملة حجز في النظام تُترجم إلى إلغاء، و«اكيد» (تأكيد) يلغي الرحلة. خسارة طلبات مباشرة.
الإصلاح: حذف `'اك'` واستبداله بمطابقة token كاملة (`\bالكي\b|\bلغيت\b|\bبطل\b`).

**P0-4 — `nlu.ts` → `DRIVER_DECLINE` (النمط `'لا'`)**
`لا` substring موجود داخل «خلاص»، «لازم»، «بلاش»، وDECLINE يُفحص قبل ACCEPT/ARRIVED/START/DONE.
الأثر: «وصلت خلاص» أو «لازم مشي» تُقرأ رفضاً صامتاً (`return []`) → السائق يظن أن النظام معطّل، والرحلة تتجمد.
الإصلاح: استبدال النمط بـ regex بحدود كلمة (`/(^|\s)لا(\s|$)/`) وترتيب ACCEPT قبل DECLINE.

**P0-5 — `pricing.ts` → `beltPrice` / `computeFare`**
`BELT_BASE[hi] ?? 0` يرجّع صفر لأي belt خارج 1–3 (أو NULL في D1)، والنتيجة تُرجَع بـ `source:'BELT'` لا `'NONE'`، وengine يرفض فقط `NONE`.
الأثر: رحلة تُنشأ بسعر 0 ل.س وتُبلَّغ للزبون والسائق — خسارة مالية صامتة عند أي خطأ إدخال في جدول zones.
الإصلاح: التحقق `if (!(from.belt in BELT_BASE) || !(to.belt in BELT_BASE) || price <= 0) return {source:'NONE',...}`.

**P0-6 — `repo.ts` → `getOpenRideForGroup`**
الاستعلام يعمل `JOIN drivers d ON d.id = r.driver_id` على رحلات `DISPATCHING` التي `driver_id` فيها NULL بالتعريف → لا يطابق أبداً؛ فيسقط دائماً على `getLastDispatching` الذي يتجاهل `groupJid` كلياً.
الأثر: «قبلت» بلا رقم تأخذ آخر رحلة DISPATCHING في النظام كله — سائق مجموعة A يستلم رحلة مجموعة B (cross-tenant leakage).
الإصلاح: تخزين `dispatch_group_jid` على صف الرحلة عند DISPATCHING والاستعلام عليه مباشرة.

**P0-7 — `worker.ts` → `/webhook/whatsapp` (غياب idempotency)**
لا يوجد `message_id` للتخلّص من التكرار، وأي `IllegalTransition` يرتفع كـ HTTP 500 → البوابة تعيد الإرسال.
الأثر: إعادة معالجة نفس الرسالة = رحلتان، أو قبول مزدوج، أو رسائل outbox مكررة مع كل retry.
الإصلاح: عمود `provider_msg_id` بـ UNIQUE + `INSERT OR IGNORE` كبوابة دخول، وإرجاع 200 للأخطاء المنطقية.

**P0-8 — `engine.ts` → `case 'CONFIRM'`**
تحديث الحالة إلى DISPATCHING يحدث قبل (وبمعزل عن) كتابة رسائل outbox في `worker.ts`، وإذا كان `drivers_group_jid` غير موجود في settings لا يُنشر الطلب ولا يُبلَّغ أحد.
الأثر: رحلة عالقة في DISPATCHING لا يراها أي سائق، والزبون قرأ «عم نرسل طلبك» — فقدان طلب صامت.
الإصلاح: `env.DB.batch([...])` لتحديث الحالة وإدراج الـ outbox معاً، والفشل بصوت عالٍ إذا الـ JID مفقود.

**P0-9 — `pricing.ts` → `formatSYP`**
`(price/1000).toFixed(0)` يقرّب: 12,500 → «13 ألف»، و1,250,000 → «1.3 مليون».
الأثر: السعر المعروض ≠ السعر المخزّن/المحصّل → خلافات مع الزبون والسائق على كل رحلة غير مدوّرة، وحساب عمولة لا يطابق ما قرأه السائق.
الإصلاح: `price.toLocaleString('en-US') + ' ل.س'` (أو تدوير السعر نفسه في `computeFare` لأقرب 500 قبل التخزين).

## P1 — مهمة

**P1-1 — `worker.ts` → `checkGatewayAuth` / `handleAdmin`**
`ADMIN_KEY` نفسه يُستخدم كـ Bearer للبوابة، ويُقبل عبر `?key=` (يُسجّل في logs وhistory)، والمقارنة `===` غير constant-time.
الأثر: تسريب مفتاح البوابة = صلاحيات admin كاملة؛ والمفتاح يظهر في أي proxy log.
الإصلاح: `GATEWAY_TOKEN` منفصل + مقارنة بـ timing-safe + الاعتماد على header/cookie فقط (HttpOnly, Secure, SameSite).

**P1-2 — `engine.ts` → `handleGroup` (بداية الدالة)**
لا تحقق أن `msg.chatId` هو فعلاً `drivers_group_jid`.
الأثر: أي مجموعة يُضاف إليها البوت تصبح لوحة توزيع؛ سائق مسجّل يقبل رحلات من أي مكان.
الإصلاح: رفض مبكر إذا `msg.chatId !== settings.drivers_group_jid` (أو `driver.group_jid`).

**P1-3 — `engine.ts` → كل نداءات `assertTransition`**
الاستثناء غير ملتقط في المسار كله.
الأثر: 500 بلا أي رد للمستخدم (مثال واقعي: سائق يكتب «وصلت» وهو `IN_RIDE`)، وسلوك «البوت ميت» + retry storm.
الإصلاح: `try/catch` حول الـ switch يرجّع رسالة عربية ودّية + log.

**P1-4 — `engine.ts` → `case 'CANCEL'`**
لا يُعاد `driver.status` إلى `AVAILABLE` عند إلغاء الزبون لرحلة مُسندة.
الأثر: السائق يبقى BUSY للأبد ويخرج من التوزيع بصمت — نقص في العرض بلا سبب ظاهر.
الإصلاح: `if (active.driver_id) await repo.setDriverStatus(env.DB, active.driver_id, 'AVAILABLE')`.

**P1-5 — `repo.ts` → `getDriverTodayRides` / `todayStats`**
حدود اليوم مبنية على UTC، وسوريا UTC+3.
الأثر: «طلعاتي اليوم» والإيرادات تُصفّر الساعة 3 فجراً محلياً؛ رحلات الليل تُحسب على اليوم الخطأ.
الإصلاح: حساب بداية اليوم بإزاحة `+03:00` صريحة (أو تخزين `local_day` مفهرس).

**P1-6 — `repo.ts` (عام) + `worker.ts` → `/outbox/ack`**
خلط تنسيقات الوقت: `new Date().toISOString()` (`2026-09-04T04:00:00.000Z`) مع `datetime('now')` (`2026-09-04 04:00:00`).
الأثر: مقارنات `>=` النصية على التواريخ تعطي نتائج خاطئة (`' '` < `'T'`) → تقارير وفلاتر مكسورة.
الإصلاح: توحيد التخزين على تنسيق واحد (مفضّل `unixepoch()` INTEGER) في كل الأعمدة الزمنية.

**P1-7 — `nlu.ts` → `normalizeArabic` + `engine.ts` → `idMatch`**
التطبيع لا يحوّل الأرقام العربية-الهندية (`٠١٢`) ولا يزيل الترقيم.
الأثر: «قبلت ١٢» لا يطابق الـ regex → يسقط على fallback ويُسند للسائق **رحلة أخرى**.
الإصلاح: إضافة تحويل `[٠-٩۰-۹]` إلى ASCII داخل `normalizeArabic`.

**P1-8 — `engine.ts` → `case 'DRIVER_DONE'` + `types.ts` → `commission_pct`**
النص يقول «عمولتك (10%)» بينما التعليق في `types.ts` يعرّفها كعمولة الشركة؛ وإذا كانت NULL في D1 فالنتيجة `NaN`.
الأثر: السائق يفهم أن هذا نصيبه من الأجرة → خلاف مالي متكرر؛ وNaN يظهر كنص في الرسالة.
الإصلاح: تسمية دقيقة («حصة الشركة») + `driver.commission_pct ?? 0`.

**P1-9 — `pricing.ts` → `computeFare` + `repo.getFixedFares`**
`find()` يأخذ أول عنصر في مصفوفة قادمة من استعلام **بلا `ORDER BY`**، والتعليق يزعم أنها «الأحدث».
الأثر: مع أي تعرفة مكرّرة يصبح السعر غير حتمي بين طلب وطلب.
الإصلاح: `ORDER BY id DESC` في الاستعلام + UNIQUE على `(from_zone_id,to_zone_id)`.

**P1-10 — `repo.ts` → `getDriverByPhone` + `worker.ts` → `senderPhone` fallback**
لا تطبيع للرقم: `963...` مقابل `+963...`، وJID بلاحقة جهاز (`963xx:7@s.whatsapp.net`)، وفي المجموعات الـ fallback `chatId.split('@')[0]` يعطي معرّف المجموعة لا الرقم.
الأثر: السائق لا يُتعرَّف عليه → كل أوامره تُعالج كأنه زبون.
الإصلاح: دالة `normalizePhone` (digits فقط، إزالة `+`/`00`/لاحقة `:`) تُطبَّق عند الكتابة والقراءة.

**P1-11 — `worker.ts` → `/outbox/pending` و `/outbox/fail`**
لا claim/lock عند السحب، ولا `attempts`، و`/outbox/fail` يضبط `sent_at` (أي «مُرسلة») ويعدّل نص الرسالة.
الأثر: بوابتان تسحبان نفس الصفوف → رسائل مكررة للزبون؛ والفشل يُدفن ولا يُعاد المحاولة أبداً.
الإصلاح: أعمدة `status/attempts/locked_until` + `UPDATE ... RETURNING` للحجز، و`status='FAILED'` بدل `sent_at`.

**P1-12 — `ride-state.ts` (كامل) + `worker.ts` (غياب `scheduled`)**
لا حالة/مؤقت انتهاء: NEW غير مؤكدة وDISPATCHING بلا سائق تبقيان أبداً، و`getActiveRideForClient` تعتبرهما نشطتين.
الأثر: رحلة NEW قديمة تمنع الزبون من الحجز نهائياً («طلبك قيد المعالجة») ولا أحد يعرف السبب؛ ولا إعادة توزيع.
الإصلاح: cron trigger + `EXPIRED` مع TTL لـ NEW/DISPATCHING.

**P1-13 — `repo.ts` → `getZones` (`JSON.parse(r.aliases)`)**
Parse غير محمي على بيانات يحرّرها الأدمن.
الأثر: صف aliases تالف واحد = استثناء في أول سطر من `handleMessage` → البوت يتوقف عن الرد لكل المستخدمين.
الإصلاح: `try/catch` يرجّع `[]` مع log.

**P1-14 — `engine.ts` → طبقة AI + `ai.ts` → `aiParse`**
تُستدعى على كل رسالة غير مفهومة بلا rate-limit/cache/سقف تكلفة، وتضيف 8 ثوانٍ للمسار الحرج؛ ونتيجتها **تستبدل** الـ zones التي استخرجها القواعدي بدل أن تكمّلها.
الأثر: مستخدم واحد يرسل رسائل عشوائية يستهلك الميزانية ويبطئ كل الردود؛ وتراجع في الدقة أحياناً.
الإصلاح: throttle لكل رقم + cache على `normalize(text)` + دمج `ai.from ?? parsed.from_zone`.

**P1-15 — عام (كل الملفات)**
صفر observability (لا `console`/analytics ولا مقاييس على fallbacks أو أخطاء AI) وصفر tests لمنطق NLU/pricing/FSM.
الأثر: أخطاء مثل P0-3/P0-5 تعيش في الإنتاج بلا اكتشاف؛ وأي تعديل على patterns يكسر السلوك بلا شبكة أمان.
الإصلاح: structured logs + Analytics Engine، وunit tests جدولية (table-driven) للنوايا والأسعار والانتقالات.

**P1-16 — `pricing.ts` → `BELT_BASE`**
أسعار الأحزمة hardcoded في الكود بعملة عالية التضخم.
الأثر: كل تعديل تعرفة يحتاج deploy؛ ولوحة الإدارة لا تستطيع ضبطها.
الإصلاح: نقلها إلى `settings`/جدول مع cache قصير.

## P2 — تحسينات

- **`nlu.ts` → `matchesAny`**: مطابقة `includes` بلا حدود كلمات هي السبب الجذري لـ P0-3/P0-4 (`'اه'` يطابق «اهلا» فيؤكّد رحلة). الإصلاح: مطابقة token/regex + scoring بدل first-match.
- **`nlu.ts` → `DRIVER_DECLINE`**: `'مش فاضي'` مكرّر في `DRIVER_BUSY` الذي يُفحص أولاً → نمط ميت. الإصلاح: إزالة التكرار.
- **`engine.ts` → `handleGroup` (فرع غير المسجّل)**: `DRIVER_ACCEPT` لا يُنتج إلا عندما `isDriver=true`، فرسالة «لازم تنسجل» غير قابلة للوصول. الإصلاح: فحص نمط القبول نصياً بمعزل عن `isDriver`.
- **`engine.ts` → نفس الفرع**: `@${msg.senderPhone}` ينشر رقم المرسل في المجموعة ولا يعمل كـ mention بلا metadata. الإصلاح: استخدام الاسم/الإشارة الرسمية.
- **`worker.ts` → `catch (e)`**: `String(e)` يُعيد رسائل داخلية (وعربية) للمتصل. الإصلاح: رد عام + log للتفاصيل.
- **`worker.ts` → `/outbox/ack|fail`**: `ids` بلا تحقق نوعي ولا سقف (حد الـ bound parameters في D1). الإصلاح: `ids.filter(Number.isInteger).slice(0,100)`.
- **`worker.ts` → حلقة إدراج outbox**: N استدعاءات D1 متتابعة. الإصلاح: `env.DB.batch()`.
- **`engine.ts` → أول 3 أسطر**: `getZones` + `getDriverByPhone` + `getFixedFares` على كل رسالة بلا cache، حتى لدردشة مجموعة تُهمَل. الإصلاح: cache على مستوى الوحدة/KV + early-exit للمجموعات.
- **`repo.ts` (عام)**: `SELECT *` مع `first<Driver>()` = type assertion بلا validation (لا يضمن `DriverStatus`). الإصلاح: أعمدة صريحة + mapper.
- **`worker.ts` → `InboundMessage`**: الحقول معلَنة إلزامية لكن الكود يعاملها كاختيارية (`body.senderPhone ?? ...`) وبلا schema validation. الإصلاح: نوع `RawInbound` + validator.
- **`ai.ts` → `aiParse`**: `ai.intent` يُحوَّل بـ cast بلا whitelist؛ الحقل `reply` غير مستخدم؛ regex `\{[\s\S]*\}` جشِع (يفشل مع كائنين). الإصلاح: مصفوفة نوايا مسموحة + `[\s\S]*?` non-greedy.
- **`ai.ts` → `matchZoneByName`**: `includes` باتجاهين يجعل نصاً قصيراً يطابق أطول منطقة بصمت. الإصلاح: حد أدنى للطول + fuzzy score (Levenshtein) مع threshold.
- **`pricing.ts` → `beltPrice`**: الرسم الإضافي مربوط بـ `BELT_BASE[1]` فيجعل 1→3 (90k) شبه مساوٍ لـ 2→3 (85k) — غير منطقي تجارياً. و`sameZoneFallback` باراميتر غير مستخدم.
- **`engine.ts` → `createRide`**: `from_text` و`to_text` كلاهما `parsed.raw` → فقدان النص الأصلي لكل طرف (يضر تحسين NLU لاحقاً).
- **`engine.ts` → `handleDriverPrivate`**: السائق لا يستطيع الحجز كزبون أبداً، ويستطيع إعلان «متاح» وهو داخل رحلة نشطة.
- **`engine.ts` → docstring**: الملف يزعم «no IO here» ثم يستعلم `settings` مباشرة متجاوزاً `repo` — يضر قابلية الاختبار.
- **قاعدة البيانات**: جدول `outbox` ينمو بلا تنظيف؛ ولا فهارس ظاهرة على `rides(status)`, `rides(client_phone,status)`, `rides(driver_id,status)`, `outbox(sent_at)`, `drivers(phone)`.
- **`ride-state.ts` → `IllegalTransition`**: بلا `name` ولا كود خطأ قابل للتمييز برمجياً.

## نقاط القوة

فصل المسؤوليات نظيف وقابل للاختبار: NLU قواعدي مستقل يعمل بلا إنترنت ولا كلفة، وطبقة AI اختيارية تفشل بأمان إلى `null`، وFSM مركزية تعلن الانتقالات المسموحة بوضوح، وrepo يعزل D1 عن منطق العمل.

كل الاستعلامات تستخدم prepared statements مع `bind` (لا SQL injection)، والتصميم غير المتزامن عبر outbox + ack يمنح النظام قدرة تحمّل لانقطاع بوابة WhatsApp، والتسعير بمبدأ «التعرفة اليدوية تتقدّم» مع نبرة عربية عامية متسقة يعطي تجربة مستخدم مقنعة.