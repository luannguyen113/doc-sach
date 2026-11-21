// Sách giấy: hồ sơ sách, đọc ảnh bìa (Gemini qua Apps Script), ảnh bìa lưu trong thư mục ẩn của Drive.
// Lần đọc được lưu như phiên đọc (sessions, kind: 'paper').
// Lưu ở kv 'paper' (map id -> sách); xoá = đánh dấu deleted để máy khác xoá theo khi đồng bộ.
import { db } from './db.js';
import { scheduleSync } from './sync.js';
import { uploadAppDataFile, downloadFileBlob } from './drive.js';

export async function loadPaper() {
  return (await db.get('kv', 'paper')) || {};
}

export async function savePaperBook(rec) {
  const map = await loadPaper();
  map[rec.id] = { ...rec, updatedAt: Date.now() };
  await db.set('kv', 'paper', map);
  scheduleSync(5000);
  return map[rec.id];
}

export async function deletePaperBook(id) {
  const map = await loadPaper();
  const before = map[id] ? { ...map[id] } : null;
  map[id] = { id, deleted: true, updatedAt: Date.now() };
  await db.set('kv', 'paper', map);
  scheduleSync(5000);
  return before;
}

export const activePaper = (map) => Object.values(map || {}).filter((b) => !b.deleted);

export function newPaperId() {
  return `p:${crypto.randomUUID()}`;
}

export function paperTitle(b) {
  return b.series && b.volume ? `${b.series} · Tập ${b.volume}` : b.title;
}

// ---------- Ảnh ----------
// Thu nhỏ ảnh về cạnh dài tối đa `max` px, xuất JPEG.
export async function shrinkImage(file, max, quality = 0.85) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// ---------- Đọc ảnh bìa bằng Gemini (gọi thẳng từ app) ----------
// Key do chủ app dán vào Cài đặt: lưu trên máy + đồng bộ qua thư mục ẩn trên Drive, không nằm trong mã nguồn.
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const PER_MODEL_TIMEOUT = 20_000;

const PROMPT = [
  'Đây là ảnh chụp bìa trước một cuốn sách hoặc một tập truyện tranh (thường là sách phát hành tại Việt Nam).',
  'Hãy đọc đúng chữ in trên bìa và trả về JSON với các trường:',
  '- title: tên sách đúng như in trên bìa, giữ nguyên dấu tiếng Việt, viết hoa như bình thường (không viết hoa toàn bộ). Với truyện tranh nhiều tập: tên bộ truyện, KHÔNG kèm số tập.',
  '- series: tên bộ nếu là truyện/sách nhiều tập, ngược lại null.',
  '- volume: số tập (số nguyên) nếu bìa có ghi, ngược lại null.',
  '- author: tác giả (viết hoa chữ cái đầu, ví dụ "Kurt Vonnegut").',
  '- translator: người dịch nếu bìa ghi "... dịch", ngược lại null.',
  '- publisher: nhà xuất bản / đơn vị phát hành in trên bìa (nối bằng " · " nếu có nhiều), ngược lại null.',
  'Không đoán thông tin không có trên ảnh: thiếu thì để null.',
].join('\n');

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', nullable: true },
    series: { type: 'STRING', nullable: true },
    volume: { type: 'INTEGER', nullable: true },
    author: { type: 'STRING', nullable: true },
    translator: { type: 'STRING', nullable: true },
    publisher: { type: 'STRING', nullable: true },
  },
};

async function gem(path, key, opts = {}) {
  return fetch(`${GEMINI}/${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`, opts);
}

// Danh sách model ứng viên (bản flash ổn định, mới trước; xen kẽ flash và flash-lite). Lưu 1 ngày.
// Model nào báo 404 (Google đã ngừng cấp) thì ghi lại và bỏ qua trong 7 ngày.
export async function pickGeminiModels(key, { force = false } = {}) {
  const dead = (await db.get('kv', 'geminiDead')) || {};
  const alive = (list) => list.filter((m) => !(dead[m] && Date.now() - dead[m] < 7 * 864e5));
  const cached = await db.get('kv', 'geminiModels');
  if (!force && cached && cached.key === key.slice(-6) && Date.now() - cached.at < 864e5) return alive(cached.models);
  const res = await gem('models?pageSize=200', key);
  if (res.status === 400 || res.status === 403) throw new Error('Gemini API key không hợp lệ hoặc chưa được phép dùng từ app này');
  if (!res.ok) throw new Error(`Không lấy được danh sách model Gemini (lỗi ${res.status})`);
  const names = ((await res.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/(image|tts|audio|live|thinking|embedding)/.test(n));
  const ver = (n) => parseFloat(n.match(/^gemini-([\d.]+)/)[1]);
  const byVer = (a, b) => ver(b) - ver(a) || a.length - b.length;
  const stable = names.filter((n) => !/(preview|exp)/.test(n));
  const flash = stable.filter((n) => !/lite/.test(n)).sort(byVer);
  const lite = stable.filter((n) => /lite/.test(n)).sort(byVer);
  const order = [];
  for (let i = 0; i < Math.max(flash.length, lite.length); i += 1) {
    if (flash[i]) order.push(flash[i]);
    if (lite[i]) order.push(lite[i]);
  }
  order.push(...names.filter((n) => /(preview|exp)/.test(n)).sort(byVer));
  if (!order.length) throw new Error('Không tìm thấy model Gemini flash phù hợp');
  await db.set('kv', 'geminiModels', { key: key.slice(-6), at: Date.now(), models: order });
  return alive(order);
}

async function markDead(model) {
  const dead = (await db.get('kv', 'geminiDead')) || {};
  dead[model] = Date.now();
  await db.set('kv', 'geminiDead', dead);
}

async function askModel(model, key, b64, outerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_MODEL_TIMEOUT);
  const onOuter = () => ctrl.abort();
  outerSignal.addEventListener('abort', onOuter);
  const body = (thinking) => JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: PROMPT }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA, ...(thinking ? { thinkingConfig: thinking } : {}) },
  });
  const send = (thinking) => gem(`models/${model}:generateContent`, key, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(thinking), signal: ctrl.signal,
  });
  try {
    // Tắt "suy nghĩ" cho nhanh; model không nhận tham số này thì gửi lại không kèm.
    let res = await send(/^gemini-2\./.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' });
    if (res.status === 400) {
      const t = await res.text();
      if (/thinking/i.test(t)) res = await send(null);
      else throw Object.assign(new Error(`Gemini từ chối yêu cầu: ${t.slice(0, 200)}`), { status: 400 });
    }
    if (!res.ok) throw Object.assign(new Error(`${model} lỗi ${res.status}`), { status: res.status });
    const j = await res.json();
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new Error(`${model} không trả kết quả`);
    return { ...JSON.parse(text), _model: model };
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error(`${model} quá ${PER_MODEL_TIMEOUT / 1000} giây`), { status: 'timeout' });
    throw e;
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', onOuter);
  }
}

// Chạy song song tối đa 3 model; model nào lỗi thì lập tức thay bằng model kế tiếp; lấy kết quả đầu tiên.
const PARALLEL = 3;
const DEADLINE = 30_000;

export async function readCoverText(key, imageBlob) {
  if (!key) throw new Error('Chưa nhập Gemini API key (vào Cài đặt để nhập)');
  if (!navigator.onLine) throw new Error('Đang offline, chưa đọc được ảnh bìa');
  const models = await pickGeminiModels(key);
  if (!models.length) { await db.del('kv', 'geminiDead'); throw new Error('Không còn model Gemini nào dùng được, thử lại để app lấy danh sách mới.'); }
  const b64 = await toBase64(imageBlob);
  const all = new AbortController();
  const start = Date.now();
  const notes = [];
  try {
    return await new Promise((resolve, reject) => {
      let next = 0;
      let active = 0;
      let done = false;
      const finishFail = () => { if (!done && active === 0) { done = true; reject(notes); } };
      const launch = () => {
        while (!done && active < PARALLEL && next < models.length && Date.now() - start < DEADLINE) {
          const m = models[next++];
          active += 1;
          askModel(m, key, b64, all.signal).then((r) => {
            if (!done) { done = true; resolve(r); }
          }).catch(async (e) => {
            active -= 1;
            notes.push(`${m.replace('gemini-', '')}: ${e.status === 'timeout' ? 'quá 20s' : e.status || 'lỗi'}`);
            if (e.status === 404) await markDead(m);
            if (e.status === 400 || e.status === 403) { if (!done) { done = true; reject(e); } return; }
            launch();
            finishFail();
          });
        }
        finishFail();
      };
      launch();
    });
  } catch (err) {
    if (err instanceof Error) { await db.del('kv', 'geminiModels'); throw err; }
    const list = err.join(' · ');
    if (err.length && err.every((x) => /quá 20s|503|429/.test(x))) throw new Error(`Gemini đang quá tải (${list}). Thử lại sau hoặc nhập tay.`);
    throw new Error(`Không đọc được ảnh bìa (${list})`);
  } finally {
    all.abort();
  }
}

// Ảnh bìa: lưu ngay trên máy (IndexedDB) và tải lên thư mục ẩn của Drive để máy khác cũng thấy.
export async function saveCover(id, blob) {
  await db.set('covers', id, blob);
  try { return await uploadAppDataFile(`cover-${id.replace(/[^a-z0-9-]/gi, '')}.jpg`, blob); } catch { return null; }
}

export async function fetchCover(id, fileId) {
  const blob = await downloadFileBlob(fileId);
  await db.set('covers', id, blob);
  return blob;
}
