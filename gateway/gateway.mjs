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
import { mkdirSync } from 'node:fs';
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

if (!ADMIN_KEY) {
  console.error('❌ ADMIN_KEY مطلوب');
  process.exit(1);
}

mkdirSync(SESSION_DIR, { recursive: true });
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

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
  connection: 'initializing',   // initializing | waiting_scan | connected | reconnecting | closed
  qr: null,
  qrAt: null,
  pairingCode: null,
  pairingPhone: null,
  pairingExpiresAt: null,
  user: null,
  lastError: null,
};

// ─── إغلاق SWocket الحالي بعزل كامل لمستمعاته ───
function killSock() {
  clearTimeout(pairTimer);
  clearTimeout(reconnTimer);
  try { sock?.ev.removeAllListeners(); } catch {}
  try { sock?.end(new Error('replaced')); } catch {}
  sock = null;
  gen++;
}

// ─── الإقلاع: سوكت واحد دائماً — القديم معزول بـ gen ───
async function startWhatsApp(pairPhone = null) {
  gen++;
  const myGen = gen;
  killSock();

  const { state: auth, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  if (myGen !== gen || shuttingDown) return;   // انستبدلنا أثناء الانتظار

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1023223821];  // fallback معروف — ما نوقف الخدمة بسبب شبكة
  }

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

  // طلب كود اقتران: بعد جهوزية السوكت مباشرة وفقط إذا غير مسجل
  if (pairPhone && !auth.creds.registered) {
    state.pairingRequested = true;
    pairTimer = setTimeout(async () => {
      if (myGen !== gen) return;
      try {
        const code = await s.requestPairingCode(pairPhone);
        if (myGen !== gen) return;
        state.pairingCode = code;
        state.pairingPhone = pairPhone;
        state.pairingExpiresAt = Date.now() + 120_000;
        state.connection = 'waiting_scan';
        console.log(`🔢 كود الاقتران لرقم ${pairPhone}: ${code}`);
        // انتهاء صلاحية الكود → تنظيف حتى ما يضل معروض قديم
        setTimeout(() => {
          if (myGen === gen && Date.now() >= (state.pairingExpiresAt ?? 0)) {
            state.pairingCode = null; state.pairingRequested = false;
          }
        }, 121_000).unref();
      } catch (e) {
        if (myGen !== gen) return;
        state.lastError = `pairing code: ${String(e)}`;
        state.pairingRequested = false;
        console.error('❌ طلب كود اقتران فشل:', String(e));
      }
    }, 4000);
  }

  s.ev.on('connection.update', (u) => {
    if (myGen !== gen) return;   // سوكت قديم — تجاهل كامل
    const { connection, lastDisconnect, qr } = u;

    if (qr && !pairPhone) {
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
      state.connection = 'connected';
      state.qr = null;
      state.pairingCode = null;
      state.pairingPhone = null;
      state.pairingExpiresAt = null;
      state.pairingRequested = false;
      state.lastError = null;
      state.user = s.user?.id ?? null;
      console.log('✅ واتساب متصل:', state.user);
    }
    if (connection === 'connecting') state.connection = 'connecting';

    if (connection === 'close') {
      state.user = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      state.lastError = `disconnect code=${code}`;
      const fatal = [DisconnectReason.loggedOut, 401, 403, 440].includes(code);
      if (fatal || ++attempts > MAX_RECONNECT_ATTEMPTS) {
        // لا إعادة تلقائية — اقتران جديد قرار بشري من اللوحة (حماية الحد اليومي)
        state.connection = 'closed';
        console.log(`🛑 توقف (code=${code}, attempts=${attempts}) — اقتران جديد من اللوحة فقط`);
        return;
      }
      state.connection = 'reconnecting';
      const delay = Math.min(30_000, 3000 * 2 ** attempts);
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
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) {
      if (!m.message) continue;
      if (m.key.fromMe) continue;
      const chatId = m.key.remoteJid;
      if (!chatId || chatId === 'status@broadcast') continue;

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

      // dedupe حسب معرف الرسالة
      if (seenIds.has(m.key.id)) continue;
      seenIds.set(m.key.id, 1);
      if (seenIds.size > 2000) seenIds.clear();

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

      // تعلّم LID: رقم ↔ JID
      if (chatId.endsWith('@lid')) learnLid(m.key.senderPn?.split('@')[0] ?? senderPhone, chatId);
      if (senderJid.endsWith('@lid')) learnLid(senderPhone, senderJid);
      if (m.key.senderLid) {
        const lid = String(m.key.senderLid).includes('@') ? String(m.key.senderLid) : `${m.key.senderLid}@lid`;
        learnLid(senderPhone, lid);
      }

      try {
        await worker('/webhook/whatsapp', 'POST', {
          chatId, senderPhone, text, isGroup: chatId.endsWith('@g.us'),
        });
      } catch (e) {
        log.error({ err: String(e), chatId }, 'webhook failed');
      }
    }
  });
}

// dedupe الرسائل الواردة
const seenIds = new Map();

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
            try {
              const resp = await sock.sendMessage(resolveJid(m.chat_id), { text: m.text });
              if (!resp?.key?.id) throw new Error(`no message id returned (resp=${JSON.stringify(resp).slice(0, 120)})`);
              sent.push(m.id);
              failCounts.delete(m.id);
              sentStore.set(resp.key.id, resp);
              if (sentStore.size > 400) sentStore.delete(sentStore.keys().next().value);
              log.info({ id: m.id, waId: resp.key.id, to: m.chat_id }, 'sent ok');
            } catch (e) {
              log.error({ err: String(e), id: m.id }, 'send failed');
              const n = (failCounts.get(m.id) ?? 0) + 1;
              failCounts.set(m.id, n);
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
        pairingPhone: state.pairingPhone,
        pairingExpiresInSec: state.pairingExpiresAt ? Math.max(0, Math.floor((state.pairingExpiresAt - Date.now()) / 1000)) : null,
        lastError: state.lastError,
      }));
      return;
    }

    // اقتران جديد: مرفوض أثناء اتصال حي — قرار قطع أولاً (منع نقر مزدوج)
    if ((url.pathname === '/pair/qr' || url.pathname === '/pair/code') && req.method === 'POST') {
      if (state.connection === 'connected') {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'متصل حالياً — اعمل /logout أولاً إذا بدك اقتران جديد' }));
        return;
      }
      killSock();  // عزل كامل للسوكت القديم + مستمعاته
      const fs = await import('node:fs');
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      mkdirSync(SESSION_DIR, { recursive: true });
      state.qr = null; state.pairingCode = null; state.pairingRequested = false;
      state.pairingPhone = null; state.pairingExpiresAt = null;
      state.connection = 'initializing'; state.lastError = null;
      attempts = 0;

      if (url.pathname === '/pair/qr') {
        startWhatsApp().catch((e) => { state.lastError = String(e); });
        res.writeHead(200); res.end(JSON.stringify({ ok: true, mode: 'qr' }));
        return;
      }
      // /pair/code
      const body = await readBody(req).catch(() => null);
      if (!body) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad request' })); return; }
      const phone = String(body.phone ?? '').replace(/[^0-9]/g, '');
      if (!/^9\d{8,14}$/.test(phone)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'رقم غير صالح — لازم دولي بدون + مثال: 963958794195' }));
        return;
      }
      startWhatsApp(phone).catch((e) => { state.lastError = String(e); });
      res.writeHead(200); res.end(JSON.stringify({ ok: true, mode: 'code', phone }));
      return;
    }

    // قطع الاتصال
    if (url.pathname === '/logout' && req.method === 'POST') {
      gen++;
      try { await sock?.logout(); } catch {}
      killSock();
      const fs = await import('node:fs');
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      mkdirSync(SESSION_DIR, { recursive: true });
      state.connection = 'closed'; state.user = null;
      state.qr = null; state.pairingCode = null;
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
    gen++;
    try { sock?.end(new Error('shutdown')); } catch {}
    try { server?.close(); } catch {}
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

// الإقلاع: بلا await مجرّد — أي فشل يُسجل ويُعاد بهدوء (لا exit → لا restart loop)
startWhatsApp().catch((e) => {
  state.lastError = String(e);
  log.error({ err: String(e) }, 'startup failed');
  setTimeout(() => startWhatsApp().catch(() => {}), 5000);
});
outboxLoop();
