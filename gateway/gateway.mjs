#!/usr/bin/env node
/**
 * بوابة واتساب (Baileys) — بوت تكسي واتساب
 * whatsapp-taxi-dispatch gateway
 *
 * الوظيفة:
 *  1) تستقبل رسائل واتساب (Baileys) وتدفعها للـ Worker على /webhook/whatsapp
 *  2) تسحب الردود من /outbox/pending وترسلها وتؤكد /outbox/ack
 *
 * التشغيل على سيرفر عادي (VPS) — ليس على Workers.
 *
 * ⚠️ القاعدة الذهبية للاقتران: اعمل QR-pair من متصفح/IP **منزلي** وليس من IP
 *    مركزي/سيرفر — تقليل خطر الحظر بشكل كبير. الجلسة تُحفظ بـ ./session
 *
 * الاستخدام:
 *   WORKER_URL=https://xxx.workers.dev ADMIN_KEY=... node gateway.mjs
 *   WORKER_URL=... ADMIN_KEY=... node gateway.mjs --pair   # إعادة اقتران QR
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8787';
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const PORT = Number(process.env.PORT ?? 3010);
const POLL_MS = Number(process.env.POLL_MS ?? 1500);
const SESSION_DIR = process.env.SESSION_DIR ?? join(__dirname, 'session');

if (!ADMIN_KEY) {
  console.error('❌ ADMIN_KEY مطلوب');
  process.exit(1);
}

mkdirSync(SESSION_DIR, { recursive: true });

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ─── إرسال للـ Worker ───
async function worker(path, method = 'GET', body = null) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`worker ${path} → ${res.status}`);
  return res.json();
}

// ─── حالة الاتصال ───
let sock = null;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: log.child({ module: 'baileys' }),
    markOnlineOnConnect: false, // لا نظهر "متصل" دائماً — طبيعي أكثر
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      const svg = await QRCode.toString(qr, { type: 'terminal', small: true });
      console.log('\n📱 امسح الكود: واتساب ← الأجهزة المرتبطة ← ربط جهاز');
      console.log('⚠️  القاعدة الذهبية: اقتران من IP منزلي، مش من سيرفر!\n');
      console.log(svg);
    }
    if (connection === 'open') {
      console.log('✅ واتساب متصل');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const rejoin = code !== DisconnectReason.loggedOut;
      console.log(`⚠️ انقطع الاتصال (code=${code}) — ${rejoin ? 'إعادة محاولة…' : 'خروج نهائي، امسح session واقتران من جديد'}`);
      if (rejoin) setTimeout(startWhatsApp, 3000);
      else process.exit(2);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message) continue;
      if (m.key.fromMe) continue; // رسائلنا الصادرة لا نعيد معالجتها
      const chatId = m.key.remoteJid;
      if (!chatId || chatId === 'status@broadcast') continue;

      const text =
        m.message.conversation ??
        m.message.extendedTextMessage?.text ??
        m.message.imageMessage?.caption ??
        '';
      if (!text.trim()) continue;

      const senderJid = m.key.participant ?? chatId; // بالمجموعات: مين أرسل
      const senderPhone = senderJid.split('@')[0].replace(/:/g, '');

      try {
        await worker('/webhook/whatsapp', 'POST', {
          chatId,
          senderPhone,
          text,
          isGroup: chatId.endsWith('@g.us'),
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
      const { messages } = await worker('/outbox/pending');
      if (messages?.length && sock) {
        const sent = [];
        for (const m of messages) {
          try {
            await sock.sendMessage(m.chat_id, { text: m.text });
            sent.push(m.id);
          } catch (e) {
            log.error({ err: String(e), id: m.id }, 'send failed');
          }
        }
        if (sent.length) await worker('/outbox/ack', 'POST', { ids: sent });
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'outbox poll failed');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// HTTP صحي بسيط (node:http)
import { createServer } from 'node:http';
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: !!sock?.user, user: sock?.user?.id ?? null }));
}).listen(PORT, () => console.log(`💚 health: http://localhost:${PORT}/`));

// ─── تشغيل ───
console.log(`🚕 بوابة تكسي واتساب → ${WORKER_URL}`);
console.log(`📂 الجلسة: ${SESSION_DIR}`);

await startWhatsApp();
outboxLoop();
