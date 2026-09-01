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
  lastError: string | null;
}): string {
  const badge: Record<string, [string, string]> = {
    connected: ['🟢 متصل', '#c9e7d3'],
    waiting_scan: ['🟡 بانتظار المسح', '#fff3cd'],
    connecting: ['🟡 جاري الاتصال', '#fff3cd'],
    reconnecting: ['🟠 إعادة محاولة', '#fde2c8'],
    closed: ['🔴 غير متصل', '#f5d0d0'],
    initializing: ['🟠 جاري التهيئة', '#fde2c8'],
  };
  const [label, color] = badge[state.connection] ?? ['⚪ غير معروف', '#eee'];

  const qrSection = state.qr
    ? `<div class="qr-box"><img src="${state.qr}" alt="QR"><p>افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز</p></div>`
    : '';

  const codeSection = state.pairingCode
    ? `<div class="code-box">
         <p>ادخل هالكود بهالشكل:</p>
         <div class="code">${state.pairingCode.match(/.{1,4}/g)?.join(' ') ?? state.pairingCode}</div>
         <p class="muted">واتساب ← الأجهزة المرتبطة ← ربط بالرقم — ينتهي خلال ${state.pairingExpiresInSec ?? '—'} ثانية</p>
       </div>`
    : '';

  return `
<h2>📡 اتصال الواتساب</h2>
<div class="wa-status">
  <span class="st" style="background:${color}">${label}</span>
  ${state.user ? `<code dir="ltr">${state.user}</code>` : ''}
  ${state.lastError ? `<span class="muted">${state.lastError}</span>` : ''}
</div>

<div class="wa-actions">
  <button onclick="pairQR()">📱 اقتران بـ QR</button>
  <span>أو</span>
  <input id="pairPhone" dir="ltr" placeholder="9639XXXXXXXXX" inputmode="numeric">
  <button onclick="pairCode()">🔢 اقتران بالرقم</button>
  ${state.connection === 'connected' ? '<button class="danger" onclick="logout()">⏏ قطع الاتصال</button>' : ''}
</div>

${qrSection}
${codeSection}

<p class="muted">⚠️ اقتران سِم الشركة — ما تستخدم رقمك الشخصي.</p>

<script>
const TOKEN = new URLSearchParams(location.search).get('key') ?? '';
const GW = '${GATEWAY_URL}';

async function pairQR() {
  await fetch(GW + '/pair/qr?token=' + TOKEN, { method: 'POST' });
  refreshLoop();
}
async function pairCode() {
  const phone = document.getElementById('pairPhone').value.replace(/[^0-9]/g, '');
  if (!phone) return alert('اكتب رقم السِم بالصيغة الدولية بدون +');
  await fetch(GW + '/pair/code?token=' + TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  refreshLoop();
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
