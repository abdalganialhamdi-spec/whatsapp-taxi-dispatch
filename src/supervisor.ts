/**
 * المشرف الخلفي — يفحص كل 30 دقيقة ويطلع تقارير للمهندس (admin_phone).
 * كشف: طلبات عالقة، إرسال فاشل، هويات LID غير محلولة، محادثات منقطعة،
 * إلغاء بعد إسناد، ونسبة فهم منخفضة. قراءة فقط — ما بياخد أي قرار تنفيذي.
 */

import * as repo from './repo.js';
import type { Env } from './types.js';

export async function runSupervisor(env: Env): Promise<void> {
  const alerts: string[] = [];

  // 1) طلبات DISPATCHING عالقة > 20 دقيقة (high)
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, client_phone FROM rides
       WHERE status = 'DISPATCHING' AND created_at <= datetime('now', '-20 minutes')`
    ).all<{ id: number; client_phone: string }>();
    for (const r of results ?? []) {
      const added = await repo.insertIssue(
        env.DB, 'STUCK_RIDE', 'high',
        `الطلب #${r.id} نايم بالمجموعة بلا سائق — زبون ${r.client_phone}`,
        String(r.id)
      );
      if (added) alerts.push(`🔴 طلب #${r.id} عالق بلا سائق`);
    }
  } catch { /* جدول ناقص = تجاهل */ }

  // 2) إرسال فاشل نهائياً — فقط آخر ساعة (القديم انصلاح ومحفوظ بالأرشيف)
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, substr(chat_id,1,20) AS c FROM outbox
       WHERE text LIKE '%فشل الإرسال نهائيا%' AND sent_at >= datetime('now', '-1 hour')`
    ).all<{ id: number; c: string }>();
    for (const r of results ?? []) {
      const added = await repo.insertIssue(
        env.DB, 'SEND_FAIL', 'high', `رسالة outbox #${r.id} لـ ${r.c} فشلت نهائياً`, String(r.id)
      );
      if (added) alerts.push(`🔴 رسالة #${r.id} فشل إرسالها نهائياً`);
    }
  } catch { /* ignore */ }

  // 3) هويات LID غير محلولة آخر 24 ساعة (med)
  try {
    const r = await env.DB.prepare(
      `SELECT chat_id, COUNT(*) AS n FROM messages
       WHERE intent = 'LID_UNKNOWN' AND created_at >= datetime('now', '-1 day')
       GROUP BY chat_id LIMIT 3`
    ).all<{ chat_id: string; n: number }>();
    for (const row of r.results ?? []) {
      const added = await repo.insertIssue(
        env.DB, 'LID_UNKNOWN', 'med',
        `${row.n} رسالة من هوية غير محلولة (${row.chat_id.slice(0, 18)}…) — ممكن سائق غير مربوط`,
        row.chat_id
      );
      if (added) alerts.push(`🟡 ${row.n} رسالة بهوية مجهولة`);
    }
  } catch { /* ignore */ }

  // 4) محادثات منقطعة: >= 4 وارد آخر 6 ساعات بلا طلب (med)
  //    الإدارة والسواقين مستثنين — تجاربهم ما بتنحسب «زبون منقطع»
  try {
    const staff = new Set(
      (await Promise.all([
        repo.getSetting(env.DB, 'manager_phone'),
        repo.getSetting(env.DB, 'admin_phone'),
      ])).filter(Boolean) as string[]
    );
    const { results: drivers } = await env.DB.prepare(
      `SELECT phone FROM drivers WHERE active = 1`
    ).all<{ phone: string }>();
    for (const d of drivers ?? []) staff.add(d.phone);

    const { results } = await env.DB.prepare(
      `SELECT sender_phone, COUNT(*) AS n FROM messages
       WHERE direction = 'in' AND created_at >= datetime('now', '-6 hours')
         AND sender_phone != 'BOT'
       GROUP BY sender_phone HAVING n >= 4 LIMIT 3`
    ).all<{ sender_phone: string; n: number }>();
    for (const row of results ?? []) {
      if (staff.has(row.sender_phone)) continue;
      const hasRide = await env.DB.prepare(
        `SELECT id FROM rides WHERE client_phone = ? LIMIT 1`
      ).bind(row.sender_phone).first();
      if (!hasRide) {
        const added = await repo.insertIssue(
          env.DB, 'DROPPED_CONV', 'med',
          `زبون ${row.sender_phone} بعت ${row.n} رسايل وما انعمللو طلب — غالباً الفهم فشل`,
          row.sender_phone
        );
        if (added) alerts.push(`🟡 زبون حاول ${row.n} مرات وترك`);
      }
    }
  } catch { /* ignore */ }

  // 5) إلغاء بعد الإسناد آخر 24 ساعة (low)
  try {
    const { results } = await env.DB.prepare(
      `SELECT id FROM rides
       WHERE status = 'CANCELLED' AND driver_id IS NOT NULL
         AND created_at >= datetime('now', '-1 day') LIMIT 5`
    ).all<{ id: number }>();
    for (const r of results ?? []) {
      const added = await repo.insertIssue(
        env.DB, 'CANCEL_AFTER_ASSIGN', 'low', `الطلب #${r.id} انلغى بعد ما انعطى لسائق — تأخير أو زحمة؟`, String(r.id)
      );
      if (added) alerts.push(`⚪ طلب #${r.id} انلغى بعد الإسناد`);
    }
  } catch { /* ignore */ }

  // 6) نسبة فهم منخفضة: > 60% UNKNOWN آخر 6 ساعات (>= 5 رسايل)
  try {
    const r = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN intent = 'UNKNOWN' THEN 1 ELSE 0 END) AS unk,
         COUNT(*) AS total
       FROM messages
       WHERE direction = 'in' AND sender_phone != 'BOT'
         AND created_at >= datetime('now', '-6 hours')`
    ).first<{ unk: number | null; total: number }>();
    if (r && (r.total ?? 0) >= 5 && (r.unk ?? 0) / r.total > 0.6) {
      const added = await repo.insertIssue(
        env.DB, 'AI_FAIL', 'med',
        `نسبة الفهم واطية: ${r.unk}/${r.total} رسالة UNKNOWN آخر 6 ساعات — راجع الـ AI/NLU`,
        'ratio-6h'
      );
      if (added) alerts.push(`🟡 الفهم عم يفشل (${r.unk}/${r.total})`);
    }
  } catch { /* ignore */ }

  // تنبيه واتساب للمهندس — فقط للجديد (high/med)
  if (alerts.length) {
    const admin = await repo.getSetting(env.DB, 'admin_phone');
    if (admin) {
      await repo.queueOutbox(
        env.DB,
        `${admin}@s.whatsapp.net`,
        `⚠️ تقرير المشرف (${new Date().toISOString().slice(11, 16)} UTC):\n${alerts.slice(0, 5).join('\n')}`,
        'BOT'
      );
    }
  }
}
