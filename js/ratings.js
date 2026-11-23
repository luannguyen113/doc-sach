// Đánh giá sách/bộ truyện khi đọc xong: điểm nguyên 1–10 + nhận xét (không bắt buộc).
// Bộ nhiều tập chấm cho CẢ BỘ, không chấm từng tập. Mỗi đối tượng chỉ giữ điểm mới nhất.
// "Để sau" = bản ghi pending (chưa có điểm) để thẻ sách hiện nhãn "Chưa đánh giá".
// Lưu ở kv 'ratings' (map key -> bản ghi), đồng bộ qua sync.js; xoá = đánh dấu deleted.
import { db } from './db.js';
import { scheduleSync } from './sync.js';

// Khoá đối tượng được chấm.
export const rKey = {
  pdfBook: (fileId) => `pdf:${fileId}`,
  pdfSeries: (genre, series) => `pdfs:${genre}/${series}`,
  paperBook: (id) => `paper:${id}`,
  paperSeries: (series) => `papers:${series}`,
};

export async function loadRatings() {
  return (await db.get('kv', 'ratings')) || {};
}

async function put(map, key, rec) {
  map[key] = { ...rec, key, updatedAt: Date.now() };
  await db.set('kv', 'ratings', map);
  scheduleSync(5000);
  return map[key];
}

// target: { key, title, scope: 'book' | 'series', source: 'pdf' | 'paper' }
export async function saveRating(target, score, comment) {
  const map = await loadRatings();
  const s = Math.round(Number(score));
  if (!(s >= 1 && s <= 10)) throw new Error('Điểm phải là số nguyên từ 1 đến 10');
  return put(map, target.key, {
    title: target.title, scope: target.scope, source: target.source,
    score: s, comment: String(comment || '').trim(), ratedAt: Date.now(),
  });
}

// Bấm "Để sau": chỉ đánh dấu chờ nếu chưa có điểm (đã có điểm thì giữ nguyên điểm cũ).
export async function markPending(target) {
  const map = await loadRatings();
  const cur = map[target.key];
  if (cur && !cur.deleted && cur.score) return cur;
  return put(map, target.key, { title: target.title, scope: target.scope, source: target.source, pending: true });
}

export async function deleteRating(key) {
  const map = await loadRatings();
  if (!map[key]) return;
  await put(map, key, { deleted: true });
}

// Trạng thái để hiển thị trên thẻ: { score } | { pending: true } | null
export function ratingOf(map, key) {
  const r = map?.[key];
  if (!r || r.deleted) return null;
  if (r.score) return r;
  return r.pending ? r : null;
}
