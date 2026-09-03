# خطة إنعاش بوابة التكسي — 2026-09-03

## الوضع المؤكد (VERIFIED)
- taxi-gateway شغالة لكن كلها عالقة `initializing` — ما بتوصل لحدث QR
- السبب: whatsapp-bridge تبع Hermes (pid bridge.js, port 3000) ماسك اتصال واتساب الوحيد للحساب 963992265248
- واتساب ما بيقبل جهازين web بنفس الحساب → أي اتصال جديد يتصرك 401/405
- الاختبار المستقل بـ Baileys من /tmp: QR بيطلع خلال ثواني لما ما في تعارض ✓
- CORS بين اللوحة (workers.dev) و almaih.cloud/g/ منحل (nginx: headers + OPTIONS 204) ✓

## ممنوع
- لمس/إيقاف bridge.js — واتساب المهندس عليه وما بيتوقف إطلاقاً
- لا VPN (الحظر على الحساب مو IP) — لا Workers كبوابة Baileys (سوكت دائم غير مدعوم)

## الخيار 1: سيم جديدة للبوت (اليوم)
1. نجيب رقم جديد (نفس الشبكة أو أي شبكة)
2. نعدّل settings بالـ D1 إذا الرقم مخزن، ونتأكد من `drivers_group_jid`
3. `POST /g/pair/code?token=...` برقم الجديد من اللوحة (كود اقتران أفضل من QR — ما بده مسح)
4. ندخل الكود بالتلفون الجديد → اتصال → `cp -a session session.bak.<رقم>` فوراً
5. نبلّش السواقين يتواصلو مع الرقم الجديد + نحدّث الرقم المنشور عند الزباين

## الخيار 2: WhatsApp Cloud API (الجذري)
1. حساب Meta Business + تطبيق → إضافة WhatsApp product
2. Test number للتجربة الفورية (حد ~250 محادثة/شهر) ثم رقم حقيقي
3. Webhook جديد على الـ Worker: route `/-/wa-cloud` — يستقبل الرسايل (بدل gateway webhook)
4. إرسال: Graph API `POST /{phone_number_id}/messages` (بدل outbox poll)
5. طبقة العقل (NLU/تسعير/حالات) ما تنمس — بس طبقة النقل تتبدل
6. Token يتحط secret `WA_CLOUD_TOKEN` على الـ Worker
7. بعدين: `systemctl disable --now taxi-gateway` نهائياً (بعد ما يثبت الجديد)

## للتنفيذ الفوري لما يختار المهندس
- خيار 1: محتاج رقم السيم الجديد فقط
- خيار 2: محتاج حساب Meta Business أو ننشئه سوا
