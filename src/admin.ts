/**
 * لوحة الإدارة — عربية RTL، صفحة واحدة بتبويبات: واتساب | اليوم | الرحلات | السواقين | المناطق والتعاريف
 * كل العمليات: إضافة/تعديل/حذف/إلغاء رحلة — بلا أي framework.
 */

import { todayStats } from './repo.js';
import { formatSYP } from './pricing.js';
import { whatsappTabHtml } from './whatsapp-tab.js';
import type { Env } from './types.js';

const GATEWAY_URL = 'https://almaih.cloud/g';

/** حالة البوابة من خادم البوت (QR/كود اقتران) — null إذا غير متاح */
async function gatewayStatus(adminKey: string): Promise<Record<string, any> | null> {
  try {
    const res = await fetch(`${GATEWAY_URL}/status`, {
      headers: { 'x-gateway-token': adminKey },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

export async function adminPage(env: Env): Promise<Response> {
  const stats = await todayStats(env.DB);
  const gw = await gatewayStatus(env.ADMIN_KEY);
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
    `SELECT f.id, f.price, f.note, f.from_zone_id, f.to_zone_id, fz.name AS from_name, tz.name AS to_name
     FROM fixed_fares f
     JOIN zones fz ON fz.id = f.from_zone_id
     JOIN zones tz ON tz.id = f.to_zone_id
     ORDER BY f.id`
  ).all();
  const { results: settings } = await env.DB.prepare(`SELECT key, value FROM settings ORDER BY key`).all();

  // هروب HTML لكل القيم القادمة من قاعدة البيانات
  const esc = (s: unknown): string =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

  const zoneOptions = (zones ?? [])
    .map((z: any) => `<option value="${z.id}">${z.name} (حزام ${z.belt})</option>`)
    .join('');

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>مشاوير الحموي — لوحة الإدارة</title>
<style>
  :root { --bg:#f6f4ef; --card:#fff; --ink:#2d2a24; --accent:#0e7c66; --line:#e4ded2; --danger:#c0392b; }
  * { box-sizing:border-box; font-family:'Segoe UI', Tahoma, 'Noto Naskh Arabic', sans-serif; }
  body { margin:0; background:var(--bg); color:var(--ink); }
  header { background:var(--accent); color:#fff; padding:16px 20px; }
  header h1 { margin:0; font-size:20px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; padding:16px 20px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; text-align:center; }
  .stat .n { font-size:26px; font-weight:700; color:var(--accent); }
  main { padding:0 20px 40px; max-width:1100px; margin:0 auto; }
  h2 { font-size:17px; margin:26px 0 10px; border-bottom:2px solid var(--line); padding-bottom:6px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:12px; overflow:hidden; font-size:14px; }
  th, td { padding:10px 12px; text-align:right; border-bottom:1px solid var(--line); }
  th { background:#efece4; font-weight:700; }
  .st { display:inline-block; padding:2px 10px; border-radius:99px; font-size:12px; }
  .st.NEW{background:#fff3cd} .st.DISPATCHING{background:#d1ecf1} .st.ASSIGNED{background:#d4edda}
  .st.ARRIVED{background:#e2d5f1} .st.IN_RIDE{background:#fde2c8} .st.DONE{background:#c9e7d3} .st.CANCELLED{background:#f5d0d0}
  .pill { display:inline-block; padding:2px 10px; border-radius:99px; background:#e8f5f1; color:var(--accent); font-size:12px; margin-inline-end:6px; }
  button { cursor:pointer; border:0; border-radius:8px; padding:8px 14px; font-size:14px; background:var(--accent); color:#fff; }
  button.danger { background:var(--danger); }
  button.small { padding:4px 10px; font-size:12px; }
  input, select { border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:14px; }
  form.bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; margin-bottom:12px; }
  form.bar label { font-size:13px; color:#6b6558; }
  footer { color:#8a8578; font-size:12px; text-align:center; padding:20px; }
  .muted { color:#8a8578; font-size:13px; }
  /* 📱 موبايل: أهداف لمس كبيرة + جداول بتمرير أفقي + نماذج مكدسة */
  @media (max-width:640px) {
    header { padding:12px 14px; } header h1 { font-size:17px; }
    main { padding:0 10px 30px; }
    .stats { padding:12px 10px; grid-template-columns:repeat(2,1fr); gap:8px; }
    .stat .n { font-size:22px; }
    table { display:block; overflow-x:auto; white-space:nowrap; }
    button { min-height:44px; font-size:15px; }
    input, select { min-height:44px; font-size:16px; max-width:100%; }
    form.bar { flex-direction:column; align-items:stretch; }
    form.bar input, form.bar select { width:100% !important; }
    .qr-box img { width:100%; max-width:280px; height:auto; }
    .code-box .code { font-size:24px; }
  }
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
${whatsappTabHtml({
  connection: gw?.connection ?? 'closed',
  user: gw?.user ?? null,
  qr: gw?.qr ?? null,
  pairingCode: gw?.pairingCode ?? null,
  pairingExpiresInSec: gw?.pairingExpiresInSec ?? null,
  lastError: gw?.lastError ?? (gw === null ? 'البوابة غير متاحة — شغّل gateway.mjs على السيرفر' : null),
})}

<h2>⚙️ الإعدادات</h2>
<form class="bar" onsubmit="return saveSettings(event, this)">
  ${(settings ?? []).map((s: any) => `
  <label>${esc(s.key)}</label><input name="${esc(s.key)}" value="${esc(s.value)}" dir="ltr" style="width:280px">`).join('')}
  <button>💾 حفظ الإعدادات</button>
</form>
<p class="muted">bot_enabled=1 شغال / 0 صيانة — drivers_group_jid مجموعة السواقين — admin_phone يستقبل تنبيهات «المهندس»</p>

<h2>آخر الرحلات</h2>
<table>
<tr><th>#</th><th>الزبون</th><th>من</th><th>إلى</th><th>السائق</th><th>الأجرة</th><th>الحالة</th><th>التاريخ</th><th></th></tr>
${(rides ?? []).map((r: any) => `<tr>
  <td>${r.id}</td><td dir="ltr">${r.client_phone}</td><td>${r.from_name ?? '—'}</td><td>${r.to_name ?? '—'}</td>
  <td>${r.driver_name ?? '—'}</td><td>${r.price ? formatSYP(r.price) : '—'}</td>
  <td><span class="st ${r.status}">${r.status}</span></td><td>${(r.created_at ?? '').slice(0, 16)}</td>
  <td>${['NEW','DISPATCHING','ASSIGNED','ARRIVED','IN_RIDE'].includes(r.status)
    ? `<button class="small danger" onclick="cancelRide(${r.id})">إلغاء</button>` : ''}</td>
</tr>`).join('')}
</table>

<h2>السواقون</h2>
<form class="bar" onsubmit="return addDriver(event, this)">
  <label>الاسم</label><input name="name" required style="width:120px">
  <label>التلفون</label><input name="phone" dir="ltr" required placeholder="9639XXXXXXXX" style="width:150px">
  <label>السيارة</label><input name="car" placeholder="كيا سيراتو" style="width:120px">
  <label>اللوحة</label><input name="plate" style="width:100px">
  <label>العمولة %</label><input name="commission_pct" type="number" value="10" min="0" max="50" style="width:70px">
  <button>➕ إضافة سائق</button>
</form>
<table>
<tr><th>#</th><th>الاسم</th><th>التلفون</th><th>السيارة</th><th>اللوحة</th><th>العمولة</th><th>الحالة</th><th></th></tr>
${(drivers ?? []).map((d: any) => `<tr>
  <td>${d.id}</td><td>${d.name}</td><td dir="ltr">+${d.phone}</td><td>${d.car}</td><td>${d.plate}</td>
  <td>${d.commission_pct}%</td><td><span class="pill">${d.status}</span></td>
  <td>
    <button class="small" onclick="driverStatus(${d.id},'${d.status === 'AVAILABLE' ? 'OFFLINE' : 'AVAILABLE'}')">${d.status === 'AVAILABLE' ? 'إيقاف' : 'تشغيل'}</button>
    <button class="small danger" onclick="delDriver(${d.id})">حذف</button>
  </td>
</tr>`).join('')}
</table>

<h2>المناطق</h2>
<form class="bar" onsubmit="return addZone(event, this)">
  <label>الاسم</label><input name="name" required style="width:160px">
  <label>أسماء بديلة (فاصلة)</label><input name="aliases" placeholder="عند المخيم,المخيم القديم" style="width:220px">
  <label>الحزام</label>
  <select name="belt"><option value="1">1 — مدينة</option><option value="2">2 — ضواحي</option><option value="3">3 — ريف</option></select>
  <button>➕ إضافة منطقة</button>
</form>
<table>
<tr><th>#</th><th>الاسم</th><th>الحزام</th><th></th></tr>
${(zones ?? []).map((z: any) => `<tr>
  <td>${z.id}</td><td>${z.name}</td><td>حزام ${z.belt}</td>
  <td>
    <button class="small" onclick="zoneBelt(${z.id},${z.belt >= 3 ? 1 : z.belt + 1})">حزام → ${z.belt >= 3 ? 1 : z.belt + 1}</button>
    <button class="small danger" onclick="delZone(${z.id})">حذف</button>
  </td>
</tr>`).join('')}
</table>

<h2>التعاريف اليدوية (تفوق الحساب دائماً)</h2>
<form class="bar" onsubmit="return addFare(event, this)">
  <label>من</label><select name="from_zone_id" required>${zoneOptions}</select>
  <label>إلى</label><select name="to_zone_id" required>${zoneOptions}</select>
  <label>الأجرة (ل.س)</label><input name="price" type="number" min="0" required style="width:120px">
  <label>ملاحظة</label><input name="note" placeholder="تعرفة معتمدة" style="width:140px">
  <button>➕ إضافة تعرفة</button>
</form>
<table>
<tr><th>من</th><th>إلى</th><th>الأجرة</th><th>ملاحظة</th><th></th></tr>
${(fares ?? []).map((f: any) => `<tr>
  <td>${f.from_name}</td><td>${f.to_name}</td><td>${formatSYP(f.price)}</td><td>${f.note ?? ''}</td>
  <td>
    <button class="small" onclick="editFare(${f.id}, ${f.from_zone_id}, ${f.to_zone_id}, ${f.price})">تعديل السعر</button>
    <button class="small danger" onclick="delFare(${f.id})">حذف</button>
  </td>
</tr>`).join('')}
</table>
</main>
<footer>whatsapp-taxi-dispatch — مبني بالـ AI ☁️ Cloudflare Workers + D1</footer>

<script>
const K = new URLSearchParams(location.search).get('key');
const API = '/admin/api/';

async function api(action, body) {
  try {
    const r = await fetch(API + action + '?key=' + K, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { alert('فشلت العملية: ' + (await r.text())); return false; }
    location.reload();
    return false;
  } catch (e) {
    alert('خطأ شبكة: ' + e);
    return false;
  }
}

function cancelRide(id) {
  if (confirm('إلغاء الرحلة ' + id + '؟')) api('ride.cancel', { id });
}
function addDriver(ev, f) {
  ev.preventDefault();
  return api('driver.add', {
    name: f.name.value, phone: f.phone.value.replace(/[^0-9]/g, ''),
    car: f.car.value, plate: f.plate.value, commission_pct: +f.commission_pct.value,
  });
}
function driverStatus(id, status) { api('driver.status', { id, status }); }
function delDriver(id) { if (confirm('حذف السائق ' + id + '؟')) api('driver.del', { id }); }
function addZone(ev, f) {
  ev.preventDefault();
  return api('zone.add', { name: f.name.value, aliases: f.aliases.value.split(',').map(s => s.trim()).filter(Boolean), belt: +f.belt.value });
}
function zoneBelt(id, belt) { api('zone.belt', { id, belt }); }
function delZone(id) { if (confirm('حذف المنطقة ' + id + '؟')) api('zone.del', { id }); }
function addFare(ev, f) {
  ev.preventDefault();
  return api('fare.add', { from_zone_id: +f.from_zone_id.value, to_zone_id: +f.to_zone_id.value, price: +f.price.value, note: f.note.value });
}
function editFare(id, from, to, oldPrice) {
  const p = prompt('السعر الجديد (ل.س):', oldPrice);
  if (p) api('fare.edit', { id, price: +p });
}
function delFare(id) { if (confirm('حذف التعرفة ' + id + '؟')) api('fare.del', { id }); }
function saveSettings(ev, f) {
  ev.preventDefault();
  const body = {};
  for (const el of f.elements) { if (el.name) body[el.name] = el.value; }
  return api('settings.set', body);
}
</script>
</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** واجهة API إدارية كاملة CRUD */
export async function adminApi(request: Request, env: Env, action: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('POST فقط', { status: 405 });
  const body = await request.json<Record<string, any>>();
  try {
    switch (action) {
      // ─── سواقين ───
      case 'driver.add': {
        await env.DB.prepare(
          `INSERT INTO drivers (phone, name, car, plate, commission_pct, group_jid) VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(String(body.phone), String(body.name), String(body.car ?? ''), String(body.plate ?? ''), Number(body.commission_pct ?? 10), String(body.group_jid ?? ''))
          .run();
        return Response.json({ ok: true });
      }
      case 'driver.status': {
        await env.DB.prepare(`UPDATE drivers SET status = ? WHERE id = ?`).bind(String(body.status), Number(body.id)).run();
        return Response.json({ ok: true });
      }
      case 'driver.del': {
        await env.DB.prepare(`UPDATE drivers SET active = 0 WHERE id = ?`).bind(Number(body.id)).run();
        return Response.json({ ok: true });
      }

      // ─── مناطق ───
      case 'zone.add': {
        await env.DB.prepare(`INSERT INTO zones (name, aliases, belt) VALUES (?, ?, ?)`)
          .bind(String(body.name), JSON.stringify(body.aliases ?? []), Number(body.belt ?? 1))
          .run();
        return Response.json({ ok: true });
      }
      case 'zone.belt': {
        await env.DB.prepare(`UPDATE zones SET belt = ? WHERE id = ?`).bind(Number(body.belt), Number(body.id)).run();
        return Response.json({ ok: true });
      }
      case 'zone.del': {
        await env.DB.prepare(`DELETE FROM zones WHERE id = ?`).bind(Number(body.id)).run();
        return Response.json({ ok: true });
      }

      // ─── تعاريف ───
      case 'fare.add': {
        await env.DB.prepare(
          `INSERT INTO fixed_fares (from_zone_id, to_zone_id, price, note) VALUES (?, ?, ?, ?)`
        )
          .bind(Number(body.from_zone_id), Number(body.to_zone_id), Number(body.price), String(body.note ?? ''))
          .run();
        return Response.json({ ok: true });
      }
      case 'fare.edit': {
        await env.DB.prepare(`UPDATE fixed_fares SET price = ? WHERE id = ?`).bind(Number(body.price), Number(body.id)).run();
        return Response.json({ ok: true });
      }
      case 'fare.del': {
        await env.DB.prepare(`DELETE FROM fixed_fares WHERE id = ?`).bind(Number(body.id)).run();
        return Response.json({ ok: true });
      }

      // ─── إعدادات ───
      case 'settings.set': {
        for (const [k, v] of Object.entries(body)) {
          if (!/^[a-z_]{1,40}$/.test(k)) continue;
          await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .bind(k, String(v ?? '')).run();
        }
        return Response.json({ ok: true });
      }

      // ─── رحلات ───
      case 'ride.cancel': {
        const ride = await env.DB.prepare(`SELECT status FROM rides WHERE id = ?`).bind(Number(body.id)).first<{ status: string }>();
        if (!ride) return Response.json({ error: 'الرحلة غير موجودة' }, { status: 404 });
        if (!['NEW', 'DISPATCHING', 'ASSIGNED', 'ARRIVED', 'IN_RIDE'].includes(ride.status)) {
          return Response.json({ error: 'الرحلة مقفلة — ما تنلغى' }, { status: 400 });
        }
        await env.DB.prepare(`UPDATE rides SET status = 'CANCELLED' WHERE id = ?`).bind(Number(body.id)).run();
        return Response.json({ ok: true });
      }

      default:
        return Response.json({ error: 'unknown action: ' + action }, { status: 404 });
    }
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
