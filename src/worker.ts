/**
 * نقطة الدخول — WhatsApp Taxi Dispatch Worker
 *
 * Routes:
 *   POST /webhook/whatsapp   — البوابة (Baileys) تدفع الرسائل الواردة هنا
 *   GET  /outbox/pending     — البوابة تسحب ما ينتظر الإرسال (poll كل ثانية)
 *   POST /outbox/ack         — البوابة تأكد الإرسال
 *   GET  /health             — فحص
 *   GET  /                   — لوحة الإدارة (تتطلب ADMIN_KEY بالكوكي أو ?key=)
 *   POST /admin/*            — أوامر الإدارة (سواقين/مناطق/تعاريف)
 */

import { handleMessage, type InboundMessage } from './engine.js';
import type { Env } from './types.js';
import { adminPage, adminApi } from './admin.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/health') {
      return json({ ok: true, service: 'whatsapp-taxi-dispatch' });
    }

    // ─── واجهة البوابة ───
    if (request.method === 'POST' && path === '/webhook/whatsapp') {
      const body = await request.json<InboundMessage>();
      if (!body?.chatId || !body?.text) return json({ error: 'chatId و text مطلوبان' }, 400);
      try {
        const outs = await handleMessage(env, {
          chatId: body.chatId,
          senderPhone: body.senderPhone ?? body.chatId.split('@')[0],
          text: body.text,
          isGroup: body.chatId.endsWith('@g.us'),
        });
        // اكتب الرسائل الصادرة على outbox ليلتقطها gateway
        for (const o of outs) {
          await env.DB.prepare(`INSERT INTO outbox (chat_id, text) VALUES (?, ?)`)
            .bind(o.chatId, o.text)
            .run();
        }
        return json({ ok: true, replies: outs.length });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (request.method === 'GET' && path === '/outbox/pending') {
      if (!(await checkGatewayAuth(request, env))) return json({ error: 'unauthorized' }, 401);
      const { results } = await env.DB.prepare(
        `SELECT id, chat_id, text FROM outbox WHERE sent_at IS NULL ORDER BY id ASC LIMIT 20`
      ).all();
      return json({ messages: results ?? [] });
    }

    if (request.method === 'POST' && path === '/outbox/ack') {
      if (!(await checkGatewayAuth(request, env))) return json({ error: 'unauthorized' }, 401);
      const { ids } = await request.json<{ ids: number[] }>();
      if (!ids?.length) return json({ ok: true, acked: 0 });
      await env.DB.prepare(
        `UPDATE outbox SET sent_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`
      )
        .bind(...ids)
        .run();
      return json({ ok: true, acked: ids.length });
    }

    // ─── لوحة الإدارة ───
    if (path === '/' || path.startsWith('/admin')) {
      return handleAdmin(request, env, path);
    }

    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') ?? parseCookie(request, 'admin_key') ?? '';
  if (key !== env.ADMIN_KEY) {
    return new Response('🔒 غلط بالمفتاح — /?key=YOUR_ADMIN_KEY', { status: 401, headers: html });
  }
  if (path.startsWith('/admin/api/')) {
    return adminApi(request, env, path.slice('/admin/api/'.length));
  }
  return adminPage(env);
}

async function checkGatewayAuth(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get('Authorization') ?? '';
  return token === `Bearer ${env.ADMIN_KEY}`;
}

function parseCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie') ?? '';
  const m = cookie.match(new RegExp(`${name}=([^;]+)`));
  return m?.[1] ?? null;
}

const html = { 'content-type': 'text/html; charset=utf-8' };
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
