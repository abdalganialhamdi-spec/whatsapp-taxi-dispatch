/**
 * طبقة الذكاء الاصطناعي الاختيارية — فوق NLU القواعدي
 * تعمل فقط عند توفر AI_API_KEY (z.ai بروتوكول Anthropic Messages).
 * إذا ما في مفتاح → نرجع null والقواعدي هو المسؤول.
 */

import { normalizeArabic } from './nlu.js';
import type { Env, Zone } from './types.js';

export interface AiIntent {
  intent: string;      // نفس أسماء نوايا NLU
  from?: string;       // اسم منطقة من (نص حر)
  to?: string;         // اسم منطقة إلى
  reply?: string;      // رد حر (للدردشة غير المفهومة) — اختياري
}

const SYSTEM_PROMPT = `أنت محلل رسائل لهجة حماة السورية لحجز تاكسي. حوّل رسالة المستخدم إلى JSON فقط بلا أي شرح أو علامات markdown.
المخطط: {"intent":"BOOK|PRICE_QUERY|CONFIRM|CANCEL|MY_RIDES|TALK_HUMAN|UNKNOWN","from":"اسم المنطقة بحماة أو null","to":"اسم المنطقة بحماة أو null"}
أمثلة:
- «منبي ع الدبله روح ع راس العين» → {"intent":"BOOK","from":"الدبله","to":"راس العين"}
- «من طريق حلب لعند المخيم» → {"intent":"BOOK","from":"طريق حلب","to":"المخيم"}
- «شحال من الصابونية لجنوب الثكنة» → {"intent":"PRICE_QUERY","from":"الصابونية","to":"جنوب الثكنة"}
- «يعله ابعت» → {"intent":"CONFIRM","from":null,"to":null}
- «الكي» → {"intent":"CANCEL","from":null,"to":null}
- «رحلاتي» → {"intent":"MY_RIDES","from":null,"to":null}
- «بدي المهندس» → {"intent":"TALK_HUMAN","from":null,"to":null}
كل الأسماء أحياء ومناطق حماة سوريا — لا تفسرها كمدن أخرى أبداً (مثلاً «منبي» حي بحماة مش Dubai).`;


/** استعلام AI — يرجع null إذا غير مفعّل أو فشل */
export async function aiParse(env: Env, text: string, zones: Zone[]): Promise<AiIntent | null> {
  if (!env.AI_API_KEY || !env.AI_BASE_URL) return null;

  const zoneList = zones.map((z) => z.name).join('، ');
  const body = {
    model: env.AI_MODEL ?? 'glm-4.6',
    max_tokens: 300,
    thinking: { type: 'disabled' }, // GLM thinking blocks بتاكل الـ tokens وما بترجع JSON
    system: SYSTEM_PROMPT + `\nأسماء المناطق المتاحة حالياً: ${zoneList}`,
    messages: [{ role: 'user', content: text }],
  };

  try {
    const res = await fetch(`${env.AI_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.AI_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    // GLM يرجع thinking blocks قبل الرد — ناخد آخر text block (النهائي)
    const blocks = (data.content ?? []).filter((c) => c.type === 'text');
    const raw = blocks.map((b) => b.text ?? '').join('\n');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as AiIntent;
    if (!parsed.intent) return null;
    return parsed;
  } catch {
    return null; // أي فشل → نرجع للقواعدي
  }
}

/** مطابقة اسم منطقة من نص الـ AI (أدق من القواعدي لأن الأسماء مفحوصة) */
export function matchZoneByName(name: string | undefined, zones: Zone[]): Zone | null {
  if (!name) return null;
  const norm = normalizeArabic(name);
  let best: Zone | null = null;
  let bestLen = 0;
  for (const z of zones) {
    const candidates = [z.name, ...(z.aliases ?? [])];
    for (const c of candidates) {
      const cn = normalizeArabic(c);
      if (norm.includes(cn) || cn.includes(norm)) {
        if (cn.length > bestLen) { best = z; bestLen = cn.length; }
      }
    }
  }
  return best;
}
