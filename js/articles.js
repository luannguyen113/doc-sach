// Bài viết đã đọc (Substack & web): lưu, gắn tag, xoá. Đồng bộ qua sync.js (khoá 'articles' trong kv).
// Xoá = đánh dấu deleted + updatedAt, để máy khác cũng xoá theo khi đồng bộ.
import { db } from './db.js';
import { scheduleSync } from './sync.js';

const TRACKING = /^(utm_|r$|s$|ref$|fbclid$|gclid$|triedRedirect$|publication_id$|post_id$|isFreemail$|token$)/;

export function cleanUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.hostname.endsWith('substack.com')) u.search = '';
  else for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

// Tìm link đầu tiên trong đoạn chữ được chia sẻ ("Tiêu đề https://...").
export function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : null;
}

export function sourceOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h.endsWith('.substack.com') ? h.replace('.substack.com', '') : h;
  } catch { return ''; }
}

export function titleFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const slug = decodeURIComponent(parts[parts.length - 1] || '');
    const t = slug.replace(/[-_]+/g, ' ').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : url;
  } catch { return url; }
}

export function normTag(t) {
  return String(t || '').trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
}

export async function loadArticles() {
  return (await db.get('kv', 'articles')) || {};
}

async function saveAll(map) {
  await db.set('kv', 'articles', map);
  scheduleSync(5000);
}

export async function upsertArticle({ url, title, tags }) {
  const map = await loadArticles();
  const id = cleanUrl(url);
  if (!id) throw new Error('Link không hợp lệ');
  const prev = map[id];
  const now = Date.now();
  map[id] = {
    id,
    url: id,
    title: (title || '').trim() || prev?.title || titleFromUrl(id),
    source: sourceOf(id),
    tags: [...new Set((tags || []).map(normTag).filter(Boolean))],
    readAt: prev && !prev.deleted ? prev.readAt : now,
    updatedAt: now,
  };
  await saveAll(map);
  return { rec: map[id], existed: Boolean(prev && !prev.deleted) };
}

export async function deleteArticle(id) {
  const map = await loadArticles();
  if (!map[id]) return null;
  const before = { ...map[id] };
  map[id] = { id, deleted: true, updatedAt: Date.now() };
  await saveAll(map);
  return before;
}

export async function restoreArticle(rec) {
  const map = await loadArticles();
  map[rec.id] = { ...rec, updatedAt: Date.now() };
  await saveAll(map);
}

export function activeList(map) {
  return Object.values(map).filter((a) => !a.deleted).sort((a, b) => b.readAt - a.readAt);
}

export function tagCounts(list) {
  const m = new Map();
  for (const a of list) for (const t of a.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'vi'));
}
