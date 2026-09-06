/**
 * تبويب «واتساب» بلوحة الإدارة — يعرض حالة البوابة + QR/كود الاقتران.
 * اللوحة (Worker) بتسحب الحالة من البوابة عبر /g/ مسار على nginx → 127.0.0.1:3010
 *
 * إصلاح 2026-09-06: إلغاء location.reload() التلقائي (كان يمسح رقم الهاتف
 * ويمنع كبس زر الإيقاف) + زر نسخ للكود + عرض الرقم المطلوب.
 */

// رابط البوابة (nginx internal proxy على نفس السيرفر)
export const GATEWAY_URL = 'https://almaih.cloud/g';

export function whatsappTabHtml(state: {
  connection: string;
  user: string | null;
  qr: string | null;
  pairingCode: string | null;
  pairingPhone?: string | null;
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
  const spacedCode = state.pairingCode
    ? (state.pairingCode.match(/.{1,4}/g)?.join(' ') ?? state.pairingCode)
    : '';

  const qrSection = qr
    ? `<div class="qr-box">
         <img id="wa-qr-img" src="${qr}" alt="QR">
         <p>افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز</p>
         <p class="muted" id="wa-qr-time">🔄 QR يتجدد كل دقيقة ضمن النافذة — ${esc(winTxt)}</p>
       </div>`
    : '<div class="qr-box" id="wa-qr-img-wrap" style="display:none"></div>';

  const codeSection = state.pairingCode
    ? `<div class="code-box" id="wa-code-box">
         <p>ادخل هالكود بهالشكل:</p>
         <div class="code" id="wa-pair-code">${esc(spacedCode)}</div>
         ${state.pairingPhone ? `<p class="muted">للرقم: <code dir="ltr" id="wa-pair-phone">${esc(state.pairingPhone)}</code> <span class="muted">(مقنّع للحماية)</span></p>` : ''}
         <p class="muted">واتساب ← الأجهزة المرتبطة ← ربط بالرقم — <span id="wa-code-exp">ينتهي خلال ${state.pairingExpiresInSec ?? '—'} ثانية</span></p>
         <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
           <button onclick="copyCode()">📋 نسخ الكود</button>
           <button class="danger" onclick="stopPair()">⏹ إيقاف</button>
         </div>
       </div>`
    : '<div id="wa-code-box"></div>';

  return `
<h2>📡 اتصال الواتساب</h2>
<div class="wa-status">
  <span class="st" id="wa-badge" style="background:${color}">${label}</span>
  <code dir="ltr" id="wa-user">${esc(state.user)}</code>
  ${state.lastError ? `<span class="muted" id="wa-err">${esc(state.lastError)}</span>` : '<span class="muted" id="wa-err"></span>'}
</div>

<div class="wa-actions" id="wa-actions">
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

<div id="wa-pair-box">
${qrSection}
${codeSection}
</div>

<p class="muted">⚠️ اقتران سِم الشركة — ما تستخدم رقمك الشخصي.</p>
<p class="muted live-note">🔄 التحديث تلقائي كل 4 ثواني بدون ما تحدث الصفحة — فيك تكتب الرقم وتكبس إيقاف بأي لحظة.</p>

<script>
const TOKEN = new URLSearchParams(location.search).get('key') ?? '';
const GW = '${GATEWAY_URL}';
let lastQr = ${qr ? 'true' : 'false'};
let lastCode = ${state.pairingCode ? JSON.stringify(state.pairingCode) : 'null'};
let lastStateKey = ${JSON.stringify(state.connection + '|' + (state.pairingMode ?? 'off'))};
let pollTimer = null;

const escJs = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtWin(sec) {
  if (sec == null) return '';
  return '⏱ تنتهي النافذة خلال ' + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function actionsHtml(conn, mode, winSec) {
  if (conn === 'connected') return '<button class="danger" onclick="logout()">⏏ قطع الاتصال</button>';
  const active = mode && mode !== 'off' && ['initializing','connecting','reconnecting','waiting_scan'].includes(conn);
  if (active) return '<span class="muted" id="wa-window">' + escJs(fmtWin(winSec)) + '</span> <button class="danger" onclick="stopPair()">⏹ إيقاف التوليد</button>';
  return '<button class="primary" onclick="pairQR()">▶ بدء اقتران QR (5 دقائق)</button> <span>أو</span> '
    + '<input id="pairPhone" dir="ltr" placeholder="9639XXXXXXXXX" inputmode="numeric"> '
    + '<button class="primary" onclick="pairCode()">▶ بدء اقتران بالرقم (5 دقائق)</button>';
}

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
      const lbl = map[s.connection] ?? ['⚪ غير معروف', '#eee'];
      badge.textContent = lbl[0];
      badge.style.background = lbl[1];
    }
    const u = document.getElementById('wa-user');
    if (u) u.textContent = s.user ?? '';
    const errEl = document.getElementById('wa-err');
    if (errEl && s.lastError) errEl.textContent = s.lastError;

    // عدّاد النافذة — تحديث نصي فقط، بلا reload
    const w = document.getElementById('wa-window');
    if (w && s.pairingWindowSec != null) w.textContent = fmtWin(s.pairingWindowSec);

    // أزرار الإجراءات — تتحدث فقط عند تبدل الحالة، مع الحفاظ على الرقم المكتوب
    const stateKey = (s.connection ?? '') + '|' + (s.pairingMode ?? 'off');
    if (stateKey !== lastStateKey) {
      lastStateKey = stateKey;
      const box = document.getElementById('wa-actions');
      const curPhone = document.getElementById('pairPhone') ? document.getElementById('pairPhone').value : '';
      const focused = document.activeElement && document.activeElement.id === 'pairPhone';
      if (box && !focused) {
        box.innerHTML = actionsHtml(s.connection, s.pairingMode, s.pairingWindowSec);
        const inp = document.getElementById('pairPhone');
        if (inp && curPhone) inp.value = curPhone;
      }
    }

    // QR — تحديث الصورة مكانها، إنشاء/إخفاء بلا reload
    const pairBox = document.getElementById('wa-pair-box');
    const hasQr = s.qr && typeof s.qr === 'string' && s.qr.indexOf('data:image/') === 0;
    let img = document.getElementById('wa-qr-img');
    if (hasQr) {
      if (!img && pairBox) {
        const d = document.createElement('div');
        d.className = 'qr-box';
        d.innerHTML = '<img id="wa-qr-img" alt="QR"><p>افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز</p><p class="muted" id="wa-qr-time"></p>';
        pairBox.prepend(d);
        img = document.getElementById('wa-qr-img');
      }
      if (img && img.src !== s.qr) img.src = s.qr;
      lastQr = true;
      const t = document.getElementById('wa-qr-time');
      if (t) t.textContent = 'جُدّد: ' + new Date().toLocaleTimeString('ar-SY');
    } else if (img) {
      img.closest('.qr-box')?.remove();
      lastQr = false;
    }

    // كود الاقتران — تحديث مكانه، بلا reload أبداً
    const codeBox = document.getElementById('wa-code-box');
    if (s.pairingCode) {
      const spaced = String(s.pairingCode).replace(/(.{4})/g, '$1 ').trim();
      if (s.pairingCode !== lastCode) {
        lastCode = s.pairingCode;
        if (codeBox) {
          codeBox.className = 'code-box';
          codeBox.innerHTML = '<p>ادخل هالكود بهالشكل:</p>'
            + '<div class="code" id="wa-pair-code">' + escJs(spaced) + '</div>'
            + (s.pairingPhone ? '<p class="muted">للرقم: <code dir="ltr" id="wa-pair-phone">' + escJs(s.pairingPhone) + '</code></p>' : '')
            + '<p class="muted">واتساب ← الأجهزة المرتبطة ← ربط بالرقم — <span id="wa-code-exp"></span></p>'
            + '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">'
            + '<button onclick="copyCode()">📋 نسخ الكود</button>'
            + '<button class="danger" onclick="stopPair()">⏹ إيقاف</button></div>';
        }
      } else {
        const el = document.getElementById('wa-pair-code');
        if (el && el.textContent !== spaced) el.textContent = spaced;
      }
      const exp = document.getElementById('wa-code-exp');
      if (exp) exp.textContent = 'ينتهي خلال ' + (s.pairingExpiresInSec ?? '—') + ' ثانية';
    } else if (codeBox && lastCode) {
      lastCode = null;
      codeBox.className = '';
      codeBox.innerHTML = '';
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
    lastQr = false; lastCode = null; lastStateKey = '';
    pollStatus();
  } catch (e) { alert('تعذر الوصول للبوابة — تأكد أنها شغالة'); }
}
async function pairCode() {
  const el = document.getElementById('pairPhone');
  const phone = (el ? el.value : '').replace(/[^0-9]/g, '');
  if (!phone) return alert('اكتب رقم السِم بالصيغة الدولية بدون + (مثال: 963992265248)');
  if (!/^963\\d{9}$/.test(phone)) {
    if (!confirm('الرقم مو بالصيغة 963XXXXXXXXX — متأكد بدك تكمل؟ (' + phone + ')')) return;
  }
  try {
    const r = await fetch(GW + '/pair/code?token=' + TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(j.error || ('فشل البدء (' + r.status + ')')); return; }
    lastQr = false; lastCode = null; lastStateKey = '';
    pollStatus();
  } catch (e) { alert('تعذر الوصول للبوابة — تأكد أنها شغالة'); }
}
async function copyCode() {
  const el = document.getElementById('wa-pair-code');
  const raw = el ? el.textContent.replace(/\\s+/g, '') : '';
  if (!raw) return alert('ما في كود للنسخ');
  try {
    await navigator.clipboard.writeText(raw);
    alert('✅ ننسخ الكود: ' + raw);
  } catch (e) {
    // fallback للمتصفحات القديمة
    const ta = document.createElement('textarea');
    ta.value = raw;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); alert('✅ ننسخ الكود: ' + raw); }
    catch (e2) { alert('الكود: ' + raw + ' — انسخه يدوياً'); }
    ta.remove();
  }
}
async function stopPair() {
  try {
    await fetch(GW + '/pair/stop?token=' + TOKEN, { method: 'POST' });
    lastQr = false; lastCode = null; lastStateKey = '';
    pollStatus();
  } catch (e) { alert('تعذر الوصول للبوابة'); }
}
async function logout() {
  if (!confirm('قطع الاتصال يمسح الجلسة — متأكد؟')) return;
  await fetch(GW + '/logout?token=' + TOKEN, { method: 'POST' });
  lastQr = false; lastCode = null; lastStateKey = '';
  pollStatus();
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
  .code-box button { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:10px 18px; font-size:15px; cursor:pointer; }
  .code-box button.danger { background:#c0392b; }
  .muted { color:#8a8578; font-size:13px; }
</style>`;
}
