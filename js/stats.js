// Màn Thống kê (P2): số liệu theo kỳ, so với cùng kỳ, heatmap 16 tuần, theo thể loại, theo bộ/cuốn, bài viết.
// Chỉ tính phiên đọc hợp lệ (≥ 1 phút). Bài viết không tính vào streak.
import { CONFIG } from './config.js';
import { esc, dayKey, fmtTime } from './ui.js';

const PERIODS = {
  week: { label: 'Tuần này', prev: 'tuần trước' },
  month: { label: 'Tháng này', prev: 'tháng trước' },
  year: { label: 'Năm nay', prev: 'năm trước' },
};

export function periodRange(kind, now = new Date()) {
  const start = new Date(now);
  if (kind === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  else if (kind === 'month') start.setDate(1);
  else { start.setMonth(0); start.setDate(1); }
  start.setHours(0, 0, 0, 0);
  const prevStart = new Date(start);
  if (kind === 'week') prevStart.setDate(prevStart.getDate() - 7);
  else if (kind === 'month') prevStart.setMonth(prevStart.getMonth() - 1);
  else prevStart.setFullYear(prevStart.getFullYear() - 1);
  const elapsed = now - start;
  // So "cùng kỳ": cùng số ngày đã trôi qua của kỳ trước, để so sánh công bằng khi kỳ này chưa hết.
  return { start: +start, end: +now, prevStart: +prevStart, prevEnd: +prevStart + elapsed };
}

const valid = (s) => (s.activeSec || 0) >= CONFIG.minSessionSec;
const inRange = (t, a, b) => t >= a && t < b;

function sumWindow(sessions, a, b) {
  const list = sessions.filter((s) => inRange(s.start, a, b));
  const sec = list.reduce((x, s) => x + s.activeSec, 0);
  return { list, minutes: sec / 60, count: list.length, pages: list.reduce((x, s) => x + (s.pages || 0), 0) };
}

export function computeStats({ sessions, progress, books, articles, period, now = new Date() }) {
  const ss = sessions.filter(valid);
  const r = periodRange(period, now);
  const cur = sumWindow(ss, r.start, r.end + 1);
  const prev = sumWindow(ss, r.prevStart, r.prevEnd + 1);

  // Ngày & streak
  const daily = new Map();
  for (const s of ss) { const k = dayKey(s.start); daily.set(k, (daily.get(k) || 0) + s.activeSec / 60); }
  const d = new Date(now);
  if (!daily.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (daily.has(dayKey(d))) { streak += 1; d.setDate(d.getDate() - 1); }
  let longest = 0;
  let run = 0;
  let prevDay = null;
  for (const k of [...daily.keys()].sort()) {
    const t = new Date(`${k}T00:00:00`);
    run = prevDay && Math.round((t - prevDay) / 864e5) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prevDay = t;
  }

  // Theo thể loại (trong kỳ)
  const bookById = new Map(books.map((b) => [b.id, b]));
  const genres = new Map();
  const g = (name) => {
    if (!genres.has(name)) genres.set(name, { name, minutes: 0, pages: 0, done: 0 });
    return genres.get(name);
  };
  for (const s of cur.list) {
    const x = g(s.genre || bookById.get(s.bookId)?.genre || 'Khác');
    x.minutes += s.activeSec / 60;
    x.pages += s.pages || 0;
  }
  let completed = 0;
  for (const [id, p] of Object.entries(progress)) {
    if (!p.finished) continue;
    const t = p.finishedAt || p.updatedAt;
    if (!inRange(t, r.start, r.end + 1)) continue;
    completed += 1;
    g(p.genre || bookById.get(id)?.genre || 'Khác').done += 1;
  }
  const genreList = [...genres.values()].sort((a, b) => b.minutes - a.minutes);

  // Heatmap 16 tuần (thứ Hai ở hàng trên cùng)
  const weeks = 16;
  const lastMonday = new Date(now);
  lastMonday.setHours(0, 0, 0, 0);
  lastMonday.setDate(lastMonday.getDate() - ((lastMonday.getDay() + 6) % 7));
  const first = new Date(lastMonday);
  first.setDate(first.getDate() - (weeks - 1) * 7);
  const cells = [];
  for (let w = 0; w < weeks; w += 1) {
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(first);
      day.setDate(first.getDate() + w * 7 + i);
      const k = dayKey(day);
      cells.push({ key: k, min: Math.round(daily.get(k) || 0), future: day > now });
    }
  }

  // Bài viết trong kỳ
  const arts = Object.values(articles || {}).filter((a) => !a.deleted && inRange(a.readAt, r.start, r.end + 1));
  const prevArts = Object.values(articles || {}).filter((a) => !a.deleted && inRange(a.readAt, r.prevStart, r.prevEnd + 1));
  const count = (key) => {
    const m = new Map();
    for (const a of arts) for (const v of key(a)) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'vi'));
  };

  const last = ss.length ? ss.reduce((a, b) => (a.end > b.end ? a : b)) : null;
  return {
    period, r, cur, prev, streak, longest, completed, genreList, cells, daily,
    arts: arts.length, prevArts: prevArts.length,
    byTag: count((a) => (a.tags?.length ? a.tags : ['(chưa có tag)'])),
    bySource: count((a) => [a.source || 'khác']),
    last,
  };
}

// ---------- Hiển thị ----------
const nf1 = (x) => x.toLocaleString('vi-VN', { maximumFractionDigits: 1 });

function fmtDuration(min) {
  if (min < 60) return { num: String(Math.round(min)), unit: 'phút' };
  return { num: nf1(min / 60), unit: 'giờ' };
}

function compare(cur, prev, unit, prevLabel) {
  if (!prev) return cur ? `Chưa có dữ liệu cùng kỳ ${prevLabel} để so sánh.` : '';
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return `Bằng cùng kỳ ${prevLabel} (${unit(prev)}).`;
  return `${pct > 0 ? 'Tăng' : 'Giảm'} ${Math.abs(pct)}% so với cùng kỳ ${prevLabel} (${unit(prev)}).`;
}

const level = (min) => (min <= 0 ? 0 : min < 20 ? 1 : min < 40 ? 2 : 3);

export function renderStatsHtml(st, { readingRows }) {
  const P = PERIODS[st.period];
  const dur = fmtDuration(st.cur.minutes);
  const avg = st.cur.count ? Math.round(st.cur.minutes / st.cur.count) : 0;
  const durUnit = (m) => { const x = fmtDuration(m); return `${x.num} ${x.unit}`; };
  const timeLine = compare(st.cur.minutes, st.prev.minutes, durUnit, P.prev);

  const totalMin = st.genreList.reduce((a, g) => a + g.minutes, 0) || 1;
  const top = st.genreList[0];
  const share = top ? Math.round((top.minutes / totalMin) * 100) : 0;
  const genreRead = top && st.genreList.length > 1
    ? `${esc(top.name)} chiếm ${share}% thời gian đọc -> ${share >= 60 ? `kỳ này nghiêng hẳn về ${esc(top.name.toLowerCase())}` : 'cơ cấu đọc khá cân bằng giữa các thể loại'}.`
    : top ? `Kỳ này chỉ đọc ${esc(top.name.toLowerCase())}.` : '';

  const genreHtml = st.genreList.length ? st.genreList.map((g) => {
    const pct = Math.round((g.minutes / totalMin) * 100);
    const perPage = g.pages ? nf1(g.minutes / g.pages) : null;
    return `<div class="gbar">
      <div class="gbar-head"><span>${esc(g.name)}</span><span class="tnum">${durUnit(g.minutes)} · ${pct}%</span></div>
      <div class="bar lg" role="img" aria-label="${esc(g.name)} ${pct}%"><i style="width:${pct}%"></i></div>
      <span class="muted xs tnum">${g.done} tập/cuốn xong${perPage ? ` · ${perPage} phút/trang` : ''}</span>
    </div>`;
  }).join('') : '<p class="muted sm">Chưa có phiên đọc nào trong kỳ này.</p>';

  const weekdays = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
  const heat = `<div class="heat">
      <div class="heat-days muted xs" aria-hidden="true">${weekdays.map((w, i) => `<span>${i % 2 === 0 ? w : ''}</span>`).join('')}</div>
      <div class="heat-grid" role="img" aria-label="Phút đọc mỗi ngày trong 16 tuần gần nhất">${st.cells.map((c) => `<i class="${c.future ? 'fut' : `lv${level(c.min)}`}" title="${c.key}: ${c.min} phút"></i>`).join('')}</div>
    </div>`;
  const activeDays = st.cells.filter((c) => c.min > 0).length;
  const pastDays = st.cells.filter((c) => !c.future).length;

  const artCmp = compare(st.arts, st.prevArts, (n) => `${n} bài`, P.prev);
  const list = (rows) => rows.slice(0, 8).map(([k, n]) => `<li><span>${esc(k)}</span><span class="tnum muted">${n}</span></li>`).join('');

  return `
    <header class="top">
      <div><h1>Thống kê</h1><span class="muted sm">${st.last ? `Đọc gần nhất ${fmtTime(st.last.end)} · ${esc(st.last.device || '')}` : 'Chưa có phiên đọc'}</span></div>
      <div class="seg-tabs" role="tablist" aria-label="Kỳ thống kê">
        ${Object.entries(PERIODS).map(([k, v]) => `<button type="button" role="tab" aria-selected="${k === st.period}" class="${k === st.period ? 'on' : ''}" data-action="stats-period" data-period="${k}">${v.label.replace(' này', '').replace(' nay', '')}</button>`).join('')}
      </div>
    </header>
    <main class="main stats">
      <section class="kpis" aria-label="Chỉ số chính">
        <div class="card kpi"><span class="big tnum">${st.streak}</span><span class="muted xs">ngày streak · dài nhất ${st.longest}</span></div>
        <div class="card kpi"><span class="big tnum">${dur.num}</span><span class="muted xs">${dur.unit} đọc · ${P.label.toLowerCase()}</span></div>
        <div class="card kpi"><span class="big tnum">${st.cur.count}</span><span class="muted xs">phiên · TB ${avg} phút</span></div>
        <div class="card kpi"><span class="big tnum">${st.completed}</span><span class="muted xs">tập/cuốn hoàn thành</span></div>
        <div class="card kpi"><span class="big tnum">${st.arts}</span><span class="muted xs">bài viết đã đọc</span></div>
      </section>
      ${timeLine ? `<p class="read">${timeLine}</p>` : ''}

      <section class="card" aria-label="Heatmap">
        <div class="sec-head"><h2 class="h3">Phút đọc mỗi ngày · 16 tuần</h2>
          <span class="legend muted xs">Ít <i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i> Nhiều</span></div>
        ${heat}
        <p class="read">Có đọc ${activeDays}/${pastDays} ngày -> ${pastDays ? Math.round((activeDays / pastDays) * 100) : 0}% số ngày.</p>
      </section>

      <div class="stats-grid">
        <section class="card" aria-label="Theo thể loại">
          <h2 class="h3">Theo thể loại · ${P.label.toLowerCase()}</h2>
          ${genreHtml}
          ${genreRead ? `<p class="read">${genreRead}</p>` : ''}
        </section>
        <section class="card" aria-label="Đang đọc">
          <h2 class="h3">Đang đọc</h2>
          ${readingRows || '<p class="muted sm">Chưa có sách đang đọc dở.</p>'}
        </section>
        <section class="card" aria-label="Bài viết">
          <h2 class="h3">Bài viết · ${P.label.toLowerCase()}</h2>
          ${st.arts ? `
            <div class="two-lists">
              <div><p class="muted xs">Theo tag</p><ul class="rank">${list(st.byTag)}</ul></div>
              <div><p class="muted xs">Theo nguồn</p><ul class="rank">${list(st.bySource)}</ul></div>
            </div>
            <p class="read">${st.arts} bài. ${artCmp}</p>` : '<p class="muted sm">Chưa có bài viết nào trong kỳ này.</p>'}
          <p class="muted xs">Bài viết không tính vào streak vì app không đo được thời gian đọc trong Substack.</p>
        </section>
      </div>
    </main>`;
}
