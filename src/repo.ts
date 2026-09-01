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
  return await db
    .prepare(
      `SELECT r.* FROM rides r
       JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'DISPATCHING' AND (d.group_jid = ? OR ? = '')
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
  await db
    .prepare(`INSERT INTO outbox (chat_id, text, created_at) VALUES (?, ?, ?)`)
    .bind(`${ride.client_phone}@s.whatsapp.net`, text, new Date().toISOString())
    .run();
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
