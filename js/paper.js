// Sách giấy: hồ sơ sách, đọc ảnh bìa (Gemini qua Apps Script), ảnh bìa lưu trong thư mục ẩn của Drive.
// Lần đọc được lưu như phiên đọc (sessions, kind: 'paper').
// Lưu ở kv 'paper' (map id -> sách); xoá = đánh dấu deleted để máy khác xoá theo khi đồng bộ.
import { db } from './db.js';
import { scheduleSync } from './sync.js';
import { getToken } from './auth.js';
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

// Gửi ảnh bìa tới Apps Script để Gemini đọc tên sách, tác giả, số tập...
export async function readCoverText(gasUrl, imageBlob) {
  if (!gasUrl) throw new Error('Chưa cài địa chỉ Apps Script đọc ảnh bìa (Cài đặt)');
  const token = await getToken();
  if (!token) throw new Error('Cần kết nối lại Google trước khi đọc ảnh bìa');
  const res = await fetch(gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // tránh preflight CORS với Apps Script
    body: JSON.stringify({ token, image: await toBase64(imageBlob) }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Apps Script trả lỗi ${res.status}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'Không đọc được ảnh bìa');
  return j.data || {};
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
