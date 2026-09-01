/**
 * NLU قواعدي عامي — يفهم لهجة حماة/الساحل السوري بدون أي مزوّد AI.
 * استخراج: النية (intent) + من/إلى + منطقة أقرب مطابقة.
 *
 * الفلسفة: القواعدي أولاً دائماً (يعمل بلا إنترنت ولا كلفة)،
 * وطبقة AI اختيارية فوقه لما يكون مزود مفعّل (شوف ai.ts).
 */

import type { Zone } from './types.js';

export interface ParsedMessage {
  intent:
    | 'BOOK'          // بدي روح / في طلب / مشتري
    | 'PRICE_QUERY'   // كم من / شحل الرحلة
    | 'CONFIRM'       // ايوة / تمام / أوك
    | 'CANCEL'        // الكي / بدي اكمل الرحلة
    | 'MY_RIDES'      // رحلاتي / وين السائق
    | 'TALK_HUMAN'    // بدي حكي مهندس / موظف
    | 'DRIVER_AVAILABLE' // متاح
    | 'DRIVER_BUSY'      // مشغول
    | 'DRIVER_ACCEPT'    // قبلت / موافق
    | 'DRIVER_DECLINE'   // مش فاضي / لا
    | 'DRIVER_ARRIVED'   // وصلت
    | 'DRIVER_START'     // مشي / بديت
    | 'DRIVER_DONE'      // خلصت / استلمت
    | 'HELP' | 'UNKNOWN';
  from_zone: Zone | null;
  to_zone: Zone | null;
  raw: string;
}

// تطبيع النص العربي: همزات، تاء مربوطة، ألف مقصورة، تشكيل، تطويل
export function normalizeArabic(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0670]/g, '')   // تشكيل
    .replace(/\u0640/g, '')                    // ـ تطويل
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ىی]/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// نوايا الزبون — أنماط عامية (normalized)
const BOOK_PATTERNS = [
  'بدي روح', 'بدك توديني', 'بدي سياره', 'بدي تاكسي', 'في حد يروح',
  'بدناه نسافر', 'بدي مشوار', 'ابعتلي سياره', 'بدي وين', 'من عندي مشوار',
  'لازم روح', 'بدي امشي', 'شوفي عندها سياره', 'في سياره', 'طلب',
  'وريني طلب', 'بدي توصلني', 'خدني ع', 'وديني ع', 'بدي اروح',
];

const PRICE_PATTERNS = ['كم من', 'شحال من', 'قديش من', 'كم الى', 'شحال الى', 'قديش الى', 'كم ع', 'شحال ع', 'قديش ع', 'التعرفه', 'التعرفة'];

const CONFIRM_PATTERNS = ['ايوه', 'اها', 'تمام', 'اوك', 'اوكي', 'يعله', 'اه', 'نعم', 'ولا يهمك', 'ابعت', 'منطوقه', 'طيب'];

const CANCEL_PATTERNS = ['اك', 'الكي', 'الغاء', 'بدي اك', 'لغيت', 'ما بدي', 'خليها', 'بطل', 'استني مو'];

const MY_RIDES_PATTERNS = ['رحلاتي', 'طلعاتي', 'وين السائق', 'وين السواق', 'فين السائق', 'مين رح ياخدني', 'وضع طلبي'];

const HUMAN_PATTERNS = ['المهندس', 'بدي موظف', 'بدي احكي', 'بدي اهتم', 'مدير', 'شكوى', 'مشكله عندي', 'بدي حكي مع'];

// نوايا السائق
const DRIVER_AVAILABLE = ['متاح', 'صاير فاضي', 'فاضي هلق', 'جاهز', 'بحط نفسي متاح', 'على الخط'];
const DRIVER_BUSY = ['مشغول', 'مش فاضي', 'واقف', 'خلصت شيفرتي', 'سكرت', 'مشدود'];
const DRIVER_ACCEPT = ['قبلت', 'موافق', 'على راسي', 'اخدتها', 'هاك', 'انا جاي', 'جاك', 'بيليتها'];
const DRIVER_DECLINE = ['مش فاضي', 'منشغله', 'لا', 'معك وحده', 'خلي ع غيري', 'ما بقدر'];
const DRIVER_ARRIVED = ['وصلت', 'صرت ع', 'صرت قدام', 'واصل'];
const DRIVER_START = ['بديت', 'مشي حالك', 'انطلقنا', 'عالطريق', 'رايحين'];
const DRIVER_DONE = ['خلصت', 'انتهت', 'استلمت', 'الكا في', 'تم الدفع', 'وصلنا', 'استوفيت'];

function matchesAny(norm: string, patterns: string[]): boolean {
  return patterns.some((p) => norm.includes(p));
}

/** استخراج "من X ل/ع/الى Y" — يدعم: بدي روح من طريق حلب لعند المخيم */
function extractFromTo(norm: string, zones: Zone[]): { from: Zone | null; to: Zone | null } {
  const SEP = /(من)\s+(.+?)\s+(?:ل\s?ع?ند?\s*|ل\s*|الى\s+|ع\s+|على\s+|حتى\s+)/;
  let from: Zone | null = null;
  let to: Zone | null = null;

  const m = norm.match(SEP);
  if (m) {
    from = matchZone(m[2], zones);
    to = matchZone(norm.slice((m.index ?? 0) + m[0].length), zones);
  }
  if (!from || !to) {
    // fallback: كل المناطق المذكورة بالترتيب — الأولى "من" والثانية "الى"
    const found: Zone[] = [];
    for (const z of zones) {
      if (matchesZone(norm, z)) found.push(z);
    }
    if (found.length >= 2) {
      if (!from) from = found[0];
      if (!to) to = found[found.length - 1];
    } else if (found.length === 1) {
      if (!to) to = found[0];
    }
  }
  return { from, to };
}

function matchesZone(norm: string, z: Zone): boolean {
  const candidates = [z.name, ...(z.aliases ?? [])];
  return candidates.some((c) => norm.includes(normalizeArabic(c)));
}

export function matchZone(text: string, zones: Zone[]): Zone | null {
  const norm = normalizeArabic(text);
  // أطول اسم أولاً (الأدق) — "جنوب الثكنة" قبل "الثكنة"
  const sorted = [...zones].sort(
    (a, b) => normalizeArabic(b.name).length - normalizeArabic(a.name).length
  );
  for (const z of sorted) {
    if (matchesZone(norm, z)) return z;
  }
  return null;
}

export function parseMessage(raw: string, zones: Zone[], isDriver: boolean): ParsedMessage {
  const norm = normalizeArabic(raw);
  const { from, to } = extractFromTo(norm, zones);

  // نوايا السائق (سائق فقط)
  if (isDriver) {
    if (matchesAny(norm, DRIVER_AVAILABLE)) return { intent: 'DRIVER_AVAILABLE', from_zone: from, to_zone: to, raw };
    if (matchesAny(norm, DRIVER_BUSY)) return { intent: 'DRIVER_BUSY', from_zone: from, to_zone: to, raw };
    if (matchesAny(norm, DRIVER_DECLINE)) return { intent: 'DRIVER_DECLINE', from_zone: from, to_zone: to, raw };
    if (matchesAny(norm, DRIVER_ACCEPT)) return { intent: 'DRIVER_ACCEPT', from_zone: from, to_zone: to, raw };
    if (matchesAny(norm, DRIVER_ARRIVED)) return { intent: 'DRIVER_ARRIVED', from_zone: from, to_zone: to, raw };
    if (matchesAny(norm, DRIVER_START)) return { intent: 'DRIVER_START', from_zone: from, to_zone: to, raw };
    if (matchesAny(norm, DRIVER_DONE)) return { intent: 'DRIVER_DONE', from_zone: from, to_zone: to, raw };
  }

  // الزبون
  if (matchesAny(norm, HUMAN_PATTERNS)) return { intent: 'TALK_HUMAN', from_zone: from, to_zone: to, raw };
  if (matchesAny(norm, MY_RIDES_PATTERNS)) return { intent: 'MY_RIDES', from_zone: from, to_zone: to, raw };
  if (matchesAny(norm, CANCEL_PATTERNS)) return { intent: 'CANCEL', from_zone: from, to_zone: to, raw };
  if (matchesAny(norm, CONFIRM_PATTERNS) && !matchesAny(norm, BOOK_PATTERNS)) return { intent: 'CONFIRM', from_zone: from, to_zone: to, raw };
  if (matchesAny(norm, PRICE_PATTERNS)) return { intent: 'PRICE_QUERY', from_zone: from, to_zone: to, raw };
  if (matchesAny(norm, BOOK_PATTERNS)) return { intent: 'BOOK', from_zone: from, to_zone: to, raw };

  // "من X لعند Y" بدون فعل = حجز ضمني
  if (from && to) return { intent: 'BOOK', from_zone: from, to_zone: to, raw };

  return { intent: 'UNKNOWN', from_zone: null, to_zone: null, raw };
}
