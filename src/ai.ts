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

// سطر سياق من سجل الرسائل — «دور» + «النص»
function historyLine(m: { direction: string; sender_phone: string; text: string }): string {
  const who = m.direction === 'out' ? 'البوت' : (m.sender_phone === 'BOT' ? 'البوت' : 'الزبون');
  return `${who}: ${m.text.slice(0, 200)}`;
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
export async function aiParse(
  env: Env, text: string, zones: Zone[],
  history: Array<{ direction: string; sender_phone: string; text: string }> = [],
  routine?: string
): Promise<AiIntent | null> {
  if (!env.AI_API_KEY || !env.AI_BASE_URL) return null;

  const zoneList = zones.map((z) => z.name).join('، ');
  const historyBlock = history.length
    ? `\nمحادثة سابقة بنفس الجلسة (الأقدم أولاً) — استعملها لفهم النص المقطوع أو المجيب على سؤالك السابق:\n${history.map(historyLine).join('\n')}`
    : '';
  const routineBlock = routine
    ? `\nروتين الزبون المعروف (من مشاويره السابقة):\n${routine}\nإذا رسالته غامضة/مقطوعة، استنتج نيتها من روتينه بحسب اليوم والساعة الحاليين، واستعمل من/إلى الروتين الأنسب. إذا اليوم شاذ عن عادته (مثلاً الجمعة وهو دايماً يطلع أيام الدوام)، رجّع UNKNOWN عشان نسأله بدل ما نخمّن غلط.`
    : '';
  const body = {
    model: env.AI_MODEL ?? 'glm-5.3-flash',
    max_tokens: 300,
    thinking: { type: 'disabled' }, // GLM thinking blocks بتاكل الـ tokens وما بترجع JSON
    system: SYSTEM_PROMPT + `\nأسماء المناطق المتاحة حالياً: ${zoneList}${historyBlock}${routineBlock}`,
    messages: [{ role: 'user', content: text }],
  };

  // محاولة واحدة + إعادة محاولة واحدة عند الفشل — مهلة Z.AI متقلبة (2-7s مرصودة)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${env.AI_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.AI_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        if (attempt === 0) continue;
        return null;
      }
      const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      // GLM يرجع thinking blocks قبل الرد — ناخد آخر text block (النهائي)
      const blocks = (data.content ?? []).filter((c) => c.type === 'text');
      const raw = blocks.map((b) => b.text ?? '').join('\n');
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) {
        if (attempt === 0) continue;
        return null;
      }
      const parsed = JSON.parse(m[0]) as AiIntent;
      if (!parsed.intent) {
        if (attempt === 0) continue;
        return null;
      }
      return parsed;
    } catch {
      if (attempt === 0) continue; // مهلة أو شبكة — محاولة ثانية قبل الاستسلام
      return null; // أي فشل → نرجع للقواعدي
    }
  }
  return null;
}

/** محادثة AI حرة (رد على عميل / تلخيص محادثة) — ترجع النص أو null */
export async function aiChat(
  env: Env, system: string, user: string, maxTokens = 500,
  history: Array<{ direction: string; sender_phone: string; text: string }> = []
): Promise<string | null> {
  if (!env.AI_API_KEY || !env.AI_BASE_URL) return null;
  try {
    // آخر 6 رسايل (قبل الحالية) كدور محادثة حقيقي — AI بيرد وكأنه صاحب المحادثة
    const convo = history.slice(-6).map((m) => ({
      role: (m.direction === 'out' || m.sender_phone === 'BOT') ? 'assistant' : 'user',
      content: m.text.slice(0, 300),
    }));
    const res = await fetch(`${env.AI_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.AI_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.AI_MODEL ?? 'glm-5.3-flash',
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        system,
        messages: [...convo, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (data.content ?? []).filter((c) => c.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    return text || null;
  } catch {
    return null;
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
