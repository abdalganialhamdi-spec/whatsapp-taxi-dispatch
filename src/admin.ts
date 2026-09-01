/**
 * لوحة الإدارة — عربية RTL، بلا أي framework (HTML واحد جاهز من الـ Worker).
 * التبويبات: اليوم | الرحلات | السواقين | المناطق والتعاريف
 */

import { todayStats } from './repo.js';
import { formatSYP } from './pricing.js';
import type { Env } from './types.js';

export async function adminPage(env: Env): Promise<Response> {
  const stats = await todayStats(env.DB);
  const { results: drivers } = await env.DB.prepare(
    `SELECT id, name, phone, car, plate, status, commission_pct FROM drivers WHERE active = 1 ORDER BY id`
  ).all();
  const { results: rides } = await env.DB.prepare(
    `SELECT r.id, r.client_phone, r.status, r.price, r.created_at,
            fz.name AS from_name, tz.name AS to_name, d.name AS driver_name
     FROM rides r
     LEFT JOIN zones fz ON fz.id = r.from_zone_id
     LEFT JOIN zones tz ON tz.id = r.to_zone_id
     LEFT JOIN drivers d ON d.id = r.driver_id
     ORDER BY r.id DESC LIMIT 50`
  ).all();
  const { results: zones } = await env.DB.prepare(`SELECT id, name, belt FROM zones ORDER BY belt, id`).all();
  const { results: fares } = await env.DB.prepare(
    `SELECT f.id, f.price, f.note, fz.name AS from_name, tz.name AS to_name
     FROM fixed_fares f
     JOIN zones fz ON fz.id = f.from_zone_id
     JOIN zones tz ON tz.id = f.to_zone_id
     ORDER BY f.id`
  ).all();

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>مشاوير الحموي — لوحة الإدارة</title>
<style>
  :root { --bg:#f6f4ef; --card:#fff; --ink:#2d2a24; --accent:#0e7c66; --line:#e4ded2; }
  * { box-sizing:border-box; font-family:'Segoe UI', Tahoma, 'Noto Naskh Arabic', sans-serif; }
  body { margin:0; background:var(--bg); color:var(--ink); }
  header { background:var(--accent); color:#fff; padding:16px 20px; }
  header h1 { margin:0; font-size:20px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; padding:16px 20px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; text-align:center; }
  .stat .n { font-size:26px; font-weight:700; color:var(--accent); }
  main { padding:0 20px 40px; }
  h2 { font-size:17px; margin:26px 0 10px; border-bottom:2px solid var(--line); padding-bottom:6px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:12px; overflow:hidden; font-size:14px; }
  th, td { padding:10px 12px; text-align:right; border-bottom:1px solid var(--line); }
  th { background:#efece4; font-weight:700; }
  .st { display:inline-block; padding:2px 10px; border-radius:99px; font-size:12px; }
  .st.NEW{background:#fff3cd} .st.DISPATCHING{background:#d1ecf1} .st.ASSIGNED{background:#d4edda}
  .st.ARRIVED{background:#e2d5f1} .st.IN_RIDE{background:#fde2c8} .st.DONE{background:#c9e7d3} .st.CANCELLED{background:#f5d0d0}
  .pill { display:inline-block; padding:2px 10px; border-radius:99px; background:#e8f5f1; color:var(--accent); font-size:12px; margin-inline-end:6px; }
  footer { color:#8a8578; font-size:12px; text-align:center; padding:20px; }
</style>
</head>
<body>
<header><h1>🚕 مشاوير الحموي — لوحة الإدارة</h1></header>

<div class="stats">
  <div class="stat"><div class="n">${stats.total}</div>رحلات اليوم</div>
  <div class="stat"><div class="n">${stats.done}</div>منفذة</div>
  <div class="stat"><div class="n">${formatSYP(stats.revenue)}</div>الإيراد</div>
  <div class="stat"><div class="n">${stats.activeDrivers}</div>سواق نشطون</div>
</div>

<main>
<h2>آخر الرحلات</h2>
<table><tr><th>#</th><th>الزبون</th><th>من</th><th>إلى</th><th>السائق</th><th>الأجرة</th><th>الحالة</th><th>التاريخ</th></tr>
${(rides ?? []).map((r: any) => `<tr>
  <td>${r.id}</td><td>${r.client_phone}</td><td>${r.from_name ?? '—'}</td><td>${r.to_name ?? '—'}</td>
  <td>${r.driver_name ?? '—'}</td><td>${r.price ? formatSYP(r.price) : '—'}</td>
  <td><span class="st ${r.status}">${r.status}</span></td><td>${(r.created_at ?? '').slice(0, 16)}</td>
</tr>`).join('')}
</table>

<h2>السواقون</h2>
<table><tr><th>#</th><th>الاسم</th><th>التلفون</th><th>السيارة</th><th>اللوحة</th><th>العمولة</th><th>الحالة</th></tr>
${(drivers ?? []).map((d: any) => `<tr>
  <td>${d.id}</td><td>${d.name}</td><td dir="ltr">+${d.phone}</td><td>${d.car}</td><td>${d.plate}</td>
  <td>${d.commission_pct}%</td><td><span class="pill">${d.status}</span></td>
</tr>`).join('')}
</table>

<h2>المناطق</h2>
<table><tr><th>#</th><th>الاسم</th><th>الحزام</th></tr>
${(zones ?? []).map((z: any) => `<tr><td>${z.id}</td><td>${z.name}</td><td>حزام ${z.belt}</td></tr>`).join('')}
</table>

<h2>التعاريف اليدوية</h2>
<table><tr><th>من</th><th>إلى</th><th>الأجرة</th><th>ملاحظة</th></tr>
${(fares ?? []).map((f: any) => `<tr><td>${f.from_name}</td><td>${f.to_name}</td><td>${formatSYP(f.price)}</td><td>${f.note ?? ''}</td></tr>`).join('')}
</table>
</main>
<footer>whatsapp-taxi-dispatch — مبني بالـ AI ☁️ Cloudflare Workers + D1</footer>
</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** واجهة API إدارية (إضافة سواق/تعرفة مستقبلاً) */
export async function adminApi(request: Request, env: Env, action: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('POST فقط', { status: 405 });
  const body = await request.json<Record<string, any>>();
  switch (action) {
    case 'driver.add': {
      await env.DB.prepare(
        `INSERT INTO drivers (phone, name, car, plate, commission_pct, group_jid) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(String(body.phone), String(body.name), String(body.car ?? ''), String(body.plate ?? ''), Number(body.commission_pct ?? 10), String(body.group_jid ?? ''))
        .run();
      return Response.json({ ok: true });
    }
    case 'fare.add': {
      await env.DB.prepare(
        `INSERT INTO fixed_fares (from_zone_id, to_zone_id, price, note) VALUES (?, ?, ?, ?)`
      )
        .bind(Number(body.from_zone_id), Number(body.to_zone_id), Number(body.price), String(body.note ?? ''))
        .run();
      return Response.json({ ok: true });
    }
    case 'zone.add': {
      await env.DB.prepare(`INSERT INTO zones (name, aliases, belt) VALUES (?, ?, ?)`)
        .bind(String(body.name), JSON.stringify(body.aliases ?? []), Number(body.belt ?? 1))
        .run();
      return Response.json({ ok: true });
    }
    default:
      return Response.json({ error: 'unknown action' }, { status: 404 });
  }
}
