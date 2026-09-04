#!/usr/bin/env node
/**
 * gen-qr-once.mjs — توليد QR اقتران لمرة واحدة، بمعزل كامل عن جلسة البوابة.
 *
 *  - جلسة Baileys مؤقتة في /tmp/taxi-qr-once (تُمسح وتُنشأ نظيفة كل تشغيل)
 *  - عند أول حدث qr: حفظ PNG إلى /tmp/taxi-qr-once/qr.png ثم exit(0)
 *  - لا reconnect، ولا لمس ./session الرسمية إطلاقاً
 *  - stdout يطبع مسار الملف فقط؛ الأخطاء تذهب إلى stderr
 *
 * التشغيل: node gen-qr-once.mjs
 */

import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { pino } from 'pino';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const QR_DIR = '/tmp/taxi-qr-once';
const QR_PNG = '/tmp/taxi-qr-once/qr.png';
const QR_TIMEOUT_MS = 60_000;

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

// جلسة مؤقتة نظيفة في كل تشغيل — هذا المجلد ملك هذا السكربت وحده
rmSync(QR_DIR, { recursive: true, force: true });
mkdirSync(QR_DIR, { recursive: true });

// صمت تام: المطلوب على stdout هو مسار الملف فقط
const log = pino({ level: 'silent' });

const { state: auth, saveCreds } = await useMultiFileAuthState(QR_DIR);

let version;
try {
  ({ version } = await fetchLatestBaileysVersion());
} catch {
  version = [2, 3000, 1023223821]; // نفس fallback البوابة
}

const sock = makeWASocket({
  version,
  auth: {
    creds: auth.creds,
    // بدون Cacheable store المفاتيح تتلف أثناء المصافحة
    keys: makeCacheableSignalKeyStore(auth.keys, log.child({ module: 'signal-keys' })),
  },
  printQRInTerminal: false,
  logger: log,
  markOnlineOnConnect: false,
  syncFullHistory: false,
  shouldSyncHistoryMessage: () => false,
  browser: ['Ubuntu', 'Chrome', '20.0.04'], // نفس بصمة البوابة
});

sock.ev.on('creds.update', saveCreds);

// مهلة واحدة ثم فشل — لا انتظار indefinitely ولا إعادة محاولة
const kill = setTimeout(() => {
  try { sock.ev.removeAllListeners(); } catch {}
  try { sock.end(new Error('qr timeout')); } catch {}
  fail('انتهت المهلة (60 ثانية) دون وصول QR');
}, QR_TIMEOUT_MS);

sock.ev.on('connection.update', async (u) => {
  const { connection, lastDisconnect, qr } = u;

  if (qr) {
    try {
      await QRCode.toFile(QR_PNG, qr, { type: 'png', margin: 1, width: 320 });
      clearTimeout(kill);
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.end(new Error('done')); } catch {}
      console.log(QR_PNG); // المسار فقط — صالح للمعالجة الآلية
      process.exit(0);
    } catch (e) {
      fail(`فشل حفظ PNG: ${e}`);
    }
  }

  if (connection === 'close') {
    const code = lastDisconnect?.error?.output?.statusCode;
    try { sock.ev.removeAllListeners(); } catch {}
    fail(`أُغلق الاتصال قبل وصول QR (code=${code ?? 'unknown'})`);
  }
});

process.on('unhandledRejection', (e) => fail(String(e)));
