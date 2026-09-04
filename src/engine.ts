/**
 * محرك البوت — يربط NLU + التسعير + آلة الحالات ويرجّع رسائل صادرة.
 * Engine: pure-ish orchestration, no fetch here (gateway does IO).
 */

import { parseMessage, normalizeArabic } from './nlu.js';
import { aiParse, matchZoneByName } from './ai.js';
import { computeFare, formatSYP } from './pricing.js';
import { assertTransition } from './ride-state.js';
import * as repo from './repo.js';
import type { Driver, Env, Ride } from './types.js';

export interface InboundMessage {
  chatId: string;       // JID الوارد (شخص أو مجموعة)
  senderPhone: string;  // رقم مرسل الرسالة (9639...)
  text: string;
  isGroup: boolean;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
}

const MENU = `🚕 أهلا فيك بمشاوير الحموي!
شو بتحب؟
1️⃣ احجز سيارة — اكتب مثلا: «بدي روح من طريق حلب لعند المخيم»
2️⃣ اسأل عن التعرفة — «كم من الصابونية لجنوب الثكنة»
3️⃣ رحلاتي — اكتب «رحلاتي»
4️⃣ تحدث مع موظف — اكتب «المهندس»`;

function rejectClientRide(ride: Ride): string {
  const n = ride.id;
  return `🚕 طلبك رقم ${n} — ${ride.status === 'DISPATCHING' ? 'لسا عم ندور على سائق، صبر شوي 🙏' : 'موجود وقيد المعالجة.'}`;
}

export async function handleMessage(env: Env, msg: InboundMessage): Promise<OutboundMessage[]> {
  const zones = await repo.getZones(env.DB);
  const driver = await repo.getDriverByPhone(env.DB, msg.senderPhone);
  const isDriver = !!driver;
  let parsed = parseMessage(msg.text, zones, isDriver);

  // طبقة AI: تعمل فقط إذا المفتاح موجود + القواعدي ما فهم شي مفيد
  if (!isDriver && (parsed.intent === 'UNKNOWN' || (!parsed.from_zone && !parsed.to_zone))) {
    const ai = await aiParse(env, msg.text, zones);
    if (ai && ai.intent !== 'UNKNOWN') {
      const from = matchZoneByName(ai.from, zones);
      const to = matchZoneByName(ai.to, zones);
      parsed = { intent: ai.intent as typeof parsed.intent, from_zone: from, to_zone: to, raw: msg.text };
    }
  }

  // ─── رسائل مجموعة السواقين: فقط أوامر سواقين/قبول ───
  if (msg.isGroup) {
    return handleGroup(env, msg, driver, parsed.intent);
  }

  // ─── رسائل خاصة ───
  if (isDriver) return handleDriverPrivate(env, msg, driver, parsed.intent);

  switch (parsed.intent) {
    case 'BOOK': {
      const active = await repo.getActiveRideForClient(env.DB, msg.senderPhone);
      if (active) {
        // طلب NEW معلق أكثر من 15 دقيقة = زبون نسيه — نلغيه تلقائياً ونكمل الحجز الجديد
        const ageMin = active.created_at ? (Date.now() - new Date(active.created_at).getTime()) / 60000 : 0;
        if (active.status === 'NEW' && ageMin > 15) {
          await repo.updateRideStatus(env.DB, active.id, 'CANCELLED');
        } else {
          return [{ chatId: msg.chatId, text: rejectClientRide(active) }];
        }
      }
      if (!parsed.from_zone || !parsed.to_zone) {
        return [{
          chatId: msg.chatId,
          text: 'منين ووين بدك؟ اكتبها هيك:\n«بدي روح من طريق حلب لعند المخيم»',
        }];
      }
      const fares = await repo.getFixedFares(env.DB);
      const fare = computeFare(parsed.from_zone, parsed.to_zone, fares);
      if (fare.source === 'NONE') return [{ chatId: msg.chatId, text: fare.note }];
      const ride = await repo.createRide(env.DB, {
        client_phone: msg.senderPhone,
        from_zone_id: parsed.from_zone.id,
        to_zone_id: parsed.to_zone.id,
        from_text: parsed.raw,
        to_text: parsed.raw,
        price: fare.price,
      });
      return [{
        chatId: msg.chatId,
        text: `🚕 طلبك رقم ${ride.id}
📍 من: ${parsed.from_zone.name}
🏁 إلى: ${parsed.to_zone.name}
💰 الأجرة: ${formatSYP(fare.price)} (${fare.note})
✅ أكّد بكلمة «تمام» — ❌ إلغاء بكلمة «الكي»`,
      }];
    }

    case 'PRICE_QUERY': {
      const fares = await repo.getFixedFares(env.DB);
      const fare = computeFare(parsed.from_zone, parsed.to_zone, fares);
      if (fare.source === 'NONE') {
        return [{ chatId: msg.chatId, text: 'احكيلي منين ووين: «كم من الصابونية لجنوب الثكنة»' }];
      }
      return [{
        chatId: msg.chatId,
        text: `💰 التعرفة: ${formatSYP(fare.price)} (${fare.note})`,
      }];
    }

    case 'CONFIRM': {
      const active = await repo.getActiveRideForClient(env.DB, msg.senderPhone);
      if (!active || active.status !== 'NEW') {
        return [{ chatId: msg.chatId, text: 'ما في طلب جديد للتأكيد — احكينا وين بدك تروح 🚕' }];
      }
      assertTransition(active.status, 'DISPATCHING');
      await repo.updateRideStatus(env.DB, active.id, 'DISPATCHING');

      // نشر الطلب فوراً على مجموعة السائقين (من settings)
      const setting = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'drivers_group_jid'`).first<{ value: string }>();
      const out: OutboundMessage[] = [{
        chatId: msg.chatId,
        text: `✅ تم القبول! عم نرسل طلبك للسائقين 🔎
أول سائق يوافق بيوصلك بياناته.`,
      }];
      if (setting?.value) {
        const zonesMap = new Map(zones.map((z) => [z.id, z.name]));
        const fromName = active.from_zone_id ? zonesMap.get(active.from_zone_id) : null;
        const toName = active.to_zone_id ? zonesMap.get(active.to_zone_id) : null;
        out.push({
          chatId: setting.value,
          text: `🚕 طلب جديد #${active.id}
📍 من: ${fromName ?? '—'}
🏁 إلى: ${toName ?? '—'}
💰 الأجرة: ${formatSYP(active.price ?? 0)}
الزبون بينتظر — للقبول ردّ بكلمة «قبلت ${active.id}»`,
        });
      }
      return out;
    }

    case 'CANCEL': {
      const active = await repo.getActiveRideForClient(env.DB, msg.senderPhone);
      if (!active) return [{ chatId: msg.chatId, text: 'ما في طلب شغال هلق.' }];
      assertTransition(active.status, 'CANCELLED');
      await repo.updateRideStatus(env.DB, active.id, 'CANCELLED');
      const out: OutboundMessage[] = [{ chatId: msg.chatId, text: `❌ تم إلغاء الطلب ${active.id}. مو منتظرينك بأي وقت 🙌` }];
      if (active.driver_id) {
        const d = await repo.getDriverById(env.DB, active.driver_id);
        if (d) out.push({ chatId: `${d.phone}@s.whatsapp.net`, text: `⚠️ الزبون ألغى الطلب ${active.id}.` });
      }
      return out;
    }

    case 'MY_RIDES': {
      const rides = await repo.getClientRides(env.DB, msg.senderPhone, 5);
      if (!rides.length) return [{ chatId: msg.chatId, text: 'لسا ما في رحلات سجلة باسمك.' }];
      const lines = rides.map((r) => {
        const icon: Record<string, string> = {
          NEW: '🕒', DISPATCHING: '🔎', ASSIGNED: '🚕', ARRIVED: '📍',
          IN_RIDE: '🛣️', DONE: '✅', CANCELLED: '❌',
        };
        return `${icon[r.status] ?? '•'} #${r.id} — ${r.status}${r.price ? ` — ${formatSYP(r.price)}` : ''}`;
      });
      return [{ chatId: msg.chatId, text: `📋 رحلاتك:\n${lines.join('\n')}` }];
    }

    case 'TALK_HUMAN': {
      // تنبيه المدير على الخاص + رد للزبون
      const admin = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'admin_phone'`).first<{ value: string }>();
      if (admin?.value) {
        await env.DB.prepare(`INSERT INTO outbox (chat_id, text, created_at) VALUES (?, ?, ?)`)
          .bind(`${admin.value}@s.whatsapp.net`, `🗣 زبون طلب موظف: +${msg.senderPhone} — «${msg.text.slice(0, 120)}»`, new Date().toISOString())
          .run();
      }
      return [{
        chatId: msg.chatId,
        text: '🗣 تم تحويلك للمهندس — استنى شوي بس، رح يرد عليك أقرب وقت.',
      }];
    }

    case 'HELP':
    case 'UNKNOWN':
    default:
      return [{ chatId: msg.chatId, text: MENU }];
  }
}

async function handleGroup(
  env: Env,
  msg: InboundMessage,
  driver: Driver | null,
  intent: ReturnType<typeof parseMessage>['intent']
): Promise<OutboundMessage[]> {
  if (!driver) {
    // غير مسجل — إذا حاول يقبل نعلمه بدل التجاهل الصامت
    // (ملاحظة: parseMessage لا يعطي DRIVER_ACCEPT لغير المسجلين، فنكشف الصيغة هنا مباشرة)
    const norm = normalizeArabic(msg.text);
    if (/قبلت|موافق|اخدتها|انا جاي|على راسي/.test(norm)) {
      return [{
        chatId: msg.chatId,
        text: `👨‍✈️ أهلاً! هالرقم مو مسجل كسائق — اكلم المهندس يسجلك بالنظام لتقدر تستلم طلبات.`,
      }];
    }
    if (intent === 'DRIVER_ACCEPT') {
      return [{
        chatId: msg.chatId,
        text: `👨‍✈️ @${msg.senderPhone} لازم تنسجل أولاً — اكلم المهندس يسجلك بالنظام.`,
      }];
    }
    return [];
  }
  if (intent !== 'DRIVER_ACCEPT' && intent !== 'DRIVER_DECLINE') return [];

  // «قبلت 12» — قبول برقم محدد، أو «قبلت» لأحدث طلب منشور
  const norm = normalizeArabic(msg.text);
  const idMatch = norm.match(/قبلت\s*(#?)(\d{1,6})/);
  let open: Ride | null = null;
  if (idMatch) {
    open = await repo.getRideById(env.DB, Number(idMatch[2]));
    if (!open || open.status !== 'DISPATCHING') {
      return [{ chatId: msg.chatId, text: `الطلب ${idMatch[2]} إما انمسح أو اناخد من قبل 🙏` }];
    }
  } else {
    open = await repo.getOpenRideForGroup(env.DB, msg.chatId);
    if (!open) return [{ chatId: msg.chatId, text: 'ما في طلب مفتوح هلق 👍' }];
  }

  if (intent === 'DRIVER_DECLINE') return []; // صامت — ما داعي زحمة بالمجموعة

  assertTransition(open.status, 'ASSIGNED');
  await repo.updateRideStatus(env.DB, open.id, 'ASSIGNED', { driver_id: driver.id });
  await repo.setDriverStatus(env.DB, driver.id, 'BUSY');

  const out: OutboundMessage[] = [
    {
      chatId: msg.chatId,
      text: `✅ الطلب ${open.id} صار لأبو ${driver.name} — الباقي بلكي على الجاي 🙏`,
    },
    {
      chatId: `${open.client_phone}@s.whatsapp.net`,
      text: `🚕 جاك السائق!
👨‍✈️ الاسم: ${driver.name}
🚗 السيارة: ${driver.car}
🔢 اللوحة: ${driver.plate}
📞 تلفونه: +${driver.phone}`,
    },
  ];
  return out;
}

async function handleDriverPrivate(
  env: Env,
  msg: InboundMessage,
  driver: Driver,
  intent: ReturnType<typeof parseMessage>['intent']
): Promise<OutboundMessage[]> {
  switch (intent) {
    case 'DRIVER_AVAILABLE':
      await repo.setDriverStatus(env.DB, driver.id, 'AVAILABLE');
      return [{ chatId: msg.chatId, text: '✅ انضفت متاح — رح توصلك الطلبات القريبة.' }];
    case 'DRIVER_BUSY':
      await repo.setDriverStatus(env.DB, driver.id, 'BUSY');
      return [{ chatId: msg.chatId, text: '👌 سجّلناك مشغول.' }];
    case 'DRIVER_ARRIVED': {
      const ride = await repo.getActiveAssignedRide(env.DB, driver.id);
      if (!ride) return [{ chatId: msg.chatId, text: 'ما في طلب شغال باسمك هلق.' }];
      assertTransition(ride.status, 'ARRIVED');
      await repo.updateRideStatus(env.DB, ride.id, 'ARRIVED');
      await repo.notifyClient(env.DB, ride.id, '📍 السائق وصل — كانك خلاص!');
      return [{ chatId: msg.chatId, text: `📍 سجلنا وصولك للطلب ${ride.id}.` }];
    }
    case 'DRIVER_START': {
      const ride = await repo.getActiveAssignedRide(env.DB, driver.id);
      if (!ride || ride.status !== 'ARRIVED') return [{ chatId: msg.chatId, text: 'لازم تكون واصل للزبون أولاً.' }];
      assertTransition(ride.status, 'IN_RIDE');
      await repo.updateRideStatus(env.DB, ride.id, 'IN_RIDE');
      return [{ chatId: msg.chatId, text: `🛣️ مشوار موفق — الطلب ${ride.id} جاري.` }];
    }
    case 'DRIVER_DONE': {
      const ride = await repo.getActiveAssignedRide(env.DB, driver.id);
      if (!ride || ride.status !== 'IN_RIDE') return [{ chatId: msg.chatId, text: 'ما في مشوار جاري باسمك.' }];
      assertTransition(ride.status, 'DONE');
      await repo.updateRideStatus(env.DB, ride.id, 'DONE');
      await repo.setDriverStatus(env.DB, driver.id, 'AVAILABLE');
      await repo.notifyClient(env.DB, ride.id, `🏁 وصلت بالسلامة! الأجرة ${formatSYP(ride.price ?? 0)} — تقييمك يهمنا 🙏`);
      const commission = ride.price ? Math.round((ride.price * driver.commission_pct) / 100) : 0;
      return [{
        chatId: msg.chatId,
        text: `✅ تمام! الطلب ${ride.id} انقفل.
💰 الأجرة: ${formatSYP(ride.price ?? 0)}
🧾 عمولتك (${driver.commission_pct}%): ${formatSYP(commission)}`,
      }];
    }
    case 'MY_RIDES': {
      const rides = await repo.getDriverTodayRides(env.DB, driver.id);
      if (!rides.length) return [{ chatId: msg.chatId, text: 'لسا ما مشيت مشوار اليوم.' }];
      const done = rides.filter((r) => r.status === 'DONE');
      const cash = done.reduce((s, r) => s + (r.price ?? 0), 0);
      const lines = rides.map((r) => `#${r.id} ${r.status}${r.price ? ` — ${formatSYP(r.price)}` : ''}`);
      return [{
        chatId: msg.chatId,
        text: `📋 طلعاتك اليوم (${rides.length}):
${lines.join('\n')}
✅ منفذة: ${done.length} — 💰 الكاش: ${formatSYP(cash)}`,
      }];
    }
    default:
      return [{
        chatId: msg.chatId,
        text: `👨‍✈️ أهلا ${driver.name}!
أوامرك:
• «متاح» / «مشغول»
• «طلعاتي» — سجل اليوم
• وقت الطلب: «وصلت» / «بديت» / «خلصت»`,
      }];
  }
}
