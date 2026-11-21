// Gọi Google Drive API trực tiếp từ trình duyệt.
import { getToken, clearToken } from './auth.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class AuthError extends Error {
  constructor() { super('Cần đăng nhập lại Google'); this.name = 'AuthError'; }
}

async function authFetch(url, opts = {}) {
  const token = await getToken();
  if (!token) throw new AuthError();
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    await clearToken();
    throw new AuthError();
  }
  if (!res.ok) throw new Error(`Drive trả lỗi ${res.status}`);
  return res;
}

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function list(query, fields, space = 'drive') {
  const out = [];
  let pageToken;
  do {
    const u = new URL(`${API}/files`);
    u.searchParams.set('q', query);
    u.searchParams.set('fields', `nextPageToken,files(${fields})`);
    u.searchParams.set('pageSize', '1000');
    u.searchParams.set('spaces', space);
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const j = await (await authFetch(u)).json();
    out.push(...(j.files || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

// Quét thư mục gốc: mỗi thư mục con là một thể loại; PDF nằm thẳng trong thư mục gốc thuộc "Khác".
export async function scanLibrary(rootName) {
  const roots = await list(
    `name='${q(rootName)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    'id,name',
  );
  if (!roots.length) return { error: 'noroot' };
  const root = roots[0];
  const subs = await list(
    `'${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    'id,name',
  );
  const folders = [{ id: root.id, name: 'Khác' }, ...subs];
  const results = await Promise.all(folders.map(async (f) => {
    const files = await list(
      `'${f.id}' in parents and mimeType='application/pdf' and trashed=false`,
      'id,name,size,modifiedTime,thumbnailLink',
    );
    return files.map((x) => ({
      id: x.id,
      name: x.name,
      size: Number(x.size) || 0,
      modifiedTime: x.modifiedTime,
      thumb: x.thumbnailLink || null,
      genre: f.name,
    }));
  }));
  return { books: results.flat(), scannedAt: Date.now() };
}

// Đọc một đoạn byte của file (để mở sách ngay mà không cần tải hết).
export async function readRange(id, begin, end, signal) {
  const res = await authFetch(`${API}/files/${id}?alt=media`, {
    headers: { Range: `bytes=${begin}-${end - 1}` },
    signal,
  });
  return res.arrayBuffer();
}

// Tải file (có thể tiếp tục từ byte `offset`).
export async function fetchMedia(id, offset, signal) {
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
  return authFetch(`${API}/files/${id}?alt=media`, { headers, signal });
}

// ---- appDataFolder: file JSON ẩn lưu tiến độ & phiên đọc ----
const STATE_NAME = 'doc-sach-state.json';

export async function readAppState() {
  const files = await list(`name='${STATE_NAME}' and trashed=false`, 'id,name,modifiedTime', 'appDataFolder');
  if (!files.length) return { fileId: null, data: null };
  const res = await authFetch(`${API}/files/${files[0].id}?alt=media`);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { fileId: files[0].id, data };
}

export async function writeAppState(fileId, data) {
  const body = JSON.stringify(data);
  if (fileId) {
    await authFetch(`${UPLOAD}/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return fileId;
  }
  const boundary = 'docsach' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: STATE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await authFetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  return (await res.json()).id;
}

// ---- File ảnh (bìa sách giấy) trong appDataFolder ----
export async function uploadAppDataFile(name, blob) {
  const boundary = 'docsach' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  const res = await authFetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await res.json()).id;
}

export async function downloadFileBlob(id) {
  const res = await authFetch(`${API}/files/${id}?alt=media`);
  return res.blob();
}
