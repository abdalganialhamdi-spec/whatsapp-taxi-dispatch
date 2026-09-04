#!/usr/bin/env node
/**
 * بوابة واتساب (Baileys) — بوت تكسي واتساب
 * whatsapp-taxi-dispatch gateway
 *
 * الوظيفة:
 *  1) تستقبل رسائل واتساب (Baileys) وتدفعها للـ Worker على /webhook/whatsapp
 *  2) تسحب الردود من /outbox/pending وترسلها وتؤكد /outbox/ack (فشل → /outbox/fail بعد 3 محاولات)
 *  3) تدير الاقتران: QR أو كود اقتران — عبر HTTP API للوحة
 *
 * ⚠️ الجلسة محفوظة بـ ./session ولا تُمسح أبداً عند إعادة التشغيل أو التحديث.
 *    المسح فقط عبر /pair/qr أو /pair/code أو /logout (طلب صريح من اللوحة).
 *
 * أمان الاقتران (بعد QA بوتس):
 *  - عدّاد توليد (gen): أي سوكت قديم صار معزول — لا سوكتات موازية أبداً
 *  - لا إعادة تسجيل تلقائية: 401/403/440 أو تجاوز المحاولات = توقف كامل (انتظار بشري)
 *  - SIGTERM/SIGINT إغلاق نظيف، version fallback، معالجات uncaught/rejection
 *
 * التشغيل:
 *   WORKER_URL=https://xxx.workers.dev ADMIN_KEY=... node gateway.mjs
 */

import { createRequire } from 'node:module';
import { mkdirSync, cpSync, rmSync, existsSync, readdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pino } from 'pino';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── الإعدادات ───
const WORKER_URL = process.env.WORKER_URL ?? 'https://whatsapp-taxi-dispatch.abdalganih2.workers.dev';
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? ADMIN_KEY; // لوحة ← بوابة
const HTTP_PORT = Number(process.env.GATEWAY_PORT ?? 3010);
const POLL_MS = Number(process.env.POLL_MS ?? 1500);
const SESSION_DIR = process.env.SESSION_DIR ?? join(__dirname, 'session');
const MAX_RECONNECT_ATTEMPTS = 4;
const WORKER_TIMEOUT_MS = 10_000;
const PAIR_WINDOW_MS = 5 * 60_000; // نافذة الاقتران: 5 دقائق فقط بضغطة زر ثم توقف تلقائي
const BACKUP_DIR = process.env.BACKUP_DIR ?? join(__dirname, 'session-backups');
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, 'data');
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maskPhone = (p) => { const s = String(p ?? ''); return s.length > 6 ? `${s.slice(0, 4)}***${s.slice(-2)}` : '***'; };
// 401 تسجيل خروج، 403 محظور، 411 multidevice mismatch، 440 استبدال، 500 جلسة تالفة
const FATAL_CODES = new Set([DisconnectReason.loggedOut, 401, 403, 411, 440, 500]);
// 408 qrTimeout، 428 إغلاق اتصال، 515 يحتاج إعادة مصافحة — لا تحتسب ضد المحاولات
const NO_COUNT_CODES = new Set([408, 428, 515]);
let startingPromise = null;   // single-flight: إقلاع واحد فقط بأي لحظة
let pairWindowTimer = null;  // مؤقت نافذة الـ 5 دقائق
let wantConnection = false;  // هل نريد اتصالاً حياً؟ false = مطفي بانتظار زر البدء

if (!ADMIN_KEY) {
  console.error('❌ ADMIN_KEY مطلوب');
  process.exit(1);
}

mkdirSync(SESSION_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ─── الـ Worker: استدعاء موحد بمهلة وإعادة محاولة (أُعيدت بعد حذفها بالخطأ في d3fb21b) ───
async function worker(path, method = 'GET', body, { retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${WORKER_URL}${path}`, {
        method,
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + ADMIN_KEY },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
      });
      if (res.ok) return res.status === 204 ? null : await res.json().catch(() => null);
      const txt = (await res.text().catch(() => '')).slice(0, 200);
      const err = Object.assign(new Error(`worker ${method} ${path} → ${res.status} ${txt}`), { status: res.status });
      if (res.status < 500 && res.status !== 408 && res.status !== 429) throw err; // دائم: لا تُعِد
      lastErr = err;
    } catch (e) {
      if (e?.status && e.status < 500) throw e;
      lastErr = e;
    }
    await sleep(300 * 2 ** i + Math.random() * 200);
  }
  throw lastErr;
}

// ─── حالة عملية عالمية ───
let gen = 0;               // عدّاد التوليد: يعزل أي سوكت قديم فوراً
let shuttingDown = false;
let attempts = 0;          // محاولات إعادة الاتصال المتتالية
let pairTimer = null;
let reconnTimer = null;
let sock = null;
let server = null;

// ─── LID mapping: الإرسال على الصيغة اللي عندها مفاتيح الجلسة ───
const lidMap = new Map(); // phone -> xxxxx@lid
function learnLid(pn, jid) {
  if (!pn || !/^\d{8,15}$/.test(pn) || !jid) return;
  if (lidMap.size > 5000) lidMap.delete(lidMap.keys().next().value);
  lidMap.set(pn, jid);
}
function resolveJid(chatId) {
  const phone = chatId.split('@')[0];
  return lidMap.get(phone) ?? chatId;
}

// ─── حالة البوابة (تُعرض على اللوحة) ───
const state = {
  connection: 'closed',   // closed | initializing | waiting_scan | connected | reconnecting (يبدأ مطفياً — الاقتران بزر فقط)
  qr: null,
  qrAt: null,
  pairingCode: null,
  pairingPhone: null,
  pairingExpiresAt: null,
  pairingRequested: false,
  pairingUntil: null,     // نهاية نافذة الـ 5 دقائق
  pairingMode: 'off',     // off | qr | code
  sessionInvalid: false,
  user: null,
  lastError: 'الاقتران مطفي — اكبس زر البدء ليولد QR لمدة 5 دقائق',
};

// ─── إغلاق السوكت الحالي بعزل كامل لمستمعاته ───
function killSock() {
  clearTimeout(pairTimer);
  pairTimer = null;
  clearTimeout(reconnTimer);
  reconnTimer = null;
  try { sock?.ev.removeAllListeners(); } catch {}
  try { sock?.end(new Error('replaced')); } catch {}
  sock = null;
  gen++;
}

// ─── أرشفة الجلسة قبل أي مسح (آخر 5 نسخ) — الجلسة لا تضيع أبداً ───
function archiveSession(reason) {
  try {
    if (!existsSync(SESSION_DIR)) return null;
    mkdirSync(BACKUP_DIR, { recursive: true });
    const dst = join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}`);
    cpSync(SESSION_DIR, dst, { recursive: true });
    for (const d of readdirSync(BACKUP_DIR).sort().slice(0, -5)) {
      rmSync(join(BACKUP_DIR, d), { recursive: true, force: true });
    }
    return dst;
  } catch (e) {
    log.error({ err: String(e) }, 'archive failed');
    return null;
  }
}
function freshSession(reason) {
  const backup = archiveSession(reason);
  rmSync(SESSION_DIR, { recursive: true, force: true });
  mkdirSync(SESSION_DIR, { recursive: true });
  if (backup) log.warn({ reason, backup }, 'session reset (archived)');
}

// ─── الاقتران عند الطلب: نافذة 5 دقائق بزر ثم توقف تلقائي (حماية حصة الرقم) ───
function stopPairing(reason) {
  clearTimeout(pairWindowTimer);
  pairWindowTimer = null;
  wantConnection = false;
  killSock();
  state.connection = 'closed';
  state.user = null;
  state.qr = null;
  state.qrAt = null;
  state.pairingCode = null;
  state.pairingRequested = false;
  state.pairingPhone = null;
  state.pairingExpiresAt = null;
  state.pairingUntil = null;
  state.pairingMode = 'off';
  state.lastError = reason || 'توقف الاقتران — اكبس زر البدء عند الجاهزية';
  console.log('⏹ اقتران متوقف:', state.lastError);
}
function startPairWindow(mode) {
  clearTimeout(pairWindowTimer);
  pairWindowTimer = null;
  wantConnection = true;
  state.pairingMode = mode;
  state.pairingUntil = Date.now() + PAIR_WINDOW_MS;
  state.lastError = null;
  pairWindowTimer = setTimeout(() => {
    stopPairing('انتهت مهلة 5 دقائق — اكبس زر الاقتران مجدداً');
  }, PAIR_WINDOW_MS);
  if (pairWindowTimer?.unref) pairWindowTimer.unref();
}

// ─── الإقلاع: سوكت واحد دائماً — القديم معزول بـ gen ───
// single-flight: نداءات متزامنة (pair + reconnect + watchdog) تشترك بنفس الإقلاع
async function startWhatsApp(pairPhone = null) {
  if (startingPromise) return startingPromise;
  startingPromise = _startWhatsApp(pairPhone).finally(() => { startingPromise = null; });
  return startingPromise;
}
async function _startWhatsApp(pairPhone = null) {
  killSock();               // killSock() نفسها تنفّذ gen++ في نهايتها
  const myGen = gen;        // الجيل الحالي بعد الإلغاء (إصلاح P0-1: كان gen++ مزدوجاً يقتل كل إقلاع)
  log.debug({ myGen }, 'generation acquired');

  const { state: auth, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  if (myGen !== gen || shuttingDown) { log.info({ myGen, gen }, 'superseded during auth load'); return; }

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1023223821];  // fallback معروف — ما نوقف الخدمة بسبب شبكة
  }
  if (myGen !== gen || shuttingDown) { log.info({ myGen, gen }, 'superseded during version fetch'); return; }

  sock = makeWASocket({
    version,
    auth: {
      creds: auth.creds,
      // حاسم: بدون Cacheable store المفاتيح تتلف أثناء المصافحة → Invalid account signature
      keys: makeCacheableSignalKeyStore(auth.keys, log.child({ module: 'signal-keys' })),
    },
    printQRInTerminal: false,
    logger: log.child({ module: 'baileys' }),
    markOnlineOnConnect: false,
    qrTimeout: 60_000,   // تجديد QR كل دقيقة — 20s كان ضغط على حساب محدود
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    getMessage: async (key) => sentStore.get(key.id)?.message,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
  });
  const s = sock; // نسخة محلية: أي مؤقت لاحق يستخدم سوكته هو، مش العالمي

  s.ev.on('creds.update', (c) => { if (myGen === gen) saveCreds(c); });

  // طلب كود اقتران: بعد جهوزية السوكت مباشرة وفقط إذا غير مسجل — مع إعادة محاولة
  if (pairPhone && !auth.creds.registered) {
    state.pairingRequested = true;
    state.pairingPhone = pairPhone;
    state.connection = 'waiting_scan';
    const tryCode = async (left) => {
      if (myGen !== gen || shuttingDown) return;
      try {
        const code = await s.requestPairingCode(pairPhone);
        if (myGen !== gen) return;
        state.pairingCode = code;
        state.pairingExpiresAt = Date.now() + 120_000;
        log.info({ phone: maskPhone(pairPhone) }, 'pairing code issued');
        // انتهاء صلاحية الكود → تنظيف حتى ما يضل معروض قديم
        setTimeout(() => {
          if (myGen === gen && Date.now() >= (state.pairingExpiresAt ?? 0)) {
            state.pairingCode = null; state.pairingRequested = false;
          }
        }, 121_000).unref();
      } catch (e) {
        if (myGen !== gen) return;
        state.lastError = `pairing code: ${String(e).slice(0, 160)}`;
        log.warn({ err: String(e).slice(0, 160), left: left - 1 }, 'pairing code failed');
        if (left > 1) {
          pairTimer = setTimeout(() => { tryCode(left - 1); }, 6000);
        } else {
          state.pairingRequested = false;
        }
      }
    };
    pairTimer = setTimeout(() => { tryCode(3); }, 4000);
  }

  s.ev.on('connection.update', (u) => {
    if (myGen !== gen) return;   // سوكت قديم — تجاهل كامل
    const { connection, lastDisconnect, qr } = u;
    state.lastActivityAt = Date.now();

    if (qr && !pairPhone) {
      // خارج النافذة أو بلا رغبة اتصال → تجاهل (حماية حصة الرقم)
      if (!wantConnection) return;
      if (state.pairingMode !== 'off' && state.pairingUntil && Date.now() > state.pairingUntil) return;
      state.connection = 'waiting_scan';
      QRCode.toDataURL(qr, { margin: 1, width: 320 })
        .then((dataUrl) => {
          if (myGen !== gen) return;
          state.qr = dataUrl;
          state.qrAt = Date.now();
          console.log('📱 QR جديد جاهز —', new Date().toLocaleTimeString('ar-SY'));
        })
        .catch((e) => { state.lastError = `qr render: ${e}`; });
    }

    if (connection === 'open') {
      attempts = 0;
      clearTimeout(pairWindowTimer);
      pairWindowTimer = null;
      state.pairingUntil = null;
      state.pairingMode = 'off';
      state.connection = 'connected';
      state.qr = null;
      state.pairingCode = null;
      state.pairingPhone = null;
      state.pairingExpiresAt = null;
      state.pairingRequested = false;
      state.sessionInvalid = false;
      state.lastError = null;
      state.user = s.user?.id ?? null;
      console.log('✅ واتساب متصل:', state.user);
    }
    // لا تطمس waiting_scan أثناء انتظار المسح/الكود
    if (connection === 'connecting' && state.connection !== 'waiting_scan') state.connection = 'connecting';

    if (connection === 'close') {
      state.user = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      // انتهت نافذة الـ 5 دقائق أثناء الاقتران → توقف نهائي بلا إعادة
      if (state.pairingMode !== 'off' && state.pairingUntil && Date.now() > state.pairingUntil) {
        stopPairing('انتهت مهلة 5 دقائق — اكبس زر الاقتران مجدداً');
        return;
      }
      // مطفي بانتظار زر البدء → لا إعادة اتصال أبداً
      if (!wantConnection) {
        state.connection = 'closed';
        return;
      }
      state.lastError = `disconnect code=${code}`;
      if (FATAL_CODES.has(code)) {
        // لا إعادة تلقائية ولا مسح تلقائي — اقتران جديد قرار بشري من اللوحة (حماية الحد اليومي)
        wantConnection = false;
        state.connection = 'closed';
        state.sessionInvalid = [401, 411, 500].includes(code);
        console.log(`🛑 توقف (code=${code}, attempts=${attempts}) — اقتران جديد من اللوحة فقط`);
        return;
      }
      if (!NO_COUNT_CODES.has(code)) attempts++;
      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        wantConnection = false;
        state.connection = 'closed';
        console.log(`🛑 توقف (code=${code}, attempts=${attempts}) — تجاوز السقف، اقتران جديد من اللوحة فقط`);
        return;
      }
      state.connection = 'reconnecting';
      const delay = code === 515 ? 250 : Math.min(60_000, 2000 * 2 ** attempts) + Math.floor(Math.random() * 1000);
      console.log(`⚠️ انقطع (code=${code}) — إعادة محاولة بعد ${delay / 1000}s (محاولة ${attempts}/${MAX_RECONNECT_ATTEMPTS})`);
      reconnTimer = setTimeout(() => {
        if (myGen === gen && !shuttingDown) {
          startWhatsApp(pairPhone).catch((e) => { state.lastError = String(e); });
        }
      }, delay);
    }
  });

  s.ev.on('messages.upsert', async ({ messages, type }) => {
    if (myGen !== gen) return;
    if (type !== 'notify') return;   // لا append ولا offline queue — تمنع رحلات مكررة بعد انقطاع
    state.lastActivityAt = Date.now();
    for (const m of messages) {
      if (!m.message) continue;
      if (m.key.fromMe) continue;
      const chatId = m.key.remoteJid;
      if (!chatId || chatId === 'status@broadcast') continue;
      // رسائل أقدم من بدء العملية بـ 5 دقائق — أرشيف متأخر، تجاهل
      const tsSec = Number(m.messageTimestamp || 0);
      if (tsSec && tsSec * 1000 < startedAt - 5 * 60_000) continue;

      // فك الطبقات: عادي/مؤقت/عرض-مرة/أزرار/قوائم
      const c =
        m.message.ephemeralMessage?.message ??
        m.message.viewOnceMessageV2?.message ??
        m.message.viewOnceMessage?.message ??
        m.message;
      const text =
        c.conversation ??
        c.extendedTextMessage?.text ??
        c.imageMessage?.caption ??
        c.buttonsResponseMessage?.selectedDisplayText ??
        c.listResponseMessage?.title ??
        '';
      if (!text.trim()) continue;

      // dedupe: علّم كمقروء فقط بعد نجاح الـ webhook (الفاشل يُعاد عبر spool)
      const msgId = m.key.id;
      if (!msgId || seenHas(msgId)) continue;

      // المرسل: بالمجموعات participant، وبالخاص remoteJid
      const senderJid = m.key.participant ?? chatId;
      // رقم الجهاز مفصول بنقطتين — خذ القسم الأول فقط (الدمج كان يشوه الأرقام)
      let senderPhone = senderJid.split('@')[0].split(':')[0];
      if (senderJid.endsWith('@lid') && m.key.senderPn) {
        senderPhone = String(m.key.senderPn).split('@')[0].split(':')[0];
      } else if (senderJid.endsWith('@lid') && !m.key.senderPn) {
        log.warn({ senderJid }, 'LID بدون senderPn — تجاهل حتى لا يُسجل رقم خاطئ');
        continue;
      }
      if (!/^\d{7,15}$/.test(senderPhone)) { log.warn('sender phone invalid — skip'); continue; }

      // تعلّم LID: رقم ↔ JID
      if (chatId.endsWith('@lid')) learnLid(m.key.senderPn?.split('@')[0] ?? senderPhone, chatId);
      if (senderJid.endsWith('@lid')) learnLid(senderPhone, senderJid);
      if (m.key.senderLid) {
        const lid = String(m.key.senderLid).includes('@') ? String(m.key.senderLid) : `${m.key.senderLid}@lid`;
        learnLid(senderPhone, lid);
      }

      try {
        const payload = { msgId, ts: tsSec, chatId, senderPhone, text, isGroup: chatId.endsWith('@g.us') };
        await worker('/webhook/whatsapp', 'POST', payload);
        seenAdd(msgId);
      } catch (e) {
        log.error({ err: String(e).slice(0, 160), msgId }, 'webhook failed -> spooled');
        spoolPush({ msgId, ts: tsSec, chatId, senderPhone, text, isGroup: chatId.endsWith('@g.us') });
      }
    }
  });
}

// ─── قائمة انتظار على القرص للرسائل التي فشل دفعها (تُفرغ كل 30s) ───
const SPOOL = join(DATA_DIR, 'inbound-spool.ndjson');
function spoolPush(p) {
  try { appendFileSync(SPOOL, `${JSON.stringify(p)}\n`); }
  catch (e) { log.error({ err: String(e) }, 'spool write failed'); }
}
async function spoolDrain() {
  if (!existsSync(SPOOL)) return;
  let lines;
  try { lines = readFileSync(SPOOL, 'utf8').split('\n').filter(Boolean); }
  catch { return; }
  if (!lines.length) return;
  writeFileSync(SPOOL, '');
  for (const line of lines) {
    let p;
    try { p = JSON.parse(line); } catch { continue; }
    if (!p?.msgId || seenHas(p.msgId)) continue;
    try { await worker('/webhook/whatsapp', 'POST', p); seenAdd(p.msgId); }
    catch { spoolPush(p); }
  }
}
setInterval(() => {
  if (!shuttingDown && state.connection === 'connected') spoolDrain().catch(() => {});
}, 30_000).unref();

// dedupe الرسائل الواردة: TTL + سقف (FIFO للأقدم — لا clear() يهدم النافذة)
const SEEN_TTL = 10 * 60_000;
const SEEN_MAX = 5000;
const seenIds = new Map(); // id -> timestamp
function seenHas(id) {
  const t = seenIds.get(id);
  if (!t) return false;
  if (Date.now() - t > SEEN_TTL) { seenIds.delete(id); return false; }
  return true;
}
function seenAdd(id) {
  seenIds.set(id, Date.now());
  while (seenIds.size > SEEN_MAX) seenIds.delete(seenIds.keys().next().value);
}

// رسائل أرسلتها (لـ getMessage عند retry receipt)
const sentStore = new Map();

// ─── حلقة الإرسال: outbox → واتساب (مع عدّاد فشل حقيقي بـ Map) ───
const failCounts = new Map();

async function outboxLoop() {
  for (;;) {
    if (shuttingDown) return;
    try {
      if (sock && state.connection === 'connected') {
        const { messages } = await worker('/outbox/pending');
        if (messages?.length) {
          const sent = [];
          const failed = [];
          for (const m of messages) {
            if (shuttingDown) break;
            // انقطع الاتصال أثناء الدفعة؟ أكّد المُرسل واقف — الباقي يُسحب لاحقاً
            if (!sock || state.connection !== 'connected') break;
            try {
              const resp = await sock.sendMessage(resolveJid(m.chat_id), { text: m.text });
              if (!resp?.key?.id) throw new Error(`no message id returned (resp=${JSON.stringify(resp).slice(0, 120)})`);
              sent.push(m.id);
              failCounts.delete(m.id);
              sentStore.set(resp.key.id, resp);
              if (sentStore.size > 400) sentStore.delete(sentStore.keys().next().value);
              log.info({ id: m.id, waId: resp.key.id, to: maskPhone(String(m.chat_id).split('@')[0]) }, 'sent ok');
            } catch (e) {
              log.error({ err: String(e).slice(0, 160), id: m.id }, 'send failed');
              const n = (failCounts.get(m.id) ?? 0) + 1;
              failCounts.set(m.id, n);
              while (failCounts.size > 500) failCounts.delete(failCounts.keys().next().value);
              if (n >= 3) {
                failCounts.delete(m.id);
                failed.push(m.id);
              }
            }
            // فاصل عشوائي بين الرسائل — لا burst يستفز الحظر
            await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
          }
          if (sent.length) await worker('/outbox/ack', 'POST', { ids: sent }).catch(() => {});
          if (failed.length) {
            // بلّغ الـ Worker بالفشل النهائي (3 محاولات) — وإن فشل البلاغ، ack حتى لا تعيد للأبد
            await worker('/outbox/fail', 'POST', { ids: failed, error: '3 attempts failed' })
              .catch(() => worker('/outbox/ack', 'POST', { ids: failed }).catch(() => {}));
          }
        }
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'outbox poll failed');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ─── HTTP API للوحة الإدارة ───
function timingSafeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function checkToken(req, url) {
  const t = req.headers['x-gateway-token'] || url.searchParams.get('token') || '';
  return GATEWAY_TOKEN.length >= 16 && timingSafeEq(t, GATEWAY_TOKEN);
}

// قراءة جسم آمن: حد حجم + JSON بلا انهيار
function readBody(req, max = 8192) {
  return new Promise((ok, no) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > max) { req.destroy(); no(new Error('body too large')); }
    });
    req.on('end', () => {
      try { ok(JSON.parse(d || '{}')); } catch { no(new Error('bad json')); }
    });
    req.on('error', no);
  });
}

server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (!checkToken(req, url)) {
    res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
  }

  try {
    // قائمة المجموعات — يتطلب اتصال حي
    if (url.pathname === '/groups' && req.method === 'GET') {
      if (!sock || state.connection !== 'connected') {
        res.writeHead(409); res.end(JSON.stringify({ error: 'offline' })); return;
      }
      const groups = await sock.groupFetchAllParticipating();
      res.writeHead(200);
      res.end(JSON.stringify({
        groups: Object.entries(groups).map(([jid, g]) => ({ jid, name: g.subject, size: g.participants?.length ?? 0 })),
      }));
      return;
    }

    // حالة الاتصال + QR الحالي
    if (url.pathname === '/status') {
      res.writeHead(200);
      res.end(JSON.stringify({
        connection: state.connection,
        user: state.user,
        qr: state.qr,
        qrAgeSec: state.qrAt ? Math.floor((Date.now() - state.qrAt) / 1000) : null,
        pairingCode: state.pairingCode,
        pairingPhone: state.pairingPhone ? maskPhone(state.pairingPhone) : null,
        pairingExpiresInSec: state.pairingExpiresAt ? Math.max(0, Math.floor((state.pairingExpiresAt - Date.now()) / 1000)) : null,
        pairingRequested: state.pairingRequested,
        pairingMode: state.pairingMode,
        pairingWindowSec: state.pairingUntil ? Math.max(0, Math.floor((state.pairingUntil - Date.now()) / 1000)) : null,
        sessionInvalid: state.sessionInvalid,
        attempts,
        lastError: state.lastError,
      }));
      return;
    }

    // إيقاف التوليد يدوياً — زر الإطفاء باللوحة (آمن دائماً)
    if (url.pathname === '/pair/stop' && req.method === 'POST') {
      stopPairing('توقف الاقتران يدوياً — اكبس زر البدء عند الجاهزية');
      res.writeHead(200); res.end(JSON.stringify({ ok: true, stopped: true }));
      return;
    }

    // اقتران جديد: زر بدء → نافذة 5 دقائق ثم توقف تلقائي (حماية حصة الرقم)
    // مرفوض أثناء اتصال حي — قرار قطع أولاً. إعادة الضغط أثناء النافذة تحتاج force:true
    if ((url.pathname === '/pair/qr' || url.pathname === '/pair/code') && req.method === 'POST') {
      let body = null;
      if (url.pathname === '/pair/code') {
        body = await readBody(req).catch(() => null);
        if (!body) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad request' })); return; }
        // تحقق من الرقم أولاً — قبل أي مسح للجلسة (رقم غلط كان يمسح الجلسة!)
        const _phone = String(body.phone ?? '').replace(/[^0-9]/g, '').replace(/^00/, '');
        if (!/^[1-9]\d{7,14}$/.test(_phone)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'رقم غير صالح — لازم دولي بدون + مثال: 963992265248' }));
          return;
        }
      }
      if (state.connection === 'connected') {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'متصل حالياً — اعمل /logout أولاً إذا بدك اقتران جديد' }));
        return;
      }
      const BUSY = ['initializing', 'connecting', 'reconnecting', 'waiting_scan'];
      if (BUSY.includes(state.connection) && body?.force !== true) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'اقتران جارٍ — انتظر النتيجة أو أعد المحاولة مع force:true', windowSec: state.pairingUntil ? Math.max(0, Math.floor((state.pairingUntil - Date.now()) / 1000)) : null }));
        return;
      }
      killSock();  // عزل كامل للسوكت القديم + مستمعاته
      freshSession(url.pathname === '/pair/qr' ? 'pair-qr' : 'pair-code');  // أرشفة قبل المسح — الجلسة لا تضيع
      state.qr = null; state.pairingCode = null; state.pairingRequested = false;
      state.pairingPhone = null; state.pairingExpiresAt = null; state.sessionInvalid = false;
      state.connection = 'initializing';
      attempts = 0;

      if (url.pathname === '/pair/qr') {
        startPairWindow('qr');
        state.lastError = null;
        startWhatsApp().catch((e) => { state.lastError = String(e); });
        res.writeHead(200); res.end(JSON.stringify({ ok: true, mode: 'qr', windowSec: Math.floor(PAIR_WINDOW_MS / 1000) }));
        return;
      }
      // /pair/code — رقم دولي E.164 (سوريا 963xxxxxxxxx وغيرها)
      const phone = String(body.phone ?? '').replace(/[^0-9]/g, '').replace(/^00/, '');
      startPairWindow('code');
      state.lastError = null;
      startWhatsApp(phone).catch((e) => { state.lastError = String(e); });
      res.writeHead(200); res.end(JSON.stringify({ ok: true, mode: 'code', phone: maskPhone(phone), windowSec: Math.floor(PAIR_WINDOW_MS / 1000) }));
      return;
    }

    // قطع الاتصال
    if (url.pathname === '/logout' && req.method === 'POST') {
      try { await Promise.race([sock?.logout?.(), sleep(5000)]); } catch {}
      clearTimeout(pairWindowTimer);
      pairWindowTimer = null;
      wantConnection = false;
      killSock();
      freshSession('logout');
      state.connection = 'closed'; state.user = null;
      state.qr = null; state.pairingCode = null; state.pairingRequested = false;
      state.pairingPhone = null; state.pairingExpiresAt = null; state.sessionInvalid = false;
      state.pairingUntil = null; state.pairingMode = 'off';
      state.lastError = 'تم قطع الاتصال — اكبس زر البدء عند الجاهزية';
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    log.error({ err: String(e) }, 'http handler');
    res.writeHead(500); res.end(JSON.stringify({ error: 'internal' }));
  }
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`🚕 بوابة تكسي — HTTP: http://127.0.0.1:${HTTP_PORT}`);
});

console.log(`🚕 بوابة تكسي واتساب → ${WORKER_URL}`);
console.log(`📂 الجلسة: ${SESSION_DIR}`);

// ─── معالجات انهيار عالمية: لا restart loop بسبب استثناء نسي ───
process.on('unhandledRejection', (e) => log.error({ err: String(e) }, 'unhandledRejection'));
process.on('uncaughtException', (e) => log.error({ err: String(e) }, 'uncaughtException'));

// ─── إغلاق نظيف: لا فساد creds.json عند systemctl stop ───
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    wantConnection = false;
    clearTimeout(pairWindowTimer);
    gen++;
    try { sock?.end(new Error('shutdown')); } catch {}
    try { server?.close(); } catch {}
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

// الإقلاع: إذا توجد جلسة مسجلة → أعد الاتصال تلقائياً.
// إذا لا توجد جلسة (جديد/ممسوح) → ابق مطفياً بانتظار زر البدء من اللوحة (حماية حصة الرقم).
// بلا await مجرّد — أي فشل يُسجل ويُعاد بهدوء (لا exit → لا restart loop)
try {
  const _creds = JSON.parse(readFileSync(join(SESSION_DIR, 'creds.json'), 'utf8'));
  if (_creds?.registered) {
    wantConnection = true;
    state.lastError = null;
    console.log('📂 جلسة مسجلة موجودة — إعادة اتصال تلقائية');
    startWhatsApp().catch((e) => {
      state.lastError = String(e);
      log.error({ err: String(e) }, 'startup failed');
    });
  } else {
    console.log('⏸ لا جلسة مسجلة — بانتظار زر البدء من اللوحة (5 دقائق لكل ضغطة)');
  }
} catch {
  console.log('⏸ لا جلسة — بانتظار زر البدء من اللوحة (5 دقائق لكل ضغطة)');
}
outboxLoop();
