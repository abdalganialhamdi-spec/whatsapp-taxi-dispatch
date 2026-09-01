/**
 * اختبارات التسعير وآلة الحالات
 */
import { describe, expect, it } from 'vitest';
import { beltPrice, computeFare, formatSYP } from '../src/pricing.js';
import { assertTransition, canTransition, IllegalTransition } from '../src/ride-state.js';
import type { FixedFare, Zone } from '../src/types.js';

const city: Zone = { id: 1, name: 'طريق حلب', aliases: [], belt: 1 };
const city2: Zone = { id: 2, name: 'المخيم', aliases: [], belt: 1 };
const suburb: Zone = { id: 12, name: 'محردة', aliases: [], belt: 2 };
const rural: Zone = { id: 20, name: 'الغاب', aliases: [], belt: 3 };

describe('beltPrice', () => {
  it('نفس الحزام 1 = 10 آلاف', () => {
    expect(beltPrice(city, city2)).toBe(10000);
  });
  it('حزام 1 → 2 = 30 ألف + 5 آلاف = 35 ألف', () => {
    expect(beltPrice(city, suburb)).toBe(35000);
  });
  it('حزام 1 → 3 = 80 ألف + 10 آلاف = 90 ألف', () => {
    expect(beltPrice(city, rural)).toBe(90000);
  });
});

describe('computeFare — اليدوية تفوق', () => {
  const fares: FixedFare[] = [
    { id: 1, from_zone_id: 1, to_zone_id: 2, price: 15000 },
    { id: 2, from_zone_id: 3, to_zone_id: 4, price: 50000 },
  ];

  it('تعرفة يدوية بالاتجاه المباشر', () => {
    const r = computeFare(city, city2, fares);
    expect(r.price).toBe(15000);
    expect(r.source).toBe('FIXED');
  });

  it('تعرفة يدوية بالاتجاه المعكوس (بالاتجاهين)', () => {
    const r = computeFare({ ...city2 }, { ...city }, fares);
    expect(r.price).toBe(15000);
    expect(r.source).toBe('FIXED');
  });

  it('بدون تعرفة يدوية → حزام', () => {
    const r = computeFare(city, suburb, fares);
    expect(r.price).toBe(35000);
    expect(r.source).toBe('BELT');
  });

  it('منطقة ناقصة → NONE برسالة ودودة', () => {
    const r = computeFare(city, null, fares);
    expect(r.source).toBe('NONE');
    expect(r.note).toContain('وين بدك');
  });
});

describe('formatSYP', () => {
  it('آلاف', () => {
    expect(formatSYP(15000)).toBe('15 ألف ل.س');
  });
  it('ملايين', () => {
    expect(formatSYP(1250000)).toBe('1.3 مليون ل.س');
  });
});

describe('آلة الحالات', () => {
  it('NEW → DISPATCHING مسموح', () => {
    expect(canTransition('NEW', 'DISPATCHING')).toBe(true);
  });
  it('NEW → ASSIGNED ممنوع (لا قفز فوق التأكيد)', () => {
    expect(canTransition('NEW', 'ASSIGNED')).toBe(false);
  });
  it('DONE نهائي', () => {
    expect(canTransition('DONE', 'CANCELLED')).toBe(false);
  });
  it('assertTransition يرمي خطأ', () => {
    expect(() => assertTransition('DISPATCHING', 'DONE')).toThrow(IllegalTransition);
  });
  it('المسار السعيد كامل', () => {
    const path = [
      ['NEW', 'DISPATCHING'],
      ['DISPATCHING', 'ASSIGNED'],
      ['ASSIGNED', 'ARRIVED'],
      ['ARRIVED', 'IN_RIDE'],
      ['IN_RIDE', 'DONE'],
    ] as const;
    for (const [a, b] of path) expect(canTransition(a, b)).toBe(true);
  });
});
