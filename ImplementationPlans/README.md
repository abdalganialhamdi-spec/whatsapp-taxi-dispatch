# ImplementationPlans — بوت تكسي حماة
مراجعة QA كاملة بمودل `claude-opus-5` (عبر relay، streaming) بتاريخ 2026-09-04 + خطط تنفيذ.

## المراجعات
- `00-review-gateway.md` — مراجعة `gateway/gateway.mjs` (Baileys)
- `00-review-worker.md` — مراجعة الـ Worker (engine/nlu/pricing/repo/state/worker/ai/types)
- `00-review-panel.md` — مراجعة اللوحة (admin.ts + whatsapp-tab.ts)

## الخطط
1. `01-revive-roadmap.md` — خط سير الإحياء حتى أول رحلة (سيم جديدة أو Cloud API test)
2. `02-gateway-hardening.md` — إصلاحات تثبيت البوابة (كود جاهز للصق)
3. `03-testing-checklist.md` — قوائم اختبار ما قبل/بعد الاقتران
4. `04-rollout.md` — التشغيل التدريجي مع السواقين والزبائن

## ⚠️ أهم اكتشاف (متحقق منه بالكود)
`gateway.mjs:105-107` — `gen++` ثم `killSock()` (التي فيها `gen++` ثانية) ⇒ `myGen` قديم دائما ⇒ كل guards تخرج مبكرا ⇒ **البوابة لا تنشئ سوكت أبدا** (يفسر `initializing` الأبدي). الإصلاح أول بند في `02-gateway-hardening.md`.
قواعد: لا لمس bridge.js، لا مسح `gateway/session` إلا بطلب صريح.
