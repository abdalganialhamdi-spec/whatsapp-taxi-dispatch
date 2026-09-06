/**
 * لوحة الإدارة — عربية RTL، كل شغلة صفحة لحالها:
 *   /                الرئيسية (نظرة عامة + روابط)
 *   /admin/chats     المحادثات — دردشة كاملة من الموقع
 *   /admin/pricing   الأسعار — سعر الانتقال من مكان لمكان + المناطق
 *   /admin/drivers   السواقون
 *   /admin/rides     الرحلات
 *   /admin/settings  الإعدادات
 *   /admin/whatsapp  ربط واتساب
 */

import { todayStats, getConversations, getChatMessages, getPausedChats, setPaused, queueOutbox } from './repo.js';
import { aiChat } from './ai.js';
import { formatSYP } from './pricing.js';
import { whatsappTabHtml } from './whatsapp-tab.js';
import type { Env } from './types.js';

/** توحيد صيغة الوجهة: رقم محلي/دولي → JID، أو JID كما هو */
function normToChat(to: string): string {
  to = to.trim();
  if (to.includes('@')) return to;
  let d = to.replace(/[^0-9]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '963' + d.slice(1);
  return d + '@s.whatsapp.net';
}

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

// ─── التنقل المشترك ───
const NAV: Array<{ id: string; href: string; label: string }> = [
  { id: 'home', href: '/', label: '🏠 الرئيسية' },
  { id: 'chats', href: '/admin/chats', label: '💬 المحادثات' },
  { id: 'pricing', href: '/admin/pricing', label: '💰 الأسعار' },
  { id: 'drivers', href: '/admin/drivers', label: '🧑‍✍️ السواقون' },
  { id: 'rides', href: '/admin/rides', label: '🧾 الرحلات' },
  { id: 'settings', href: '/admin/settings', label: '⚙️ الإعدادات' },
  { id: 'whatsapp', href: '/admin/whatsapp', label: '📱 واتساب' },
];

const SHARED_CSS = `
  :root { --bg:#f6f4ef; --card:#fff; --ink:#2d2a24; --accent:#0e7c66; --line:#e4ded2; --danger:#c0392b; }
  * { box-sizing:border-box; font-family:'Segoe UI', Tahoma, 'Noto Naskh Arabic', sans-serif; }
  body { margin:0; background:var(--bg); color:var(--ink); }
  header { background:var(--accent); color:#fff; padding:16px 20px; }
  header h1 { margin:0; font-size:20px; }
  nav.tabs { position:sticky; top:0; z-index:10; background:var(--card); border-bottom:1px solid var(--line);
    display:flex; gap:6px; overflow-x:auto; padding:8px 12px; }
  nav.tabs a { white-space:nowrap; text-decoration:none; color:var(--ink); background:#f1ede4;
    padding:10px 14px; border-radius:10px; font-size:14px; }
  nav.tabs a.active { background:var(--accent); color:#fff; font-weight:700; }
  main { padding:16px 20px 40px; max-width:1100px; margin:0 auto; }
  h1.page-title { font-size:20px; margin:6px 0 4px; }
  p.page-desc { color:#6b6558; font-size:14px; margin:0 0 16px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
  a.card { display:block; background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:18px 14px; text-decoration:none; color:var(--ink); }
  a.card .e { font-size:30px; }
  a.card .t { font-weight:700; font-size:16px; margin:6px 0 2px; }
  a.card .d { color:#6b6558; font-size:13px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:8px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; text-align:center; }
  .stat .n { font-size:26px; font-weight:700; color:var(--accent); }
  .pill-conn { display:inline-block; padding:6px 14px; border-radius:99px; font-size:14px; margin:4px 0 12px; }
  .pill-conn.on { background:#d4edda; } .pill-conn.off { background:#f5d0d0; }
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
  form.bar, .box { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; margin-bottom:12px; }
  form.bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  form.bar label, .box label { font-size:13px; color:#6b6558; }
  .set-row { display:flex; gap:10px; align-items:center; padding:10px 2px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .set-row .lab { font-weight:700; min-width:150px; }
  .set-row .hint { color:#8a8578; font-size:12px; flex:1; min-width:200px; }
  footer { color:#8a8578; font-size:12px; text-align:center; padding:20px; }
  .muted { color:#8a8578; font-size:13px; }
  /* الدردشة */
  .chat-layout { display:grid; grid-template-columns:280px 1fr; gap:12px; }
  .conv-pane { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; max-height:70vh; overflow-y:auto; }
  .conv { display:block; width:100%; text-align:right; background:none; color:var(--ink); border:0; border-bottom:1px solid var(--line); padding:10px 12px; font-size:13px; }
  .conv.active { background:#e8f5f1; }
  .conv .ph { font-weight:700; }
  .conv .prev { color:#8a8578; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; display:block; }
  .badge-paused { background:#f5d0d0; border-radius:99px; font-size:11px; padding:1px 8px; }
  .badge-ai { background:#d1ecf1; border-radius:99px; font-size:11px; padding:1px 8px; }
  .thread-pane { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; display:flex; flex-direction:column; min-height:40vh; }
  #thread { flex:1; max-height:60vh; min-height:200px; overflow-y:auto; display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
  .b { max-width:85%; padding:8px 12px; border-radius:12px; font-size:14px; white-space:pre-wrap; word-break:break-word; }
  .b-in { align-self:flex-start; background:#f1ede4; }
  .b-out { align-self:flex-end; background:#d9efe7; }
  .b-human { align-self:flex-end; background:#d7e6fb; }
  .b-meta { font-size:11px; color:#8a8578; margin-top:2px; }
  .reply-bar { display:flex; gap:8px; }
  .reply-bar input { flex:1; }
  .thread-actions { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; align-items:center; }
  #ai-summary { background:#f6f4ef; border:1px dashed var(--line); border-radius:8px; padding:10px; font-size:13px; white-space:pre-wrap; margin-bottom:10px; }
  #btn-back { display:none; }
  @media (max-width:640px) {
    #btn-back { display:inline-block; }
    header { padding:12px 14px; } header h1 { font-size:17px; }
    main { padding:12px 10px 30px; }
    .stats { grid-template-columns:repeat(2,1fr); gap:8px; }
    .stat .n { font-size:22px; }
    table { display:block; overflow-x:auto; white-space:nowrap; }
    button { min-height:44px; font-size:15px; }
    button.small { min-height:36px; }
    input, select { min-height:44px; font-size:16px; max-width:100%; }
    form.bar { flex-direction:column; align-items:stretch; }
    form.bar input, form.bar select { width:100% !important; }
    .qr-box img { width:100%; max-width:280px; height:auto; }
    .code-box .code { font-size:24px; }
    .chat-layout { grid-template-columns:1fr; }
    #thread-pane { display:none; }
    .chat-layout.chat-open #thread-pane { display:flex; }
    .chat-layout.chat-open #conv-pane { display:none; }
    #btn-back { display:''; }
  }
`;

const SHARED_JS = `
const K = new URLSearchParams(location.search).get('key');
const API = '/admin/api/';
const escJs = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

async function postApi(action, body) {
  const r = await fetch(API + action + '?key=' + K, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert(j.error || ('فشلت العملية (' + r.status + ')')); return null; }
  return j;
}
`;

/** الهيكل المشترك: ترويسة + تنقل + محتوى الصفحة */
function layout(page: string, key: string, title: string, body: string, extraCss = '', pageJs = ''): string {
  const esc = (s: unknown): string =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const nav = NAV.map((n) =>
    `<a href="${n.href}?key=${esc(key)}" class="${n.id === page ? 'active' : ''}">${n.label}</a>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — مشاوير الحموي</title>
<style>${SHARED_CSS}${extraCss}</style>
</head>
<body>
<header><h1>🚕 مشاوير الحموي</h1></header>
<nav class="tabs">${nav}</nav>
<main>
<h1 class="page-title">${esc(title)}</h1>
${body}
</main>
<footer>whatsapp-taxi-dispatch — Cloudflare Workers + D1</footer>
<script>${SHARED_JS}${pageJs}</script>
</body></html>`;
}

function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export type AdminPageId = 'home' | 'chats' | 'pricing' | 'drivers' | 'rides' | 'settings' | 'whatsapp';

export async function adminPage(env: Env, page: AdminPageId, key: string): Promise<Response> {
  let body = '';
  let title = '';
  let pageJs = '';

  if (page === 'home') {
    const stats = await todayStats(env.DB);
    const gw = await gatewayStatus(env.ADMIN_KEY);
    const connected = gw?.connection === 'open' || gw?.connection === 'connected';
    title = 'الرئيسية';
    body = `<p class="page-desc">نظرة سريعة على شغل اليوم، ومن هون بتروح لأي صفحة.</p>
<div class="stats">
  <div class="stat"><div class="n">${stats.total}</div>رحلات اليوم</div>
  <div class="stat"><div class="n">${stats.done}</div>منفذة</div>
  <div class="stat"><div class="n">${formatSYP(stats.revenue)}</div>الإيراد</div>
  <div class="stat"><div class="n">${stats.activeDrivers}</div>سواق نشطون</div>
</div>
<span class="pill-conn ${connected ? 'on' : 'off'}">${connected ? '🟢 واتساب متصل' + (gw?.user ? ' — ' + escHtml(gw.user) : '') : '🔴 واتساب مو متصل — فوت على صفحة واتساب للربط'}</span>
<div class="cards">
  <a class="card" href="/admin/chats?key=${escHtml(key)}"><div class="e">💬</div><div class="t">المحادثات</div><div class="d">دردش مع الزبائن من الموقع — رد بشر أو تابع البوت</div></a>
  <a class="card" href="/admin/pricing?key=${escHtml(key)}"><div class="e">💰</div><div class="t">الأسعار</div><div class="d">سعر الانتقال من مكان لمكان + المناطق</div></a>
  <a class="card" href="/admin/drivers?key=${escHtml(key)}"><div class="e">🧑‍✍️</div><div class="t">السواقون</div><div class="d">إضافة سائق جديد وتشغيل / إيقاف</div></a>
  <a class="card" href="/admin/rides?key=${escHtml(key)}"><div class="e">🧾</div><div class="t">الرحلات</div><div class="d">طلبات اليوم وإلغاء الطلب</div></a>
  <a class="card" href="/admin/whatsapp?key=${escHtml(key)}"><div class="e">📱</div><div class="t">واتساب</div><div class="d">ربط رقم الشركة بالبوت</div></a>
  <a class="card" href="/admin/settings?key=${escHtml(key)}"><div class="e">⚙️</div><div class="t">الإعدادات</div><div class="d">تشغيل البوت والـ AI وأرقام التنبيهات</div></a>
</div>`;
  } else if (page === 'chats') {
    const convs = await getConversations(env.DB, 30);
    title = 'المحادثات';
    body = `<p class="page-desc">دردش مع الزبائن من هون مباشرة. رسالتك بتروح باسم الشركة فوراً. قبل ما تتدخل اكبس «إيقاف البوت» مشان ما يرد هو وياك سوا.</p>
<div class="box">
  <form onsubmit="return newChat(event)" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <label>📩 محادثة جديدة لرقم:</label>
    <input id="newchat-phone" dir="ltr" placeholder="9639XXXXXXXX" style="width:170px">
    <button class="small">فتح</button>
  </form>
</div>
<div class="chat-layout" id="chat-layout">
  <div class="conv-pane" id="conv-pane"><div id="conv-list">
    ${convs.length ? convs.map((c) => `
    <button class="conv" data-chat="${escHtml(c.chat_id)}" onclick="openChat('${escHtml(c.chat_id)}', this)">
      <span class="ph" dir="ltr">${escHtml(c.is_group ? 'مجموعة السواقين' : '+' + c.phone)}</span>
      ${c.paused ? '<span class="badge-paused">⏸ بشر فقط</span>' : '<span class="badge-ai">بوت</span>'}
      <span class="prev">${escHtml((c.last_text ?? '').slice(0, 60))}</span>
    </button>`).join('') : '<p class="muted" style="padding:12px">لا رسائل بعد — السجل بيظهر هون أول ما يوصل شي على رقم البوت.</p>'}
  </div></div>
  <div class="thread-pane" id="thread-pane">
    <div class="thread-actions">
      <button class="small" id="btn-back" onclick="closeChat()">← رجوع</button>
      <span class="muted" id="thread-title">اختر محادثة 👆</span>
      <span style="flex:1"></span>
      <button class="small" id="btn-pause" style="display:none" onclick="togglePause()">⏸ إيقاف البوت</button>
      <button class="small" id="btn-summary" style="display:none" onclick="aiSummary()">✨ تلخيص AI</button>
    </div>
    <div id="ai-summary" style="display:none"></div>
    <div id="thread"></div>
    <form class="reply-bar" id="reply-form" style="display:none" onsubmit="return sendHuman(event)">
      <input id="reply-text" placeholder="اكتب ردك كبشر…" autocomplete="off">
      <button>📨 إرسال</button>
    </form>
  </div>
</div>`;
    pageJs = `
let curChat = null, curPaused = false;

function convBtn(c) {
  const name = c.is_group ? 'مجموعة السواقين' : '+' + escJs(c.phone);
  const badge = c.paused ? '<span class="badge-paused">⏸ بشر فقط</span>' : '<span class="badge-ai">بوت</span>';
  return '<button class="conv' + (c.chat_id === curChat ? ' active' : '') + '" data-chat="' + escJs(c.chat_id) +
    '" onclick="openChat(\\'' + escJs(c.chat_id) + '\\', this)">' +
    '<span class="ph" dir="ltr">' + escJs(name) + '</span> ' + badge +
    '<span class="prev">' + escJs((c.last_text || '').slice(0, 60)) + '</span></button>';
}

async function refreshList() {
  try {
    const r = await fetch(API + 'conv.list?key=' + K);
    const j = await r.json();
    if (!r.ok || !j.conversations) return;
    const list = document.getElementById('conv-list');
    list.innerHTML = j.conversations.length ? j.conversations.map(convBtn).join('')
      : '<p class="muted" style="padding:12px">لا رسائل بعد.</p>';
  } catch (e) {}
}

async function loadThread(silent) {
  if (!curChat) return;
  try {
    const r = await fetch(API + 'chat.get?key=' + K + '&chat_id=' + encodeURIComponent(curChat));
    const j = await r.json();
    if (!r.ok) { if (!silent) alert(j.error || 'فشل التحميل'); return; }
    curPaused = !!j.paused;
    paintPauseBtn();
    const t = document.getElementById('thread');
    t.innerHTML = (j.messages || []).map((m) => {
      const cls = m.direction === 'in' ? 'b-in' : (m.sender_phone === 'BOT' ? 'b-out' : 'b-human');
      const who = m.direction === 'in' ? '+' + escJs(m.sender_phone) : (m.sender_phone === 'BOT' ? '🤖 البوت' : '🧑 الموظف');
      return '<div class="b ' + cls + '">' + escJs(m.text) +
        '<div class="b-meta">' + who + ' • ' + escJs((m.created_at || '').slice(5, 16)) + '</div></div>';
    }).join('') || '<p class="muted">لا رسائل.</p>';
    t.scrollTop = t.scrollHeight;
  } catch (e) { if (!silent) alert('خطأ شبكة: ' + e); }
}

async function openChat(chat, btn) {
  curChat = chat;
  document.querySelectorAll('.conv').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('chat-layout').classList.add('chat-open');
  document.getElementById('thread-title').textContent = chat;
  document.getElementById('thread-title').dir = 'ltr';
  document.getElementById('ai-summary').style.display = 'none';
  document.getElementById('reply-form').style.display = 'flex';
  document.getElementById('btn-summary').style.display = '';
  await loadThread(false);
}

function closeChat() {
  curChat = null;
  document.getElementById('chat-layout').classList.remove('chat-open');
}

function paintPauseBtn() {
  const b = document.getElementById('btn-pause');
  b.style.display = '';
  b.textContent = curPaused ? '▶ تشغيل البوت' : '⏸ إيقاف البوت';
}

function normChat(v) {
  v = v.trim();
  if (v.includes('@')) return v;
  let d = v.replace(/[^0-9]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '963' + d.slice(1);
  return d + '@s.whatsapp.net';
}

function newChat(ev) {
  ev.preventDefault();
  const v = document.getElementById('newchat-phone').value.trim();
  if (!v) return false;
  openChat(normChat(v), null);
  refreshList();
  return false;
}

async function sendHuman(ev) {
  ev.preventDefault();
  const inp = document.getElementById('reply-text');
  const text = inp.value.trim();
  if (!text || !curChat) return false;
  const j = await postApi('msg.send', { to: curChat, text });
  if (j) { inp.value = ''; await loadThread(true); refreshList(); }
  return false;
}

async function togglePause() {
  if (!curChat) return;
  const phone = curChat.includes('@') ? curChat.split('@')[0].split(':')[0] : curChat;
  const j = await postApi('chat.pause', { phone, paused: !curPaused });
  if (j) { curPaused = !curPaused; paintPauseBtn(); refreshList(); }
}

async function aiSummary() {
  if (!curChat) return;
  const box = document.getElementById('ai-summary');
  box.style.display = 'block';
  box.textContent = '⏳ عم لخص…';
  const j = await postApi('ai.summarize', { chat_id: curChat });
  box.textContent = j ? j.summary : 'فشل التلخيص.';
}

setInterval(refreshList, 15000);
setInterval(() => {
  const inp = document.getElementById('reply-text');
  if (curChat && inp && !inp.value.trim()) loadThread(true);
}, 10000);
`;
  } else if (page === 'pricing') {
    const { results: zones } = await env.DB.prepare(`SELECT id, name, aliases, belt FROM zones ORDER BY belt, id`).all();
    const { results: fares } = await env.DB.prepare(
      `SELECT f.id, f.price, f.note, f.from_zone_id, f.to_zone_id, fz.name AS from_name, tz.name AS to_name
       FROM fixed_fares f
       JOIN zones fz ON fz.id = f.from_zone_id
       JOIN zones tz ON tz.id = f.to_zone_id
       ORDER BY f.id`
    ).all();
    title = 'الأسعار';
    const zoneOptions = (zones ?? [])
      .map((z: any) => `<option value="${z.id}">${escHtml(z.name)} (حزام ${z.belt})</option>`)
      .join('');
    const aliasesOf = (z: any): string => {
      try { return (JSON.parse(z.aliases || '[]') as string[]).join('، '); } catch { return ''; }
    };
    body = `<p class="page-desc">من هون بتحدد سعر الانتقال من أي مكان لأي مكان. السعر اليدوي بيفوق الحساب التلقائي دائماً.</p>
<h2>💰 سعر انتقال من مكان لمكان</h2>
<form class="bar" onsubmit="return addFare(event, this)">
  <label>من</label><select name="from_zone_id" required>${zoneOptions}</select>
  <label>إلى</label><select name="to_zone_id" required>${zoneOptions}</select>
  <label>الأجرة (ل.س)</label><input name="price" type="number" min="0" required style="width:130px">
  <label>ملاحظة</label><input name="note" placeholder="تعرفة معتمدة" style="width:140px">
  <button>➕ حفظ السعر</button>
</form>
<table>
<tr><th>من</th><th>إلى</th><th>الأجرة</th><th>ملاحظة</th><th></th></tr>
${(fares ?? []).map((f: any) => `<tr>
  <td>${escHtml(f.from_name)}</td><td>${escHtml(f.to_name)}</td><td>${formatSYP(f.price)}</td><td>${escHtml(f.note ?? '')}</td>
  <td>
    <button class="small" onclick="editFare(${f.id}, ${f.price})">تعديل السعر</button>
    <button class="small danger" onclick="delFare(${f.id})">حذف</button>
  </td>
</tr>`).join('') || '<tr><td colspan="5" class="muted">لا أسعار بعد — ضيف أول سعر من الفورم فوق.</td></tr>'}
</table>
<h2>📍 المناطق</h2>
<form class="bar" onsubmit="return addZone(event, this)">
  <label>اسم المنطقة</label><input name="name" required style="width:160px">
  <label>أسماء بديلة (افصل بفاصلة)</label><input name="aliases" placeholder="عند المخيم, المخيم القديم" style="width:220px">
  <label>الحزام</label>
  <select name="belt"><option value="1">1 — مدينة</option><option value="2">2 — ضواحي</option><option value="3">3 — ريف</option></select>
  <button>➕ إضافة منطقة</button>
</form>
<table>
<tr><th>#</th><th>الاسم</th><th>أسماء بديلة</th><th>الحزام</th><th></th></tr>
${(zones ?? []).map((z: any) => `<tr>
  <td>${z.id}</td><td>${escHtml(z.name)}</td><td>${escHtml(aliasesOf(z))}</td><td>حزام ${z.belt}</td>
  <td>
    <button class="small" onclick="zoneBelt(${z.id},${z.belt >= 3 ? 1 : z.belt + 1})">حزام ← ${z.belt >= 3 ? 1 : z.belt + 1}</button>
    <button class="small danger" onclick="delZone(${z.id})">حذف</button>
  </td>
</tr>`).join('')}
</table>`;
    pageJs = `
function addFare(ev, f) {
  ev.preventDefault();
  return api('fare.add', { from_zone_id: +f.from_zone_id.value, to_zone_id: +f.to_zone_id.value, price: +f.price.value, note: f.note.value });
}
function editFare(id, oldPrice) {
  const p = prompt('السعر الجديد (ل.س):', oldPrice);
  if (p) api('fare.edit', { id, price: +p });
}
function delFare(id) { if (confirm('حذف هالسعر؟')) api('fare.del', { id }); }
function addZone(ev, f) {
  ev.preventDefault();
  return api('zone.add', { name: f.name.value, aliases: f.aliases.value.split(',').map(s => s.trim()).filter(Boolean), belt: +f.belt.value });
}
function zoneBelt(id, belt) { api('zone.belt', { id, belt }); }
function delZone(id) { if (confirm('حذف هالمنطقة؟')) api('zone.del', { id }); }
`;
  } else if (page === 'drivers') {
    const { results: drivers } = await env.DB.prepare(
      `SELECT id, name, phone, car, plate, status, commission_pct FROM drivers WHERE active = 1 ORDER BY id`
    ).all();
    title = 'السواقون';
    body = `<p class="page-desc">ضيف سواق جديد، أو وقّف / شغّل سواق موجود.</p>
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
  <td>${d.id}</td><td>${escHtml(d.name)}</td><td dir="ltr">+${escHtml(d.phone)}</td><td>${escHtml(d.car)}</td><td>${escHtml(d.plate)}</td>
  <td>${d.commission_pct}%</td><td><span class="pill">${escHtml(d.status)}</span></td>
  <td>
    <button class="small" onclick="driverStatus(${d.id},'${d.status === 'AVAILABLE' ? 'OFFLINE' : 'AVAILABLE'}')">${d.status === 'AVAILABLE' ? 'إيقاف' : 'تشغيل'}</button>
    <button class="small danger" onclick="delDriver(${d.id})">حذف</button>
  </td>
</tr>`).join('')}
</table>`;
    pageJs = `
function addDriver(ev, f) {
  ev.preventDefault();
  return api('driver.add', {
    name: f.name.value, phone: f.phone.value.replace(/[^0-9]/g, ''),
    car: f.car.value, plate: f.plate.value, commission_pct: +f.commission_pct.value,
  });
}
function driverStatus(id, status) { api('driver.status', { id, status }); }
function delDriver(id) { if (confirm('حذف السائق ' + id + '؟')) api('driver.del', { id }); }
`;
  } else if (page === 'rides') {
    const { results: rides } = await env.DB.prepare(
      `SELECT r.id, r.client_phone, r.status, r.price, r.created_at,
              fz.name AS from_name, tz.name AS to_name, d.name AS driver_name
       FROM rides r
       LEFT JOIN zones fz ON fz.id = r.from_zone_id
       LEFT JOIN zones tz ON tz.id = r.to_zone_id
       LEFT JOIN drivers d ON d.id = r.driver_id
       ORDER BY r.id DESC LIMIT 50`
    ).all();
    title = 'الرحلات';
    body = `<p class="page-desc">آخر 50 طلب — بتقدر تلغي الطلب الشغال من هون.</p>
<table>
<tr><th>#</th><th>الزبون</th><th>من</th><th>إلى</th><th>السائق</th><th>الأجرة</th><th>الحالة</th><th>التاريخ</th><th></th></tr>
${(rides ?? []).map((r: any) => `<tr>
  <td>${r.id}</td><td dir="ltr">${escHtml(r.client_phone)}</td><td>${escHtml(r.from_name ?? '—')}</td><td>${escHtml(r.to_name ?? '—')}</td>
  <td>${escHtml(r.driver_name ?? '—')}</td><td>${r.price ? formatSYP(r.price) : '—'}</td>
  <td><span class="st ${r.status}">${r.status}</span></td><td>${escHtml((r.created_at ?? '').slice(0, 16))}</td>
  <td>${['NEW', 'DISPATCHING', 'ASSIGNED', 'ARRIVED', 'IN_RIDE'].includes(r.status)
    ? `<button class="small danger" onclick="cancelRide(${r.id})">إلغاء</button>` : ''}</td>
</tr>`).join('') || '<tr><td colspan="9" class="muted">لا رحلات بعد.</td></tr>'}
</table>`;
    pageJs = `
function cancelRide(id) {
  if (confirm('إلغاء الرحلة ' + id + '؟')) api('ride.cancel', { id });
}
`;
  } else if (page === 'settings') {
    const { results: settings } = await env.DB.prepare(`SELECT key, value FROM settings ORDER BY key`).all();
    title = 'الإعدادات';
    const sm: Record<string, string> = Object.fromEntries((settings ?? []).map((s: any) => [s.key, s.value]));
    const boolRow = (k: string, label: string, hint: string): string => {
      const v = sm[k] !== '0';
      return `<div class="set-row"><span class="lab">${label}</span>
        <select name="${k}"><option value="1"${v ? ' selected' : ''}>✅ شغال</option><option value="0"${v ? '' : ' selected'}>⛔ مطفي</option></select>
        <span class="hint">${hint}</span></div>`;
    };
    const textRow = (k: string, label: string, hint: string): string =>
      `<div class="set-row"><span class="lab">${label}</span>
        <input name="${k}" value="${escHtml(sm[k] ?? '')}" dir="ltr" style="width:260px">
        <span class="hint">${hint}</span></div>`;
    const known = new Set(['bot_enabled', 'ai_enabled', 'ai_chat', 'admin_phone', 'drivers_group_jid', 'paused_chats']);
    const others = (settings ?? []).filter((s: any) => !known.has(s.key));
    body = `<p class="page-desc">مفاتيح التشغيل — غيّر واحفظ بزر واحد.</p>
<form class="box" onsubmit="return saveSettings(event, this)">
  ${boolRow('bot_enabled', '🤖 البوت', 'شغال = بيرد على الزبائن — مطفي = رسالة صيانة فقط')}
  ${boolRow('ai_enabled', '🧠 مساعد AI للفهم', 'بيساعد البوت يفهم الرسائل المكتوبة بطرق مختلفة')}
  ${boolRow('ai_chat', '💬 رد AI حر', 'عند رسالة ما فهمها البوت بيرد AI بالعامية — بدون أسعار أبداً')}
  ${textRow('admin_phone', '📞 رقم المدير', 'بيستقبل تنبيه «بدي احكي مع المهندس» — صيغة دولية بدون +')}
  ${textRow('drivers_group_jid', '👥 مجموعة السواقين', 'بينحط تلقائياً — لا تغيرو إلا إذا نقلت المجموعة')}
  <div class="set-row"><span class="lab">⏸ المحادثات الموقوفة</span>
    <span dir="ltr">${escHtml(sm['paused_chats'] ?? '[]')}</span>
    <span class="hint">تُدار من صفحة المحادثات بزر إيقاف البوت — مو من هون</span></div>
  ${others.map((s: any) => `<div class="set-row"><span class="lab">${escHtml(s.key)}</span>
    <input name="${escHtml(s.key)}" value="${escHtml(s.value)}" dir="ltr" style="width:260px"><span class="hint"></span></div>`).join('')}
  <div style="margin-top:12px"><button>💾 حفظ الإعدادات</button></div>
</form>`;
    pageJs = `
function saveSettings(ev, f) {
  ev.preventDefault();
  const body = {};
  for (const el of f.elements) { if (el.name) body[el.name] = el.value; }
  return api('settings.set', body);
}
`;
  } else {
    // whatsapp
    const gw = await gatewayStatus(env.ADMIN_KEY);
    title = 'ربط واتساب';
    body = `<p class="page-desc">من هون بتربط رقم الشركة بالبوت — مرة وحدة وبس.</p>
${whatsappTabHtml({
  connection: gw?.connection ?? 'closed',
  user: gw?.user ?? null,
  qr: gw?.qr ?? null,
  pairingCode: gw?.pairingCode ?? null,
  pairingPhone: gw?.pairingPhone ?? null,
  pairingExpiresInSec: gw?.pairingExpiresInSec ?? null,
  pairingMode: gw?.pairingMode ?? null,
  pairingWindowSec: gw?.pairingWindowSec ?? null,
  lastError: gw?.lastError ?? (gw === null ? 'البوابة غير متاحة — شغّل gateway.mjs على السيرفر' : null),
})}`;
  }

  const html = layout(page, key, title, body, '', pageJs);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** واجهة API إدارية كاملة CRUD + الواجهة الموحدة للرسائل */
export async function adminApi(request: Request, env: Env, action: string): Promise<Response> {
  const url = new URL(request.url);
  // قراءات GET (سجل المحادثات) — كتابة POST فقط
  if (request.method === 'GET') {
    if (action === 'conv.list') {
      return Response.json({ conversations: await getConversations(env.DB, 30) });
    }
    if (action === 'chat.get') {
      const chatId = url.searchParams.get('chat_id') ?? '';
      if (!chatId) return Response.json({ error: 'chat_id مطلوب' }, { status: 400 });
      const phone = chatId.includes('@') ? chatId.split('@')[0].split(':')[0] : chatId;
      const paused = (await getPausedChats(env.DB)).includes(phone);
      return Response.json({ messages: await getChatMessages(env.DB, chatId, 60), paused });
    }
    return Response.json({ error: 'GET غير مدعوم لهذا الإجراء' }, { status: 405 });
  }
  if (request.method !== 'POST') return new Response('POST فقط', { status: 405 });
  const body = await request.json<Record<string, any>>();
  try {
    switch (action) {
      // ─── الواجهة الموحدة: إرسال بشر + إيقاف + تلخيص ───
      case 'msg.send': {
        const text = String(body.text ?? '').trim().slice(0, 2000);
        if (!text || !body.to) return Response.json({ error: 'to و text مطلوبان' }, { status: 400 });
        const chatId = normToChat(String(body.to));
        await queueOutbox(env.DB, chatId, text, 'HUMAN');
        return Response.json({ ok: true, to: chatId });
      }
      case 'chat.pause': {
        const phone = String(body.phone ?? '').replace(/[^0-9]/g, '');
        if (!phone) return Response.json({ error: 'phone مطلوب' }, { status: 400 });
        const list = await setPaused(env.DB, phone, body.paused !== false);
        return Response.json({ ok: true, paused_chats: list });
      }
      case 'ai.summarize': {
        const chatId = String(body.chat_id ?? '');
        if (!chatId) return Response.json({ error: 'chat_id مطلوب' }, { status: 400 });
        const msgs = await getChatMessages(env.DB, chatId, 30);
        if (!msgs.length) return Response.json({ summary: 'لا رسائل بهالمحادثة.' });
        const transcript = msgs.map((m) =>
          m.direction === 'in' ? `العميل (+${m.sender_phone}): ${m.text}`
            : m.sender_phone === 'BOT' ? `البوت: ${m.text}` : `الموظف: ${m.text}`
        ).join('\n');
        const summary = await aiChat(
          env,
          'أنت محلل محادثات شركة تاكسي. لخص باختصار بالعربية: طلب الزبون (من/إلى)، حالة الطلب، آخر شي صار، وشو الخطوة الجاية المقترحة للموظف. 6 أسطر max.',
          transcript,
          600
        );
        if (!summary) return Response.json({ error: 'AI غير مفعّل — اضبط AI_API_KEY ثم جرّب' }, { status: 400 });
        return Response.json({ summary });
      }
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
