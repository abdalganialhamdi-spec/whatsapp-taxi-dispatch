/**
 * تحويل رسالة صوتية (ogg/opus) إلى نص عبر GLM-ASR — طبقة فوق messages.upsert.
 * WhatsApp الصوتية = ogg/opus. GLM-ASR-2512: ≤25MB و ≤30 ثانية (مثالي للرسايل الصوتية).
 * أي فشل → null والرسالة تُتجاهل بصمت (الزبون يعيد أو يكتب).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ASR_URL = 'https://api.z.ai/api/paas/v4/audio/transcriptions';
const ASR_MODEL = 'glm-asr-2512';

/**
 * @param {object} opts
 * @param {Buffer} opts.buffer  بيانات الملف الصوتي
 * @param {string} opts.mimetype mimetype من Baileys (audio/ogg; codecs=opus ...)
 * @param {string} opts.apiKey  مفتاح Z.AI
 * @returns {Promise<string|null>} النص أو null
 */
export async function transcribeVoice({ buffer, mimetype, apiKey }) {
  if (!apiKey || !buffer || buffer.length === 0) return null;
  if (!/^audio\//.test(mimetype ?? '')) return null;
  if (buffer.length > 25 * 1024 * 1024) return null;

  const ext = (mimetype ?? '').includes('ogg') ? 'ogg'
    : (mimetype ?? '').includes('mpeg') ? 'mp3'
    : (mimetype ?? '').includes('wav') ? 'wav'
    : (mimetype ?? '').includes('mp4') || (mimetype ?? '').includes('m4a') ? 'm4a'
    : 'ogg';

  try {
    const form = new FormData();
    form.append('model', ASR_MODEL);
    form.append('stream', 'false');
    form.append('file', new Blob([buffer], { type: mimetype || 'audio/ogg' }), `voice.${ext}`);

    const res = await fetch(ASR_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = String(data?.text ?? '').trim();
    return text || null;
  } catch {
    return null;
  }
}
