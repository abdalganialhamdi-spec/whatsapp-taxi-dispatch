/**
 * الوكلاء (Repos) فوق D1 — استعلامات نظيفة قابلة للاختبار.
 */

import type { Driver, FixedFare, Ride, RideStatus, Zone } from './types.js';

export async function getZones(db: D1Database): Promise<Zone[]> {
  const { results } = await db
    .prepare('SELECT id, name, aliases, belt FROM zones ORDER BY belt, id')
    .all<{ id: number; name: string; aliases: string | null; belt: number }>();
  return (results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    belt: r.belt,
    aliases: r.aliases ? (JSON.parse(r.aliases) as string[]) : [],
  }));
}

export async function getFixedFares(db: D1Database): Promise<FixedFare[]> {
  const { results } = await db
    .prepare('SELECT id, from_zone_id, to_zone_id, price FROM fixed_fares')
    .all<FixedFare>();
  return results ?? [];
}

export async function getDriverByPhone(db: D1Database, phone: string): Promise<Driver | null> {
  return await db
    .prepare('SELECT * FROM drivers WHERE phone = ? AND active = 1')
    .bind(phone)
    .first<Driver>();
}

// مطابقة السائق بالرقم أو بهوية LID (لرسائل المجموعات بلا senderPn)
export async function getDriverByPhoneOrLid(
  db: D1Database, phone: string, lid?: string
): Promise<Driver | null> {
  if (lid) {
    const byLid = await db
      .prepare('SELECT * FROM drivers WHERE lid = ? AND active = 1')
      .bind(lid)
      .first<Driver>();
    if (byLid) return byLid;
  }
  return getDriverByPhone(db, phone);
}

export async function setDriverLid(db: D1Database, id: number, lid: string): Promise<void> {
  await db.prepare('UPDATE drivers SET lid = ? WHERE id = ?').bind(lid, id).run();
}

// ─── طلبات الانضمام كسائق ───

export interface DriverApplication {
  id: number;
  phone: string;
  name: string;
  car: string;
  plate: string;
  status: string;
}

export async function getDriverApplication(db: D1Database, phone: string): Promise<DriverApplication | null> {
  return await db
    .prepare('SELECT * FROM driver_applications WHERE phone = ? ORDER BY id DESC LIMIT 1')
    .bind(phone)
    .first<DriverApplication>();
}

export async function getDriverApplicationById(db: D1Database, id: number): Promise<DriverApplication | null> {
  return await db
    .prepare('SELECT * FROM driver_applications WHERE id = ?')
    .bind(id)
    .first<DriverApplication>();
}

// upsert حقل واحد من الطلب (جمع تدريجي بالحوار)
export async function upsertDriverApplication(
  db: D1Database, phone: string, fields: Partial<Pick<DriverApplication, 'name' | 'car' | 'plate'>>
): Promise<void> {
  const cur = (await getDriverApplication(db, phone)) ?? { name: '', car: '', plate: '' };
  const merged = { ...cur, ...fields };
  await db
    .prepare(
      `INSERT INTO driver_applications (phone, name, car, plate, status)
       VALUES (?, ?, ?, ?, 'pending')
       ON CONFLICT (phone) DO UPDATE SET name = excluded.name, car = excluded.car, plate = excluded.plate, status = 'pending'`
    )
    .bind(phone, merged.name ?? '', merged.car ?? '', merged.plate ?? '')
    .run();
}

export async function setDriverApplicationStatus(db: D1Database, id: number, status: string): Promise<void> {
  await db.prepare('UPDATE driver_applications SET status = ? WHERE id = ?').bind(status, id).run();
}

export async function addDriver(
  db: D1Database, a: { phone: string; name: string; car: string; plate: string }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drivers (phone, name, car, plate, status, commission_pct, group_jid, active)
       VALUES (?, ?, ?, ?, 'OFFLINE', 10, '', 1)
       ON CONFLICT (phone) DO UPDATE SET name = excluded.name, car = excluded.car, plate = excluded.plate, active = 1`
    )
    .bind(a.phone, a.name, a.car, a.plate)
    .run();
}

// ─── سجل مشاكل المشرف الخلفي ───

export interface Issue {
  id: number;
  kind: string;
  severity: string;
  detail: string;
  ref_id: string | null;
  status: string;
  created_at: string;
}

export async function insertIssue(
  db: D1Database, kind: string, severity: 'high' | 'med' | 'low', detail: string, refId?: string
): Promise<boolean> {
  // dedupe: نفس النوع والمرجع ما زال جديد
  if (refId) {
    const dup = await db
      .prepare(`SELECT id FROM issues WHERE kind = ? AND ref_id = ? AND status = 'new'`)
      .bind(kind, refId)
      .first();
    if (dup) return false;
  }
  await db
    .prepare('INSERT INTO issues (kind, severity, detail, ref_id) VALUES (?, ?, ?, ?)')
    .bind(kind, severity, detail, refId ?? null)
    .run();
  return true;
}

export async function listIssues(db: D1Database, limit = 50): Promise<Issue[]> {
  const { results } = await db
    .prepare('SELECT * FROM issues ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all<Issue>();
  return results ?? [];
}

export async function countNewIssues(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE status = 'new'`).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function setIssueStatus(db: D1Database, id: number, status: 'acked' | 'fixed'): Promise<void> {
  await db
    .prepare(`UPDATE issues SET status = ?, acked_at = datetime('now') WHERE id = ?`)
    .bind(status, id)
    .run();
}

export async function getDriverById(db: D1Database, id: number): Promise<Driver | null> {
  return await db.prepare('SELECT * FROM drivers WHERE id = ?').bind(id).first<Driver>();
}

export async function setDriverStatus(db: D1Database, id: number, status: string): Promise<void> {
  await db.prepare('UPDATE drivers SET status = ? WHERE id = ?').bind(status, id).run();
}

export async function createRide(
  db: D1Database,
  r: {
    client_phone: string;
    from_zone_id: number | null;
    to_zone_id: number | null;
    from_text: string;
    to_text: string;
    price: number | null;
  }
): Promise<Ride> {
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `INSERT INTO rides (client_phone, from_zone_id, to_zone_id, from_text, to_text, price, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'NEW', ?)`
    )
    .bind(r.client_phone, r.from_zone_id, r.to_zone_id, r.from_text, r.to_text, r.price, now)
    .run();
  const id = res.meta.last_row_id as number;
  return {
    id,
    client_phone: r.client_phone,
    from_zone_id: r.from_zone_id,
    to_zone_id: r.to_zone_id,
    from_text: r.from_text,
    to_text: r.to_text,
    price: r.price,
    status: 'NEW',
    driver_id: null,
    created_at: now,
    assigned_at: null,
    done_at: null,
  };
}

export async function getRideById(db: D1Database, id: number): Promise<Ride | null> {
  return await db.prepare('SELECT * FROM rides WHERE id = ?').bind(id).first<Ride>();
}

export async function getClientRides(db: D1Database, phone: string, limit = 5): Promise<Ride[]> {
  const { results } = await db
    .prepare('SELECT * FROM rides WHERE client_phone = ? ORDER BY id DESC LIMIT ?')
    .bind(phone, limit)
    .all<Ride>();
  return results ?? [];
}

// آخر رسايل محادثة (وارد+صادر) — سياق للـ AI (فهم النص المقطوع + دردشة بذاكرة)
export async function getRecentMessages(
  db: D1Database, chatId: string, limit = 8
): Promise<Array<{ direction: string; sender_phone: string; text: string }>> {
  const { results } = await db
    .prepare(
      `SELECT direction, sender_phone, text FROM messages
       WHERE chat_id = ? ORDER BY id DESC LIMIT ?`
    )
    .bind(chatId, limit)
    .all<{ direction: string; sender_phone: string; text: string }>();
  return (results ?? []).reverse(); // الأقدم أولاً
}

// ─── حجز معلق ناقص: الزبون أعطى وجه واحد — ننتظر الباقي بدون إعادة السؤال ───

export interface PendingBooking {
  chat_id: string;
  from_zone_id: number | null;
  to_zone_id: number | null;
}

export async function getPendingBooking(db: D1Database, chatId: string): Promise<PendingBooking | null> {
  // ينتهي تلقائياً بعد 30 دقيقة صمت
  return await db
    .prepare(
      `SELECT chat_id, from_zone_id, to_zone_id FROM pending_bookings
       WHERE chat_id = ? AND created_at >= datetime('now', '-30 minutes')`
    )
    .bind(chatId)
    .first<PendingBooking>();
}

export async function setPendingBooking(
  db: D1Database, chatId: string, fromZoneId: number | null, toZoneId: number | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_bookings (chat_id, from_zone_id, to_zone_id, created_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (chat_id) DO UPDATE SET
         from_zone_id = excluded.from_zone_id,
         to_zone_id = excluded.to_zone_id,
         created_at = datetime('now')`
    )
    .bind(chatId, fromZoneId, toZoneId)
    .run();
}

export async function clearPendingBooking(db: D1Database, chatId: string): Promise<void> {
  await db.prepare('DELETE FROM pending_bookings WHERE chat_id = ?').bind(chatId).run();
}

// ─── روتين الزبون: تعلّم من المشاوير المنفذة + ملخص للـ AI ───

export interface ClientRoutine {
  id: number;
  phone: string;
  from_zone_id: number;
  to_zone_id: number;
  from_name: string;
  to_name: string;
  dow: number | null;   // 0=الأحد..6=السبت، null=كل يوم
  hour: number;
  hits: number;
}

const DOW_AR = ['الأحد', 'الإتنين', 'التلاتة', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];

// تعلّم: مشوار منفذ (DONE) = نقطة روتين. الساعة بتوقيت سوريا (UTC+3)
export async function learnRoutine(
  db: D1Database, phone: string, fromZoneId: number, toZoneId: number, createdAt: string | null
): Promise<void> {
  const d = createdAt ? new Date(createdAt) : new Date();
  const local = new Date(d.getTime() + 3 * 3600_000); // سوريا UTC+3
  const dow = local.getUTCDay();
  const hour = local.getUTCHours();
  await db
    .prepare(
      `INSERT INTO client_routines (phone, from_zone_id, to_zone_id, dow, hour, hits, last_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT (phone, from_zone_id, to_zone_id, dow, hour)
       DO UPDATE SET hits = hits + 1, last_at = datetime('now'), active = 1`
    )
    .bind(phone, fromZoneId, toZoneId, dow, hour)
    .run();
}

// ملخص نصي عربي لروتين الزبون — يُحقن ببرومبت الـ AI
export async function getRoutineSummary(db: D1Database, phone: string): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT r.*, zf.name AS from_name, zt.name AS to_name
       FROM client_routines r
       JOIN zones zf ON zf.id = r.from_zone_id
       JOIN zones zt ON zt.id = r.to_zone_id
       WHERE r.phone = ? AND r.active = 1 AND r.hits >= 2
       ORDER BY r.hits DESC LIMIT 6`
    )
    .bind(phone)
    .all<ClientRoutine>();
  if (!results?.length) return '';
  return results
    .map((r) => {
      const day = r.dow === null ? 'كل يوم' : `كل يوم ${DOW_AR[r.dow] ?? r.dow}`;
      const hh = String(r.hour).padStart(2, '0') + ':00';
      return `- ${day} حوالي الساعة ${hh} من ${r.from_name} إلى ${r.to_name} (${r.hits} مرات)`;
    })
    .join('\n');
}

export async function getActiveRideForClient(db: D1Database, phone: string): Promise<Ride | null> {
  return await db
    .prepare(
      `SELECT * FROM rides
       WHERE client_phone = ? AND status IN ('NEW','DISPATCHING','ASSIGNED','ARRIVED','IN_RIDE')
       ORDER BY id DESC LIMIT 1`
    )
    .bind(phone)
    .first<Ride>();
}

export async function getOpenRideForGroup(db: D1Database, groupJid: string): Promise<Ride | null> {
  // الرحلة المعلقة الحالية في مجموعة توزيع معينة (DISPATCHING)
  // LEFT JOIN: الطلب الموزع لسا بلا سائق (driver_id NULL) — JOIN عادي كان يخفيه دائماً
  return await db
    .prepare(
      `SELECT r.* FROM rides r
       LEFT JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'DISPATCHING' AND (d.group_jid = ? OR d.group_jid IS NULL OR ? = '')
       ORDER BY r.id DESC LIMIT 1`
    )
    .bind(groupJid, groupJid)
    .first<Ride>()
    .then((r) => r ?? getLastDispatching(db, groupJid));
}

async function getLastDispatching(db: D1Database, groupJid: string): Promise<Ride | null> {
  const { results } = await db
    .prepare(`SELECT * FROM rides WHERE status = 'DISPATCHING' ORDER BY id DESC LIMIT 1`)
    .all<Ride>();
  return results?.[0] ?? null;
}

export async function updateRideStatus(
  db: D1Database,
  id: number,
  status: RideStatus,
  extra?: { driver_id?: number }
): Promise<void> {
  const now = new Date().toISOString();
  if (status === 'ASSIGNED') {
    await db
      .prepare(
        `UPDATE rides SET status = ?, driver_id = ?, assigned_at = ? WHERE id = ?`
      )
      .bind(status, extra?.driver_id ?? null, now, id)
      .run();
  } else if (status === 'DONE') {
    await db
      .prepare(`UPDATE rides SET status = ?, done_at = ? WHERE id = ?`)
      .bind(status, now, id)
      .run();
  } else {
    await db.prepare(`UPDATE rides SET status = ? WHERE id = ?`).bind(status, id).run();
  }
}

export async function getActiveAssignedRide(db: D1Database, driverId: number): Promise<Ride | null> {
  return await db
    .prepare(
      `SELECT * FROM rides
       WHERE driver_id = ? AND status IN ('ASSIGNED','ARRIVED','IN_RIDE')
       ORDER BY id DESC LIMIT 1`
    )
    .bind(driverId)
    .first<Ride>();
}

export async function getDriverTodayRides(db: D1Database, driverId: number): Promise<Ride[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { results } = await db
    .prepare(
      `SELECT * FROM rides WHERE driver_id = ? AND assigned_at >= ? ORDER BY id DESC`
    )
    .bind(driverId, `${today}T00:00:00`)
    .all<Ride>();
  return results ?? [];
}

export async function notifyClient(db: D1Database, rideId: number, text: string): Promise<void> {
  // سجل الإشعار فقط — الإرسال الفعلي يجري في الـ gateway عند استقبال outbox
  const ride = await getRideById(db, rideId);
  if (!ride) return;
  await queueOutbox(db, `${ride.client_phone}@s.whatsapp.net`, text, 'BOT');
}

// ─── سجل الرسائل الموحد + الإرسال (رقم الشركة: بشر أو AI) ───

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

/** توثيق أي رسالة (وارد/صادر) — يُستدعى لكل رسالة بلا استثناء */
export async function logMessage(
  db: D1Database,
  m: { direction: 'in' | 'out'; chat_id: string; sender_phone: string; text: string; intent?: string | null }
): Promise<void> {
  await db
    .prepare(`INSERT INTO messages (direction, chat_id, sender_phone, text, intent) VALUES (?, ?, ?, ?, ?)`)
    .bind(m.direction, m.chat_id, m.sender_phone, m.text.slice(0, 2000), m.intent ?? null)
    .run();
}

/** إدخال outbox + توثيق تلقائي — كل الصادر يمر من هنا */
export async function queueOutbox(db: D1Database, chat_id: string, text: string, sender = 'BOT'): Promise<void> {
  await db.prepare(`INSERT INTO outbox (chat_id, text) VALUES (?, ?)`).bind(chat_id, text).run();
  await logMessage(db, { direction: 'out', chat_id, sender_phone: sender, text });
}

export interface Conversation {
  chat_id: string;
  phone: string;        // الرقم المستخرج من الـ JID (أو اسم المجموعة)
  is_group: boolean;
  last_text: string;
  last_at: string;
  last_dir: string;
  total: number;
  paused: boolean;
}

export async function getConversations(db: D1Database, limit = 30): Promise<Conversation[]> {
  const { results } = await db
    .prepare(
      `SELECT chat_id,
              MAX(id) AS last_id,
              COUNT(*) AS total
       FROM messages GROUP BY chat_id ORDER BY last_id DESC LIMIT ?`
    )
    .bind(limit)
    .all<{ chat_id: string; last_id: number; total: number }>();
  const paused = await getPausedChats(db);
  const out: Conversation[] = [];
  for (const r of results ?? []) {
    const last = await db
      .prepare(`SELECT text, created_at, direction FROM messages WHERE id = ?`)
      .bind(r.last_id)
      .first<{ text: string; created_at: string; direction: string }>();
    const isGroup = r.chat_id.endsWith('@g.us');
    const phone = isGroup ? r.chat_id : r.chat_id.split('@')[0].split(':')[0];
    out.push({
      chat_id: r.chat_id,
      phone,
      is_group: isGroup,
      last_text: last?.text ?? '',
      last_at: last?.created_at ?? '',
      last_dir: last?.direction ?? '',
      total: r.total,
      paused: paused.includes(phone),
    });
  }
  return out;
}

export interface ChatMessage {
  id: number;
  direction: string;
  sender_phone: string;
  text: string;
  intent: string | null;
  created_at: string;
}

export async function getChatMessages(db: D1Database, chat_id: string, limit = 60): Promise<ChatMessage[]> {
  const { results } = await db
    .prepare(`SELECT id, direction, sender_phone, text, intent, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`)
    .bind(chat_id, limit)
    .all<ChatMessage>();
  return (results ?? []).reverse();
}

/** أرقام موقوف عنها البوت (الرد بشر من اللوحة فقط) */
export async function getPausedChats(db: D1Database): Promise<string[]> {
  const v = await getSetting(db, 'paused_chats');
  try {
    const arr = JSON.parse(v ?? '[]');
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export async function setPaused(db: D1Database, phone: string, paused: boolean): Promise<string[]> {
  const list = (await getPausedChats(db)).filter((p) => p !== phone);
  if (paused) list.push(phone);
  await db
    .prepare(`INSERT INTO settings (key, value) VALUES ('paused_chats', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(JSON.stringify(list))
    .run();
  return list;
}

export async function todayStats(db: D1Database) {
  const today = new Date().toISOString().slice(0, 10);
  const rides = await db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN status = 'DONE' THEN price ELSE 0 END) as revenue
       FROM rides WHERE created_at >= ?`
    )
    .bind(`${today}T00:00:00`)
    .first<{ total: number; done: number | null; revenue: number | null }>();
  const drivers = await db
    .prepare(`SELECT COUNT(*) as active FROM drivers WHERE status != 'OFFLINE' AND active = 1`)
    .first<{ active: number }>();
  return {
    total: rides?.total ?? 0,
    done: rides?.done ?? 0,
    revenue: rides?.revenue ?? 0,
    activeDrivers: drivers?.active ?? 0,
  };
}
