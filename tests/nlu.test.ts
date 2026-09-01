/**
 * اختبارات NLU — لهجة عامية فعلية
 */
import { describe, expect, it } from 'vitest';
import { matchZone, normalizeArabic, parseMessage } from '../src/nlu.js';
import type { Zone } from '../src/types.js';

const zones: Zone[] = [
  { id: 1, name: 'طريق حلب', aliases: ['شارع حلب', 'دوار حلب'], belt: 1 },
  { id: 2, name: 'المخيم', aliases: ['عند المخيم'], belt: 1 },
  { id: 3, name: 'الصابونية', aliases: [], belt: 1 },
  { id: 4, name: 'جنوب الثكنة', aliases: ['الثكنة'], belt: 1 },
  { id: 5, name: 'القمقومية', aliases: ['القلعة'], belt: 1 },
  { id: 12, name: 'محردة', aliases: ['محرده'], belt: 2 },
];

describe('normalizeArabic', () => {
  it('يوحّد الهمزات والتاء المربوطة', () => {
    expect(normalizeArabic('بدي أروح عَ المدرسةِ')).toBe('بدي اروح ع المدرسه');
  });
});

describe('matchZone', () => {
  it('يطابق الاسم الأساسي', () => {
    expect(matchZone('من طريق حلب', zones)?.id).toBe(1);
  });
  it('يطابق الاسم البديل', () => {
    expect(matchZone('عند المخيم', zones)?.id).toBe(2);
  });
  it('الأطول أولاً: جنوب الثكنة لا يلتقطها الثكنة فقط', () => {
    expect(matchZone('جنوب الثكنة', zones)?.id).toBe(4);
  });
});

describe('parseMessage — الزبون', () => {
  it('بدي روح من X لعند Y → BOOK مع من وإلى', () => {
    const p = parseMessage('بدي روح من طريق حلب لعند المخيم', zones, false);
    expect(p.intent).toBe('BOOK');
    expect(p.from_zone?.id).toBe(1);
    expect(p.to_zone?.id).toBe(2);
  });

  it('«من الصابونية لجنوب الثكنة» بدون فعل → BOOK ضمني', () => {
    const p = parseMessage('من الصابونية لجنوب الثكنة', zones, false);
    expect(p.intent).toBe('BOOK');
    expect(p.from_zone?.id).toBe(3);
    expect(p.to_zone?.id).toBe(4);
  });

  it('كم من X الى Y → PRICE_QUERY', () => {
    const p = parseMessage('شحال من الصابونية الى جنوب الثكنة', zones, false);
    expect(p.intent).toBe('PRICE_QUERY');
    expect(p.from_zone?.id).toBe(3);
    expect(p.to_zone?.id).toBe(4);
  });

  it('تأكيد عامي', () => {
    expect(parseMessage('يعله ابعت', zones, false).intent).toBe('CONFIRM');
    expect(parseMessage('ايوه تمام', zones, false).intent).toBe('CONFIRM');
  });

  it('إلغاء', () => {
    expect(parseMessage('لأ خلاص الكي الطلب', zones, false).intent).toBe('CANCEL');
  });

  it('رحلاتي', () => {
    expect(parseMessage('وين رحلاتي؟', zones, false).intent).toBe('MY_RIDES');
  });

  it('تدخل بشري — المهندس', () => {
    expect(parseMessage('بدي احكي المهندس ضروري', zones, false).intent).toBe('TALK_HUMAN');
  });

  it('غير مفهوم → UNKNOWN', () => {
    expect(parseMessage('شو أخبارك', zones, false).intent).toBe('UNKNOWN');
  });
});

describe('parseMessage — السائق', () => {
  it('متاح', () => {
    expect(parseMessage('صاير فاضي هلق', zones, true).intent).toBe('DRIVER_AVAILABLE');
  });
  it('قبول', () => {
    expect(parseMessage('قبلت هاك', zones, true).intent).toBe('DRIVER_ACCEPT');
  });
  it('رفض', () => {
    expect(parseMessage('معك وحده منشغله', zones, true).intent).toBe('DRIVER_DECLINE');
  });
  it('وصلت', () => {
    expect(parseMessage('وصلت قدام البيت', zones, true).intent).toBe('DRIVER_ARRIVED');
  });
  it('خلصت', () => {
    expect(parseMessage('خلصت واستلمت الكاش', zones, true).intent).toBe('DRIVER_DONE');
  });
});
