/**
 * تبويب «واتساب» بلوحة الإدارة — يعرض حالة البوابة + QR/كود الاقتران.
 * اللوحة (Worker) بتسحب الحالة من البوابة عبر /g/ مسار على nginx → 127.0.0.1:3010
 */

// رابط البوابة (nginx internal proxy على نفس السيرفر)
export const GATEWAY_URL = 'https://almaih.cloud/g';

export function whatsappTabHtml(state: {
  connection: string;
  user: string | null;
  qr: string | null;
  pairingCode: string | null;
  pairingExpiresInSec: number | null;
  pairingMode?: string | null;
  pairingWindowSec?: number | null;
  lastError: string | null;
}): string {
  // هروب HTML — قيم البوابة (user/lastError) قد تحمل محارف كاسرة (XSS)
  const esc = (s: string | null | undefined): string =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  // الـ QR: data:image فقط (أي قيمة أخرى تُرفض)
  const qr = state.qr && state.qr.startsWith('data:image/') ? state.qr : null;
  const badge: Record<string, [string, string]> = {
    connected: ['🟢 متصل', '#c9e7d3'],
    waiting_scan: ['🟡 بانتظار المسح', '#fff3cd'],
    connecting: ['🟡 جاري الاتصال', '#fff3cd'],
    reconnecting: ['🟠 إعادة محاولة', '#fde2c8'],
    closed: ['🔴 غير متصل', '#f5d0d0'],
    initializing: ['🟠 جاري التهيئة', '#fde2c8'],
  };
  const [label, color] = badge[state.connection] ?? ['⚪ غير معروف', '#eee'];
  const pairingActive = state.pairingMode && state.pairingMode !== 'off' &&
    ['initializing', 'connecting', 'reconnecting', 'waiting_scan'].includes(state.connection);
  const winSec = state.pairingWindowSec ?? null;
  const winTxt = winSec != null ? `⏱ تنتهي النافذة خلال ${Math.floor(winSec / 60)}:${String(winSec % 60).padStart(2, '0')}` : '';

  const qrSection = qr
    ? `<div class="qr-box">
         <img id="wa-qr-img" src="${qr}" alt="QR">
         <p>افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز</p>
         <p class="muted" id="wa-qr-time">🔄 QR يتجدد كل دقيقة ضمن النافذة — ${esc(winTxt)}</p>
       </div>`
    : '';

  const codeSection = state.pairingCode
    ? `<div class="code-box">
         <p>ادخل هالكود بهالشكل:</p>
         <div class="code">${esc(state.pairingCode.match(/.{1,4}/g)?.join(' ') ?? state.pairingCode)}</div>
         <p class="muted">واتساب ← الأجهزة المرتبطة ← ربط بالرقم — ينتهي خلال ${state.pairingExpiresInSec ?? '—'} ثانية</p>
       </div>`
    : '';

  return `
<h2>📡 اتصال الواتساب</h2>
<div class="wa-status">
  <span class="st" id="wa-badge" style="background:${color}">${label}</span>
  <code dir="ltr" id="wa-user">${esc(state.user)}</code>
  ${state.lastError ? `<span class="muted">${esc(state.lastError)}</span>` : ''}
</div>

<div class="wa-actions">
  ${state.connection === 'connected'
    ? '<button class="danger" onclick="logout()">⏏ قطع الاتصال</button>'
    : pairingActive
      ? `<span class="muted" id="wa-window">${esc(winTxt)}</span>
         <button class="danger" onclick="stopPair()">⏹ إيقاف التوليد</button>`
      : `<button class="primary" onclick="pairQR()">▶ بدء اقتران QR (5 دقائق)</button>
         <span>أو</span>
         <input id="pairPhone" dir="ltr" placeholder="9639XXXXXXXXX" inputmode="numeric">
         <button class="primary" onclick="pairCode()">▶ بدء اقتران بالرقم (5 دقائق)</button>`}
</div>
<p class="muted">🔒 التوليد بزر فقط — كل ضغطة تفتح نافذة 5 دقائق ثم تتوقف تلقائياً لحماية الرقم من الحظر.</p>
<p class="muted">⚠️ كبسة واحدة تكفي: الكبسة الثانية أثناء وجود كود ترجع <b>نفس الكود</b> — لا تكبس مرتين وتدخل كوداً قديماً.</p>

${qrSection}
${codeSection}

<p class="muted">⚠️ اقتران سِم الشركة — ما تستخدم رقمك الشخصي.</p>
<p class="muted live-note">🔄 التحديث تلقائي كل 4 ثواني — خلي الصفحة مفتوحة بس.</p>

<script>
const TOKEN = new URLSearchParams(location.search).get('key') ?? '';
const GW = '${GATEWAY_URL}';
let lastQr = null, lastCode = null, pollTimer = null;

async function pollStatus() {
  try {
    const r = await fetch(GW + '/status', { headers: { 'x-gateway-token': TOKEN } });
    if (!r.ok) return;
    const s = await r.json();

    // شارة الحالة
    const badge = document.getElementById('wa-badge');
    if (badge) {
      const map = {
        connected:    ['🟢 متصل', '#c9e7d3'],
        waiting_scan: ['🟡 بانتظار المسح', '#fff3cd'],
        connecting:   ['🟡 جاري الاتصال', '#fff3cd'],
        reconnecting: ['🟠 إعادة محاولة', '#fde2c8'],
        closed:       ['🔴 غير متصل', '#f5d0d0'],
        initializing: ['🟠 جاري التهيئة', '#fde2c8'],
      };
      const [label, color] = map[s.connection] ?? ['⚪ غير معروف', '#eee'];
      badge.textContent = label;
      badge.style.background = color;
    }
    const u = document.getElementById('wa-user');
    if (u) u.textContent = s.user ?? '';

    // نافذة الاقتران: عدّاد حي + reload عند انتهائها
    const w = document.getElementById('wa-window');
    if (w && s.pairingWindowSec != null) {
      w.textContent = '⏱ تنتهي النافذة خلال ' + Math.floor(s.pairingWindowSec / 60) + ':' + String(s.pairingWindowSec % 60).padStart(2, '0');
    }
    if (w && s.pairingWindowSec == null && (s.pairingMode === 'off' || s.connection === 'closed')) {
      // كانت نافذة مفتوحة وانتهت → صفحة جديدة تعرض زر البدء
      if (document.querySelector('.wa-actions .danger')) location.reload();
    }

    // QR: يتغير تلقائياً لما البوابة تولّد واحد جديد
    if (s.qr && typeof s.qr === 'string' && s.qr.indexOf('data:image/') === 0 && s.qr !== lastQr) {
      lastQr = s.qr;
      let img = document.getElementById('wa-qr-img');
      if (!img) location.reload(); // أول مرة — نرسم القسم كامل
      else img.src = s.qr;
      const t = document.getElementById('wa-qr-time');
      if (t) t.textContent = 'جُدّد: ' + new Date().toLocaleTimeString('ar-SY');
    }
    if (!s.qr && lastQr) {
      // انمسح — الرحلة خلصت، صفحة جديدة
      lastQr = null;
      location.reload();
    }

    // كود الاقتران
    if (s.pairingCode && s.pairingCode !== lastCode) {
      lastCode = s.pairingCode;
      location.reload(); // أسهل: نرسم الكود الجديد من السيرفر
    }
  } catch (e) { /* البوابة مو جاهزة لسا — نرجّع بعدين */ }
}

function refreshLoop() {
  clearInterval(pollTimer);
  pollTimer = setInterval(pollStatus, 4000);
}
document.addEventListener('DOMContentLoaded', refreshLoop);
refreshLoop();
</script>

<script>
async function pairQR() {
  try {
    const r = await fetch(GW + '/pair/qr?token=' + TOKEN, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(j.error || ('فشل البدء (' + r.status + ')')); return; }
    lastQr = null; lastCode = null;
    location.reload();
  } catch (e) { alert('تعذر الوصول للبوابة — تأكد أنها شغالة'); }
}
async function pairCode() {
  const phone = document.getElementById('pairPhone').value.replace(/[^0-9]/g, '');
  if (!phone) return alert('اكتب رقم السِم بالصيغة الدولية بدون + (مثال: 963992265248)');
  try {
    const r = await fetch(GW + '/pair/code?token=' + TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(j.error || ('فشل البدء (' + r.status + ')')); return; }
    lastQr = null; lastCode = null;
    location.reload();
  } catch (e) { alert('تعذر الوصول للبوابة — تأكد أنها شغالة'); }
}
async function stopPair() {
  try {
    await fetch(GW + '/pair/stop?token=' + TOKEN, { method: 'POST' });
    location.reload();
  } catch (e) { alert('تعذر الوصول للبوابة'); }
}
async function logout() {
  if (!confirm('قطع الاتصال يمسح الجلسة — متأكد؟')) return;
  await fetch(GW + '/logout?token=' + TOKEN, { method: 'POST' });
  location.reload();
}
</script>

<style>
  .wa-status { display:flex; gap:10px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
  .wa-actions { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:18px; }
  .wa-actions button { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:10px 18px; font-size:15px; cursor:pointer; }
  .wa-actions button.danger { background:#c0392b; }
  .wa-actions input { border:1px solid var(--line); border-radius:8px; padding:10px; font-size:15px; width:180px; }
  .qr-box { text-align:center; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; max-width:360px; }
  .qr-box img { width:280px; height:280px; }
  .code-box { text-align:center; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; max-width:360px; margin-top:12px; }
  .code-box .code { font-size:28px; letter-spacing:4px; font-weight:700; color:var(--accent); margin:8px 0; }
  .muted { color:#8a8578; font-size:13px; }
</style>`;
}
