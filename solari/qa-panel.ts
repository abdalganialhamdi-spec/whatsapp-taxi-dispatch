# ☁️ وحدة Solari — QA أوتوماتيكي للبوت بمتصفح سحابي
#
# هذه الوحدة تستخدم Solari Cloud Browser (Stealth Chrome) لتجربة لوحة الإدارة
# والتحقق أن: الصفحة تفتح، الإحصائيات تظهر، ولا يوجد أخطاء JS.
#
# الاستخدام:
#   export SOLARI_API_KEY=slr_live_...   # من console.getsolari.com
#   export PANEL_URL=https://xxx.workers.dev/?key=...
#   npx tsx solari/qa-panel.ts
#
# هي جزء التقييم في fork solari-cookbook: use case حقيقي "QA agent"

import { Solari } from '@solarisdk/browser';

const PANEL_URL = process.env.PANEL_URL;
if (!PANEL_URL) { console.error('PANEL_URL مطلوب'); process.exit(1); }

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! });
const browser = await solari.launch({ stealth: true, captcha: true });

try {
  const page = await browser.newPage();

  // 1) اللوحة تفتح
  await page.goto(PANEL_URL, { waitUntil: 'networkidle' });
  const title = await page.title();
  console.log('✅ العنوان:', title);
  if (!title.includes('مشاوير')) throw new Error('عنوان اللوحة غير متوقع');

  // 2) الإحصائيات موجودة
  const statsCount = await page.locator('.stat').count();
  console.log(`✅ بطاقات الإحصائيات: ${statsCount}`);
  if (statsCount < 4) throw new Error('بطاقات الإحصائيات ناقصة');

  // 3) لا أخطاء JS
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.reload({ waitUntil: 'networkidle' });
  if (errors.length) throw new Error(`أخطاء JS: ${errors.join(', ')}`);
  console.log('✅ لا أخطاء JS');

  console.log('\n🎉 QA Solari: اللوحة صحية 100%');
} finally {
  // ⚠️ مهم جداً (gotcha من الكوكبوك): بدون close() السكربت يعلق للأبد
  await solari.close();
}
