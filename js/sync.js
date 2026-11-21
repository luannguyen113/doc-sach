// Đồng bộ tiến độ, phiên đọc và tuỳ chọn từng bộ qua file ẩn trong Google Drive (appDataFolder).
// Quy tắc gộp: tiến độ & tuỳ chọn lấy bản mới hơn theo updatedAt; phiên đọc gộp theo id.
import { db } from './db.js';
import { readAppState, writeAppState } from './drive.js';
import { getToken } from './auth.js';

let timer = null;
let inFlight = null;
const listeners = new Set();
export const onSynced = (fn) => listeners.add(fn);

export function scheduleSync(ms = 8000) {
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, ms);
}

function mergeMap(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (!out[k] || (v?.updatedAt || 0) > (out[k]?.updatedAt || 0)) out[k] = v;
  }
  return out;
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

export async function syncNow() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!navigator.onLine || !(await getToken())) return false;
    const [localProgress, localSessions, localPrefs, localArticles, meta] = await Promise.all([
      db.entries('progress'), db.all('sessions'), db.get('kv', 'prefs'), db.get('kv', 'articles'), db.get('kv', 'syncMeta'),
    ]);
    const localPaper = await db.get('kv', 'paper');
    const remote = await readAppState();
    const r = remote.data || {};
    const progress = mergeMap(Object.fromEntries(localProgress), r.progress);
    const prefs = mergeMap(localPrefs || {}, r.prefs);
    const articles = mergeMap(localArticles || {}, r.articles);
    const paper = mergeMap(localPaper || {}, r.paper);
    const sessMap = new Map((r.sessions || []).map((s) => [s.id, s]));
    for (const s of localSessions) {
      const o = sessMap.get(s.id);
      if (!o || (s.rev || s.end || 0) > (o.rev || o.end || 0)) sessMap.set(s.id, s);
    }
    const sessions = [...sessMap.values()].sort((a, b) => a.start - b.start);

    // Ghi lại về máy
    for (const [k, v] of Object.entries(progress)) {
      const cur = localProgress.find(([id]) => id === k)?.[1];
      if (!cur || cur.updatedAt < v.updatedAt) await db.set('progress', k, v);
    }
    const localById = new Map(localSessions.map((s) => [s.id, s]));
    for (const s of sessions) {
      const l = localById.get(s.id);
      if (!l || (s.rev || s.end || 0) > (l.rev || l.end || 0)) await db.set('sessions', null, s);
    }
    // Gộp lại lần nữa với bản trên máy, phòng khi anh vừa sửa trong lúc đang đồng bộ.
    Object.assign(prefs, mergeMap(prefs, await db.get('kv', 'prefs')));
    Object.assign(articles, mergeMap(articles, await db.get('kv', 'articles')));
    Object.assign(paper, mergeMap(paper, await db.get('kv', 'paper')));
    await db.set('kv', 'paper', paper);
    await db.set('kv', 'prefs', prefs);
    await db.set('kv', 'articles', articles);

    // Ghi lên Drive nếu có thay đổi
    const payload = { v: 1, progress: sortKeys(progress), prefs: sortKeys(prefs), articles: sortKeys(articles), paper: sortKeys(paper), sessions };
    const remoteNorm = {
      v: 1,
      progress: sortKeys(r.progress || {}),
      prefs: sortKeys(r.prefs || {}),
      articles: sortKeys(r.articles || {}),
      paper: sortKeys(r.paper || {}),
      sessions: [...(r.sessions || [])].sort((a, b) => a.start - b.start),
    };
    let fileId = remote.fileId;
    if (!r.v || JSON.stringify(payload) !== JSON.stringify(remoteNorm)) {
      fileId = await writeAppState(remote.fileId, payload);
    }
    await db.set('kv', 'syncMeta', { ...(meta || {}), fileId, at: Date.now() });
    listeners.forEach((fn) => fn());
    return true;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

export async function lastSyncAt() {
  return (await db.get('kv', 'syncMeta'))?.at || 0;
}

// Tuỳ chọn theo bộ/cuốn (hướng lật, bố cục, chế độ đọc, lệch trang bìa)
export async function getPref(key) {
  const prefs = (await db.get('kv', 'prefs')) || {};
  return prefs[key]?.value;
}
export async function setPref(key, value) {
  const prefs = (await db.get('kv', 'prefs')) || {};
  prefs[key] = { value, updatedAt: Date.now() };
  await db.set('kv', 'prefs', prefs);
  scheduleSync();
}
