// Trình đọc PDF: 2 chế độ (Sách chữ / Truyện tranh), 1 hoặc 2 trang, lật phải→trái, đọc từng phần.
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { esc, icon } from './ui.js';

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';

// Nguồn dữ liệu theo từng đoạn byte: file trên máy hoặc Google Drive.
class RangeTransport extends pdfjs.PDFDataRangeTransport {
  constructor(length, initialData, read, onFail) {
    super(length, initialData);
    this.read = read;
    this.onFail = onFail;
    this.failed = [];
  }
  requestDataRange(begin, end) { this.fetchRange(begin, end, 0); }
  fetchRange(begin, end, attempt) {
    this.read(begin, end)
      .then((buf) => this.onDataRange(begin, new Uint8Array(buf)))
      .catch((err) => {
        if (attempt < 2) setTimeout(() => this.fetchRange(begin, end, attempt + 1), 800 * (attempt + 1));
        else { this.failed.push([begin, end]); this.onFail(err); }
      });
  }
  retry() {
    const f = this.failed;
    this.failed = [];
    for (const [b, e] of f) this.fetchRange(b, e, 0);
  }
}

const CACHE_MAX = 10;
const MAX_PIXELS = 16e6;

export class Reader {
  /**
   * o: { title, subtitle, kind: 'manga'|'text', dir: 'rtl'|'ltr', layout: 'auto'|'single'|'double',
   *      coverAlone: bool, startPage, onPosition(pos), onActivity(), onPrefChange(key, value) }
   */
  constructor(host, o) {
    this.host = host;
    this.o = o;
    this.page = Math.max(1, o.startPage || 1);
    this.total = 0;
    this.z = 1;
    this.cache = new Map();
    this.sizes = new Map();
    this.seq = 0;
    this.closed = false;
    this.lastW = 0;
    this.lastH = 0;
    this.build();
  }

  // ---------- Giao diện ----------
  build() {
    const o = this.o;
    this.host.innerHTML = `
      <div class="rd" data-kind="${o.kind}" data-dir="${o.dir}">
        <header class="rd-top">
          <a class="icon-btn" href="#/" aria-label="Về thư viện">${icon('back')}</a>
          <div class="rd-title"><strong>${esc(o.title)}</strong><span class="rd-sub">${esc(o.subtitle || '')}</span></div>
          <button type="button" class="chip rd-dir" aria-label="Đổi hướng lật"></button>
          <button type="button" class="icon-btn rd-zoom" aria-label="Phóng to">${icon('zoom')}</button>
          <button type="button" class="icon-btn rd-more" aria-label="Tuỳ chọn đọc" aria-expanded="false">${icon('more')}</button>
        </header>
        <div class="rd-panel" hidden>
          <div class="seg" role="group" aria-label="Chế độ đọc">
            <span class="seg-label">Chế độ</span>
            <button type="button" data-kind="text">Sách chữ</button>
            <button type="button" data-kind="manga">Truyện tranh</button>
          </div>
          <div class="seg" role="group" aria-label="Bố cục">
            <span class="seg-label">Bố cục</span>
            <button type="button" data-layout="auto">Tự động</button>
            <button type="button" data-layout="single">1 trang</button>
            <button type="button" data-layout="double">2 trang</button>
          </div>
          <label class="switch-row"><span>Trang bìa đứng riêng khi xem 2 trang</span><input type="checkbox" class="rd-cover"></label>
        </div>
        <div class="rd-stage" tabindex="0" aria-label="Trang sách">
          <div class="rd-spread"></div>
          <div class="rd-msg" hidden><p></p><button type="button" class="btn"></button></div>
        </div>
        <footer class="rd-bottom">
          <button type="button" class="nav-btn rd-left"></button>
          <div class="rd-mid">
            <input type="range" class="rd-slider" min="1" max="1" value="1" aria-label="Đến trang">
            <span class="rd-label tnum"></span>
          </div>
          <button type="button" class="nav-btn rd-right"></button>
        </footer>
      </div>`;
    const $ = (s) => this.host.querySelector(s);
    this.root = $('.rd');
    this.stage = $('.rd-stage');
    this.spreadEl = $('.rd-spread');
    this.msgEl = $('.rd-msg');
    this.sub = $('.rd-sub');
    this.slider = $('.rd-slider');
    this.label = $('.rd-label');
    this.panel = $('.rd-panel');
    this.btnLeft = $('.rd-left');
    this.btnRight = $('.rd-right');
    this.btnDir = $('.rd-dir');
    this.btnZoom = $('.rd-zoom');
    this.btnMore = $('.rd-more');
    this.coverBox = $('.rd-cover');
    this.applyChrome();
  }

  applyChrome() {
    const o = this.o;
    this.root.dataset.kind = o.kind;
    this.root.dataset.dir = o.dir;
    const rtl = o.dir === 'rtl';
    this.btnDir.hidden = o.kind !== 'manga';
    this.btnDir.textContent = rtl ? 'Lật phải → trái' : 'Lật trái → phải';
    this.btnLeft.innerHTML = rtl ? `${icon('back')}<span>Trang sau</span>` : `${icon('back')}<span>Trang trước</span>`;
    this.btnRight.innerHTML = rtl ? `<span>Trang trước</span>${icon('next')}` : `<span>Trang sau</span>${icon('next')}`;
    this.btnLeft.setAttribute('aria-label', rtl ? 'Trang sau (sang trái)' : 'Trang trước');
    this.btnRight.setAttribute('aria-label', rtl ? 'Trang trước (sang phải)' : 'Trang sau');
    this.slider.dir = rtl ? 'rtl' : 'ltr';
    this.panel.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === o.kind)));
    this.panel.querySelectorAll('[data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === o.layout)));
    this.coverBox.checked = o.coverAlone;
    this.btnZoom.setAttribute('aria-label', this.z > 1 ? 'Thu nhỏ' : 'Phóng to');
    this.btnZoom.innerHTML = icon(this.z > 1 ? 'zoomout' : 'zoom');
  }

  setStatus(text) { this.sub.textContent = text; }

  showMsg(text, btnLabel, onBtn) {
    this.msgEl.hidden = false;
    this.msgEl.querySelector('p').textContent = text;
    const b = this.msgEl.querySelector('button');
    b.hidden = !btnLabel;
    if (btnLabel) { b.textContent = btnLabel; b.onclick = onBtn; }
  }
  hideMsg() { this.msgEl.hidden = true; }

  // ---------- Mở tài liệu ----------
  // src: { length, read(begin, end) -> Promise<ArrayBuffer>, chunk }
  async open(src) {
    this.showMsg('Đang mở sách…');
    const initLen = Math.min(src.length, 128 * 1024);
    const init = new Uint8Array(await src.read(0, initLen));
    if (this.closed) return;
    this.transport = new RangeTransport(src.length, init, src.read, () => {
      this.showMsg('Mất kết nối khi tải trang.', 'Thử lại', () => { this.hideMsg(); this.transport.retry(); });
    });
    this.task = pdfjs.getDocument({
      range: this.transport,
      length: src.length,
      rangeChunkSize: src.chunk,
      disableAutoFetch: true,
      disableStream: true,
      cMapUrl: BASE + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: BASE + 'standard_fonts/',
      wasmUrl: BASE + 'wasm/',
      iccUrl: BASE + 'iccs/',
      isEvalSupported: false,
    });
    this.pdf = await this.task.promise;
    if (this.closed) { this.pdf.destroy(); return; }
    this.total = this.pdf.numPages;
    this.page = Math.min(Math.max(1, this.page), this.total);
    this.slider.max = String(this.total);
    this.hideMsg();
    this.bind();
    await this.display(true);
  }

  // ---------- Bố cục ----------
  isDouble() {
    const { layout, kind } = this.o;
    if (layout === 'single') return false;
    if (layout === 'double') return true;
    const r = this.stage.clientWidth / Math.max(1, this.stage.clientHeight);
    return kind === 'manga' ? r >= 0.75 : r >= 1.25;
  }

  spreadFor(p) {
    const n = this.total;
    if (!this.isDouble() || n < 2) return [p];
    let s;
    if (this.o.coverAlone) {
      if (p === 1) return [1];
      s = p % 2 === 0 ? p : p - 1;
    } else {
      s = p % 2 === 1 ? p : p - 1;
    }
    return s + 1 <= n ? [s, s + 1] : [s];
  }

  async pageSize(n) {
    if (!this.sizes.has(n)) {
      const pg = await this.pdf.getPage(n);
      const v = pg.getViewport({ scale: 1 });
      this.sizes.set(n, { w: v.width, h: v.height });
    }
    return this.sizes.get(n);
  }

  async layoutFor(spread) {
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const sizes = await Promise.all(spread.map((n) => this.pageSize(n)));
    if (this.o.kind === 'text' && spread.length === 1) {
      // Sách chữ 1 trang: vừa chiều rộng, cuộn dọc nếu trang cao hơn màn.
      return [{ n: spread[0], w: Math.min(W, 1100) * this.z, ratio: sizes[0].h / sizes[0].w }];
    }
    const unitW = sizes.reduce((a, s) => a + s.w / s.h, 0);
    const h = Math.min(H, W / unitW);
    return spread.map((n, i) => ({ n, w: h * (sizes[i].w / sizes[i].h) * this.z, ratio: sizes[i].h / sizes[i].w }));
  }

  render(n, cssW) {
    const key = `${n}|${Math.round(cssW)}`;
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, v);
      return v;
    }
    const p = (async () => {
      const pg = await this.pdf.getPage(n);
      const v1 = pg.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      let scale = (cssW / v1.width) * dpr;
      if (v1.width * v1.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (v1.width * v1.height));
      const vp = pg.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      c.style.width = `${Math.round(cssW)}px`;
      c.style.height = `${Math.round(cssW * (v1.height / v1.width))}px`;
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', `Trang ${n}`);
      await pg.render({ canvas: c, viewport: vp }).promise;
      return c;
    })();
    this.cache.set(key, p);
    p.catch(() => this.cache.delete(key));
    while (this.cache.size > CACHE_MAX) {
      const [k, old] = this.cache.entries().next().value;
      this.cache.delete(k);
      old.then((c) => { if (!c.isConnected) { c.width = 0; c.height = 0; } }).catch(() => {});
    }
    return p;
  }

  async display(resetScroll) {
    if (!this.pdf || this.closed) return;
    const seq = ++this.seq;
    const spread = this.spreadFor(this.page);
    this.page = spread[0];
    this.updateLabels(spread);
    const loadingTimer = setTimeout(() => { if (seq === this.seq) this.showMsg('Đang tải trang…'); }, 350);
    try {
      const lay = await this.layoutFor(spread);
      if (seq !== this.seq) return;
      const canvases = await Promise.all(lay.map((l) => this.render(l.n, l.w)));
      if (seq !== this.seq) return;
      clearTimeout(loadingTimer);
      if (!this.msgEl.querySelector('button:not([hidden])')) this.hideMsg();
      this.spreadEl.replaceChildren(...canvases);
      if (resetScroll) this.stage.scrollTo(0, 0);
      const last = spread[spread.length - 1];
      this.o.onPosition?.({ page: spread[0], last, total: this.total, finished: last >= this.total });
      setTimeout(() => { if (seq === this.seq) this.prefetch(spread); }, 150);
    } catch (e) {
      clearTimeout(loadingTimer);
      if (seq === this.seq && !this.closed) this.showMsg('Không hiển thị được trang này.', 'Thử lại', () => { this.hideMsg(); this.display(); });
    }
  }

  async prefetch(spread) {
    const last = spread[spread.length - 1];
    const targets = [];
    if (last < this.total) targets.push(this.spreadFor(last + 1));
    if (spread[0] > 1) targets.push(this.spreadFor(spread[0] - 1));
    for (const sp of targets) {
      try {
        const lay = await this.layoutFor(sp);
        for (const l of lay) await this.render(l.n, l.w);
      } catch { /* bỏ qua */ }
    }
  }

  updateLabels(spread) {
    const a = spread[0];
    const b = spread[spread.length - 1];
    const pct = Math.round((b / this.total) * 100);
    this.label.textContent = `${a === b ? a : `${a}–${b}`} / ${this.total} · ${pct}%`;
    this.slider.value = String(a);
  }

  // ---------- Điều hướng ----------
  next() {
    const sp = this.spreadFor(this.page);
    const last = sp[sp.length - 1];
    if (last < this.total) { this.page = last + 1; this.afterMove(); }
  }
  prev() {
    const first = this.spreadFor(this.page)[0];
    if (first > 1) { this.page = this.spreadFor(first - 1)[0]; this.afterMove(); }
  }
  goTo(p) {
    this.page = Math.min(Math.max(1, p), this.total);
    this.afterMove();
  }
  afterMove() {
    if (this.z !== 1) { this.z = 1; this.applyChrome(); }
    this.o.onActivity?.();
    this.display(true);
  }
  // Nút/cạnh bên trái màn hình: truyện (phải→trái) = trang sau; sách = trang trước.
  left() { this.o.dir === 'rtl' ? this.next() : this.prev(); }
  right() { this.o.dir === 'rtl' ? this.prev() : this.next(); }

  toggleZoom(cx, cy) {
    const st = this.stage;
    const relX = cx != null ? (st.scrollLeft + cx) / Math.max(1, st.scrollWidth) : 0.5;
    const relY = cy != null ? (st.scrollTop + cy) / Math.max(1, st.scrollHeight) : 0.5;
    this.z = this.z > 1 ? 1 : 2;
    this.root.classList.toggle('zoomed', this.z > 1);
    this.applyChrome();
    this.display(false).then(() => {
      if (this.z > 1) {
        st.scrollLeft = relX * st.scrollWidth - st.clientWidth / 2;
        st.scrollTop = relY * st.scrollHeight - st.clientHeight / 2;
      }
    });
  }

  setOption(key, value) {
    this.o[key] = value;
    this.o.onPrefChange?.(key, value);
    this.applyChrome();
    this.cache.clear();
    this.display(true);
  }

  // ---------- Sự kiện ----------
  bind() {
    const ac = new AbortController();
    this.ac = ac;
    const sig = { signal: ac.signal };
    this.btnLeft.addEventListener('click', () => this.left(), sig);
    this.btnRight.addEventListener('click', () => this.right(), sig);
    this.btnZoom.addEventListener('click', () => this.toggleZoom(), sig);
    this.btnDir.addEventListener('click', () => this.setOption('dir', this.o.dir === 'rtl' ? 'ltr' : 'rtl'), sig);
    this.btnMore.addEventListener('click', () => {
      this.panel.hidden = !this.panel.hidden;
      this.btnMore.setAttribute('aria-expanded', String(!this.panel.hidden));
    }, sig);
    this.panel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.kind) {
        const kind = b.dataset.kind;
        this.o.dir = kind === 'manga' ? (this.o.dir || 'rtl') : 'ltr';
        this.setOption('kind', kind);
        this.o.onPrefChange?.('dir', this.o.dir);
      }
      if (b.dataset.layout) this.setOption('layout', b.dataset.layout);
    }, sig);
    this.coverBox.addEventListener('change', () => this.setOption('coverAlone', this.coverBox.checked), sig);
    this.slider.addEventListener('change', () => this.goTo(Number(this.slider.value)), sig);
    this.slider.addEventListener('input', () => {
      const v = Number(this.slider.value);
      this.label.textContent = `${v} / ${this.total} · ${Math.round((v / this.total) * 100)}%`;
    }, sig);
    this.stage.addEventListener('scroll', () => this.o.onActivity?.(), { ...sig, passive: true });

    // Chạm & vuốt
    let down = null;
    let lastTap = 0;
    let tapTimer = null;
    this.stage.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    }, sig);
    this.stage.addEventListener('pointerup', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      const dt = performance.now() - down.t;
      down = null;
      if (e.target.closest('.rd-msg')) return;
      this.o.onActivity?.();
      const pinched = (window.visualViewport?.scale || 1) > 1.01;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3 && this.z === 1 && !pinched) {
        // Vuốt: ngón tay sang trái = đi theo hướng "phải" của sách và ngược lại.
        if (dx < 0) this.right(); else this.left();
        return;
      }
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || dt > 400) return;
      const now = performance.now();
      const rect = this.stage.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (now - lastTap < 300) {
        clearTimeout(tapTimer);
        lastTap = 0;
        this.toggleZoom(cx, cy);
        return;
      }
      lastTap = now;
      tapTimer = setTimeout(() => {
        const zone = cx / rect.width;
        if (this.z > 1 || pinched || (zone > 0.3 && zone < 0.7)) this.root.classList.toggle('immersive');
        else if (zone <= 0.3) this.left();
        else this.right();
      }, 260);
    }, sig);

    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.left(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.right(); }
      else if (e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); this.next(); }
      else if (e.key === 'PageUp') { e.preventDefault(); this.prev(); }
    }, sig);

    // Gập/mở Fold, xoay màn hình, ẩn/hiện thanh công cụ: tính lại bố cục, giữ nguyên trang.
    let rt = null;
    this.ro = new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        const W = this.stage.clientWidth;
        const H = this.stage.clientHeight;
        if (Math.abs(W - this.lastW) < 2 && Math.abs(H - this.lastH) < 2) return;
        this.lastW = W;
        this.lastH = H;
        this.display(false);
      }, 150);
    });
    this.lastW = this.stage.clientWidth;
    this.lastH = this.stage.clientHeight;
    this.ro.observe(this.stage);
    this.stage.focus({ preventScroll: true });
  }

  close() {
    this.closed = true;
    this.ac?.abort();
    this.ro?.disconnect();
    this.cache.forEach((p) => p.then((c) => { c.width = 0; c.height = 0; }).catch(() => {}));
    this.cache.clear();
    try { this.task?.destroy(); } catch { /* bỏ qua */ }
    this.host.innerHTML = '';
  }
}
