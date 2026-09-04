# 02 — Gateway Hardening

كل الإصلاحات الخاصة بـ `gateway.mjs` مرتّبة **P0 → P1 → P2**. المواقع بأرقام الأسطر التقريبية من المراجعة. الكود جاهز للّصق (ESM، Node 20+، Baileys ≥ 6.6).

**افتراضات مشتركة** تُضاف قرب أعلى الملف:

```js
import NodeCache from 'node-cache';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const startedAt = Date.now();
let lastActivityAt = Date.now();
const msgRetryCounterCache = new NodeCache({ stdTTL: 300, useClones: false });
const maskPhone = p => p ? String(p).slice(0, 4) + '***' + String(p).slice(-2) : '';
```

---

## P0 — البوت معطّل كلياً

### P0-1 — `gen` يُزاد مرتين فيخرج `startWhatsApp` قبل إنشاء السوكت
**الموقع:** `gateway.mjs:~123-128`

```diff
-  gen++;
-  const myGen = gen;
-  killSock();
+  killSock();               // killSock() نفسها تنفّذ gen++ في نهايتها
+  const myGen = gen;        // الجيل الحالي بعد الإلغاء
+  log.debug({ myGen, gen }, 'generation acquired');
   const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
-  if (myGen !== gen) return;
+  if (myGen !== gen) { log.info({ myGen, gen }, 'superseded during auth load'); return; }
```

**التحقق:** `curl -H "x-gateway-token: $T" -XPOST localhost:8080/pair/code -d '{"phone":"9639…"}'` ثم `journalctl -u taxi-gw -f` — لازم يظهر `generation acquired` بلا `superseded`، و`/status` ينتقل من `initializing` إلى `waiting_scan` خلال ثوانٍ، ويصدر pairing code.

### P0-1b — single-flight لـ `startWhatsApp` (منع سباق السوكتات)
**المشكلة:** نداءان متزامنان (`/pair/qr` + watchdog + reconnect timer) يفتحون سوكتين على نفس مجلد الـ auth ⇒ تلف الجلسة و`401`.
**الموقع:** `gateway.mjs:~120`

```js
let startingPromise = null;
export function startWhatsApp() {
  if (startingPromise) return startingPromise;            // نداء واحد فقط قيد التنفيذ
  startingPromise = _startWhatsApp().finally(() => { startingPromise = null; });
  return startingPromise;
}
async function _startWhatsApp() { /* الجسم القديم */ }
```

وفي كل مسارات `/pair/*`:

```js
if (['initializing', 'connecting'].includes(state.connection) || state.pairingRequested)
  return send(res, 409, { error: 'pairing_in_progress' });
```

**التحقق:** `for i in 1 2 3; do curl -XPOST -H "x-gateway-token: $T" localhost:8080/pair/qr & done; wait` ⇒ استجابة واحدة `200` واثنتان `409`، وسطر `generation acquired` واحد فقط.

### P0-2 — الدالة `worker()` غير معرّفة
**الموقع:** `gateway.mjs:~285, ~318, ~342, ~347`

```js
const WORKER_TIMEOUT_MS = 10_000;

async function worker(path, method = 'GET', body, { retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(WORKER_URL + path, {
        method,
        headers: { 'x-gateway-token': WORKER_TOKEN, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
      });
      if (res.ok) return res.status === 204 ? null : await res.json().catch(() => null);
      const txt = (await res.text().catch(() => '')).slice(0, 200);
      const err = Object.assign(new Error(`worker ${method} ${path} -> ${res.status} ${txt}`), { status: res.status });
      if (res.status < 500 && res.status !== 408 && res.status !== 429) throw err;  // دائم: لا تُعِد
      lastErr = err;
    } catch (e) {
      if (e?.status && e.status < 500) throw e;
      lastErr = e;
    }
    await sleep(300 * 2 ** i + Math.random() * 200);
  }
  throw lastErr;
}
```

**التحقق:** `node -e "…"` غير ضروري — أوقف الـ Worker مؤقتاً وأرسل رسالة: لازم يظهر `webhook failed -> spooled` (بند P1-1) بدل الصمت. ثم شغّله: `curl -H "x-gateway-token: $T" localhost:8080/status | jq .lastWorkerOk`.

---

## P1 — أ) التوكن والمصادقة وحدود الحجم

### P1-15 + P2-9 + P2-10 — فصل التوكن والتحقق منه عند الإقلاع
**المشكلة:** `GATEWAY_TOKEN` افتراضياً = `ADMIN_KEY` (سِرّ واحد لنطاقَي ثقة)، و`Number(env)` بلا تحقق يعطي `setTimeout(NaN)`.
**الموقع:** `gateway.mjs:~62-64, ~366`

```js
function reqEnv(name, min = 32) {
  const v = process.env[name];
  if (!v || v.length < min) { console.error(`FATAL: ${name} missing or < ${min} chars`); process.exit(1); }
  return v;
}
function num(name, def, min, max) {
  const raw = process.env[name];
  const n = raw === undefined ? def : Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) { console.error(`FATAL: ${name}="${raw}" invalid`); process.exit(1); }
  return n;
}
const WORKER_TOKEN  = reqEnv('WORKER_GATEWAY_TOKEN');   // البوابة ← الـ Worker
const GATEWAY_TOKEN = reqEnv('GATEWAY_TOKEN');          // اللوحة ← البوابة
if (GATEWAY_TOKEN === WORKER_TOKEN) { console.error('FATAL: GATEWAY_TOKEN must differ'); process.exit(1); }
const POLL_MIN_MS = num('POLL_MS', 1500, 500, 60_000);
const MAX_BODY    = num('MAX_BODY', 32 * 1024, 1024, 1 << 20);
const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN || '';
```

### P2-7 — التوكن من الهيدر فقط + CORS مقيّد
**الموقع:** `gateway.mjs:~360`

```js
function authOk(req) {
  const raw = req.headers['x-gateway-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!raw) return false;                        // لا ?token= أبداً
  const a = Buffer.from(String(raw)), b = Buffer.from(GATEWAY_TOKEN);
  if (a.length !== b.length) { timingSafeEqual(b, b); return false; }
  return timingSafeEqual(a, b);
}
function corsOk(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  if (!origin) return true;                      // curl / الـ Worker
  if (origin !== ADMIN_ORIGIN) return false;
  res.setHeader('Access-Control-Allow-Origin', ADMIN_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'x-gateway-token, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}
```

اشتراط الهيدر يفرض preflight على كل مسار ⇒ يقتل CSRF على `/pair/*` و`/logout`.

### حدود الحجم والمهل (P2-8 + hardening)
```js
async function readBody(req, limit = MAX_BODY) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) { req.destroy(); throw Object.assign(new Error('too large'), { httpCode: 413 }); }
    chunks.push(c);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] || '').includes('application/json'))
    throw Object.assign(new Error('unsupported media type'), { httpCode: 415 });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.maxRequestsPerSocket = 100;
server.on('error', (e) => { log.fatal({ err: String(e) }, 'http server error'); process.exit(1); });
server.listen(PORT, '127.0.0.1');
```

**التحقق (الثلاثة معاً):**
- `curl -i "localhost:8080/status?token=$T"` ⇒ `401`؛ مع `-H "x-gateway-token: $T"` ⇒ `200`.
- `curl -i -H "Origin: https://evil.tld" -H "x-gateway-token: $T" localhost:8080/status` ⇒ `403`، بلا `Access-Control-Allow-Origin`.
- `head -c 200000 /dev/urandom | base64 | curl -i -XPOST -H "x-gateway-token: $T" -H 'content-type: application/json' --data-binary @- localhost:8080/pair/code` ⇒ `413`.
- `GATEWAY_TOKEN=short node gateway.mjs` ⇒ خروج فوري برسالة واضحة، لا `401` صامت.
- `POLL_MS=abc node gateway.mjs` ⇒ `FATAL` بدل حلقة 1ms.
- `ss -ltnp | grep 8080` ⇒ `127.0.0.1` فقط. `PORT=8080 node gateway.mjs` مرتين ⇒ الثانية تموت بـ `EADDRINUSE` معلَنة.

---

## P1 — ب) سياسة إعادة الاتصال والحظر

### P1-7 + P2-11 + P1-8 — عدّاد محاولات عادل + قائمة fatal كاملة + إشعار
**المشكلة:** `attempts` لا يتراجع، و`408/515` يقضمانه، و`411/500` غائبان عن قائمة الـ fatal، ولا إشعار عند التوقف النهائي.
**الموقع:** `gateway.mjs:~78, ~215-238`

```js
const FATAL_CODES   = new Set([401, 403, 411, 440, 500]); // loggedOut, banned, multideviceMismatch, replaced, badSession
const NO_COUNT_CODES = new Set([408, 428, 515]);          // qrTimeout, connectionClosed, restartRequired
const MAX_ATTEMPTS = 5;
let attempts = 0, reconnectTimer = null, stableTimer = null;

function onClose(code) {
  clearTimeout(reconnectTimer);
  if (FATAL_CODES.has(code)) {
    state.connection = 'closed';
    state.lastError = `fatal ${code}`;
    state.sessionInvalid = [401, 411, 500].includes(code);   // بحاجة اقتران يدوي — لا مسح تلقائي
    void worker('/gateway/alert', 'POST', { state: 'closed', code, reason: 'fatal' }).catch(() => {});
    log.fatal({ code }, 'fatal disconnect — no auto reconnect');
    return;                                                  // حماية من استنزاف حدّ الاقتران/الحظر
  }
  if (!NO_COUNT_CODES.has(code)) attempts++;
  if (attempts > MAX_ATTEMPTS) {
    state.connection = 'closed';
    void worker('/gateway/alert', 'POST', { state: 'closed', code, attempts }).catch(() => {});
    return;
  }
  const delay = code === 515 ? 250                                        // rehandshake فوري
    : Math.min(60_000, 2_000 * 2 ** attempts) + Math.floor(Math.random() * 1_000); // full jitter
  state.connection = 'reconnecting';
  reconnectTimer = setTimeout(() => void startWhatsApp(), delay);
}

// داخل connection.update عند 'open':
attempts = 0;
clearTimeout(stableTimer);
stableTimer = setTimeout(() => { attempts = 0; log.info('stability window reached'); }, 10 * 60_000);
```

**سياسة الحظر (قاعدة صريحة):** لا `startWhatsApp()` تلقائي على `401/403/440`، لا مسح جلسة تلقائي، ولا أكثر من **3 طلبات اقتران/ساعة**:

```js
const pairHits = [];
function pairAllowed() {
  const now = Date.now();
  while (pairHits.length && now - pairHits[0] > 3_600_000) pairHits.shift();
  if (pairHits.length >= 3) return false;
  pairHits.push(now); return true;
}
```

**التحقق:** اطلب QR ولا تمسحه ⇒ بعد 60s يظهر `close 408` و`attempts` يبقى `0` في `/status`. `sudo iptables -I OUTPUT -p tcp --dport 443 -j DROP` لدقيقة ⇒ backoff تصاعدي في اللوغ بلا وصول للسقف. اقترن ثم اختر «تسجيل خروج» من الهاتف ⇒ `401`، `sessionInvalid:true`، صفر محاولات، ووصول `POST /gateway/alert` في لوغ الـ Worker.

### P1-6 — watchdog لحالة "open لكن ميت"
**الموقع:** `gateway.mjs:~200, ~318`

```js
const IDLE_MAX_MS = 5 * 60_000;
setInterval(async () => {
  if (shuttingDown || state.connection !== 'connected') return;
  if (Date.now() - lastActivityAt < IDLE_MAX_MS) return;
  try {
    await Promise.race([
      sock.sendPresenceUpdate('available'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('presence timeout')), 5_000)),
    ]);
    lastActivityAt = Date.now();
  } catch (e) {
    log.warn({ err: String(e) }, 'watchdog: stalled socket, restarting');
    void startWhatsApp();
  }
}, 60_000).unref();
```

حدّث `lastActivityAt = Date.now()` في `connection.update`، `messages.upsert`، وبعد كل `sendMessage` ناجح.

**التحقق:** `kill -STOP` لعملية… لا؛ بدلها احجب 443 بعد الاتصال (`iptables`) ⇒ خلال ≤6 دقائق يظهر `watchdog: stalled socket` وإعادة تشغيل السوكت، ويتوقف الـ outbox عن الإرسال إلى العدم.

### P1-9 — `uncaughtException` يُبتلَع
**الموقع:** `gateway.mjs:~500`

```js
process.on('uncaughtException', (e) => { log.fatal({ err: String(e), stack: e?.stack }, 'uncaught'); hardExit(1); });
process.on('unhandledRejection', (e) => { log.fatal({ err: String(e) }, 'unhandledRejection'); hardExit(1); });
function hardExit(code) {
  shuttingDown = true;
  try { server.close(); killSock(); } catch {}
  setTimeout(() => process.exit(code), 1_500).unref();
}
```

```ini
# /etc/systemd/system/taxi-gw.service
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=5
[Service]
Restart=always
RestartSec=10
```

**التحقق:** `curl` لمسار تجريبي يرمي استثناءً ⇒ العملية تخرج، و`systemctl status taxi-gw` يبيّن restart بعد 10s؛ خمس أعطال خلال 5 دقائق ⇒ `failed` بدل zombie.

---

## P1 — ج) إدارة الجلسة، النسخ الاحتياطي، والاقتران الآمن

### P1-11 — `/pair/*` يمسح جلسة سليمة أثناء `reconnecting`
**الموقع:** `gateway.mjs:~412-420`

```js
function canResetSession(body) {
  if (body?.force === true) return true;
  return state.connection === 'closed';   // ليس connecting/reconnecting/waiting_scan/connected
}
// في المعالج:
if (!canResetSession(body)) return send(res, 409, { error: 'session_busy', connection: state.connection });
if (!pairAllowed())        return send(res, 429, { error: 'pair_rate_limited' });
```

### P2-18 — مسح آمن + أرشفة + كتابات creds متسلسلة
**الموقع:** `gateway.mjs:~416, ~473`

```js
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';

async function archiveSession(reason) {
  if (!existsSync(SESSION_DIR)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const dst = join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}`);
  cpSync(SESSION_DIR, dst, { recursive: true });
  for (const d of readdirSync(BACKUP_DIR).sort().slice(0, -5))
    rmSync(join(BACKUP_DIR, d), { recursive: true, force: true });
  return dst;
}
async function resetSession(reason) {
  killSock();                       // يُبطل الجيل ويوقف مصدر saveCreds
  await credsQueue.catch(() => {}); // انتظر آخر كتابة
  await sleep(300);
  const backup = await archiveSession(reason);
  rmSync(SESSION_DIR, { recursive: true, force: true });
  log.warn({ reason, backup }, 'session reset');
}
// تسلسل كتابات creds (useMultiFileAuthState غير atomic)
let credsQueue = Promise.resolve();
const saveCredsSafe = () => (credsQueue = credsQueue.then(() => saveCreds()).catch(e => log.error({ err: String(e) }, 'saveCreds')));
sock.ev.on('creds.update', saveCredsSafe);
```

نسخة احتياطية دورية خارج العملية (لا تعتمد على البوابة):
```
# systemd timer يومي
tar czf /var/backups/wa/$(date +%F-%H%M).tgz -C /opt/taxi session/ && find /var/backups/wa -mtime +14 -delete
```

### P1-12 — `logout()` بلا timeout
**الموقع:** `gateway.mjs:~470`

```js
await Promise.race([sock?.logout?.(), sleep(5_000)]).catch(() => {});
await resetSession('manual_logout');
```

### P1-10 — regex الهاتف يقبل `9…` فقط
**الموقع:** `gateway.mjs:~437`

```diff
-const PHONE_RE = /^9\d{8,14}$/;
+const PHONE_RE = /^[1-9]\d{7,14}$/;             // E.164 بلا '+'
+const phone = String(body.phone || '').replace(/[^\d]/g, '').replace(/^00/, '');
+if (!PHONE_RE.test(phone)) return send(res, 400, { error: 'bad_phone' });
```

### P2-21 + P2-22 + P2-4/5/6 — اقتران بالكود بدل QR، بالتوقيت الصحيح
**المشكلة:** `requestPairingCode` بعد `setTimeout(4000)` ثابت هشّ، ومؤقّت انتهاء الكود غير متعقّب، و`connecting` يطمس `waiting_scan`، و`state.qr` لا يُلغى.
**الموقع:** `gateway.mjs:~165-198, ~211`

```js
let pairPhone = null, qrEpoch = 0, qrExpiryTimer = null, pairCodeTimer = null;

on('connection.update', async (u) => {
  if (myGen !== gen) return;
  lastActivityAt = Date.now();
  if (u.connection === 'connecting' && state.connection !== 'waiting_scan')
    state.connection = 'connecting';                       // لا تطمس waiting_scan

  if (u.qr) {
    if (state.connection !== 'connected') state.connection = 'waiting_scan';
    state.qrEpoch = ++qrEpoch;
    state.qrAt = Date.now();
    state.qr = pairPhone ? null : u.qr;                    // مسار الكود: لا نعرض QR إطلاقاً
    clearTimeout(qrExpiryTimer);
    qrExpiryTimer = setTimeout(() => { state.qr = null; }, 55_000);

    if (pairPhone && !state.pairingRequested) {            // السوكت جاهز فعلاً الآن
      state.pairingRequested = true;
      try {
        const raw = await sock.requestPairingCode(pairPhone);
        state.pairingCode = raw.match(/.{1,4}/g).join('-');
        state.pairingCodeAt = Date.now();
        clearTimeout(pairCodeTimer);
        pairCodeTimer = setTimeout(() => { state.pairingCode = null; state.pairingRequested = false; }, 120_000);
        log.info({ phone: maskPhone(pairPhone) }, 'pairing code issued');
      } catch (e) {
        state.pairingRequested = false;
        state.lastError = `pairing: ${String(e).slice(0, 120)}`;
      }
    }
  }
});
```

`killSock()` لازم يمسح كل المؤقتات ويصفّر حالة الاقتران:

```js
clearTimeout(qrExpiryTimer); clearTimeout(pairCodeTimer);
clearTimeout(reconnectTimer); clearTimeout(stableTimer);
state.pairingRequested = false; state.pairingCode = null; state.qr = null;
```

عقد `/status` الكامل (كي لا تخترع اللوحة الحقائق):

```js
{ connection, sessionInvalid, attempts, qr, qrEpoch, qrAgeSec, pairingRequested,
  pairingCode, pairingExpiresInSec, user, lastError, lastActivityAt, uptimeSec, waVersion }
```

**التحقق (الجلسة والاقتران):**
- `/pair/code` أثناء `reconnecting` ⇒ `409`؛ ومع `{"force":true}` ⇒ يُنفّذ، وتظهر نسخة في `BACKUP_DIR`.
- `/pair/code` بأرقام `15551234567`, `201234567890`, `4915112345678` ⇒ `200` (لا `400`).
- ثلاث محاولات ⇒ الرابعة `429`.
- بعد الاقتران بنجاح `ls session/creds.json | wc -l` = 1 و`jq . session/creds.json` صالح؛ ثم `kill -9` أثناء رسائل نشطة ⇒ `creds.json` ما زال قابلاً للـ parse.
- `/logout` على سوكت ميت (بعد حجب 443) ⇒ رد خلال ≤6s لا تجميد.
- `/status` أثناء انتظار الكود ⇒ `qr:null`, `pairingRequested:true`, `pairingExpiresInSec` يتنازل.

---

## P1 — د) الرسائل الواردة والـ dedupe

### P1-1 + P1-2 + P1-3 + P2-12 + P2-14 — معالج واحد مُصحَّح
**المشكلة:** `seenIds.set` قبل نجاح الـ webhook، بلا `msgId/ts`، وقبول `append` والرسائل القديمة، و`clear()` يهدم نافذة الـ dedupe.
**الموقع:** `gateway.mjs:~245-290`

```js
const SKEW_MS = 5 * 60_000, SEEN_MAX = 5_000, SEEN_TTL = 10 * 60_000;
const seen = new Map();
const seenHas = id => { const t = seen.get(id); if (!t) return false;
  if (Date.now() - t > SEEN_TTL) { seen.delete(id); return false; } return true; };
const seenAdd = id => { seen.set(id, Date.now());
  while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value); };   // FIFO للأقدم فقط

on('messages.upsert', async ({ messages, type }) => {
  if (myGen !== gen) return;
  if (type !== 'notify') return;                                  // لا append/offline queue
  lastActivityAt = Date.now();
  for (const m of messages) {
    const chat = m.key?.remoteJid || '';
    if (m.key?.fromMe) continue;
    if (chat.endsWith('@broadcast') || chat.endsWith('@newsletter')) continue;
    const tsSec = Number(m.messageTimestamp || 0);
    if (tsSec && tsSec * 1000 < startedAt - SKEW_MS) continue;     // رسائل ما قبل الإقلاع
    const id = m.key?.id;
    if (!id || seenHas(id)) continue;
    const text = extractText(m); if (!text) continue;
    const senderPhone = resolveSenderPhone(m); if (!senderPhone) continue;  // يرفض @lid بلا senderPn
    if (chat.endsWith('@s.whatsapp.net') || chat.endsWith('@lid'))
      learnLid(senderPhone, jidNormalizedUser(m.key.participant || chat));  // P1-14
    const payload = { msgId: id, ts: tsSec, chatId: chat, senderPhone, text, isGroup: chat.endsWith('@g.us') };
    try { await worker('/webhook/whatsapp', 'POST', payload); seenAdd(id); }
    catch (e) { log.error({ err: String(e), msgId: id, from: maskPhone(senderPhone) }, 'webhook failed -> spooled');
                spoolPush(payload); }
  }
});
```

### قائمة انتظار على القرص للفاشل (استكمال P1-1)
```js
const SPOOL = join(DATA_DIR, 'inbound-spool.ndjson');
const spoolPush = p => appendFileSync(SPOOL, JSON.stringify(p) + '\n');
async function spoolDrain() {
  if (!existsSync(SPOOL)) return;
  const lines = readFileSync(SPOOL, 'utf8').split('\n').filter(Boolean);
  writeFileSync(SPOOL, '');
  for (const line of lines) {
    let p; try { p = JSON.parse(line); } catch { continue; }
    if (seenHas(p.msgId)) continue;
    try { await worker('/webhook/whatsapp', 'POST', p); seenAdd(p.msgId); } catch { spoolPush(p); }
  }
}
setInterval(() => void spoolDrain().catch(() => {}), 30_000).unref();
```
> الشرط الملازم: عمود `provider_msg_id UNIQUE` + `INSERT OR IGNORE` في الـ Worker، وإلا فالـ spool يولّد رحلات مكرّرة.

### P1-14 + P2-16 + P2-23 — LID مُطبَّع و LRU حقيقي
```js
function lidGet(phone) {
  const v = lidMap.get(phone); if (v === undefined) return undefined;
  lidMap.delete(phone); lidMap.set(phone, v); return v;            // touch ⇒ LRU
}
function resolveJid(chatId) {
  if (!chatId.endsWith('@s.whatsapp.net')) return chatId;          // مجموعات كما هي
  return lidGet(chatId.split('@')[0].split(':')[0]) || chatId;
}
```

**التحقق:** أرسل رسالة من مجموعة ومن خاص ⇒ في اللوغ `msgId` و`ts` موجودان والرقم مموّه. أوقف الـ Worker، أرسل رسالتين، `wc -l inbound-spool.ndjson` = 2؛ شغّله ⇒ يفرغ الملف وتُنشأ رحلة واحدة لكل رسالة. اقطع الشبكة 10 دقائق ثم أعِدها ⇒ رسائل الـ offline queue **لا** تولّد رحلات (`type !== 'notify'` + فلتر الزمن). أعِد تشغيل البوابة وأرسل نفس الرسالة من أرشيف واتساب ⇒ يرفضها الـ Worker بـ UNIQUE.

---

## P1 — هـ) الـ outbox

### P1-4 + P1-5 + P2-15 + P2-20 + P1-13 — دورة إرسال صحيحة
**الموقع:** `gateway.mjs:~318-352`

```js
const POLL_MAX_MS = 30_000;
let pollMs = POLL_MIN_MS;
const backoffIdle = () => { pollMs = Math.min(POLL_MAX_MS, Math.round(pollMs * 1.6)); };
const isPermanent = e => /not-on-whatsapp|item-not-found|jid-malformed|forbidden|not-authorized|bad-request/i
  .test(String(e?.message || e));

async function outboxTick() {
  if (shuttingDown || state.connection !== 'connected') return backoffIdle();
  const rows = await worker('/outbox/pending?limit=20');
  if (!rows?.length) return backoffIdle();
  pollMs = POLL_MIN_MS;
  let buf = [];
  const flushAck = async () => {
    if (!buf.length) return;
    const ids = buf; buf = [];
    try { await worker('/outbox/ack', 'POST', { ids }); }
    catch (e) { log.error({ err: String(e), ids }, 'ack failed'); }
  };
  for (const m of rows) {
    if (shuttingDown) break;
    if (state.connection !== 'connected') { await flushAck(); break; }   // P1-5: لا تحرق المحاولات
    try {
      await sock.sendMessage(resolveJid(m.chat_id), { text: m.text });   // لا تفحص resp.key.id
      lastActivityAt = Date.now();
      buf.push(m.id);
      if (buf.length >= 5) await flushAck();                             // P1-4
      await sleep(400 + Math.random() * 400);                            // pacing ضد الحظر
    } catch (e) {
      log.warn({ err: String(e), to: maskPhone(m.chat_id) }, 'send failed');
      if (isPermanent(e)) await worker('/outbox/fail', 'POST', { ids: [m.id], error: String(e).slice(0, 200) });
      else { await flushAck(); break; }
    }
  }
  await flushAck();
}
async function outboxLoop() {
  while (!shuttingDown) {
    try { await outboxTick(); }
    catch (e) { log.error({ err: String(e) }, 'outbox poll failed'); backoffIdle(); }
    await sleep(pollMs);
  }
}
```

### P2-17 — فحص `onWhatsApp` مُخزَّن قبل أول إرسال لرقم جديد
```js
const waCheck = new Map();
async function existsOnWA(phone) {
  const hit = waCheck.get(phone);
  if (hit && Date.now() - hit.at < 7 * 864e5) return hit.exists;
  const [r] = await sock.onWhatsApp(phone + '@s.whatsapp.net').catch(() => []);
  const exists = !!r?.exists;
  waCheck.set(phone, { exists, at: Date.now() });
  return exists;
}
```

**التحقق:** أدرج 12 رسالة في الـ outbox ثم `kill -9` بعد الرابعة ⇒ عند العودة تُعاد ≤5 رسائل فقط لا 12. اقطع 443 وسط دفعة ⇒ اللوغ يبيّن `break` بلا أي `outbox/fail`، وعدّاد المحاولات في D1 ثابت. رقم غير موجود على واتساب ⇒ `FAILED` من أول محاولة. راقب `/outbox/pending` في لوغ الـ Worker: عند الخمول تنزل التردّدات إلى ~1 كل 30s (≈2.9k طلب/يوم بدل 57.6k).

---

## P2 — نظافة ومتانة

**P2-1 — إزالة مستمعين موجّهة** (`~115`): لا تمسح مستمعي Baileys الداخليين.
```js
const handlers = [];
const on = (ev, fn) => { handlers.push([ev, fn]); sock.ev.on(ev, fn); };
// killSock: for (const [ev, fn] of handlers) try { curSock.ev.off(ev, fn); } catch {}
```

**P2-2 + P2-3 — خيارات السوكت** (`~144-145`):
```diff
   const sock = makeWASocket({
     auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, log) },
-    printQRInTerminal: true,
+    msgRetryCounterCache,
+    getMessage: async () => undefined,
     version, syncFullHistory: false, markOnlineOnConnect: false, qrTimeout: 60_000,
   });
```
التحقق: صفر تحذير deprecation، واختفاء تكرار `Bad MAC` من اللوغ.

**P2-13 — `failCounts` محدود** (`~313`): مصدر الحقيقة لعدّاد المحاولات هو الـ Worker (`outbox.attempts`)؛ محلياً `Map` بسقف 500 مع FIFO فقط لتفادي الرسالة السامّة داخل الدفعة الواحدة.

**P2-19 — لوغ نظيف** (`~330`): استبدل كل `console.log` بـ `pino`، ولا تسجّل رقماً كاملاً — `maskPhone()` في كل مكان، ولا نص الرسالة في مستوى `info`.

**تنظيف الاقتران/الحالة:** أضف `state.pairingRequested`, `state.qrEpoch`, `state.sessionInvalid`, `state.attempts` إلى literal الـ state وإلى `/status` (P2-4/5/6).

---

## Smoke test نهائي (تسلسل قبول)

```bash
T=$GATEWAY_TOKEN; B=localhost:8080
curl -s -H "x-gateway-token: $T" $B/status | jq '{connection,attempts,qrEpoch,pairingRequested}'
curl -s -XPOST -H "x-gateway-token: $T" -H 'content-type: application/json' \
     -d '{"phone":"9639XXXXXXXX"}' $B/pair/code | jq
# أدخل الكود على الهاتف ⇒ انتظر connection=connected و user مضبوط
curl -s -H "x-gateway-token: $T" $B/status | jq '{connection,user,attempts,lastActivityAt}'
```

المعايير: `connected` خلال ≤60s، رسالة واردة تصل الـ Worker مع `msgId`، رد يُرسل ويُؤكَّد خلال ≤5 رسائل، إعادة تشغيل العملية لا تُنشئ رحلة مكرّرة، وقطع الشبكة 10 دقائق ثم العودة يُنتج `reconnecting → connected` بلا أي `fail` في الـ outbox.