// Sách giấy: hồ sơ sách, tra cứu ISBN, quét mã vạch. Lần đọc được lưu như phiên đọc (sessions, kind: 'paper').
// Lưu ở kv 'paper' (map id -> sách); xoá = đánh dấu deleted để máy khác xoá theo khi đồng bộ.
import { db } from './db.js';
import { scheduleSync } from './sync.js';

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

// ---------- ISBN ----------
export function normIsbn(raw) {
  const s = String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return s.length === 10 || s.length === 13 ? s : null;
}

// Tra Google Books, không có thì thử Open Library. Sách Việt Nam hay thiếu dữ liệu -> trả null để nhập tay.
export async function lookupIsbn(isbn) {
  const out = { isbn };
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    if (r.ok) {
      const v = (await r.json()).items?.[0]?.volumeInfo;
      if (v) {
        out.title = [v.title, v.subtitle].filter(Boolean).join(': ');
        out.author = (v.authors || []).join(', ');
        out.totalPages = v.pageCount || null;
        out.cover = (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '').replace(/^http:/, 'https:') || null;
      }
    }
  } catch { /* thử nguồn khác */ }
  if (!out.title || !out.totalPages) {
    try {
      const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
      if (r.ok) {
        const v = (await r.json())[`ISBN:${isbn}`];
        if (v) {
          out.title ||= v.title;
          out.author ||= (v.authors || []).map((a) => a.name).join(', ');
          out.totalPages ||= v.number_of_pages || null;
          out.cover ||= v.cover?.medium || null;
        }
      }
    } catch { /* bỏ qua */ }
  }
  return out.title ? out : null;
}

export const canScan = () => 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

// Mở camera, quét mã vạch EAN-13 (ISBN bắt đầu bằng 978/979). Trả về ISBN hoặc null nếu huỷ.
export async function scanIsbn() {
  const detector = new window.BarcodeDetector({ formats: ['ean_13'] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet scan';
    dlg.setAttribute('aria-label', 'Quét mã vạch ISBN');
    dlg.innerHTML = `<div class="sheet-body">
      <h2 class="sheet-title">Quét mã vạch sau bìa sách</h2>
      <video playsinline muted></video>
      <p class="muted xs">Đưa mã vạch (bắt đầu bằng 978 hoặc 979) vào giữa khung hình.</p>
      <div class="sheet-actions"><button type="button" class="btn ghost">Huỷ</button></div></div>`;
    document.body.appendChild(dlg);
    const video = dlg.querySelector('video');
    video.srcObject = stream;
    video.play().catch(() => {});
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      stream.getTracks().forEach((t) => t.stop());
      dlg.close();
      dlg.remove();
      resolve(val);
    };
    dlg.querySelector('button').onclick = () => finish(null);
    dlg.addEventListener('cancel', () => finish(null));
    const tick = async () => {
      if (done) return;
      try {
        const codes = await detector.detect(video);
        const hit = codes.map((c) => c.rawValue).find((v) => /^97[89]\d{10}$/.test(v));
        if (hit) { finish(hit); return; }
      } catch { /* khung hình chưa sẵn sàng */ }
      setTimeout(tick, 250);
    };
    dlg.showModal();
    tick();
  });
}
