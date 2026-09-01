#!/usr/bin/env node
/**
 * بوابة واتساب (Baileys) — بوت تكسي واتساب
 * whatsapp-taxi-dispatch gateway
 *
 * الوظيفة:
 *  1) تستقبل رسائل واتساب (Baileys) وتدفعها للـ Worker على /webhook/whatsapp
 *  2) تسحب الردود من /outbox/pending وترسلها وتؤكد /outbox/ack
 *  3) تدير الاقتران: QR أو كود اقتران (Pairing Code) — عبر HTTP API للوحة
 *
 * ⚠️ الجلسة محفوظة بـ ./session ولا تُمسح أبداً عند إعادة التشغيل أو التحديث.
 *    المسح يكون فقط عبر /pair/qr أو /pair/code أو /logout (طلب صريح من اللوحة).
 *
 * التشغيل:
 *   WORKER_URL=https://xxx.workers.dev ADMIN_KEY=... node gateway.mjs
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { pino } from 'pino';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── الإعدادات ───
const WORKER_URL = process.env.WORKER_URL ?? 'https://whatsapp-taxi-dispatch.abdalganih2.workers.dev';
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? ADMIN_KEY; // لوحة ← بوابة
const HTTP_PORT = Number(process.env.GATEWAY_PORT ?? 3010);
const POLL_MS = Number(process.env.POLL_MS ?? 1500);
const SESSION_DIR = process.env.SESSION_DIR ?? join(__dirname, 'session');

if (!ADMIN_KEY) {
  console.error('❌ ADMIN_KEY مطلوب');
  process.exit(1);
}

mkdirSync(SESSION_DIR, { recursive: true });
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function worker(path, method = 'GET', body = null) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`worker ${path} → ${res.status}`);
  return res.json();
}

// ─── LID mapping: واتساب الجديد بيخزن مفاتيح الجلسة على @lid — الإرسال لازم ينعمل عليه ───
const lidMap = new Map(); // phone -> xxxxx@lid
function resolveJid(chatId) {
  const phone = chatId.split('@')[0];
  return lidMap.get(phone) ?? chatId;
}

// ─── حالة البوابة (تُعرض على اللوحة) ───
let sock = null;
const state = {
  connection: 'initializing',   // initializing | waiting_scan | connected | closed
  qr: null,                     // data URL لآخر QR صالح
  qrAt: null,
  pairingCode: null,            // كود الاقتران الحالي
  pairingPhone: null,
  pairingExpiresAt: null,
  user: null,                   // JID المتصل
  lastError: null,
};

async function startWhatsApp(pairPhone = null) {
  const { state: auth, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: auth,
    printQRInTerminal: false,
    logger: log.child({ module: 'baileys' }),
    markOnlineOnConnect: false,
    qrTimeout: 20_000,   // QR يتجدد كل 20 ثانية تلقائياً من واتساب
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,  // لا تسحب تاريخ المحادثات — بيعطّل الاستقبال أحياناً
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr && !pairPhone) {
      state.connection = 'waiting_scan';
      // توليد QR مُنعّد بالخلفية — الصورة تتجدد تلقائياً بسرعة بلا انتظار الواجهة
      QRCode.toDataURL(qr, { margin: 1, width: 320 })
        .then((dataUrl) => {
          state.qr = dataUrl;
          state.qrAt = Date.now();
          console.log('📱 QR جديد جاهز (auto-refresh) —', new Date().toLocaleTimeString('ar-SY'));
        })
        .catch((e) => state.lastError = `qr render: ${e}`);
    }

    // كود الاقتران: يُطلب مرة واحدة بعد جهوزية الاتصال الأولية (قبل الـ QR)
    if (pairPhone && !state.pairingCode && !state.pairingRequested) {
      state.pairingRequested = true;
      // ننتظر لحظة حتى تستقر القناة ثم نطلب الكود
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(pairPhone);
          state.pairingCode = code;
          state.pairingPhone = pairPhone;
          state.pairingExpiresAt = Date.now() + 120_000;
          state.connection = 'waiting_scan';
          console.log(`🔢 كود الاقتران لرقم ${pairPhone}: ${code}`);
        } catch (e) {
          state.lastError = `pairing code: ${String(e)}`;
          state.pairingRequested = false;
          console.error('❌ طلب كود اقتران فشل:', String(e));
        }
      }, 3000);
    }

    if (connection === 'open') {
      state.connection = 'connected';
      state.qr = null;
      state.pairingCode = null;
      state.user = sock.user?.id ?? null;
      console.log('✅ واتساب متصل:', state.user);
    }
    if (connection === 'connecting') state.connection = 'connecting';
    if (connection === 'close') {
      state.user = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      state.connection = loggedOut ? 'closed' : 'reconnecting';
      state.lastError = `disconnect code=${code}`;
      console.log(`⚠️ انقطع (code=${code}) — ${loggedOut ? 'مسح الجلسة وإعادة اقتران' : 'إعادة محاولة…'}`);
      if (loggedOut) {
        // جلسة فسدت — امسحها وانتظر اقتراناً جديداً من اللوحة
        sock = null;
        state.connection = 'closed';
      } else {
        setTimeout(() => startWhatsApp(), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message) continue;
      if (m.key.fromMe) continue;
      const chatId = m.key.remoteJid;
      if (!chatId || chatId === 'status@broadcast') continue;

      const text =
        m.message.conversation ??
        m.message.extendedTextMessage?.text ??
        m.message.imageMessage?.caption ??
        '';
      if (!text.trim()) continue;

      // المرسل: بالمجموعات participant، وبالخاص remoteJid
      const senderJid = m.key.participant ?? chatId;

      // الرقم الحقيقي: senderPn يتفوق على LID (واتساب الجديد بيبعت المجموعات بـ @lid)
      let senderPhone = senderJid.split('@')[0].replace(/:/g, '');
      if (senderJid.endsWith('@lid') && m.key.senderPn) {
        senderPhone = String(m.key.senderPn).split('@')[0].replace(/:/g, '');
      }

      // تعلّم LID: رقم ↔ JID، ليصير الإرسال دايماً على الصيغة اللي عندها مفاتيح الجلسة
      const learnLid = (pn, jid) => {
        if (pn && /^\d{8,15}$/.test(pn) && jid) lidMap.set(pn, jid);
      };
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

// ─── حلقة الإرسال: outbox → واتساب ───
async function outboxLoop() {
  for (;;) {
    try {
      if (sock && state.connection === 'connected') {
        const { messages } = await worker('/outbox/pending');
        if (messages?.length) {
          const sent = [];
          for (const m of messages) {
            try {
              // sendMessage بيرجّع رسالة واتساب الفعلية — التحقق منها يكشف الفشل الصامت
              const resp = await sock.sendMessage(resolveJid(m.chat_id), { text: m.text });
              if (!resp?.key?.id) throw new Error(`no message id returned (resp=${JSON.stringify(resp).slice(0, 120)})`);
              sent.push(m.id);
              log.info({ id: m.id, waId: resp.key.id, to: m.chat_id }, 'sent ok');
            } catch (e) {
              log.error({ err: String(e), id: m.id }, 'send failed');
              // فشل صريح: علّم الرسالة failed بعد 3 محاولات — ما نعلق اللوب
              m._tries = (m._tries ?? 0) + 1;
            }
          }
          if (sent.length) await worker('/outbox/ack', 'POST', { ids: sent });
        }
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'outbox poll failed');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ─── HTTP API للوحة الإدارة ───
// الأمان: GATEWAY_TOKEN (يساوي ADMIN_KEY الافتراضياً) — اللوحة بتبعته بـ ?token=
function checkToken(req, url) {
  // التوكن ممكن يوصل هيدر (للوحة) أو query ?token= (لأزرار الجافاسكربت)
  const header = req.headers['x-gateway-token'];
  const query = url.searchParams.get('token');
  const t = header || query || '';
  return t === GATEWAY_TOKEN;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');

  if (!checkToken(req, url)) {
    res.writeHead(401); res.end(JSON.stringify({ error: 'token غلط' })); return;
  }

  try {
    // قائمة المجموعات التي يشارك فيها البوت
    if (url.pathname === '/groups' && req.method === 'GET') {
      const groups = await sock.groupFetchAllParticipating();
      res.writeHead(200);
      res.end(JSON.stringify({
        groups: Object.entries(groups).map(([jid, g]) => ({ jid, name: g.subject, size: g.participants?.length ?? 0 })),
      }));
      return;
    }

    // حالة الاتصال + QR الحالي (data URL)
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

    // بدء اقتران QR جديد (يمسح الجلسة القديمة)
    if (url.pathname === '/pair/qr' && req.method === 'POST') {
      if (sock) { try { sock.end(); } catch {} sock = null; }
      const fs = await import('node:fs');
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      mkdirSync(SESSION_DIR, { recursive: true });
      state.qr = null; state.pairingCode = null; state.connection = 'initializing';
      await startWhatsApp();
      res.writeHead(200); res.end(JSON.stringify({ ok: true, mode: 'qr' }));
      return;
    }

    // بدء اقتران بكود لرقم معين
    if (url.pathname === '/pair/code' && req.method === 'POST') {
      const body = await new Promise((resolve) => {
        let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(JSON.parse(d || '{}')));
      });
      const phone = String(body.phone ?? '').replace(/[^0-9]/g, '');
      if (!/^9\d{8,14}$/.test(phone)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'رقم غير صالح — لازم دولي بدون + مثال: 963958794195' }));
        return;
      }
      if (sock) { try { sock.end(); } catch {} sock = null; }
      const fs = await import('node:fs');
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      mkdirSync(SESSION_DIR, { recursive: true });
      state.qr = null; state.pairingCode = null; state.pairingRequested = false; state.connection = 'initializing';
      await startWhatsApp(phone);
      res.writeHead(200); res.end(JSON.stringify({ ok: true, mode: 'code', phone }));
      return;
    }

    // قطع الاتصال
    if (url.pathname === '/logout' && req.method === 'POST') {
      try { await sock?.logout(); } catch {}
      const fs = await import('node:fs');
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      mkdirSync(SESSION_DIR, { recursive: true });
      sock = null; state.connection = 'closed'; state.user = null;
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
  }
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`🚕 بوابة تكسي — HTTP: http://127.0.0.1:${HTTP_PORT}`);
  console.log(`🔑 GATEWAY_TOKEN: ${GATEWAY_TOKEN}`);
});

console.log(`🚕 بوابة تكسي واتساب → ${WORKER_URL}`);
console.log(`📂 الجلسة: ${SESSION_DIR}`);
await startWhatsApp();
outboxLoop();
