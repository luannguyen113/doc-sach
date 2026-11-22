// Highlight trong sách PDF: đoạn chữ, vị trí trên trang, ghi chú, tag. Đồng bộ qua sync.js (khoá 'highlights' trong kv).
// Xoá = đánh dấu deleted + updatedAt, để máy khác cũng xoá theo khi đồng bộ (giống Bài viết).
import { db } from './db.js';
import { scheduleSync } from './sync.js';
import { normTag } from './articles.js';

export async function loadHighlights() {
  return (await db.get('kv', 'highlights')) || {};
}

async function saveAll(map) {
  await db.set('kv', 'highlights', map);
  scheduleSync(5000);
}

const newId = () => `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Làm gọn đoạn chữ lấy từ lớp chữ PDF: gộp khoảng trắng, nối chữ bị ngắt dòng bằng gạch nối.
export function cleanText(s) {
  return String(s || '').replace(/-\s*\n\s*/g, '').replace(/\s+/g, ' ').trim();
}

// rec: { id?, bookId, bookTitle, genre, page, text, rects, note, tags }
export async function saveHighlight(rec) {
  const map = await loadHighlights();
  const now = Date.now();
  const id = rec.id || newId();
  const prev = map[id] && !map[id].deleted ? map[id] : null;
  map[id] = {
    id,
    bookId: rec.bookId ?? prev?.bookId,
    bookTitle: rec.bookTitle ?? prev?.bookTitle ?? '',
    genre: rec.genre ?? prev?.genre ?? '',
    page: rec.page ?? prev?.page ?? 1,
    text: cleanText(rec.text ?? prev?.text),
    rects: rec.rects ?? prev?.rects ?? [],
    note: String(rec.note ?? prev?.note ?? '').trim(),
    tags: [...new Set((rec.tags ?? prev?.tags ?? []).map(normTag).filter(Boolean))],
    createdAt: prev?.createdAt || now,
    updatedAt: now,
  };
  await saveAll(map);
  return map[id];
}

export async function deleteHighlight(id) {
  const map = await loadHighlights();
  if (!map[id] || map[id].deleted) return null;
  const before = { ...map[id] };
  map[id] = { id, deleted: true, updatedAt: Date.now() };
  await saveAll(map);
  return before;
}

export async function restoreHighlight(rec) {
  const map = await loadHighlights();
  map[rec.id] = { ...rec, updatedAt: Date.now() };
  await saveAll(map);
}

export function activeHighlights(map) {
  return Object.values(map || {}).filter((h) => !h.deleted).sort((a, b) => b.createdAt - a.createdAt);
}

export function highlightsOf(map, bookId, page) {
  return activeHighlights(map).filter((h) => h.bookId === bookId && (page == null || h.page === page));
}

// Nhóm theo sách; sách có highlight mới nhất đứng trước.
export function groupByBook(list) {
  const m = new Map();
  for (const h of list) {
    if (!m.has(h.bookId)) m.set(h.bookId, { bookId: h.bookId, title: h.bookTitle, genre: h.genre, items: [] });
    m.get(h.bookId).items.push(h);
  }
  return [...m.values()];
}
