// Service worker: lưu vỏ app để mở được khi offline. Sách lưu riêng trong bộ nhớ của app (OPFS), không qua đây.
const VERSION = 'v1.2.0';
const SHELL = `shell-${VERSION}`;
const VENDOR = 'vendor-pdfjs-6.5.438';

const SHELL_FILES = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/config.js', './js/db.js', './js/auth.js', './js/drive.js',
  './js/storage.js', './js/sync.js', './js/reader.js', './js/ui.js', './js/articles.js', './js/stats.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];
const VENDOR_FILES = ['./vendor/pdfjs/pdf.min.mjs', './vendor/pdfjs/pdf.worker.min.mjs'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })));
    await (await caches.open(VENDOR)).addAll(VENDOR_FILES);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== VENDOR) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google API & đăng nhập đi thẳng ra mạng

  if (url.pathname.includes('/vendor/')) {
    // Thư viện pdf.js: lấy từ bộ nhớ đệm trước, chưa có thì tải rồi lưu lại.
    e.respondWith((async () => {
      const cache = await caches.open(VENDOR);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Vỏ app: trả bản đã lưu ngay (mở nhanh), đồng thời lấy bản mới ở nền cho lần mở sau.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  })());
});
