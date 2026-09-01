/**
 * التسعير — التعرفة اليدوية تفوق دائماً، وبعدها صيغة الأحزمة.
 * Pricing: manual fixed fares always win, then belt formula.
 */

import type { Zone, FixedFare } from './types.js';

export const BELT_BASE: Record<number, number> = {
  1: 10000,   // داخل المدينة — 10 آلاف ل.س (أساس 2025)
  2: 30000,   // ضواحي
  3: 80000,   // ريف
};

/** نفس الحزام = سعر الحزام. أحزمة مختلفة = سعر الأعلى + 50% أجرة حزام لكل حزام فرق */
export function beltPrice(from: Zone, to: Zone): number {
  if (from.belt === to.belt) return BELT_BASE[from.belt] ?? 0;
  const hi = Math.max(from.belt, to.belt);
  const lo = Math.min(from.belt, to.belt);
  const diff = hi - lo;
  return (BELT_BASE[hi] ?? 0) + Math.round(diff * 0.5 * (BELT_BASE[1] ?? 0));
}

export interface FareResult {
  price: number;
  source: 'FIXED' | 'BELT' | 'NONE';
  note: string;
}

/**
 * حساب الأجرة: التعرفة اليدوية (من/الى) تفوق أي حساب.
 * ملاحظة: المنطقة الواحدة قد يكون لها أكثر من تعرفة يدوية — نأخذ المتوسط؟ لا،
 * الأدق: نأخذ الأولى المسجلة (الأحدث) — الأدمن يتحكم بالجدول.
 */
export function computeFare(
  from: Zone | null,
  to: Zone | null,
  fixedFares: FixedFare[],
  sameZoneFallback = true
): FareResult {
  if (!from || !to) return { price: 0, source: 'NONE', note: 'ما قدرنا نحدد المشوار — احكينا وين بدك تروح؟' };

  // 1) تعرفة يدوية؟ (بالاتجاهين)
  const fixed =
    fixedFares.find((f) => f.from_zone_id === from.id && f.to_zone_id === to.id) ??
    fixedFares.find((f) => f.from_zone_id === to.id && f.to_zone_id === from.id);

  if (fixed) {
    return { price: fixed.price, source: 'FIXED', note: 'حسب التعرفة المعتمدة' };
  }

  // 2) نفس المنطقة = سعر الحزام
  if (from.id === to.id && sameZoneFallback) {
    return { price: BELT_BASE[from.belt] ?? 0, source: 'BELT', note: 'مشوار داخلي' };
  }

  // 3) صيغة الأحزمة
  const p = beltPrice(from, to);
  return { price: p, source: 'BELT', note: 'حسب الأحزمة' };
}

/** تنسيق المبالغ بالصيغة السورية المقروءة */
export function formatSYP(price: number): string {
  if (price >= 1000000) return `${(price / 1000000).toFixed(1)} مليون ل.س`;
  if (price >= 1000) return `${(price / 1000).toFixed(0)} ألف ل.س`;
  return `${price} ل.س`;
}
