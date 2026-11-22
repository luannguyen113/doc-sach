// Podcast Spotify: lấy thông tin một tập từ link.
// 1) oEmbed công khai của Spotify (nhanh, không cần key): tên tập + ảnh bìa.
// 2) Gemini đọc trang tập (công cụ url_context, dùng key đã có trong Cài đặt): tên chương trình + số phút.
import { gem, pickGeminiModels, markDead } from './paper.js';

export async function spotifyOembed(url, signal) {
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { signal });
  if (!res.ok) throw new Error(`Spotify lỗi ${res.status}`);
  const j = await res.json();
  return { title: j.title || '', cover: j.thumbnail_url || '' };
}

const PROMPT = (url, title) => [
  `Mở trang tập podcast Spotify này: ${url}`,
  title ? `(Tên tập: "${title}")` : '',
  'Chỉ trả về đúng một đối tượng JSON, không kèm chữ nào khác, dạng:',
  '{"show": "tên chương trình podcast", "title": "tên tập", "minutes": số phút làm tròn (số nguyên)}',
  'Tên chương trình và tên tập giữ nguyên văn như trên trang. Không chắc trường nào thì để null. Không đoán.',
].filter(Boolean).join('\n');

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function askModel(model, key, url, title, signal) {
  const send = (thinking) => gem(`models/${model}:generateContent`, key, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT(url, title) }] }],
      tools: [{ url_context: {} }],
      generationConfig: { temperature: 0, ...(thinking ? { thinkingConfig: thinking } : {}) },
    }),
  });
  let res = await send(/^gemini-2\./.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' });
  if (res.status === 400) {
    const t = await res.text();
    if (/thinking/i.test(t)) res = await send(null);
    else throw Object.assign(new Error(`${model}: ${t.slice(0, 120)}`), { status: 400 });
  }
  if (res.status === 404) await markDead(model);
  if (!res.ok) throw Object.assign(new Error(`${model} lỗi ${res.status}`), { status: res.status });
  const j = await res.json();
  const out = parseJson((j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''));
  if (!out || (!out.show && !out.minutes)) throw new Error(`${model} không đọc được trang`);
  const minutes = Math.round(Number(out.minutes));
  return {
    show: typeof out.show === 'string' ? out.show.trim() : '',
    title: typeof out.title === 'string' ? out.title.trim() : '',
    minutes: minutes > 0 && minutes < 1000 ? minutes : null,
  };
}

// Thử lần lượt tối đa 3 model, mỗi model tối đa 25 giây. Lỗi hết thì báo lý do từng model.
export async function readPodcastPage(key, url, title, outerSignal) {
  const models = (await pickGeminiModels(key)).slice(0, 3);
  const errs = [];
  for (const model of models) {
    if (outerSignal?.aborted) break;
    const ctrl = new AbortController();
    const onOuter = () => ctrl.abort();
    outerSignal?.addEventListener('abort', onOuter);
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      return await askModel(model, key, url, title, ctrl.signal);
    } catch (e) {
      errs.push(e.name === 'AbortError' ? `${model}: quá 25s` : e.message);
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuter);
    }
  }
  throw new Error(errs.join(' · ') || 'Không đọc được trang Spotify');
}
