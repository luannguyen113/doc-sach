// Lưu sách offline (OPFS; dự phòng IndexedDB) + hàng đợi tải có nhận biết loại mạng.
import { db } from './db.js';
import { fetchMedia, AuthError } from './drive.js';

// ---------- Loại mạng ----------
// 'wifi' | 'cellular' | 'offline'. Trình duyệt máy tính thường không báo loại mạng -> coi như Wi-Fi.
export function netType() {
  if (!navigator.onLine) return 'offline';
  const c = navigator.connection;
  if (c?.saveData) return 'cellular';
  if (c?.type === 'cellular') return 'cellular';
  if (c?.type === 'none') return 'offline';
  return 'wifi';
}

export function onNetChange(cb) {
  navigator.connection?.addEventListener?.('change', cb);
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
}

// ---------- File offline ----------
const hasOPFS = Boolean(navigator.storage?.getDirectory);

async function booksDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('books', { create: true });
}

async function canWriteOPFS() {
  if (!hasOPFS) return false;
  try {
    const d = await booksDir();
    const fh = await d.getFileHandle('.probe', { create: true });
    const ok = typeof fh.createWritable === 'function';
    await d.removeEntry('.probe').catch(() => {});
    return ok;
  } catch { return false; }
}
let opfsWritable = null;

// Trả về File/Blob của sách nếu đã tải xong, ngược lại null.
export async function localFile(id) {
  const mark = await db.get('kv', `local:${id}`);
  if (!mark) return null;
  try {
    if (mark.where === 'opfs') {
      const d = await booksDir();
      const f = await (await d.getFileHandle(`${id}.pdf`)).getFile();
      if (f.size === mark.size) return f;
    } else {
      const b = await db.get('files', id);
      if (b && b.size === mark.size) return b;
    }
  } catch { /* coi như chưa có */ }
  await db.del('kv', `local:${id}`);
  return null;
}

export async function localIds() {
  const keys = await db.keys('kv');
  return new Set(keys.filter((k) => typeof k === 'string' && k.startsWith('local:')).map((k) => k.slice(6)));
}

export async function removeLocal(id) {
  await db.del('kv', `local:${id}`);
  if (hasOPFS) {
    try { const d = await booksDir(); await d.removeEntry(`${id}.pdf`); } catch { /* không có */ }
  }
  await db.del('files', id).catch(() => {});
  downloads.delete(id);
  emit();
}

export async function removeAllLocal() {
  for (const id of await localIds()) await removeLocal(id);
}

export async function requestPersist() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* bỏ qua */ }
}

export async function storageUsage() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}

// ---------- Hàng đợi tải ----------
// status: queued | downloading | waiting-wifi | paused | error | auth | done
export const downloads = new Map();
const listeners = new Set();
export const onDownloads = (fn) => listeners.add(fn);
let emitTimer = null;
function emit() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => { emitTimer = null; listeners.forEach((fn) => fn()); }, 250);
}

const queue = [];
let running = null;

export function enqueue(book, { cellularOk = false } = {}) {
  const cur = downloads.get(book.id);
  if (cur?.status === 'done') return;
  if (cur && (cur.status === 'queued' || cur.status === 'downloading')) {
    if (cellularOk) cur.cellularOk = true;
    return;
  }
  downloads.set(book.id, { status: 'queued', received: cur?.received || 0, total: book.size, cellularOk });
  queue.push(book);
  emit();
  pump();
}

export function cancelDownload(id) {
  const st = downloads.get(id);
  if (!st) return;
  if (st.status === 'downloading') { st.abortReason = 'paused'; st.ctrl?.abort(); }
  const i = queue.findIndex((b) => b.id === id);
  if (i >= 0) queue.splice(i, 1);
  downloads.delete(id);
  emit();
}

// Khi mạng đổi: đang tải bằng Wi-Fi mà chuyển sang 4G (chưa được phép) thì tạm dừng.
export function onNetworkChanged() {
  const nt = netType();
  if (running) {
    const st = downloads.get(running);
    if (st && nt === 'cellular' && !st.cellularOk) { st.abortReason = 'waiting-wifi'; st.ctrl?.abort(); }
    if (st && nt === 'offline') { st.abortReason = 'paused'; st.ctrl?.abort(); }
  }
}

async function pump() {
  if (running || !queue.length) return;
  const book = queue.shift();
  const st = downloads.get(book.id);
  if (!st || st.status !== 'queued') return pump();
  const nt = netType();
  if (nt === 'offline') { st.status = 'paused'; emit(); return pump(); }
  if (nt === 'cellular' && !st.cellularOk) { st.status = 'waiting-wifi'; emit(); return pump(); }
  running = book.id;
  st.status = 'downloading';
  st.ctrl = new AbortController();
  st.abortReason = null;
  emit();
  try {
    if (opfsWritable === null) opfsWritable = await canWriteOPFS();
    await (opfsWritable ? downloadOPFS(book, st) : downloadIDB(book, st));
    st.status = 'done';
  } catch (e) {
    if (e.name === 'AbortError') st.status = st.abortReason || 'paused';
    else if (e instanceof AuthError) st.status = 'auth';
    else { st.status = 'error'; st.error = e.message; }
  }
  running = null;
  emit();
  pump();
}

async function downloadOPFS(book, st) {
  const d = await booksDir();
  const fh = await d.getFileHandle(`${book.id}.pdf`, { create: true });
  let offset = (await fh.getFile()).size;
  if (book.size && offset >= book.size) offset = 0;
  let res = await fetchMedia(book.id, offset, st.ctrl.signal);
  if (offset > 0 && res.status !== 206) offset = 0; // máy chủ không cho tải tiếp -> tải lại từ đầu
  const w = await fh.createWritable({ keepExistingData: offset > 0 });
  if (offset > 0) await w.seek(offset); else await w.truncate(0);
  st.received = offset;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await w.write(value);
      st.received += value.length;
      emit();
    }
    await w.close();
  } catch (e) {
    await w.close().catch(() => {}); // giữ phần đã tải để lần sau tải tiếp
    throw e;
  }
  const f = await fh.getFile();
  if (book.size && f.size !== book.size) throw new Error('File tải về không đủ dung lượng');
  await db.set('kv', `local:${book.id}`, { size: f.size, at: Date.now(), where: 'opfs' });
}

async function downloadIDB(book, st) {
  const res = await fetchMedia(book.id, 0, st.ctrl.signal);
  const reader = res.body.getReader();
  const chunks = [];
  st.received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    st.received += value.length;
    emit();
  }
  const blob = new Blob(chunks, { type: 'application/pdf' });
  if (book.size && blob.size !== book.size) throw new Error('File tải về không đủ dung lượng');
  await db.set('files', book.id, blob);
  await db.set('kv', `local:${book.id}`, { size: blob.size, at: Date.now(), where: 'idb' });
}
