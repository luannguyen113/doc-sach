// Điều phối: thư viện, quy tắc tải offline theo mạng, phiên đọc, cài đặt, điều hướng.
import { CONFIG } from './config.js';
import { db } from './db.js';
import * as auth from './auth.js';
import { scanLibrary, readRange, AuthError } from './drive.js';
import {
  netType, onNetChange, localFile, localIds, removeLocal, removeAllLocal, requestPersist, storageUsage,
  downloads, onDownloads, enqueue, cancelDownload, onNetworkChanged,
} from './storage.js';
import { syncNow, scheduleSync, onSynced, lastSyncAt, getPref, setPref } from './sync.js';
import { Reader } from './reader.js';
import { esc, icon, fmtMB, fmtTime, dayKey, toast, parseName } from './ui.js';
import {
  loadArticles, upsertArticle, deleteArticle, restoreArticle, activeList, tagCounts,
  extractUrl, cleanUrl, titleFromUrl, normTag, isPodcastUrl, isPodcast, showNames,
} from './articles.js';
import { spotifyOembed, readPodcastPage } from './podcast.js';
import { computeStats, renderStatsHtml } from './stats.js';
import {
  loadHighlights, saveHighlight, deleteHighlight, restoreHighlight, activeHighlights, highlightsOf, groupByBook,
} from './highlights.js';
import {
  loadPaper, savePaperBook, deletePaperBook, activePaper, newPaperId, paperTitle, shrinkImage, readCoverText, pickGeminiModels, saveCover, fetchCover,
  readPageText, splitSentences,
} from './paper.js';

const app = document.getElementById('app');

const S = {
  books: [],
  scannedAt: 0,
  libError: null,
  progress: {},
  sessions: [],
  local: new Set(),
  covers: new Map(),
  settings: { rootFolder: CONFIG.defaultRootFolder, allowCellular: false, cellularSeries: [] },
  ask: [],
  dismissUntilWifi: false,
  approved: new Set(),
  needAuth: false,
  scanning: false,
  expanded: new Set(),
  route: '',
  reader: null,
  readingId: null,
  articles: {},
  artTag: '',
  artQuery: '',
  artKind: '', // '' = tất cả · 'post' = bài viết · 'podcast'
  statsPeriod: 'month',
  paper: {},
  highlights: {},
  hlTag: '',
  hlQuery: '',
  jump: null, // mở sách tới đúng trang của một highlight: { id, page, flashId }
};

// ---------------- Khởi động ----------------
async function boot() {
  if ('serviceWorker' in navigator) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    // Có bản app mới: tự tải lại khi đang ở thư viện (không cắt ngang lúc đang đọc).
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      if (!S.reader) location.reload(); else S.pendingReload = true;
    });
  }
  const [settings, lib, progressEntries, sessions, local, articles] = await Promise.all([
    db.get('kv', 'settings'), db.get('kv', 'library'), db.entries('progress'), db.all('sessions'), localIds(), loadArticles(),
  ]);
  S.articles = articles;
  S.paper = await loadPaper();
  S.highlights = await loadHighlights();
  const gk = await getPref('geminiKey');
  if (gk != null && !S.settings.geminiKey) S.settings.geminiKey = gk;
  if (settings) S.settings = { ...S.settings, ...settings };
  if (lib) { S.books = lib.books || []; S.scannedAt = lib.scannedAt || 0; }
  S.progress = Object.fromEntries(progressEntries);
  S.sessions = sessions;
  S.local = local;
  for (const [id, blob] of await db.entries('covers')) S.covers.set(id, URL.createObjectURL(blob));

  onDownloads(onDownloadsChanged);
  onSynced(reloadFromDb);
  onNetChange(onNet);
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { sessFlush(false); syncNow().catch(() => {}); }
  });
  app.addEventListener('click', onClick);
  app.addEventListener('change', onChange);
  app.addEventListener('input', onInput);
  app.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'art-url') { e.preventDefault(); addFromInput(); }
  });

  const shared = readShareParams();
  route();
  if (shared) openArticleEditor(shared);
  await refresh();
}

async function refresh({ force = false } = {}) {
  if (netType() === 'offline') { runPolicy(); return; }
  const token = await auth.getToken();
  if (!token) {
    S.needAuth = await auth.everSignedIn();
    renderView();
    return;
  }
  S.needAuth = false;
  requestPersist();
  syncNow().catch(handleErr);
  if (force || Date.now() - S.scannedAt > 60_000 || !S.books.length) {
    S.scanning = true;
    renderView();
    try {
      const res = await scanLibrary(S.settings.rootFolder);
      if (res.error === 'noroot') { S.libError = 'noroot'; }
      else {
        S.libError = null;
        S.books = res.books;
        S.scannedAt = res.scannedAt;
        await db.set('kv', 'library', { books: S.books, scannedAt: S.scannedAt });
      }
    } catch (e) { handleErr(e); }
    S.scanning = false;
  }
  runPolicy();
  renderView();
  uploadPendingCovers().catch(() => {});
}

function handleErr(e) {
  if (e instanceof AuthError) { S.needAuth = true; renderView(); return; }
  if (e?.name !== 'AbortError') console.warn(e);
}

async function reloadFromDb() {
  const [p, s, a] = await Promise.all([db.entries('progress'), db.all('sessions'), loadArticles()]);
  S.progress = Object.fromEntries(p);
  S.sessions = s;
  S.articles = a;
  S.paper = await loadPaper();
  S.highlights = await loadHighlights();
  S.reader?.refreshHighlights();
  const gk = await getPref('geminiKey');
  if (gk != null) S.settings.geminiKey = gk;
  runPolicy();
  if (!S.reader) renderView();
}

async function signIn() {
  try {
    await auth.signIn();
    S.needAuth = false;
    toast('Đã kết nối Google Drive');
    await refresh({ force: true });
    // Tải tiếp những bản đang dở do hết phiên đăng nhập
    for (const [id, st] of downloads) if (st.status === 'auth') { const b = bookById(id); if (b) { downloads.delete(id); enqueue(b, { cellularOk: st.cellularOk }); } }
  } catch (e) { toast(e.message); }
}

// ---------------- Mô hình thư viện ----------------
const bookById = (id) => S.books.find((b) => b.id === id);
const isMangaGenre = (g) => /truy[eệ]n|manga|comic|tranh/i.test(g || '');

function info(b) {
  const p = parseName(b.name);
  return { ...b, series: p.series, vol: p.vol, title: p.title, key: p.series ? `s:${b.genre}/${p.series}` : `b:${b.id}` };
}

function displayTitle(b) {
  const x = info(b);
  return x.series ? `${x.series} · Tập ${x.vol}` : x.title;
}

function nextVolume(b) {
  const x = info(b);
  if (!x.series) return null;
  return S.books.map(info)
    .filter((o) => o.series === x.series && o.genre === x.genre && o.vol > x.vol)
    .sort((a, c) => a.vol - c.vol)[0] || null;
}

const isFinished = (id) => Boolean(S.progress[id]?.finished);

// Danh sách cần có offline: sách đang đọc gần đây (chưa xong) + tập kế tiếp của bộ.
function offlineTargets() {
  const cutoff = Date.now() - CONFIG.recentDays * 864e5;
  const recent = S.books
    .filter((b) => S.progress[b.id] && S.progress[b.id].updatedAt > cutoff)
    .sort((a, b) => S.progress[b.id].updatedAt - S.progress[a.id].updatedAt)
    .slice(0, CONFIG.maxReading);
  const out = new Map();
  for (const b of recent) {
    if (!isFinished(b.id)) out.set(b.id, b);
    const n = nextVolume(b);
    if (n && !isFinished(n.id)) out.set(n.id, bookById(n.id));
  }
  return [...out.values()];
}

async function runPolicy() {
  const nt = netType();
  if (nt === 'wifi') S.dismissUntilWifi = false;
  const targets = offlineTargets();
  const ask = [];
  for (const b of targets) {
    if (S.local.has(b.id)) continue;
    const st = downloads.get(b.id);
    if (st && (st.status === 'queued' || st.status === 'downloading' || st.status === 'done')) continue;
    if (nt === 'offline' || st?.status === 'auth') continue;
    const series = info(b).series;
    const cellOk = S.settings.allowCellular || (series && S.settings.cellularSeries.includes(series)) || S.approved.has(b.id);
    if (nt === 'wifi' || cellOk) enqueue(b, { cellularOk: nt !== 'wifi' && cellOk });
    else if (!S.dismissUntilWifi) ask.push(b);
  }
  S.ask = ask;
  // Tập đã đọc xong: xoá bản offline (file trên Drive giữ nguyên).
  const keep = new Set(targets.map((b) => b.id));
  for (const id of [...S.local]) {
    if (isFinished(id) && id !== S.readingId && !keep.has(id)) {
      await removeLocal(id);
      S.local.delete(id);
    }
  }
  if (!S.reader) renderView();
}

async function onDownloadsChanged() {
  for (const [id, st] of downloads) {
    if (st.status === 'done' && !S.local.has(id)) { S.local.add(id); downloads.delete(id); }
    if (st.status === 'auth') S.needAuth = true;
  }
  if (S.reader) updateReaderStatus(); else renderView();
}

function onNet() {
  onNetworkChanged();
  const nt = netType();
  if (nt !== 'offline') {
    // Nối lại các bản tải đang chờ khi mạng phù hợp
    for (const [id, st] of [...downloads]) {
      if (st.status === 'paused' || st.status === 'error' || (st.status === 'waiting-wifi' && nt === 'wifi')) {
        downloads.delete(id);
        const b = bookById(id);
        if (b) enqueue(b, { cellularOk: st.cellularOk });
      }
    }
    syncNow().catch(handleErr);
  }
  runPolicy();
  if (S.reader) updateReaderStatus(); else renderView();
}

// ---------------- Phiên đọc ----------------
const T = { s: null, timer: null, lastActive: 0, lastSave: 0, wake: null };

function sessStart() {
  const b = bookById(S.readingId);
  if (!b) return;
  const x = info(b);
  T.s = {
    id: crypto.randomUUID(), bookId: b.id, title: x.title, genre: b.genre, series: x.series, vol: x.vol,
    start: Date.now(), end: Date.now(), activeSec: 0, pages: [], device: deviceName(),
  };
  T.lastActive = Date.now();
  clearInterval(T.timer);
  T.timer = setInterval(sessTick, 5000);
}

function sessTick() {
  if (!T.s) return;
  const now = Date.now();
  if (now - T.lastActive >= CONFIG.idleMs) { sessFlush(true); releaseWake(); return; }
  if (document.visibilityState === 'visible') { T.s.activeSec += 5; T.s.end = now; }
  if (now - T.lastSave > 30_000) sessFlush(false);
}

function sessActivity() {
  T.lastActive = Date.now();
  if (S.readingId && !T.s) sessStart();
  requestWake();
}

function sessPage(n) {
  if (T.s && !T.s.pages.includes(n)) T.s.pages.push(n);
}

async function sessFlush(end) {
  const s = T.s;
  if (!s) return;
  T.lastSave = Date.now();
  if (end) { T.s = null; clearInterval(T.timer); }
  if (s.activeSec < CONFIG.minSessionSec) return;
  const rec = { ...s, pages: s.pages.length };
  await db.set('sessions', null, rec);
  const i = S.sessions.findIndex((x) => x.id === rec.id);
  if (i >= 0) S.sessions[i] = rec; else S.sessions.push(rec);
  scheduleSync(10_000);
}

async function requestWake() {
  try { if (!T.wake && navigator.wakeLock && document.visibilityState === 'visible') { T.wake = await navigator.wakeLock.request('screen'); T.wake.addEventListener('release', () => { T.wake = null; }); } } catch { /* bỏ qua */ }
}
function releaseWake() { try { T.wake?.release(); } catch { /* bỏ qua */ } T.wake = null; }

function deviceName() {
  const ua = navigator.userAgent;
  const m = ua.match(/;\s*(SM-[A-Z0-9]+)/);
  if (m) return m[1];
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac/.test(ua)) return 'Mac';
  return 'Thiết bị khác';
}

// Phút đọc theo ngày & streak
function dailyMinutes() {
  const m = new Map();
  for (const s of S.sessions) {
    if ((s.activeSec || 0) < CONFIG.minSessionSec) continue;
    const k = dayKey(s.start);
    m.set(k, (m.get(k) || 0) + s.activeSec / 60);
  }
  return m;
}

function streakInfo() {
  const m = dailyMinutes();
  const today = new Date();
  let streak = 0;
  const d = new Date(today);
  if (!m.has(dayKey(d))) d.setDate(d.getDate() - 1); // hôm nay chưa đọc thì tính đến hôm qua
  while (m.has(dayKey(d))) { streak += 1; d.setDate(d.getDate() - 1); }
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const x = new Date(today);
    x.setDate(x.getDate() - i);
    days.push({ key: dayKey(x), min: Math.round(m.get(dayKey(x)) || 0) });
  }
  return { streak, today: Math.round(m.get(dayKey(today)) || 0), days };
}

// ---------------- Điều hướng ----------------
function route() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/read\/(.+)$/);
  const pm = h.match(/^#\/paper\/(.+)$/);
  if (pm) { if (S.reader) closeReader(); S.route = h; renderPaperDetail(decodeURIComponent(pm[1])); return; }
  if (S.reader && !m) closeReader();
  if (m) { openBook(decodeURIComponent(m[1])); return; }
  S.route = h;
  renderView();
}

function renderView() {
  if (S.reader) return;
  const h = S.route || '#/';
  if (h.startsWith('#/settings')) return renderSettings();
  if (h.startsWith('#/articles')) return renderArticles();
  const pm = h.match(/^#\/paper\/(.+)$/);
  if (pm) return renderPaperDetail(decodeURIComponent(pm[1]));
  if (h.startsWith('#/stats')) return renderStats();
  if (h.startsWith('#/hl')) return renderHighlights();
  return renderLibrary();
}

// ---------------- Màn Thư viện ----------------
function dlState(b) {
  if (S.local.has(b.id)) return { kind: 'local' };
  const st = downloads.get(b.id);
  if (!st) return { kind: 'none' };
  return { kind: st.status, pct: b.size ? Math.floor(((st.received || 0) / b.size) * 100) : 0 };
}

function offlineBadge(b, compact) {
  const d = dlState(b);
  const size = fmtMB(b.size);
  if (d.kind === 'local') {
    return `<span class="st ok">${icon('check', 14)}Đã tải</span>${compact ? '' : `<button type="button" class="icon-btn sm" data-action="remove" data-id="${b.id}" aria-label="Xoá bản offline">${icon('trash', 18)}</button>`}`;
  }
  if (d.kind === 'downloading') return `<span class="st">Đang tải ${d.pct}%</span><button type="button" class="btn ghost sm" data-action="cancel" data-id="${b.id}">Dừng</button>`;
  if (d.kind === 'queued') return `<span class="st">Chờ tải…</span>`;
  if (d.kind === 'waiting-wifi') return `<span class="st warn">Chờ Wi-Fi</span><button type="button" class="btn ghost sm" data-action="dl" data-id="${b.id}">Tải bằng 4G (${size})</button>`;
  if (d.kind === 'error') return `<span class="st warn">Tải lỗi</span><button type="button" class="btn ghost sm" data-action="dl" data-id="${b.id}">Thử lại</button>`;
  if (d.kind === 'auth') return `<span class="st warn">Cần đăng nhập lại</span>`;
  if (d.kind === 'paused') return `<span class="st warn">Tạm dừng ${d.pct}%</span><button type="button" class="btn ghost sm" data-action="dl" data-id="${b.id}">Tiếp tục</button>`;
  if (netType() === 'offline') return `<span class="st muted">Chưa tải</span>`;
  return `<button type="button" class="btn ghost sm" data-action="dl" data-id="${b.id}">Tải (${size})</button>`;
}

function cover(b, cls = 'cover') {
  const url = S.covers.get(b.id);
  const x = info(b);
  const label = x.vol ? `V${x.vol}` : x.title.slice(0, 2);
  if (url) return `<img class="${cls}" src="${url}" alt="" loading="lazy">`;
  if (b.thumb && netType() !== 'offline') return `<span class="${cls} ph"><img src="${esc(b.thumb)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()"><span>${esc(label)}</span></span>`;
  return `<span class="${cls} ph"><span>${esc(label)}</span></span>`;
}

function progressText(b) {
  const p = S.progress[b.id];
  if (!p) return 'Chưa đọc';
  if (p.finished) return 'Đã đọc xong';
  return `Trang ${p.page} / ${p.total} · ${Math.round((p.last / p.total) * 100)}%`;
}

function bar(pct) {
  return `<div class="bar" role="img" aria-label="Tiến độ ${pct}%"><i style="width:${pct}%"></i></div>`;
}

function continueBook() {
  const withP = S.books.filter((b) => S.progress[b.id]).sort((a, b) => S.progress[b.id].updatedAt - S.progress[a.id].updatedAt);
  for (const b of withP) {
    if (!isFinished(b.id)) return b;
    const n = nextVolume(b);
    if (n && !isFinished(n.id)) return bookById(n.id);
  }
  return null;
}

function renderLibrary() {
  const nt = netType();
  const st = streakInfo();
  const signedOutNoData = !S.books.length && !S.needAuth && !S.scanning && !S.libError;
  if (signedOutNoData && !S.scannedAt) return renderWelcome();

  const banners = [];
  if (nt === 'offline') banners.push(`<div class="banner">Đang offline – chỉ mở được sách đã tải về máy.</div>`);
  if (S.needAuth && nt !== 'offline') banners.push(`<div class="banner warn"><span>Phiên Google đã hết hạn.</span><button type="button" class="btn sm" data-action="signin">Kết nối lại</button></div>`);
  if (S.libError === 'noroot') banners.push(`<div class="banner warn"><span>Không thấy thư mục “${esc(S.settings.rootFolder)}” trên Drive.</span><a class="btn sm" href="#/settings">Đổi thư mục</a></div>`);
  if (S.ask.length) {
    const total = S.ask.reduce((a, b) => a + b.size, 0);
    const what = S.ask.length === 1 ? esc(displayTitle(S.ask[0])) : `${S.ask.length} tập`;
    banners.push(`<div class="ask card">
      <p><strong>Tải ${what} (${fmtMB(total)}) bằng 4G?</strong><br><span class="muted">Đang dùng dữ liệu di động. Tải trước để đọc offline.</span></p>
      <div class="ask-actions">
        <button type="button" class="btn" data-action="ask-yes">Tải</button>
        <button type="button" class="btn ghost" data-action="ask-wifi">Để khi có Wi-Fi</button>
        <button type="button" class="btn ghost" data-action="ask-always">Luôn cho phép với bộ này</button>
      </div></div>`);
  }

  const contPdf = continueBook();
  const contPaper = activePaper(S.paper).filter((b) => b.status === 'reading' && b.lastReadAt).sort((a, b) => (b.lastReadAt || b.updatedAt) - (a.lastReadAt || a.updatedAt))[0];
  const pdfTs = contPdf ? (S.progress[contPdf.id]?.updatedAt || 0) : 0;
  const usePaper = contPaper && (contPaper.lastReadAt || contPaper.updatedAt) > pdfTs;
  const cont = usePaper ? null : contPdf;
  const contHtml = usePaper ? paperContinueCard(contPaper) : cont ? (() => {
    const p = S.progress[cont.id];
    const pct = p ? Math.round((p.last / p.total) * 100) : 0;
    return `<section aria-label="Đọc tiếp"><h2 class="h2">Đọc tiếp</h2>
      <div class="card cont">
        <a href="#/read/${encodeURIComponent(cont.id)}" class="cont-link" aria-label="Đọc tiếp ${esc(displayTitle(cont))}">${cover(cont, 'cover lg')}</a>
        <div class="cont-body">
          <strong class="t">${esc(displayTitle(cont))}</strong>
          <span class="muted sm tnum">${esc(progressText(cont))} · ${esc(cont.genre)}</span>
          ${bar(pct)}
          <div class="row-end"><span class="badges">${offlineBadge(cont, true)}</span><a class="btn primary" href="#/read/${encodeURIComponent(cont.id)}">Đọc tiếp</a></div>
        </div></div></section>`;
  })() : '';

  // Nhóm theo thể loại -> bộ / sách lẻ
  const genres = new Map();
  for (const b of S.books) {
    const x = info(b);
    if (!genres.has(b.genre)) genres.set(b.genre, new Map());
    const g = genres.get(b.genre);
    const k = x.series ? `s:${x.series}` : `b:${b.id}`;
    if (!g.has(k)) g.set(k, { series: x.series, items: [] });
    g.get(k).items.push({ ...b, ...x });
  }
  for (const pb of activePaper(S.paper)) {
    if (!genres.has(pb.genre)) genres.set(pb.genre, new Map());
    const gm = genres.get(pb.genre);
    if (pb.series) {
      const k = `ps:${pb.series}`;
      if (!gm.has(k)) gm.set(k, { paperSeries: pb.series, papers: [], items: [] });
      gm.get(k).papers.push(pb);
    } else gm.set(pb.id, { paper: pb, items: [] });
  }
  const pts = (p) => p.lastReadAt || p.updatedAt || 0;
  const recency = (items, g) => (g?.paper ? pts(g.paper) : g?.papers ? Math.max(...g.papers.map(pts)) : Math.max(0, ...items.map((i) => S.progress[i.id]?.updatedAt || 0)));
  const genreHtml = [...genres.entries()]
    .sort((a, b) => (a[0] === 'Khác') - (b[0] === 'Khác') || a[0].localeCompare(b[0], 'vi'))
    .map(([genre, groups]) => {
      const rows = [...groups.values()]
        .sort((a, b) => recency(b.items, b) - recency(a.items, a) || groupName(a).localeCompare(groupName(b), 'vi'))
        .map((g) => (g.paper ? paperRow(g.paper) : g.papers ? paperSeriesCard(g) : g.series && g.items.length > 1 ? seriesCard(g) : bookRow(g.items[0]))).join('');
      return `<section aria-label="${esc(genre)}"><h2 class="h2">${esc(genre)}</h2><div class="list">${rows}</div></section>`;
    }).join('');

  const empty = !S.books.length && !activePaper(S.paper).length && !S.scanning && !S.libError && !S.needAuth
    ? `<div class="card empty"><p>Chưa có sách. Hãy chép file PDF vào <strong>${esc(S.settings.rootFolder)}/&lt;Thể loại&gt;/</strong> trên Google Drive rồi kéo xuống để làm mới.</p><button type="button" class="btn" data-action="refresh">Quét lại</button></div>` : '';

  app.innerHTML = `
    <div class="page">
      <header class="top">
        <div><h1>Thư viện</h1><span class="muted sm">${S.scanning ? 'Đang quét Google Drive…' : syncLine()}</span></div>
        <div class="top-actions">
          <button type="button" class="btn ghost" data-action="paper-new" aria-label="Thêm sách giấy">${icon('plus', 18)}<span>Sách giấy</span></button>
          <button type="button" class="icon-btn" data-action="refresh" aria-label="Làm mới">${icon('refresh')}</button>
          <a class="icon-btn" href="#/settings" aria-label="Cài đặt">${icon('gear')}</a>
        </div>
      </header>
      <main class="main">
        ${banners.join('')}
        <section class="card streak" aria-label="Streak đọc">
          <div class="streak-head">
            <div><span class="big tnum">${st.streak}</span> <span class="muted sm">ngày đọc liên tiếp</span></div>
            <span class="muted sm tnum">Hôm nay ${st.today} phút</span>
          </div>
          <div class="cells">${st.days.map((d) => `<i class="lv${level(d.min)}" title="${d.key}: ${d.min} phút"></i>`).join('')}</div>
          <div class="cells-foot muted xs"><span>14 ngày trước</span><span>Hôm nay</span></div>
        </section>
        ${contHtml}
        ${genreHtml}
        ${empty}
      </main>
      ${nav('lib')}
    </div>`;
}

const level = (min) => (min <= 0 ? 0 : min < 20 ? 1 : min < 40 ? 2 : 3);

function syncLine() {
  const parts = [];
  if (S.scannedAt) parts.push(`Quét Drive ${fmtTime(S.scannedAt)}`);
  return parts.join(' · ') || 'Google Drive';
}

const groupName = (g) => (g.paper ? g.paper.title : g.paperSeries || g.series || g.items[0].title);

// ---------------- Sách giấy ----------------
const PAPER_STATUS = { reading: 'Đang đọc', done: 'Đã đọc xong', dropped: 'Bỏ dở' };
const paperPct = (b) => (b.totalPages ? Math.min(100, Math.round(((b.page || 0) / b.totalPages) * 100)) : 0);

function paperCover(b, cls) {
  const local = S.covers.get(b.id);
  if (local) return `<img class="${cls}" src="${local}" alt="" loading="lazy">`;
  if (b.coverFileId && !S.coverLoading?.has(b.id)) loadPaperCover(b);
  if (b.cover && netType() !== 'offline') return `<span class="${cls} ph"><img src="${esc(b.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"><span>${icon('book', 18)}</span></span>`;
  return `<span class="${cls} ph"><span>${icon('book', 18)}</span></span>`;
}

// Ảnh bìa chụp trên máy khác: tải từ thư mục ẩn của Drive về một lần rồi lưu lại.
async function loadPaperCover(b) {
  S.coverLoading ||= new Set();
  if (netType() === 'offline' || !(await auth.getToken())) return;
  S.coverLoading.add(b.id);
  try {
    const blob = await fetchCover(b.id, b.coverFileId);
    S.covers.set(b.id, URL.createObjectURL(blob));
    if (!S.reader) renderView();
  } catch { /* để lần sau */ }
}

// Bìa chụp lúc offline: tải lên Drive khi có mạng.
async function uploadPendingCovers() {
  if (netType() === 'offline' || !(await auth.getToken())) return;
  for (const b of activePaper(S.paper)) {
    if (b.coverFileId || !b.hasCover) continue;
    const blob = await db.get('covers', b.id);
    if (!blob) continue;
    const fid = await saveCover(b.id, blob);
    if (fid) S.paper[b.id] = await savePaperBook({ ...S.paper[b.id], coverFileId: fid });
  }
}

function paperSeriesCard(g) {
  const vols = g.papers.slice().sort((a, b) => (a.volume || 0) - (b.volume || 0));
  const done = vols.filter((v) => v.status === 'done').length;
  const key = `paper/${vols[0].genre}/${g.paperSeries}`;
  const open = S.expanded.has(key);
  const cur = vols.filter((v) => v.status === 'reading' && v.page).sort((a, b) => pts(b) - pts(a))[0]
    || vols.find((v) => v.status === 'reading');
  return `<div class="card series">
    <button type="button" class="series-head" data-action="toggle" data-key="${esc(key)}" aria-expanded="${open}">
      <span class="t">${esc(g.paperSeries)}</span><span class="pill">Sách giấy</span>
      <span class="muted sm tnum">${done} / ${vols.length} tập xong</span>
      ${icon('chevron', 18)}
    </button>
    <div class="segs" style="grid-template-columns:repeat(${vols.length},minmax(0,1fr))">${vols.map((v) => `<i class="${v.status === 'done' ? 'done' : v.status === 'reading' && v.page ? 'cur' : ''}" title="Tập ${v.volume || '?'}"></i>`).join('')}</div>
    ${!open && cur ? `<div class="row-end"><span class="muted sm">${cur.page ? `Đang đọc: Tập ${cur.volume || '?'} · trang ${cur.page}/${cur.totalPages}` : `Tiếp theo: Tập ${cur.volume || '?'}`}</span><a class="btn ghost sm" href="#/paper/${encodeURIComponent(cur.id)}">Mở</a></div>` : ''}
    ${open ? `<div class="vols">${vols.map((v) => paperRow(v, true)).join('')}</div>` : ''}
  </div>`;
}
const pts = (p) => p.lastReadAt || p.updatedAt || 0;

function paperRow(b, inSeries) {
  const pct = paperPct(b);
  const st = b.status === 'reading' ? (b.page ? `Trang ${b.page} / ${b.totalPages} · ${pct}%` : `Chưa đọc · ${b.totalPages} trang`) : PAPER_STATUS[b.status];
  return `<div class="row">
    <a class="row-link" href="#/paper/${encodeURIComponent(b.id)}">
      ${paperCover(b, 'cover sm')}
      <span class="row-text"><span class="t">${esc(inSeries ? `Tập ${b.volume || '?'}` : paperTitle(b))}</span>
      <span class="muted sm tnum">${esc(st)}${b.author && !inSeries ? ` · ${esc(b.author)}` : ''}</span>
      ${b.status === 'reading' && b.page ? bar(pct) : ''}</span>
    </a>
    ${inSeries ? '' : '<span class="badges"><span class="pill">Sách giấy</span></span>'}
  </div>`;
}

function paperContinueCard(b) {
  const pct = paperPct(b);
  return `<section aria-label="Đọc tiếp"><h2 class="h2">Đọc tiếp</h2>
    <div class="card cont">
      <a href="#/paper/${encodeURIComponent(b.id)}" class="cont-link" aria-label="${esc(paperTitle(b))}">${paperCover(b, 'cover lg')}</a>
      <div class="cont-body">
        <strong class="t">${esc(paperTitle(b))}</strong>
        <span class="muted sm tnum">Trang ${b.page || 0} / ${b.totalPages} · ${pct}% · ${esc(b.genre)}</span>
        ${bar(pct)}
        <div class="row-end"><span class="pill">Sách giấy</span><button type="button" class="btn primary" data-action="paper-log" data-id="${esc(b.id)}">Ghi lần đọc</button></div>
      </div></div></section>`;
}

const paperLogs = (id) => S.sessions.filter((s) => s.bookId === id && s.kind === 'paper' && !s.deleted).sort((a, b) => b.end - a.end);

function toDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Ngày chọn + giờ hiện tại (để thứ tự các lần đọc trong ngày vẫn đúng).
function fromDateInput(v) {
  const [y, m, d] = v.split('-').map(Number);
  const now = new Date();
  const t = new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
  return Math.min(+t, Date.now());
}
const fmtDay = (ts) => new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

function renderPaperDetail(id) {
  const b = S.paper[id];
  if (!b || b.deleted) { location.hash = '#/'; return; }
  const pct = paperPct(b);
  const logs = paperLogs(id);
  const totalMin = Math.round(logs.reduce((a, s) => a + s.activeSec, 0) / 60);
  const quotes = highlightsOf(S.highlights, id).sort((a, b) => (a.page || 0) - (b.page || 0));
  app.innerHTML = `
    <div class="page">
      <header class="top"><div class="top-left"><a class="icon-btn" href="#/" aria-label="Về thư viện">${icon('back')}</a><span class="pill">Sách giấy</span></div>
        <button type="button" class="icon-btn" data-action="paper-edit" data-id="${esc(id)}" aria-label="Sửa thông tin sách">${icon('edit')}</button></header>
      <main class="main">
        <section class="card cont">
          ${paperCover(b, 'cover lg')}
          <div class="cont-body">
            <h1 class="pb-title">${esc(paperTitle(b))}</h1>
            <span class="muted sm">${esc(b.author || 'Chưa có tác giả')} · ${esc(b.genre)} · ${b.totalPages} trang</span>
            ${b.translator || b.publisher ? `<span class="muted xs">${[b.translator ? `${esc(b.translator)} dịch` : '', esc(b.publisher || '')].filter(Boolean).join(' · ')}</span>` : ''}
            <span class="sm"><strong>${PAPER_STATUS[b.status]}</strong> · <span class="tnum">trang ${b.page || 0} / ${b.totalPages} · ${pct}%</span></span>
            ${bar(pct)}
          </div>
        </section>
        <section class="card pb-facts">
          <div><span class="muted xs">Bắt đầu</span><strong class="tnum">${fmtDay(b.startedAt)}</strong></div>
          <div><span class="muted xs">Đọc xong</span><strong class="tnum">${b.finishedAt ? fmtDay(b.finishedAt) : '—'}</strong></div>
          <div><span class="muted xs">Tổng thời gian</span><strong class="tnum">${totalMin >= 60 ? `${(totalMin / 60).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} giờ` : `${totalMin} phút`}</strong></div>
          <div><span class="muted xs">Số lần đọc</span><strong class="tnum">${logs.length}</strong></div>
        </section>
        <div class="pb-actions">
          <button type="button" class="btn primary" data-action="paper-log" data-id="${esc(id)}">Ghi lần đọc</button>
          ${b.series ? `<button type="button" class="btn ghost" data-action="paper-next-vol" data-id="${esc(id)}">${icon('plus', 18)}Thêm tập ${(b.volume || 0) + 1}</button>` : ''}
          ${b.status === 'dropped'
    ? `<button type="button" class="btn ghost" data-action="paper-status" data-id="${esc(id)}" data-status="reading">Đọc tiếp</button>`
    : b.status === 'reading' ? `<button type="button" class="btn ghost" data-action="paper-status" data-id="${esc(id)}" data-status="dropped">Bỏ dở</button>` : ''}
        </div>
        <section class="quotes" aria-label="Đoạn tâm đắc">
          <div class="sec-head"><h2 class="h2">Đoạn tâm đắc</h2>
            <label class="btn ghost sm">${icon('plus', 18)}Thêm từ ảnh<input type="file" accept="image/*" multiple class="visually-hidden" data-quote-photos="${esc(id)}"></label></div>
          ${quotes.length ? quotes.map((h) => hlCardHtml(h, false)).join('') : '<p class="muted sm">Chụp các trang có đoạn anh tâm đắc (chụp nhiều rồi thêm một lần cũng được). App đọc chữ, anh chạm câu đầu – câu cuối để giữ đúng đoạn. Đã gạch chân hoặc tô bút thì app tự lấy phần đó.</p>'}
        </section>
        <section aria-label="Các lần đọc"><h2 class="h2">Các lần đọc</h2>
          ${logs.length ? `<div class="card log-list">${logs.map((s) => `
            <div class="log">
              <div><strong class="tnum">${fmtDay(s.end)}</strong>
                <span class="muted sm tnum">Trang ${s.fromPage || 0} → ${s.toPage} (+${s.pages} trang) · ${Math.round(s.activeSec / 60)} phút</span></div>
              <button type="button" class="icon-btn sm" data-action="paper-log-del" data-id="${esc(s.id)}" aria-label="Xoá lần đọc ngày ${fmtDay(s.end)}">${icon('trash', 18)}</button>
            </div>`).join('')}</div>` : '<p class="muted sm">Chưa có lần đọc nào. Đọc xong một buổi thì bấm “Ghi lần đọc”.</p>'}
        </section>
        <button type="button" class="btn ghost danger" data-action="paper-del" data-id="${esc(id)}">Xoá sách này</button>
      </main>
    </div>`;
}

// Tính lại trang hiện tại & trạng thái từ các lần đọc còn lại (sau khi xoá một lần đọc).
async function recomputePaper(id) {
  const b = S.paper[id];
  if (!b) return;
  const logs = paperLogs(id);
  const latest = logs[0];
  b.page = latest ? latest.toPage : 0;
  b.lastReadAt = latest ? latest.end : null;
  if (b.page >= b.totalPages) { b.status = 'done'; b.finishedAt = b.finishedAt || latest.end; }
  else if (b.status === 'done') { b.status = 'reading'; b.finishedAt = null; }
  S.paper[id] = await savePaperBook(b);
}

function allGenres() {
  return [...new Set([...S.books.map((b) => b.genre), ...activePaper(S.paper).map((b) => b.genre)])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'vi'));
}

// rec: sách đang sửa; preset: điền sẵn khi thêm tập mới của một bộ.
function openPaperEditor(rec, preset) {
  const isNew = !rec;
  const b = rec || {
    title: '', series: '', volume: '', author: '', translator: '', publisher: '',
    genre: allGenres()[0] || '', totalPages: '', status: 'reading', page: 0, startedAt: Date.now(), ...(preset || {}),
  };
  const genres = allGenres();
  if (b.genre && !genres.includes(b.genre)) genres.unshift(b.genre);
  let coverBlob = null;
  document.querySelector('dialog.sheet')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.setAttribute('aria-label', isNew ? 'Thêm sách giấy' : 'Sửa sách giấy');
  const curCover = S.covers.get(b.id || '') || '';
  dlg.innerHTML = `
    <form class="sheet-body" novalidate>
      <h2 class="sheet-title">${isNew ? 'Thêm sách giấy' : 'Sửa thông tin sách'}</h2>
      <div class="cover-pick">
        <span class="cover lg ph pb-prev">${curCover ? `<img src="${curCover}" alt="">` : icon('book', 22)}</span>
        <div class="cover-pick-body">
          <label class="btn ghost" for="pb-photo">${icon('scan', 18)}${curCover ? 'Chụp lại bìa' : 'Chụp / chọn ảnh bìa'}</label>
          <input id="pb-photo" type="file" accept="image/*" class="visually-hidden">
          <p class="muted xs pb-hint" role="status">App đọc tên sách, tác giả, số tập từ ảnh bìa. Số trang anh nhập tay.</p>
        </div>
      </div>
      <label for="pb-title">Tên sách *</label>
      <input id="pb-title" type="text" value="${esc(b.title)}" autocomplete="off">
      <div class="two-col">
        <div><label for="pb-series">Tên bộ (truyện nhiều tập)</label>
          <input id="pb-series" type="text" value="${esc(b.series || '')}" autocomplete="off" list="pb-series-list">
          <datalist id="pb-series-list">${[...new Set(activePaper(S.paper).map((x) => x.series).filter(Boolean))].map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
        <div><label for="pb-vol">Tập số</label>
          <input id="pb-vol" type="number" inputmode="numeric" min="1" value="${esc(b.volume || '')}"></div>
      </div>
      <label for="pb-author">Tác giả</label>
      <input id="pb-author" type="text" value="${esc(b.author || '')}" autocomplete="off">
      <div class="two-col">
        <div><label for="pb-trans">Người dịch</label>
          <input id="pb-trans" type="text" value="${esc(b.translator || '')}" autocomplete="off"></div>
        <div><label for="pb-pub">Nhà xuất bản</label>
          <input id="pb-pub" type="text" value="${esc(b.publisher || '')}" autocomplete="off"></div>
      </div>
      <label for="pb-genre">Thể loại *</label>
      <select id="pb-genre">
        ${genres.map((g) => `<option ${g === b.genre ? 'selected' : ''}>${esc(g)}</option>`).join('')}
        <option value="__new" ${genres.length ? '' : 'selected'}>+ Thể loại mới…</option>
      </select>
      <input id="pb-genre-new" type="text" placeholder="Tên thể loại mới" autocomplete="off" ${genres.length ? 'hidden' : ''}>
      <label for="pb-pages">Tổng số trang *</label>
      <input id="pb-pages" type="number" inputmode="numeric" min="1" value="${esc(b.totalPages)}">
      <label for="pb-start">Ngày bắt đầu</label>
      <input id="pb-start" type="date" value="${toDateInput(b.startedAt)}" max="${toDateInput(Date.now())}">
      ${isNew ? '' : `
      <label for="pb-status">Trạng thái</label>
      <select id="pb-status">${Object.entries(PAPER_STATUS).map(([k, v]) => `<option value="${k}" ${k === b.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label for="pb-end">Ngày đọc xong</label>
      <input id="pb-end" type="date" value="${b.finishedAt ? toDateInput(b.finishedAt) : ''}" max="${toDateInput(Date.now())}">`}
      <p class="form-err" role="alert"></p>
      <div class="sheet-actions">
        <button type="button" class="btn ghost" data-x="cancel">Huỷ</button>
        <button type="submit" class="btn primary">Lưu</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const $ = (q) => dlg.querySelector(q);
  const hint = $('.pb-hint');

  // Truyện nhiều tập: lấy sẵn số trang, tác giả, thể loại từ tập gần nhất của cùng bộ.
  const fillFromSeries = () => {
    const name = $('#pb-series').value.trim();
    if (!name) return;
    const prev = activePaper(S.paper).filter((x) => x.series === name && x.id !== b.id).sort((x, y) => (y.volume || 0) - (x.volume || 0))[0];
    if (!prev) return;
    if (!$('#pb-pages').value) $('#pb-pages').value = prev.totalPages;
    if (!$('#pb-author').value) $('#pb-author').value = prev.author || '';
    if (!$('#pb-trans').value) $('#pb-trans').value = prev.translator || '';
    if (!$('#pb-pub').value) $('#pb-pub').value = prev.publisher || '';
    if (!$('#pb-vol').value && prev.volume) $('#pb-vol').value = prev.volume + 1;
    if ([...$('#pb-genre').options].some((o) => o.value === prev.genre)) { $('#pb-genre').value = prev.genre; $('#pb-genre-new').hidden = true; }
  };
  $('#pb-series').addEventListener('change', fillFromSeries);

  $('#pb-photo').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      coverBlob = await shrinkImage(file, 480, 0.8);
      $('.pb-prev').innerHTML = `<img src="${URL.createObjectURL(coverBlob)}" alt="">`;
    } catch { hint.textContent = 'Không đọc được ảnh này, thử ảnh khác.'; return; }
    if (netType() === 'offline') { hint.textContent = 'Đang offline: đã lưu ảnh bìa, anh nhập thông tin bằng tay.'; return; }
    const t0 = Date.now();
    hint.textContent = 'Đang đọc ảnh bìa…';
    const tick = setInterval(() => { hint.textContent = `Đang đọc ảnh bìa… ${Math.round((Date.now() - t0) / 1000)} giây`; }, 1000);
    try {
      const big = await shrinkImage(file, 1024, 0.8);
      const info = await readCoverText(S.settings.geminiKey, big).finally(() => clearInterval(tick));
      const set = (sel, v) => { if (v != null && v !== '') $(sel).value = v; };
      set('#pb-title', info.title);
      set('#pb-series', info.series || (info.volume ? info.title : ''));
      set('#pb-vol', info.volume);
      set('#pb-author', info.author);
      set('#pb-trans', info.translator);
      set('#pb-pub', info.publisher);
      fillFromSeries();
      const secs = Math.round((Date.now() - t0) / 1000);
      hint.textContent = info.title ? `Đã điền từ ảnh bìa sau ${secs} giây. Kiểm tra lại và nhập số trang.` : 'Không đọc được chữ trên bìa, anh nhập tay giúp em.';
      console.info('Đọc bìa bằng', info._model, 'sau', secs, 'giây');
    } catch (err) { clearInterval(tick); hint.textContent = err.message; }
  });
  $('#pb-genre').addEventListener('change', () => { $('#pb-genre-new').hidden = $('#pb-genre').value !== '__new'; });
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-x="cancel"]')) dlg.close(); });
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-err');
    const title = $('#pb-title').value.trim();
    const genre = $('#pb-genre').value === '__new' ? $('#pb-genre-new').value.trim() : $('#pb-genre').value;
    const totalPages = parseInt($('#pb-pages').value, 10);
    const volume = parseInt($('#pb-vol').value, 10) || null;
    const series = $('#pb-series').value.trim() || null;
    if (!title) { err.textContent = 'Nhập tên sách.'; return; }
    if (!genre) { err.textContent = 'Chọn hoặc nhập thể loại.'; return; }
    if (!(totalPages > 0)) { err.textContent = 'Nhập tổng số trang (số lớn hơn 0).'; return; }
    if (series && !volume) { err.textContent = 'Truyện nhiều tập: nhập số tập.'; return; }
    const next = {
      ...b,
      id: b.id || newPaperId(),
      title, series, volume, genre, totalPages,
      author: $('#pb-author').value.trim(),
      translator: $('#pb-trans').value.trim(),
      publisher: $('#pb-pub').value.trim(),
      startedAt: $('#pb-start').value ? fromDateInput($('#pb-start').value) : b.startedAt,
    };
    delete next.isbn;
    if (!isNew) {
      next.status = $('#pb-status').value;
      const endV = $('#pb-end').value;
      next.finishedAt = next.status === 'done' ? (endV ? fromDateInput(endV) : (b.finishedAt || Date.now())) : null;
      if (next.status === 'done' && (next.page || 0) < totalPages) next.page = totalPages;
    }
    if (coverBlob) {
      next.hasCover = true;
      next.coverFileId = null;
      S.covers.set(next.id, URL.createObjectURL(coverBlob));
    }
    S.paper[next.id] = await savePaperBook(next);
    dlg.close();
    toast(isNew ? 'Đã thêm sách giấy' : 'Đã lưu');
    if (isNew) location.hash = `#/paper/${encodeURIComponent(next.id)}`; else renderView();
    if (coverBlob) {
      const fid = await saveCover(next.id, coverBlob);
      if (fid) S.paper[next.id] = await savePaperBook({ ...S.paper[next.id], coverFileId: fid });
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

function openLogDialog(id) {
  const b = S.paper[id];
  if (!b) return;
  document.querySelector('dialog.sheet')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.setAttribute('aria-label', 'Ghi lần đọc');
  dlg.innerHTML = `
    <form class="sheet-body" novalidate>
      <h2 class="sheet-title">Ghi lần đọc</h2>
      <p class="muted sm">${esc(b.title)} · đang ở trang <span class="tnum">${b.page || 0} / ${b.totalPages}</span></p>
      <label for="lg-page">Đọc đến trang *</label>
      <input id="lg-page" type="number" inputmode="numeric" min="1" max="${b.totalPages}" autocomplete="off">
      <label for="lg-min">Thời gian đọc (phút) *</label>
      <input id="lg-min" type="number" inputmode="numeric" min="1" max="720" autocomplete="off">
      <label for="lg-date">Ngày đọc</label>
      <input id="lg-date" type="date" value="${toDateInput(Date.now())}" max="${toDateInput(Date.now())}">
      <p class="form-err" role="alert"></p>
      <div class="sheet-actions">
        <button type="button" class="btn ghost" data-x="cancel">Huỷ</button>
        <button type="submit" class="btn primary">Lưu</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const $ = (q) => dlg.querySelector(q);
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-x="cancel"]')) dlg.close(); });
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-err');
    const toPage = parseInt($('#lg-page').value, 10);
    const minutes = parseInt($('#lg-min').value, 10);
    if (!(toPage >= 1 && toPage <= b.totalPages)) { err.textContent = `Trang phải từ 1 đến ${b.totalPages}.`; return; }
    if (!(minutes >= 1 && minutes <= 720)) { err.textContent = 'Nhập số phút đọc (1–720).'; return; }
    const end = $('#lg-date').value ? fromDateInput($('#lg-date').value) : Date.now();
    const fromPage = b.page || 0;
    const rec = {
      id: crypto.randomUUID(), kind: 'paper', bookId: b.id, title: paperTitle(b), genre: b.genre, series: b.series || null, vol: b.volume || null,
      start: end - minutes * 60_000, end, rev: Date.now(), activeSec: minutes * 60,
      pages: Math.max(0, toPage - fromPage), fromPage, toPage, device: 'Sách giấy',
    };
    await db.set('sessions', null, rec);
    S.sessions.push(rec);
    b.page = toPage;
    b.lastReadAt = Math.max(b.lastReadAt || 0, end);
    if (toPage >= b.totalPages) { b.status = 'done'; b.finishedAt = b.finishedAt || end; }
    else { b.status = 'reading'; b.finishedAt = null; }
    S.paper[id] = await savePaperBook(b);
    scheduleSync(5000);
    dlg.close();
    toast(b.status === 'done' ? 'Đã ghi – đã đọc xong cuốn này' : `Đã ghi +${rec.pages} trang, ${minutes} phút`);
    renderView();
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  $('#lg-page').focus();
}

function seriesCard(g) {
  const items = g.items.sort((a, b) => a.vol - b.vol);
  const done = items.filter((i) => isFinished(i.id)).length;
  const key = `${items[0].genre}/${g.series}`;
  const open = S.expanded.has(key);
  const segs = items.map((i) => {
    const p = S.progress[i.id];
    const cls = p?.finished ? 'done' : p ? 'cur' : '';
    return `<i class="${cls}" title="Tập ${i.vol}"></i>`;
  }).join('');
  const current = items.find((i) => S.progress[i.id] && !isFinished(i.id)) || items.find((i) => !isFinished(i.id));
  return `<div class="card series">
    <button type="button" class="series-head" data-action="toggle" data-key="${esc(key)}" aria-expanded="${open}">
      <span class="t">${esc(g.series)}</span>
      <span class="muted sm tnum">${done} / ${items.length} tập xong</span>
      ${icon('chevron', 18)}
    </button>
    <div class="segs" style="grid-template-columns:repeat(${items.length},minmax(0,1fr))">${segs}</div>
    ${current && !open ? `<div class="row-end"><span class="muted sm">Tiếp theo: Tập ${current.vol}</span><span class="badges">${offlineBadge(current, false)}</span><a class="btn ghost sm" href="#/read/${encodeURIComponent(current.id)}">Đọc</a></div>` : ''}
    ${open ? `<div class="vols">${items.map((i) => bookRow(i, true)).join('')}</div>` : ''}
  </div>`;
}

function bookRow(b, inSeries) {
  const p = S.progress[b.id];
  const pct = p ? Math.round((p.last / p.total) * 100) : 0;
  return `<div class="row">
    <a class="row-link" href="#/read/${encodeURIComponent(b.id)}">
      ${cover(b, 'cover sm')}
      <span class="row-text"><span class="t">${esc(inSeries ? `Tập ${b.vol}` : b.title)}</span>
      <span class="muted sm tnum">${esc(progressText(b))} · ${fmtMB(b.size)}</span>
      ${p && !p.finished ? bar(pct) : ''}</span>
    </a>
    <span class="badges">${offlineBadge(b, false)}</span>
  </div>`;
}

function nav(active) {
  const item = (key, href, ic, label) => `<a href="${href}" class="${active === key ? 'on' : ''}" ${active === key ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`;
  const notesHref = S.notesSeg === 'hl' ? '#/hl' : '#/articles';
  return `<nav class="nav" aria-label="Điều hướng chính">${item('lib', '#/', 'library', 'Thư viện')}${item('art', notesHref, 'article', 'Ghi chép')}${item('stats', '#/stats', 'stats', 'Thống kê')}</nav>`;
}

function renderWelcome() {
  app.innerHTML = `
    <div class="page welcome">
      <main class="main center">
        <h1>Đọc sách</h1>
        <p class="muted">Đọc PDF từ Google Drive, đọc được offline, theo dõi thói quen đọc.</p>
        <button type="button" class="btn primary lg" data-action="signin">Đăng nhập Google</button>
        <p class="muted xs">Lần đầu, Google có thể báo “Google chưa xác minh ứng dụng này”. Bấm <strong>Nâng cao → Tiếp tục</strong>, vì đây là app riêng của bạn.</p>
        ${netType() === 'offline' ? '<p class="banner">Đang offline – cần mạng để đăng nhập lần đầu.</p>' : ''}
      </main>
    </div>`;
}

function renderPlaceholder(which) {
  const sessions = S.sessions.filter((s) => s.activeSec >= CONFIG.minSessionSec).length;
  const body = `<h1>Thống kê</h1><div class="card"><p><strong>Thống kê chi tiết sẽ có ở giai đoạn P2</strong> (heatmap, phút đọc theo thể loại và theo bộ).</p><p class="muted">App đã bắt đầu ghi phiên đọc từ bây giờ, hiện có <span class="tnum">${sessions}</span> phiên hợp lệ, nên khi lên P2 sẽ có sẵn dữ liệu.</p></div>`;
  app.innerHTML = `<div class="page"><main class="main">${body}</main>${nav(which)}</div>`;
}

// ---------------- Màn Bài viết ----------------
// Nhận link được chia sẻ từ app khác (Web Share Target): ./?title=…&text=…&url=…
function readShareParams() {
  const q = new URLSearchParams(location.search);
  if (!q.has('url') && !q.has('text') && !q.has('title')) return null;
  const raw = q.get('url') || extractUrl(q.get('text')) || extractUrl(q.get('title'));
  history.replaceState(null, '', `${location.pathname}#/articles`);
  S.route = '#/articles';
  if (!raw) { setTimeout(() => toast('Không tìm thấy link trong nội dung được chia sẻ'), 300); return null; }
  let title = (q.get('title') || '').trim();
  if (!title) title = (q.get('text') || '').replace(raw, '').trim();
  if (/^https?:\/\//.test(title)) title = '';
  return { url: raw, title };
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function filteredArticles() {
  const q = S.artQuery.trim().toLowerCase();
  return activeList(S.articles).filter((a) => (!S.artTag || a.tags.includes(S.artTag))
    && (!S.artKind || (S.artKind === 'podcast') === isPodcast(a))
    && (!q || a.title.toLowerCase().includes(q) || a.source.toLowerCase().includes(q)));
}

// Đầu màn Ghi chép (mở luôn thẻ <main>), dùng chung cho 2 mục Bài viết | Highlight.
function notesHead(seg) {
  S.notesSeg = seg;
  const allArt = activeList(S.articles);
  const nPod = allArt.filter(isPodcast).length;
  const nArt = allArt.length - nPod;
  const nHl = activeHighlights(S.highlights).length;
  return `
      <header class="top"><div><h1>Ghi chép</h1><span class="muted sm tnum">${nArt} bài đã đọc${nPod ? ` · ${nPod} podcast` : ''} · ${nHl} highlight</span></div></header>
      <main class="main">
        <nav class="seg-tabs notes-seg" aria-label="Loại ghi chép">
          <a href="#/articles" class="${seg === 'art' ? 'on' : ''}" ${seg === 'art' ? 'aria-current="page"' : ''}>Bài viết</a>
          <a href="#/hl" class="${seg === 'hl' ? 'on' : ''}" ${seg === 'hl' ? 'aria-current="page"' : ''}>Highlight</a>
        </nav>`;
}

function renderArticles() {
  const all = activeList(S.articles);
  const tags = tagCounts(all);
  if (S.artTag && !tags.some(([t]) => t === S.artTag)) S.artTag = '';
  app.innerHTML = `
    <div class="page">
      ${notesHead('art')}
        <section class="card form" aria-label="Thêm bài đã đọc">
          <label for="art-url">Thêm bài đã đọc / podcast đã nghe</label>
          <div class="inline">
            <input id="art-url" type="url" inputmode="url" placeholder="Dán link bài viết hoặc tập Spotify" autocomplete="off">
            <button type="button" class="btn primary" data-action="art-add">Thêm</button>
          </div>
          <p class="muted xs">Trên điện thoại: trong app Substack hoặc Spotify bấm <strong>Chia sẻ → Đọc sách</strong>.</p>
        </section>
        ${all.length ? `
        <section class="art-tools" aria-label="Lọc bài viết">
          <input id="art-q" type="search" placeholder="Tìm theo tiêu đề, nguồn, chương trình" value="${esc(S.artQuery)}" autocomplete="off" aria-label="Tìm bài viết">
          ${all.some(isPodcast) ? `<div class="tagbar" role="group" aria-label="Lọc theo loại">
            ${[['', 'Tất cả', all.length], ['post', 'Bài viết', all.filter((a) => !isPodcast(a)).length], ['podcast', '🎧 Podcast', all.filter(isPodcast).length]]
              .map(([k, l, n]) => `<button type="button" class="tag ${S.artKind === k ? 'on' : ''}" data-action="art-kind" data-kind="${k}" aria-pressed="${S.artKind === k}">${l} <span class="tnum">${n}</span></button>`).join('')}
          </div>` : ''}
          <div class="tagbar" role="group" aria-label="Lọc theo tag">
            <button type="button" class="tag ${S.artTag ? '' : 'on'}" data-action="art-tag" data-tag="" aria-pressed="${!S.artTag}">Mọi tag</button>
            ${tags.map(([t, n]) => `<button type="button" class="tag ${S.artTag === t ? 'on' : ''}" data-action="art-tag" data-tag="${esc(t)}" aria-pressed="${S.artTag === t}">${esc(t)} <span class="tnum">${n}</span></button>`).join('')}
          </div>
        </section>
        <section class="list" id="art-list" aria-label="Danh sách bài viết">${artListHtml()}</section>` : `
        <div class="card empty"><p>Chưa có gì. Đọc xong một bài trên Substack hoặc nghe xong một tập trên Spotify thì chia sẻ vào đây, hoặc dán link ở trên.</p></div>`}
      </main>
      ${nav('art')}
    </div>`;
}

function artListHtml() {
  const list = filteredArticles();
  if (!list.length) return '<p class="muted sm">Không có bài nào khớp.</p>';
  return list.map((a) => `
    <article class="card art${isPodcast(a) ? ' pod' : ''}">
      <a class="art-link" href="${esc(a.url)}" target="_blank" rel="noopener">
        ${isPodcast(a) ? `<span class="pod-cover" aria-hidden="true">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '🎧'}</span>` : ''}
        <span class="art-text">
          <span class="t2">${esc(a.title)}</span>
          <span class="muted xs">${isPodcast(a)
            ? `🎧 ${esc(a.source)}${a.minutes ? ` · <span class="tnum">${a.minutes}</span> phút` : ''} · nghe ${fmtDate(a.readAt)}`
            : `${esc(a.source)} · đọc ${fmtDate(a.readAt)}`}</span>
        </span>
      </a>
      <div class="art-foot">
        <div class="tags">${a.tags.map((t) => `<button type="button" class="tag sm" data-action="art-tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('') || '<span class="muted xs">Chưa có tag</span>'}</div>
        <div class="art-actions">
          <button type="button" class="icon-btn sm" data-action="art-edit" data-id="${esc(a.id)}" aria-label="Sửa tiêu đề và tag">${icon('edit', 18)}</button>
          <button type="button" class="icon-btn sm" data-action="art-del" data-id="${esc(a.id)}" aria-label="Xoá bài">${icon('trash', 18)}</button>
        </div>
      </div>
    </article>`).join('');
}

function addFromInput() {
  const el = app.querySelector('#art-url');
  const raw = extractUrl(el?.value) || el?.value?.trim();
  if (!raw || !cleanUrl(raw)) { toast('Link không hợp lệ'); el?.focus(); return; }
  openArticleEditor({ url: raw, title: '' });
}

// Hộp sửa: tiêu đề + tag (gõ rồi Enter hoặc dấu phẩy để thêm; chạm gợi ý để thêm nhanh).
function openArticleEditor({ url, title }) {
  if (/^https?:\/\/spotify\.link\//i.test(String(url))) { toast('Link rút gọn spotify.link: mở link trong trình duyệt rồi dán link open.spotify.com'); return; }
  const id = cleanUrl(url);
  if (!id) { toast('Link không hợp lệ'); return; }
  const pod = isPodcastUrl(id);
  const prev = S.articles[id] && !S.articles[id].deleted ? S.articles[id] : null;
  // Spotify khi chia sẻ thường gửi kèm câu chào chứ không phải tên tập → bỏ, để tự lấy.
  if (pod && title && /spotify|listen to|nghe tập|check out/i.test(title)) title = '';
  let tags = prev ? [...prev.tags] : [];
  const allTags = tagCounts(activeList(S.articles)).map(([t]) => t);
  document.querySelector('dialog.sheet')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  const noun = pod ? 'tập podcast đã nghe' : 'bài đã đọc';
  const shows = showNames(activeList(S.articles));
  let cover = prev?.cover || '';
  dlg.setAttribute('aria-label', `Lưu ${noun}`);
  dlg.innerHTML = `
    <form method="dialog" class="sheet-body">
      <h2 class="sheet-title">${prev ? `Sửa ${noun}` : `Lưu ${noun}`}</h2>
      ${prev ? `<p class="muted xs">${pod ? 'Tập' : 'Bài'} này đã có trong danh sách.</p>` : ''}
      ${pod ? `<div class="pod-head"><span class="pod-cover lg" aria-hidden="true">${cover ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer">` : '🎧'}</span><p class="muted xs url-line">${esc(id)}</p></div>
      <p class="muted xs pod-status" role="status" aria-live="polite"></p>` : `<p class="muted xs url-line">${esc(id)}</p>`}
      <label for="art-title">${pod ? 'Tên tập' : 'Tiêu đề'}</label>
      <input id="art-title" type="text" value="${esc(title || prev?.title || (pod ? '' : titleFromUrl(id)))}" autocomplete="off">
      ${pod ? `
      <label for="art-show">Chương trình</label>
      <input id="art-show" type="text" list="art-show-list" value="${esc(prev && prev.source !== 'Spotify' ? prev.source : '')}" autocomplete="off">
      <datalist id="art-show-list">${shows.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <label for="art-min">Số phút</label>
      <input id="art-min" type="number" inputmode="numeric" min="1" max="999" value="${prev?.minutes || ''}">` : ''}
      <label for="art-tag-in">Tag</label>
      <div class="tag-input">
        <span class="chosen"></span>
        <input id="art-tag-in" type="text" placeholder="Gõ tag rồi Enter, ví dụ tin-tuc" autocomplete="off" autocapitalize="off" enterkeyhint="done">
      </div>
      <div class="sugg" aria-label="Tag đã dùng"></div>
      <div class="sheet-actions">
        <button type="button" class="btn ghost" value="cancel" data-x="cancel">Huỷ</button>
        <button type="submit" class="btn primary" value="save">Lưu</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const tagIn = dlg.querySelector('#art-tag-in');
  const draw = () => {
    dlg.querySelector('.chosen').innerHTML = tags.map((t) => `<button type="button" class="tag on sm" data-rm="${esc(t)}" aria-label="Bỏ tag ${esc(t)}">${esc(t)} ×</button>`).join('');
    const typed = normTag(tagIn.value);
    const sugg = allTags.filter((t) => !tags.includes(t) && (!typed || t.includes(typed))).slice(0, 12);
    dlg.querySelector('.sugg').innerHTML = sugg.map((t) => `<button type="button" class="tag sm" data-add="${esc(t)}">+ ${esc(t)}</button>`).join('');
  };
  const addTyped = () => {
    for (const part of tagIn.value.split(',')) { const t = normTag(part); if (t && !tags.includes(t)) tags.push(t); }
    tagIn.value = '';
    draw();
  };
  tagIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTyped(); }
    else if (e.key === 'Backspace' && !tagIn.value && tags.length) { tags.pop(); draw(); }
  });
  tagIn.addEventListener('input', () => { if (tagIn.value.includes(',')) addTyped(); else draw(); });
  dlg.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    const add = e.target.closest('[data-add]');
    if (rm) { tags = tags.filter((t) => t !== rm.dataset.rm); draw(); }
    if (add) { tags.push(add.dataset.add); draw(); tagIn.focus(); }
    if (e.target.closest('[data-x="cancel"]')) dlg.close('cancel');
  });
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    addTyped();
    try {
      const extra = pod ? { show: dlg.querySelector('#art-show').value, minutes: dlg.querySelector('#art-min').value, cover } : {};
      const { existed } = await upsertArticle({ url: id, title: dlg.querySelector('#art-title').value, tags, ...extra });
      S.articles = await loadArticles();
      dlg.close('save');
      toast(existed ? (pod ? 'Đã cập nhật tập' : 'Đã cập nhật bài') : (pod ? 'Đã lưu tập podcast đã nghe' : 'Đã lưu bài đã đọc'));
      const inp = app.querySelector('#art-url');
      if (inp) inp.value = '';
      if ((S.route || '').startsWith('#/articles')) renderArticles(); else location.hash = '#/articles';
    } catch (err) { toast(err.message); }
  });
  const stop = new AbortController();
  dlg.addEventListener('close', () => { stop.abort(); dlg.remove(); });
  draw();
  dlg.showModal();
  if (pod) fillPodcast(dlg, id, prev, stop.signal, (c) => { cover = c; });
  if (!prev) tagIn.focus();
}

// Tự điền tập podcast: chỉ điền ô còn trống, không đè chữ chủ app đã gõ.
async function fillPodcast(dlg, url, prev, signal, setCover) {
  const $ = (sel) => dlg.querySelector(sel);
  const status = (t) => { const el = $('.pod-status'); if (el) el.textContent = t; };
  const fill = (sel, v) => { const el = $(sel); if (el && v && !el.value.trim()) el.value = v; };
  const needCover = !prev?.cover;
  const needMeta = !prev || !prev.minutes || !prev.source || prev.source === 'Spotify';
  if (!needCover && !needMeta) return;
  let title = $('#art-title').value.trim();
  if (needCover || !title) {
    try {
      const o = await spotifyOembed(url, signal);
      fill('#art-title', o.title);
      title = title || o.title;
      if (o.cover && needCover) {
        setCover(o.cover);
        const box = $('.pod-cover');
        if (box) box.innerHTML = `<img src="${esc(o.cover)}" alt="" referrerpolicy="no-referrer">`;
      }
    } catch { /* Gemini bên dưới vẫn lấy được tên tập */ }
  }
  if (!needMeta || signal.aborted) return;
  const key = S.settings.geminiKey;
  if (!key) { status('Chưa có Gemini API key (Cài đặt) nên cần nhập tay tên chương trình và số phút.'); return; }
  const t0 = Date.now();
  status('Đang lấy tên chương trình và số phút…');
  const tick = setInterval(() => status(`Đang lấy tên chương trình và số phút… ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
  try {
    const info = await readPodcastPage(key, url, title, signal);
    if (signal.aborted) return;
    fill('#art-title', info.title);
    fill('#art-show', info.show);
    fill('#art-min', info.minutes);
    status(`Đã điền tự động (${Math.round((Date.now() - t0) / 1000)}s), kiểm tra lại trước khi lưu.`);
  } catch (e) {
    if (!signal.aborted) status(`Không tự lấy được, nhập tay giúp: ${e.message}`);
  } finally { clearInterval(tick); }
}

// ---------------- Highlight (mục con của Ghi chép) ----------------
function filteredHighlights() {
  const q = S.hlQuery.trim().toLowerCase();
  return activeHighlights(S.highlights).filter((h) => (!S.hlTag || h.tags.includes(S.hlTag))
    && (!q || h.text.toLowerCase().includes(q) || h.note.toLowerCase().includes(q) || (h.bookTitle || '').toLowerCase().includes(q)));
}

function renderHighlights() {
  const all = activeHighlights(S.highlights);
  const tags = tagCounts(all);
  if (S.hlTag && !tags.some(([t]) => t === S.hlTag)) S.hlTag = '';
  app.innerHTML = `
    <div class="page">
      ${notesHead('hl')}
        ${all.length ? `
        <section class="art-tools" aria-label="Lọc highlight">
          <input id="hl-q" type="search" placeholder="Tìm trong đoạn trích, ghi chú, tên sách" value="${esc(S.hlQuery)}" autocomplete="off" aria-label="Tìm highlight">
          ${tags.length ? `<div class="tagbar" role="group" aria-label="Lọc theo tag">
            <button type="button" class="tag ${S.hlTag ? '' : 'on'}" data-action="hl-tag" data-tag="" aria-pressed="${!S.hlTag}">Tất cả <span class="tnum">${all.length}</span></button>
            ${tags.map(([t, n]) => `<button type="button" class="tag ${S.hlTag === t ? 'on' : ''}" data-action="hl-tag" data-tag="${esc(t)}" aria-pressed="${S.hlTag === t}">${esc(t)} <span class="tnum">${n}</span></button>`).join('')}
          </div>` : ''}
        </section>
        <section class="list" id="hl-list" aria-label="Highlight theo sách">${hlListHtml()}</section>` : `
        <div class="card empty"><p><strong>Chưa có highlight.</strong></p>
          <p class="muted sm">Khi đọc sách chữ: giữ tay lên một từ, kéo hai đầu để chọn cả cụm, rồi bấm <strong>Highlight</strong> hoặc <strong>Ghi chú</strong> trên thanh hiện ra ở dưới. Trên laptop thì kéo chuột để chọn.</p>
          <p class="muted xs">PDF dạng ảnh scan (truyện tranh, nhiều file kiếm hiệp) không có chữ bên trong nên chưa chọn được.</p></div>`}
      </main>
      ${nav('art')}
    </div>`;
}

// Thẻ một highlight. inList: đang ở Ghi chép (bấm = mở sách); ngoài ra (trang sách giấy) bấm = sửa.
function hlCardHtml(h, inList) {
  const paper = h.source === 'paper';
  const openAct = inList ? 'hl-open' : 'hl-edit';
  const openLabel = inList ? (paper ? 'Mở trang sách giấy' : `Mở sách tới trang ${h.page}`) : 'Sửa đoạn tâm đắc';
  return `
      <article class="card hl">
        <button type="button" class="hl-open" data-action="${openAct}" data-id="${esc(h.id)}" aria-label="${openLabel}">
          <blockquote class="hl-quote">${esc(h.text)}</blockquote>
          ${h.note ? `<p class="hl-note">${esc(h.note)}</p>` : ''}
          <span class="muted xs tnum">${paper && inList ? '<span class="pill">Sách giấy</span> ' : ''}${h.page ? `Trang ${h.page} · ` : ''}${fmtDate(h.createdAt)}</span>
        </button>
        <div class="art-foot">
          <div class="tags">${h.tags.map((t) => (inList ? `<button type="button" class="tag sm" data-action="hl-tag" data-tag="${esc(t)}">${esc(t)}</button>` : `<span class="tag sm">${esc(t)}</span>`)).join('') || '<span class="muted xs">Chưa có tag</span>'}</div>
          <div class="art-actions">
            <button type="button" class="icon-btn sm" data-action="hl-edit" data-id="${esc(h.id)}" aria-label="Sửa ghi chú và tag">${icon('edit', 18)}</button>
            <button type="button" class="icon-btn sm" data-action="hl-del" data-id="${esc(h.id)}" aria-label="Xoá">${icon('trash', 18)}</button>
          </div>
        </div>
      </article>`;
}

function hlListHtml() {
  const groups = groupByBook(filteredHighlights());
  if (!groups.length) return '<p class="muted sm">Không có highlight nào khớp.</p>';
  return groups.map((g) => `
    <section class="hl-group" aria-label="${esc(g.title)}">
      <div class="hl-group-head"><strong>${esc(g.title)}</strong><span class="muted xs tnum">${g.items.length} highlight</span></div>
      ${g.items.map((h) => hlCardHtml(h, true)).join('')}
    </section>`).join('');
}

function openHighlightFromList(id) {
  const h = S.highlights[id];
  if (!h || h.deleted) return;
  if (h.source === 'paper') {
    const pb = S.paper[h.bookId];
    if (!pb || pb.deleted) { toast('Sách giấy này đã bị xoá. Đoạn tâm đắc vẫn được giữ lại.'); return; }
    location.hash = `#/paper/${encodeURIComponent(h.bookId)}`;
    return;
  }
  if (!bookById(h.bookId)) { toast('Sách này không còn trong thư mục Drive. Highlight vẫn được giữ lại.'); return; }
  S.jump = { id: h.bookId, page: h.page, flashId: h.id };
  location.hash = `#/read/${encodeURIComponent(h.bookId)}`;
}

async function removeHighlight(id) {
  const before = await deleteHighlight(id);
  S.highlights = await loadHighlights();
  S.reader?.refreshHighlights();
  if (!S.reader) renderView();
  if (before) {
    toast('Đã xoá highlight', { label: 'Hoàn tác', fn: async () => {
      await restoreHighlight(before);
      S.highlights = await loadHighlights();
      S.reader?.refreshHighlights();
      if (!S.reader) renderView();
    } });
  }
}

// Thao tác trên đoạn chữ đã chọn trong trình đọc.
function onReaderSelection(b, action, sel) {
  const text = sel.text;
  if (action === 'search') {
    if (netType() === 'offline') { toast('Cần mạng để tìm trên Google'); return; }
    window.open(`https://www.google.com/search?q=${encodeURIComponent(text.slice(0, 300))}`, '_blank', 'noopener');
    return;
  }
  if (action === 'copy') {
    navigator.clipboard?.writeText(text).then(() => toast('Đã sao chép'), () => toast('Không sao chép được'));
    return;
  }
  const draft = { bookId: b.id, bookTitle: displayTitle(b), genre: b.genre, page: sel.page, text, rects: sel.rects, note: '', tags: [] };
  if (action === 'note') { openHighlightEditor(draft); return; }
  if (action === 'highlight') {
    saveHighlight(draft).then(async (rec) => {
      S.highlights = await loadHighlights();
      S.reader?.refreshHighlights();
      toast('Đã highlight', { label: 'Thêm ghi chú', fn: () => openHighlightEditor(S.highlights[rec.id]) });
    }).catch(() => toast('Không lưu được highlight'));
  }
}

// Hộp ghi chú cho highlight: đoạn trích (chỉ xem), ghi chú, tag. rec có id = sửa; không có id = highlight mới.
function openHighlightEditor(rec) {
  if (!rec) return;
  const isNew = !rec.id;
  let tags = [...(rec.tags || [])];
  const allTags = tagCounts(activeHighlights(S.highlights)).map(([t]) => t);
  document.querySelector('dialog.sheet')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.setAttribute('aria-label', isNew ? 'Highlight và ghi chú' : 'Sửa highlight');
  dlg.innerHTML = `
    <form method="dialog" class="sheet-body">
      <h2 class="sheet-title">${isNew ? 'Highlight và ghi chú' : 'Sửa highlight'}</h2>
      ${rec.source === 'paper' ? `
      <p class="muted xs">${esc(rec.bookTitle)}</p>
      <label for="hl-text">Đoạn tâm đắc</label>
      <textarea id="hl-text" rows="5">${esc(rec.text)}</textarea>
      <label for="hl-page">Trang</label>
      <input id="hl-page" type="number" inputmode="numeric" min="1" value="${rec.page || ''}">` : `
      <p class="muted xs">${esc(rec.bookTitle)} · Trang <span class="tnum">${rec.page}</span></p>
      <blockquote class="hl-quote hl-sheet-quote">${esc(rec.text)}</blockquote>`}
      <label for="hl-note">Ghi chú</label>
      <textarea id="hl-note" rows="4" placeholder="Anh nghĩ gì về đoạn này?">${esc(rec.note || '')}</textarea>
      <label for="hl-tag-in">Tag</label>
      <div class="tag-input">
        <span class="chosen"></span>
        <input id="hl-tag-in" type="text" placeholder="Gõ tag rồi Enter, ví dụ y-tuong" autocomplete="off" autocapitalize="off" enterkeyhint="done">
      </div>
      <div class="sugg" aria-label="Tag đã dùng"></div>
      ${isNew ? '' : '<button type="button" class="btn ghost danger" data-x="del">Xoá highlight</button>'}
      <div class="sheet-actions">
        <button type="button" class="btn ghost" data-x="cancel">Huỷ</button>
        <button type="submit" class="btn primary">Lưu</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const tagIn = dlg.querySelector('#hl-tag-in');
  const draw = () => {
    dlg.querySelector('.chosen').innerHTML = tags.map((t) => `<button type="button" class="tag on sm" data-rm="${esc(t)}" aria-label="Bỏ tag ${esc(t)}">${esc(t)} ×</button>`).join('');
    const typed = normTag(tagIn.value);
    const sugg = allTags.filter((t) => !tags.includes(t) && (!typed || t.includes(typed))).slice(0, 12);
    dlg.querySelector('.sugg').innerHTML = sugg.map((t) => `<button type="button" class="tag sm" data-add="${esc(t)}">+ ${esc(t)}</button>`).join('');
  };
  const addTyped = () => {
    for (const part of tagIn.value.split(',')) { const t = normTag(part); if (t && !tags.includes(t)) tags.push(t); }
    tagIn.value = '';
    draw();
  };
  tagIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTyped(); }
    else if (e.key === 'Backspace' && !tagIn.value && tags.length) { tags.pop(); draw(); }
  });
  tagIn.addEventListener('input', () => { if (tagIn.value.includes(',')) addTyped(); else draw(); });
  dlg.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    const add = e.target.closest('[data-add]');
    if (rm) { tags = tags.filter((t) => t !== rm.dataset.rm); draw(); }
    if (add) { tags.push(add.dataset.add); draw(); tagIn.focus(); }
    if (e.target.closest('[data-x="cancel"]')) dlg.close('cancel');
    if (e.target.closest('[data-x="del"]')) { dlg.close('del'); removeHighlight(rec.id); }
  });
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    addTyped();
    try {
      const extra = {};
      if (rec.source === 'paper') {
        extra.text = dlg.querySelector('#hl-text').value;
        if (!extra.text.trim()) { toast('Đoạn tâm đắc đang trống'); return; }
        extra.page = parseInt(dlg.querySelector('#hl-page').value, 10) || null;
      }
      await saveHighlight({ ...rec, ...extra, note: dlg.querySelector('#hl-note').value, tags });
      S.highlights = await loadHighlights();
      dlg.close('save');
      toast(isNew ? 'Đã lưu highlight' : 'Đã cập nhật highlight');
      S.reader?.refreshHighlights();
      if (!S.reader) renderView();
    } catch { toast('Không lưu được highlight'); }
  });
  dlg.addEventListener('close', () => { dlg.remove(); S.reader?.stage?.focus({ preventScroll: true }); });
  draw();
  dlg.showModal();
  if (isNew) dlg.querySelector('#hl-note').focus();
}

// ---------------- Đoạn tâm đắc từ ảnh chụp sách giấy ----------------
// Chọn nhiều ảnh một lúc → Gemini đọc lần lượt (chạy trước ở nền) → mỗi ảnh: lấy phần đã đánh dấu bằng bút,
// hoặc chạm câu đầu – câu cuối → ghi chú, tag → lưu như highlight (source 'paper'). Ảnh gốc không lưu lại.
function openQuoteBatch(bookId, files) {
  const pb = S.paper[bookId];
  if (!pb) return;
  if (!S.settings.geminiKey) { toast('Cần Gemini API key để đọc chữ từ ảnh (vào Cài đặt để nhập)'); return; }
  const items = files.map((f) => ({ file: f, url: URL.createObjectURL(f), state: 'wait', res: null, err: '' }));
  let idx = 0;
  let saved = 0;
  let closed = false;

  // Đọc ảnh tuần tự ở nền, để ảnh kế tiếp thường đã xong khi anh chọn xong ảnh hiện tại.
  const runOcr = async (it) => {
    it.state = 'busy';
    it.err = '';
    try {
      const blob = await shrinkImage(it.file, 2000, 0.85);
      it.res = await readPageText(S.settings.geminiKey, blob);
      it.state = 'ok';
    } catch (err) { it.state = 'err'; it.err = err.message || 'Không đọc được ảnh'; }
    if (!closed && items[idx] === it) { setupItem(); draw(); }
  };
  (async () => { for (const it of items) { if (closed) break; if (it.state === 'wait') await runOcr(it); } })();

  document.querySelector('dialog.sheet')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet quote-sheet';
  dlg.setAttribute('aria-label', 'Thêm đoạn tâm đắc');
  document.body.appendChild(dlg);
  const allTags = tagCounts(activeHighlights(S.highlights)).map(([t]) => t);
  let tags = [];
  let sents = [];
  let a = -1;
  let b = -1;
  let mode = 'pick'; // 'marked' | 'pick'

  const fromRange = () => {
    if (a < 0) return '';
    const [lo, hi] = b < 0 ? [a, a] : [Math.min(a, b), Math.max(a, b)];
    let out = '';
    for (let i = lo; i <= hi; i += 1) out += (i > lo ? (sents[i].para !== sents[i - 1].para ? '\n\n' : ' ') : '') + sents[i].t;
    return out;
  };

  const setupItem = () => {
    const it = items[idx];
    a = -1; b = -1;
    sents = it.res ? splitSentences(it.res.text) : [];
    mode = it.res?.markedText ? 'marked' : 'pick';
  };

  function draw() {
    const it = items[idx];
    const n = items.length;
    const head = `<h2 class="sheet-title">Đoạn tâm đắc${n > 1 ? ` · ảnh <span class="tnum">${idx + 1}/${n}</span>` : ''}</h2>
      <p class="muted xs">${esc(paperTitle(pb))}</p>
      <img class="quote-thumb" src="${it.url}" alt="Ảnh trang sách đang xử lý">`;
    let body;
    if (it.state === 'wait' || it.state === 'busy') {
      body = '<p class="muted sm" role="status">Đang đọc chữ trong ảnh… (khoảng 5–15 giây)</p>';
    } else if (it.state === 'err') {
      body = `<p class="form-err" role="alert">${esc(it.err)}</p>
        <div class="pb-actions"><button type="button" class="btn" data-q="retry">Thử lại</button><button type="button" class="btn ghost" data-q="manual">Tự gõ đoạn này</button></div>`;
    } else {
      const marked = mode === 'marked';
      const text = marked ? it.res.markedText : fromRange();
      body = `
        ${marked ? `<p class="sm"><strong>Đã lấy phần anh đánh dấu bằng bút.</strong> <button type="button" class="linkish" data-q="pick">Chọn lại từ cả trang</button></p>`
        : `${it.res.markedText ? '<p class="sm"><button type="button" class="linkish" data-q="marked">Dùng phần đã đánh dấu bằng bút</button></p>' : ''}
          <p class="muted xs">Chạm <strong>câu đầu</strong> rồi <strong>câu cuối</strong> của đoạn cần giữ. Chạm lại để chọn lại.</p>
          <div class="sents" role="group" aria-label="Các câu trên trang">${sents.map((x, i) => {
    const on = a >= 0 && (b < 0 ? i === a : i >= Math.min(a, b) && i <= Math.max(a, b));
    const gap = i > 0 && sents[i - 1].para !== x.para ? ' para' : '';
    return `<button type="button" class="sent${on ? ' on' : ''}${gap}" data-s="${i}" aria-pressed="${on}">${esc(x.t)}</button>`;
  }).join('') || '<p class="muted sm">Không đọc được chữ nào trong ảnh.</p>'}</div>`}
        <label for="q-text">Đoạn sẽ lưu (sửa được)</label>
        <textarea id="q-text" rows="4" placeholder="Chưa chọn câu nào">${esc(text || '')}</textarea>`;
    }
    const ready = it.state === 'ok' || it.state === 'manual';
    if (it.state === 'manual') {
      body = `<label for="q-text">Đoạn tâm đắc</label><textarea id="q-text" rows="5" placeholder="Gõ hoặc dán đoạn chữ"></textarea>`;
    }
    dlg.innerHTML = `
      <form class="sheet-body" novalidate>
        ${head}
        ${body}
        ${ready ? `
        <div class="two-col">
          <div><label for="q-page">Trang</label><input id="q-page" type="number" inputmode="numeric" min="1" value="${it.res?.page || pb.page || ''}"></div>
          <div></div>
        </div>
        <label for="q-note">Ghi chú</label>
        <textarea id="q-note" rows="2" placeholder="Anh nghĩ gì về đoạn này?"></textarea>
        <label for="q-tag-in">Tag</label>
        <div class="tag-input"><span class="chosen"></span>
          <input id="q-tag-in" type="text" placeholder="Gõ tag rồi Enter" autocomplete="off" autocapitalize="off" enterkeyhint="done"></div>
        <div class="sugg" aria-label="Tag đã dùng"></div>` : ''}
        <div class="sheet-actions">
          <button type="button" class="btn ghost" data-q="skip">${idx + 1 < n ? 'Bỏ ảnh này' : 'Đóng'}</button>
          ${ready ? `<button type="button" class="btn ghost" data-q="again">Lưu, chọn thêm ở ảnh này</button>
          <button type="submit" class="btn primary">${idx + 1 < n ? 'Lưu & ảnh tiếp' : 'Lưu'}</button>` : ''}
        </div>
      </form>`;
    if (ready) drawTags();
  }

  const drawTags = () => {
    const tagIn = dlg.querySelector('#q-tag-in');
    if (!tagIn) return;
    dlg.querySelector('.chosen').innerHTML = tags.map((t) => `<button type="button" class="tag on sm" data-rm="${esc(t)}" aria-label="Bỏ tag ${esc(t)}">${esc(t)} ×</button>`).join('');
    const typed = normTag(tagIn.value);
    dlg.querySelector('.sugg').innerHTML = allTags.filter((t) => !tags.includes(t) && (!typed || t.includes(typed))).slice(0, 10)
      .map((t) => `<button type="button" class="tag sm" data-add="${esc(t)}">+ ${esc(t)}</button>`).join('');
  };
  const addTyped = () => {
    const tagIn = dlg.querySelector('#q-tag-in');
    if (!tagIn) return;
    for (const part of tagIn.value.split(',')) { const t = normTag(part); if (t && !tags.includes(t)) tags.push(t); }
    tagIn.value = '';
    drawTags();
  };

  const next = () => {
    idx += 1;
    tags = [];
    if (idx >= items.length) { dlg.close(); return; }
    setupItem();
    draw();
  };

  const save = async (stay) => {
    addTyped();
    const text = (dlg.querySelector('#q-text')?.value || '').trim();
    if (!text) { toast('Chưa có đoạn nào để lưu'); return; }
    const page = parseInt(dlg.querySelector('#q-page')?.value, 10) || null;
    try {
      await saveHighlight({
        source: 'paper', bookId, bookTitle: paperTitle(pb), genre: pb.genre, page, text, rects: [],
        note: dlg.querySelector('#q-note')?.value || '', tags,
      });
      S.highlights = await loadHighlights();
      saved += 1;
      toast('Đã lưu đoạn tâm đắc');
      if (stay) { a = -1; b = -1; mode = 'pick'; draw(); } else next();
    } catch { toast('Không lưu được'); }
  };

  dlg.addEventListener('click', (e) => {
    const s = e.target.closest('[data-s]');
    if (s) {
      const i = Number(s.dataset.s);
      if (a < 0 || b >= 0) { a = i; b = -1; } else b = i;
      const keepNote = dlg.querySelector('#q-note')?.value;
      const keepPage = dlg.querySelector('#q-page')?.value;
      addTyped();
      draw();
      if (keepNote != null) dlg.querySelector('#q-note').value = keepNote;
      if (keepPage != null) dlg.querySelector('#q-page').value = keepPage;
      return;
    }
    const q = e.target.closest('[data-q]')?.dataset.q;
    const rm = e.target.closest('[data-rm]');
    const add = e.target.closest('[data-add]');
    if (rm) { tags = tags.filter((t) => t !== rm.dataset.rm); drawTags(); }
    if (add) { tags.push(add.dataset.add); drawTags(); }
    if (q === 'retry') { const it = items[idx]; it.state = 'busy'; draw(); runOcr(it); }
    if (q === 'manual') { items[idx].state = 'manual'; draw(); dlg.querySelector('#q-text')?.focus(); }
    if (q === 'pick' || q === 'marked') { mode = q; a = -1; b = -1; draw(); }
    if (q === 'skip') next();
    if (q === 'again') save(true);
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.target.id === 'q-tag-in' && (e.key === 'Enter' || e.key === ',')) { e.preventDefault(); addTyped(); }
  });
  dlg.addEventListener('input', (e) => { if (e.target.id === 'q-tag-in') { if (e.target.value.includes(',')) addTyped(); else drawTags(); } });
  dlg.addEventListener('submit', (e) => { e.preventDefault(); save(false); });
  dlg.addEventListener('close', () => {
    closed = true;
    items.forEach((it) => URL.revokeObjectURL(it.url));
    dlg.remove();
    if (saved) { scheduleSync(3000); if (!S.reader) renderView(); }
  });
  setupItem();
  draw();
  dlg.showModal();
}

// ---------------- Màn Thống kê ----------------
function renderStats() {
  const st = computeStats({
    sessions: S.sessions, progress: S.progress, books: S.books, articles: S.articles, paper: S.paper, period: S.statsPeriod,
  });
  // Đang đọc: gom theo bộ, mới nhất ở trên.
  const reading = S.books
    .filter((b) => S.progress[b.id] && !isFinished(b.id))
    .sort((a, b) => S.progress[b.id].updatedAt - S.progress[a.id].updatedAt);
  const seen = new Set();
  const rows = [];
  for (const b of reading) {
    const x = info(b);
    const key = x.series ? `s:${b.genre}/${x.series}` : `b:${b.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (x.series) {
      const vols = S.books.map(info).filter((o) => o.series === x.series && o.genre === b.genre).sort((m, n) => m.vol - n.vol);
      const done = vols.filter((v) => isFinished(v.id)).length;
      rows.push(`<div class="gbar"><div class="gbar-head"><span>${esc(x.series)}</span><span class="muted tnum">${done} / ${vols.length} tập</span></div>
        <div class="segs" style="grid-template-columns:repeat(${vols.length},minmax(0,1fr))">${vols.map((v) => `<i class="${isFinished(v.id) ? 'done' : S.progress[v.id] ? 'cur' : ''}" title="Tập ${v.vol}"></i>`).join('')}</div></div>`);
    } else {
      const p = S.progress[b.id];
      const pct = Math.round((p.last / p.total) * 100);
      rows.push(`<div class="gbar"><div class="gbar-head"><span>${esc(x.title)}</span><span class="muted tnum">${pct}%</span></div>${bar(pct)}</div>`);
    }
    if (rows.length >= 6) break;
  }
  for (const pb of activePaper(S.paper).filter((x) => x.status === 'reading').sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))) {
    if (rows.length >= 8) break;
    const pct = paperPct(pb);
    rows.push(`<div class="gbar"><div class="gbar-head"><span>${esc(paperTitle(pb))} <span class="pill">Sách giấy</span></span><span class="muted tnum">${pct}%</span></div>${bar(pct)}</div>`);
  }
  app.innerHTML = `<div class="page wide">${renderStatsHtml(st, { readingRows: rows.join('') })}${nav('stats')}</div>`;
}

// ---------------- Màn Cài đặt ----------------
async function renderSettings() {
  const [usage, last] = await Promise.all([storageUsage(), lastSyncAt()]);
  const localBooks = S.books.filter((b) => S.local.has(b.id));
  const localSize = localBooks.reduce((a, b) => a + b.size, 0);
  const signed = await auth.everSignedIn();
  app.innerHTML = `
    <div class="page">
      <header class="top"><div class="top-left"><a class="icon-btn" href="#/" aria-label="Về thư viện">${icon('back')}</a><h1>Cài đặt</h1></div></header>
      <main class="main">
        <section class="card form">
          <label for="root">Thư mục sách trên Google Drive</label>
          <div class="inline"><input id="root" type="text" value="${esc(S.settings.rootFolder)}" autocomplete="off"><button type="button" class="btn" data-action="save-root">Lưu & quét lại</button></div>
          <p class="muted xs">Mỗi thư mục con là một thể loại, ví dụ “${esc(S.settings.rootFolder)}/Truyện tranh”.</p>
        </section>
        <section class="card form">
          <label for="gem-key">Gemini API key (đọc ảnh bìa sách giấy)</label>
          <div class="inline"><input id="gem-key" type="password" value="${esc(S.settings.geminiKey || '')}" placeholder="AIza…" autocomplete="off" spellcheck="false"><button type="button" class="btn" data-action="save-gem">Lưu & thử</button></div>
          <p class="muted xs">Key chỉ lưu trên máy này và trong thư mục ẩn trên Google Drive của bạn (để máy khác tự có), không nằm trong mã nguồn app.</p>
        </section>
        <section class="card form">
          <label class="switch-row"><span><strong>Cho phép tải offline bằng 4G</strong><br><span class="muted xs">Tắt: dùng 4G thì app hỏi trước khi tải. Wi-Fi luôn tự tải.</span></span><input type="checkbox" data-setting="allowCellular" ${S.settings.allowCellular ? 'checked' : ''}></label>
          ${S.settings.cellularSeries.length ? `<p class="xs muted">Các bộ luôn được tải bằng 4G:</p><ul class="chips">${S.settings.cellularSeries.map((s) => `<li><span>${esc(s)}</span><button type="button" class="icon-btn sm" data-action="unallow" data-series="${esc(s)}" aria-label="Bỏ ${esc(s)}">×</button></li>`).join('')}</ul>` : ''}
          <p class="xs muted">Mạng hiện tại: <strong>${{ wifi: 'Wi-Fi', cellular: 'Dữ liệu di động', offline: 'Offline' }[netType()]}</strong></p>
        </section>
        <section class="card form">
          <p><strong>Bộ nhớ offline</strong></p>
          <p class="muted sm tnum">${localBooks.length} cuốn · ${fmtMB(localSize)}${usage?.quota ? ` · máy còn trống khoảng ${fmtMB(usage.quota - usage.usage)}` : ''}</p>
          <button type="button" class="btn ghost" data-action="clear-local" ${localBooks.length ? '' : 'disabled'}>Xoá tất cả bản offline</button>
        </section>
        <section class="card form">
          <p><strong>Đồng bộ giữa các máy</strong></p>
          <p class="muted sm">${last ? `Lần cuối: ${fmtTime(last)}` : 'Chưa đồng bộ'}</p>
          <button type="button" class="btn ghost" data-action="sync">Đồng bộ ngay</button>
        </section>
        <section class="card form">
          <p><strong>Tài khoản Google</strong></p>
          ${signed ? '<button type="button" class="btn ghost" data-action="signout">Đăng xuất</button>' : '<button type="button" class="btn" data-action="signin">Đăng nhập Google</button>'}
        </section>
        <p class="muted xs center">Đọc sách · phiên bản ${CONFIG.version}</p>
      </main>
    </div>`;
}

async function saveSettings() {
  await db.set('kv', 'settings', S.settings);
}

// ---------------- Mở sách ----------------
async function openBook(id) {
  if (S.reader && S.readingId === id) return;
  if (S.reader) closeReader();
  const b = bookById(id);
  if (!b) { location.hash = '#/'; toast('Không tìm thấy sách'); return; }
  S.readingId = id;
  const x = info(b);
  const kind = (await getPref(`kind:${x.key}`)) || (isMangaGenre(b.genre) ? 'manga' : 'text');
  const dir = (await getPref(`dir:${x.key}`)) || (kind === 'manga' ? 'rtl' : 'ltr');
  const layout = (await getPref(`layout:${x.key}`)) || 'auto';
  const coverAlone = (await getPref(`coverAlone:${x.key}`)) ?? true;
  const p = S.progress[id];
  const jump = S.jump && S.jump.id === id ? S.jump : null;
  S.jump = null;
  app.innerHTML = '<div class="reader-host"></div>';
  const host = app.querySelector('.reader-host');
  const reader = new Reader(host, {
    title: displayTitle(b),
    subtitle: b.genre,
    kind, dir, layout, coverAlone,
    startPage: jump ? jump.page : (p && !p.finished ? p.page : 1),
    flashId: jump?.flashId || null,
    onPosition: (pos) => savePosition(b, pos),
    onActivity: sessActivity,
    onPrefChange: (k, v) => setPref(`${k}:${x.key}`, v),
    highlightsFor: (page) => highlightsOf(S.highlights, id, page),
    onSelection: (action, sel) => onReaderSelection(b, action, sel),
    onHighlightTap: (hid) => openHighlightEditor(S.highlights[hid]),
    onEnd: () => onReachEnd(b),
  });
  S.reader = reader;
  sessActivity();

  const file = await localFile(id);
  let src;
  if (file) {
    src = { length: file.size, read: (s, e) => file.slice(s, e).arrayBuffer(), chunk: CONFIG.localChunk };
  } else if (netType() === 'offline') {
    reader.showMsg('Sách này chưa tải về máy và đang offline.', 'Về thư viện', () => { location.hash = '#/'; });
    return;
  } else if (!(await auth.getToken())) {
    reader.showMsg('Cần kết nối lại Google Drive để mở sách chưa tải.', 'Kết nối lại', async () => { await signIn(); closeReader(); openBook(id); });
    return;
  } else {
    // Khi bản offline tải xong thì chuyển sang đọc từ máy, không gọi mạng nữa.
    let localF = null;
    src = {
      length: b.size,
      chunk: CONFIG.remoteChunk,
      read: async (s, e) => {
        if (!localF && S.local.has(id)) localF = await localFile(id);
        return localF ? localF.slice(s, e).arrayBuffer() : readRange(b.id, s, e);
      },
    };
    // Wi-Fi: đọc ngay và tải trọn file ngầm. 4G: chỉ lấy các trang đang đọc.
    const nt = netType();
    const series = x.series;
    const cellOk = S.settings.allowCellular || (series && S.settings.cellularSeries.includes(series)) || S.approved.has(id);
    if (nt === 'wifi' || cellOk) enqueue(b, { cellularOk: nt !== 'wifi' && cellOk });
  }
  updateReaderStatus();
  try {
    await reader.open(src);
    if (reader.pdf && !S.covers.has(id)) makeCover(reader.pdf, id);
  } catch (e) {
    if (S.reader !== reader) return;
    if (e instanceof AuthError) reader.showMsg('Phiên Google đã hết hạn.', 'Kết nối lại', async () => { await signIn(); closeReader(); openBook(id); });
    else if (e?.name === 'PasswordException') reader.showMsg('File PDF này có mật khẩu, app chưa hỗ trợ.', 'Về thư viện', () => { location.hash = '#/'; });
    else reader.showMsg('Không mở được sách. Kiểm tra mạng rồi thử lại.', 'Thử lại', () => { closeReader(); openBook(id); });
  }
}

// Truyện tranh: lật tiếp ở trang cuối → mở tập kế tiếp của bộ; hết bộ thì báo kết thúc.
function onReachEnd(b) {
  if (!S.reader || S.readingId !== b.id || S.reader.o.kind !== 'manga') return;
  const n = nextVolume(b);
  if (!n) { toast('Đã kết thúc, vui lòng đọc cuốn khác'); return; }
  toast(`Đang mở Tập ${n.vol}…`);
  location.replace(`#/read/${encodeURIComponent(n.id)}`); // thay chỗ trong lịch sử: nút Back vẫn về thư viện
}

function updateReaderStatus() {
  if (!S.reader || !S.readingId) return;
  const b = bookById(S.readingId);
  if (!b) return;
  const d = dlState(b);
  let st;
  if (d.kind === 'local') st = 'Đã tải offline';
  else if (d.kind === 'downloading') st = `Đang tải offline ${d.pct}%`;
  else if (netType() === 'offline') st = 'Offline';
  else if (netType() === 'cellular') st = '4G · chỉ tải trang đang đọc';
  else st = 'Đọc trực tuyến';
  S.reader.setStatus(`${b.genre} · ${st}`);
}

async function savePosition(b, pos) {
  sessPage(pos.page);
  if (pos.last !== pos.page) sessPage(pos.last);
  const prev = S.progress[b.id];
  const finished = pos.finished || Boolean(prev?.finished); // đã đọc xong thì giữ trạng thái xong
  const now = Date.now();
  const finishedAt = finished ? (prev?.finishedAt || (prev?.finished ? prev.updatedAt : now)) : null;
  const rec = { page: pos.page, last: pos.last, total: pos.total, finished, finishedAt, updatedAt: now, name: b.name, genre: b.genre };
  S.progress[b.id] = rec;
  await db.set('progress', b.id, rec);
  scheduleSync(8000);
}

async function makeCover(pdf, id) {
  try {
    const pg = await pdf.getPage(1);
    const v1 = pg.getViewport({ scale: 1 });
    const scale = 240 / v1.width;
    const vp = pg.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await pg.render({ canvas: c, viewport: vp }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    if (!blob) return;
    await db.set('covers', id, blob);
    S.covers.set(id, URL.createObjectURL(blob));
  } catch { /* bỏ qua */ }
}

function closeReader() {
  sessFlush(true);
  releaseWake();
  S.reader?.close();
  S.reader = null;
  S.readingId = null;
  syncNow().catch(() => {});
  runPolicy();
  if (S.pendingReload) setTimeout(() => location.reload(), 300);
}

// ---------------- Sự kiện ----------------
async function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  if (a === 'signin') return signIn();
  if (a === 'art-add') return addFromInput();
  if (a === 'paper-new') return openPaperEditor(null);
  if (a === 'paper-edit') return openPaperEditor(S.paper[id]);
  if (a === 'paper-next-vol') {
    const p = S.paper[id];
    if (p) openPaperEditor(null, { title: p.title, series: p.series, volume: (p.volume || 0) + 1, author: p.author, translator: p.translator, publisher: p.publisher, genre: p.genre, totalPages: p.totalPages });
    return;
  }
  if (a === 'paper-log') return openLogDialog(id);
  if (a === 'paper-status') {
    const b = S.paper[id];
    if (b) { b.status = el.dataset.status; S.paper[id] = await savePaperBook(b); toast(b.status === 'dropped' ? 'Đã chuyển sang Bỏ dở' : 'Đã chuyển sang Đang đọc'); renderView(); }
    return;
  }
  if (a === 'paper-log-del') {
    const s = S.sessions.find((x) => x.id === id);
    if (!s) return;
    const before = { ...s };
    Object.assign(s, { deleted: true, activeSec: 0, rev: Date.now() });
    await db.set('sessions', null, s);
    await recomputePaper(s.bookId);
    scheduleSync(5000);
    renderView();
    toast('Đã xoá lần đọc', { label: 'Hoàn tác', fn: async () => {
      delete s.deleted;
      Object.assign(s, before, { rev: Date.now() });
      await db.set('sessions', null, s);
      await recomputePaper(s.bookId);
      scheduleSync(5000);
      renderView();
    } });
    return;
  }
  if (a === 'paper-del') {
    const before = await deletePaperBook(id);
    S.paper = await loadPaper();
    location.hash = '#/';
    if (before) toast('Đã xoá sách', { label: 'Hoàn tác', fn: async () => { S.paper[id] = await savePaperBook(before); renderView(); } });
    return;
  }
  if (a === 'stats-period') { S.statsPeriod = el.dataset.period; return renderStats(); }
  if (a === 'hl-tag') { S.hlTag = S.hlTag === el.dataset.tag ? '' : el.dataset.tag; return renderHighlights(); }
  if (a === 'hl-open') return openHighlightFromList(id);
  if (a === 'hl-edit') return openHighlightEditor(S.highlights[id]);
  if (a === 'hl-del') return removeHighlight(id);
  if (a === 'art-tag') { S.artTag = S.artTag === el.dataset.tag ? '' : el.dataset.tag; return renderArticles(); }
  if (a === 'art-kind') { S.artKind = el.dataset.kind || ''; return renderArticles(); }
  if (a === 'art-edit') { const r = S.articles[id]; if (r) openArticleEditor({ url: r.url, title: r.title }); return; }
  if (a === 'art-del') {
    const before = await deleteArticle(id);
    S.articles = await loadArticles();
    renderArticles();
    if (before) {
      toast(isPodcast(before) ? 'Đã xoá tập' : 'Đã xoá bài', { label: 'Hoàn tác', fn: async () => { await restoreArticle(before); S.articles = await loadArticles(); if ((S.route || '').startsWith('#/articles')) renderArticles(); } });
    }
    return;
  }
  if (a === 'refresh') return refresh({ force: true });
  if (a === 'dl') {
    const b = bookById(id);
    if (!b) return;
    downloads.delete(id);
    enqueue(b, { cellularOk: true }); // bấm tay = đồng ý tải kể cả khi đang dùng 4G
    return renderView();
  }
  if (a === 'cancel') { cancelDownload(id); return renderView(); }
  if (a === 'remove') { await removeLocal(id); S.local.delete(id); toast('Đã xoá bản offline'); return renderView(); }
  if (a === 'toggle') {
    const k = el.dataset.key;
    if (S.expanded.has(k)) S.expanded.delete(k); else S.expanded.add(k);
    return renderView();
  }
  if (a === 'ask-yes') { S.ask.forEach((b) => S.approved.add(b.id)); return runPolicy(); }
  if (a === 'ask-wifi') { S.dismissUntilWifi = true; S.ask = []; return renderView(); }
  if (a === 'ask-always') {
    const series = [...new Set(S.ask.map((b) => info(b).series).filter(Boolean))];
    S.ask.forEach((b) => S.approved.add(b.id));
    S.settings.cellularSeries = [...new Set([...S.settings.cellularSeries, ...series])];
    await saveSettings();
    if (series.length) toast(`Luôn tải bằng 4G: ${series.join(', ')}`);
    return runPolicy();
  }
  if (a === 'save-root') {
    const v = app.querySelector('#root').value.trim();
    if (!v) return;
    S.settings.rootFolder = v;
    await saveSettings();
    location.hash = '#/';
    return refresh({ force: true });
  }
  if (a === 'save-gem') {
    const v = app.querySelector('#gem-key').value.trim();
    S.settings.geminiKey = v;
    await saveSettings();
    await setPref('geminiKey', v);
    if (!v) { toast('Đã xoá Gemini API key'); return; }
    try {
      const models = await pickGeminiModels(v, { force: true });
      toast(`Key dùng được – sẽ thử ${models.length} model: ${models.join(', ')}`);
    } catch (err) { toast(err.message); }
    return;
  }
  if (a === 'unallow') {
    S.settings.cellularSeries = S.settings.cellularSeries.filter((s) => s !== el.dataset.series);
    await saveSettings();
    return renderSettings();
  }
  if (a === 'clear-local') {
    await removeAllLocal();
    S.local = new Set();
    toast('Đã xoá tất cả bản offline');
    return renderSettings();
  }
  if (a === 'sync') {
    try { const ok = await syncNow(); toast(ok ? 'Đã đồng bộ' : 'Chưa đồng bộ được (offline hoặc chưa đăng nhập)'); } catch (err) { handleErr(err); toast('Đồng bộ lỗi'); }
    return renderSettings();
  }
  if (a === 'signout') {
    await auth.signOut();
    S.needAuth = false;
    S.books = [];
    S.scannedAt = 0;
    await db.del('kv', 'library');
    toast('Đã đăng xuất');
    location.hash = '#/';
    return renderView();
  }
}

function onInput(e) {
  if (e.target.id === 'hl-q') {
    S.hlQuery = e.target.value;
    const list = app.querySelector('#hl-list');
    if (list) list.innerHTML = hlListHtml();
  }
  if (e.target.id === 'art-q') {
    S.artQuery = e.target.value;
    const list = app.querySelector('#art-list');
    if (list) list.innerHTML = artListHtml();
  }
}

async function onChange(e) {
  const qp = e.target.closest?.('[data-quote-photos]');
  if (qp) {
    const files = [...(qp.files || [])];
    qp.value = '';
    if (files.length) openQuoteBatch(qp.dataset.quotePhotos, files);
    return;
  }
  const el = e.target.closest('[data-setting]');
  if (!el) return;
  S.settings[el.dataset.setting] = el.checked;
  await saveSettings();
  runPolicy();
}

boot();
