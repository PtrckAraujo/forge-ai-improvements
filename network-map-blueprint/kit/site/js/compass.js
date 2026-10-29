/* ══════════════════════════════════════════════════════════════════════════
   MEDIA COMPASS: where each profile sits by tone and topic. SVG scatter.
   x = share of heated posts (square-root scale), y = the chosen axis,
   circle size = posts with text. Month by month, profiles move.
   ══════════════════════════════════════════════════════════════════════════ */
(() => {
'use strict';

const { fmt, esc, clamp } = Kit;
const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';

Kit.loadData().then(start).catch(err => {
  console.error(err);
  $('gateMsg').textContent = Kit.loadError(err);
});

function start(DATA) {
const D = DATA.compass;
const meta = DATA.meta;
$('brandTitle').textContent = meta.title;
$('brandSub').textContent = meta.subtitle || '';
if (!D) { $('gateMsg').textContent = 'This edition has no Media Compass.'; return; }

const T = D.thresholds;
const nodes = DATA.nodes;
const catOf = Object.fromEntries(DATA.categories.map(c => [c.key, c]));
const P = D.profiles.map((p, i) => {
  const node = p.n != null ? nodes[p.n] : null;
  return { ...p, i, node, key: node ? node.id : p.name, label: node ? node.dn || node.name : p.name };
});
const byKey = new Map(P.map(p => [p.key, p]));
const MAX_TXT = Math.max(...P.map(p => p.txt));
const AXES = {
  pol: { title: 'Talks about politics →', desc: 'share of posts about politics' },
  side: { title: 'Aimed at the government →', desc: 'share of heated, side-naming posts aimed at the government' },
  vague: { title: 'Unnamed enemy →', desc: 'share of heated posts naming no coded target' },
};
const TONE = {
  light: { informative: '#4F7393', mixed: '#C9820A', militant: '#DB0A78' },
  dark: { informative: '#8FA9C4', mixed: '#F2BE45', militant: '#FF45A6' },
};

const S = { axis: 'pol', color: 'tone', month: -1, order: 'acc', sel: null, q: '', tone: '' };
let play = null, tk = Kit.tokens(), clusterCol = [];

/* ------------------------------------------------------------ colours */
function recolor() {
  tk = Kit.tokens();
  const t = Kit.theme.get();
  clusterCol = Kit.clusterColors(DATA, t);
  P.forEach(p => {
    p.col = S.color === 'tone' ? TONE[t][p.tone]
      : !p.node ? tk.nodeOff
      : S.color === 'cat' ? (catOf[p.node.cat] || {})[t] || tk.nodeOff
      : clusterCol[p.node.c] || tk.nodeOff;
  });
}

/* ------------------------------------------------------------ values */
/* Both coordinates always come from the same period: in a month, every axis
   is that month's, with the same minimums as the whole period (so a month
   with few heated posts puts a profile on the n.d. strip, not on a guess). */
function values(p) {
  let acc = p.acc, pol = p.pol, side = p.side, vague = p.vague, off = false;
  if (S.month >= 0) {
    const [n = 0, hot = 0, polN = 0, gov = 0, opp = 0, unnamed = 0] = p.months[S.month] || [];
    if (n >= T.min_month) {
      acc = hot / n;
      pol = polN / n;
      side = gov + opp >= T.min_sides ? gov / (gov + opp) : null;
      vague = hot >= T.min_heated ? unnamed / hot : null;
    } else {
      off = true;                          // too few posts that month: goes dark, not to zero
    }
  }
  const y = S.axis === 'pol' ? pol : S.axis === 'side' ? side : vague;
  return { acc, y, nd: y == null, off };
}

/* ------------------------------------------------------------ plot */
const svg = $('cpSvg');
const gBack = el('g'), gDots = el('g'), gLabels = el('g');
svg.append(gBack, gDots, gLabels);
const dots = P.map(p => {
  const g = el('g', { class: 'dot', 'data-i': p.i, tabindex: '-1' });
  // a transparent disc on top: small dots and hollow n.d. rings stay easy to click
  g.append(el('circle', { class: 'b' }), el('circle', { class: 'hit' }));
  gDots.append(g);
  return g;
});
function el(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

const X_STEPS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1];
const X_TICKS = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1];
const X_MAX = X_STEPS.find(v => v >= 1.04 * Math.max(0.03, ...P.map(p => p.acc))) || 1;

/* Positions (and the O(n²) overlap pass) depend only on axis, month, plot
   size and theme. Filters, selection and colour changes reuse them and only
   repaint, so typing in the filter box stays cheap with hundreds of profiles. */
let geo = null;
function draw() {
  const box = svg.getBoundingClientRect();
  const W = Math.max(300, Math.round(box.width)), H = Math.max(280, Math.round(box.height));
  const key = [S.axis, S.month, W, H, Kit.theme.get()].join('|');
  if (!geo || geo.key !== key) geo = { key, ...layoutPlot(W, H) };
  // a single month rarely has enough heated posts for these axes: say why dots sit on n.d.
  const note = $('cpNote');
  note.hidden = !(S.month >= 0 && S.axis !== 'pol');
  note.textContent = note.hidden ? '' : `This month's posts only · n.d. = fewer than ${
    S.axis === 'side' ? T.min_sides + ' heated posts naming a side' : T.min_heated + ' heated posts'}`;
  paint();
}
function layoutPlot(W, H) {
  const narrow = W < 520;
  const vals = P.map(values);
  const hasNd = vals.some(v => v.nd && !v.off);
  const m = { l: narrow ? 36 : 52, r: narrow ? 12 : 22, t: 30, b: (narrow ? 40 : 46) + (hasNd ? 46 : 0) };
  const x0 = m.l, x1 = W - m.r, y0 = m.t, y1 = H - m.b, PAD = narrow ? 9 : 14;
  const X = v => x0 + PAD + (x1 - x0 - PAD) * Math.sqrt(clamp(v / X_MAX, 0, 1));
  const Y = v => y1 - (y1 - y0) * clamp(v, 0, 1);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  $('cpSvgDesc').textContent = `Scatter plot: horizontal, share of heated posts; vertical, ${AXES[S.axis].desc}.`;

  /* background: tone bands, grid, axes */
  gBack.replaceChildren();
  const bands = [[0, T.informative, 'Informative'], [T.informative, T.militant, 'Mixed'], [T.militant, X_MAX, 'Militant']];
  bands.forEach(([a, b, name], k) => {
    if (a >= X_MAX) return;
    const xa = k === 0 ? x0 : X(a), xb = X(Math.min(b, X_MAX));
    if (k) gBack.append(el('rect', { x: xa, y: y0, width: xb - xa, height: y1 - y0,
      fill: k === 2 ? Kit.alpha(tk.accent, 0.05) : Kit.alpha(tk.muted, 0.05) }));
    gBack.append(el('text', { x: (xa + xb) / 2, y: y0 - 10, 'text-anchor': 'middle',
      class: 'band-lab' + (k === 2 ? ' hot' : '') }, name));
  });
  [0, 0.25, 0.5, 0.75, 1].forEach(v => {
    gBack.append(el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), class: 'grid' }));
    gBack.append(el('text', { x: x0 - 6, y: Y(v) + 3, 'text-anchor': 'end' }, Math.round(v * 100) + '%'));
  });
  X_TICKS.filter(v => v <= X_MAX).forEach(v => {
    gBack.append(el('line', { x1: X(v), x2: X(v), y1: y0, y2: y1, class: 'grid' }));
    if (!narrow || [0, 0.02, 0.1, 0.3, 1].includes(v))
      gBack.append(el('text', { x: X(v), y: y1 + 14, 'text-anchor': 'middle' }, fmt.pct(v)));
  });
  gBack.append(el('text', { x: x1, y: y1 + 32, 'text-anchor': 'end', class: 'axis-t' }, 'Heated posts →'));
  gBack.append(el('text', { x: 12, y: (y0 + y1) / 2, 'text-anchor': 'middle', class: 'axis-t',
    transform: `rotate(-90 12 ${(y0 + y1) / 2})` }, AXES[S.axis].title));
  const ndY = H - 26;
  if (hasNd) gBack.append(el('text', { x: x0 - 6, y: ndY + 3, 'text-anchor': 'end' }, 'n.d.'));

  /* positions: data point, then a bounded nudge so circles overlap less */
  const pts = P.map((p, k) => {
    const v = vals[k];
    const r = (3.4 + 14 * Math.sqrt(p.txt / MAX_TXT)) * (narrow ? 0.72 : 1);
    return { p, v, r: v.nd ? 2.8 : r, x: X(v.acc), y: v.nd ? ndY : Y(v.y) };
  });
  relax(pts.filter(q => !q.v.nd && !q.v.off), x0, x1);
  pack(pts.filter(q => q.v.nd && !q.v.off), x1);
  return { pts, narrow, x1, W };
}
function paint() {
  const { pts, narrow, x1, W } = geo;
  /* draw bigger circles first, the selected one last */
  const order = pts.slice().sort((a, b) => b.r - a.r);
  if (S.sel) order.push(order.splice(order.findIndex(q => q.p === S.sel), 1)[0]);
  const filtered = filterSet();
  order.forEach(q => {
    const g = dots[q.p.i];
    g.style.transform = `translate(${q.x}px, ${q.y}px)`;
    const c = g.firstChild;
    c.setAttribute('r', q.r);
    c.setAttribute('fill', q.p.col);
    c.classList.toggle('nd', q.v.nd);
    c.style.stroke = q.v.nd ? q.p.col : '';           // inline: the CSS rim would hide the ring
    g.lastChild.setAttribute('r', Math.max(q.r, 7));
    g.classList.toggle('off', q.v.off);
    g.classList.toggle('dim', !q.v.off && ((S.sel && S.sel !== q.p) || !filtered.has(q.p)));
    g.classList.toggle('sel', S.sel === q.p);
    g.setAttribute('aria-label', `${q.p.label}: ${fmt.pct(q.v.acc, 1)} heated`);
    gDots.append(g);
  });
  labels(pts.filter(q => !q.v.off), narrow, x1, W);
}

/* overlapping circles push each other apart, never more than 10px from the
   true value: the chart stays honest, just readable */
function relax(pts, xmin, xmax) {
  pts.forEach(q => { q.ox = q.x; q.oy = q.y; });
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        const need = a.r + b.r + 1;
        if (d >= need) continue;
        if (d < 0.01) { dx = Math.cos(i + j); dy = Math.sin(i + j); d = 1; }
        const push = (need - d) / 4;
        a.x -= dx / d * push; a.y -= dy / d * push;
        b.x += dx / d * push; b.y += dy / d * push;
        moved = true;
      }
    }
    pts.forEach(q => {
      const ex = q.x - q.ox, ey = q.y - q.oy, e = Math.hypot(ex, ey);
      if (e > 10) { q.x = q.ox + ex / e * 10; q.y = q.oy + ey / e * 10; }
      q.x = clamp(q.x, xmin + q.r * 0.3, xmax);
    });
    if (!moved) break;
  }
}
/* the n.d. strip: a tidy row of small rings, left to right by heated share */
function pack(pts, xmax) {
  const taken = [];
  pts.sort((a, b) => a.x - b.x).forEach(q => {
    for (let dx = 0; dx < 800; dx += 6) {
      for (const dy of [0, -6, 6, -12, 12]) {
        const x = Math.min(q.x + dx, xmax), y = q.y + dy;
        if (taken.every(t => Math.hypot(t.x - x, t.y - y) > 5.8)) {
          q.x = x; q.y = y; taken.push(q);
          return;
        }
      }
    }
  });
}

/* labels: biggest and most extreme first, tried right, left, above, below;
   any overlap with a placed label or a circle is rejected */
function labels(pts, narrow, xmax, W) {
  gLabels.replaceChildren();
  if (play) return;                              // moving dots: names would only flicker
  const boxes = pts.map(q => [q.x - q.r, q.y - q.r, q.x + q.r, q.y + q.r]);
  const hit = b => boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  const cand = pts.filter(q => !q.v.nd)
    .sort((a, b) => (b.p === S.sel) - (a.p === S.sel) || (b.r + 40 * b.v.acc) - (a.r + 40 * a.v.acc));
  let n = 0;
  for (const q of cand) {
    const sel = q.p === S.sel;
    if (!sel && n >= (narrow ? 10 : 26)) continue;
    const text = q.p.label.length > 24 ? q.p.label.slice(0, 22) + '…' : q.p.label;
    const w = text.length * 6 + 4, h = 11;
    const tries = [[q.x + q.r + 3, q.y + 3, 'start'], [q.x - q.r - 3, q.y + 3, 'end'],
                   [q.x, q.y - q.r - 4, 'middle'], [q.x, q.y + q.r + 11, 'middle']];
    if (q.x > xmax * 0.7) tries.unshift(tries.splice(1, 1)[0]);
    for (const [x, y, anchor] of tries) {
      const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
      const b = [left, y - h + 2, left + w, y + 2];
      if (!sel && (hit(b) || b[0] < 2 || b[2] > W - 2)) continue;
      boxes.push(b);
      gLabels.append(el('text', { x, y, 'text-anchor': anchor, class: 'lbl' + (sel ? ' sel' : '') }, text));
      n++;
      break;
    }
  }
}

svg.addEventListener('click', e => {
  const g = e.target.closest('.dot');
  choose(g ? P[+g.dataset.i] : null);
});

/* ------------------------------------------------------------ timeline */
function timeline() {
  const tl = $('timeline');
  const shown = D.months_shown;
  if (!shown.length) { tl.hidden = true; return; }
  const rate = j => {
    const [n, h] = P.reduce((s, p) => [s[0] + p.months[j][0], s[1] + p.months[j][1]], [0, 0]);
    return n ? h / n : 0;
  };
  const max = Math.max(...shown.map(rate), 0.001);
  const label = j => new Date(D.months[j] + '-15').toLocaleString(document.documentElement.lang, { month: 'short' });
  tl.innerHTML = `<button type="button" class="play" id="play" aria-label="Play month by month">▶</button>` +
    `<button type="button" data-m="-1" aria-pressed="true"><span class="t"><b style="height:${Math.min(100, 100 * D.profiles.reduce((s, p) => s + p.heated, 0) / D.total_posts / max)}%"></b></span>All ${fmt.pct(D.profiles.reduce((s, p) => s + p.heated, 0) / D.total_posts, 1)}</button>` +
    shown.map(j => `<button type="button" data-m="${j}" aria-pressed="false"><span class="t"><b style="height:${100 * rate(j) / max}%"></b></span>${esc(label(j))} ${fmt.pct(rate(j), 1)}</button>`).join('');
  tl.addEventListener('click', e => {
    if (e.target.closest('#play')) { play ? stop() : startPlay(); return; }
    const b = e.target.closest('[data-m]');
    if (b) { stop(); setMonth(+b.dataset.m); }
  });
}
function setMonth(j) {
  S.month = j;
  document.querySelectorAll('#timeline [data-m]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.m === j)));
  draw();
}
function startPlay() {
  const shown = D.months_shown;
  if (S.month === shown[shown.length - 1]) S.month = -1;   // at the end: play again from the start
  const next = () => {
    const k = shown.indexOf(S.month);
    if (k === shown.length - 1) { stop(); setMonth(-1); return; }
    setMonth(shown[k + 1]);
  };
  $('play').textContent = '❚❚';
  play = setInterval(next, 2100);
  next();
}
function stop() {
  if (!play) return;
  clearInterval(play);
  play = null;
  $('play').textContent = '▶';
  draw();
}

/* ------------------------------------------------------------ sidebar */
const side = $('side');
function sidebar() {
  if (S.sel) return detail(S.sel);
  const k = S.order;
  const list = P.slice().sort((a, b) => b[k] - a[k] || a.label.localeCompare(b.label));
  const max = list[0] ? list[0][k] || 1 : 1;
  side.innerHTML = list.map((p, i) => `<button class="row rank" type="button" data-i="${p.i}">
    <small>${i + 1}</small><span>${esc(p.label)}</span><em class="${k === 'acc' ? 'hot' : ''}">${k === 'txt' ? fmt.int(p.txt) : fmt.pct(p[k], 1)}</em>
    <i class="track"><b style="width:${(100 * p[k] / max).toFixed(1)}%;background:${p.col}"></b></i></button>`).join('');
}
function hbars(counts, names, total, n = 4) {
  const top = counts.map((v, k) => [v, k]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, n);
  if (!top.length) return '<p class="empty">None in this period.</p>';
  return top.map(([v, k]) => `<div class="hbar"><span>${esc(names[k])}</span><b>${fmt.pct(v / total)}</b>
    <i><b style="width:${(100 * v / top[0][0]).toFixed(1)}%"></b></i></div>`).join('');
}
function detail(p) {
  const t = Kit.theme.get();
  // months with too few posts are not drawn, so they must not set the scale either
  const rates = p.months.map(m => (m[0] >= T.min_month ? m[1] / m[0] : null));
  const mx = Math.max(0.01, ...rates.filter(r => r != null));
  side.innerHTML = `<div class="side-detail">
    <div class="card-head" style="padding:0 0 10px;border:0"><span class="lab">Profile</span><button class="close" type="button" aria-label="Back to the ranking">×</button></div>
    <h2>${esc(p.label)}</h2>${p.node && p.node.dn ? `<p class="lab">${esc(p.node.name)}</p>` : ''}
    <span class="tone" style="background:${TONE[t][p.tone]}">${esc(p.tone)}</span>
    <dl>
      <div><dt>Heated</dt><dd class="hot">${fmt.pct(p.acc, 1)}</dd></div>
      <div><dt>About politics</dt><dd>${fmt.pct(p.pol)}</dd></div>
      <div><dt>Posts with text</dt><dd>${fmt.int(p.txt)}</dd></div>
      <div><dt>Heated posts</dt><dd>${fmt.int(p.heated)}</dd></div>
      <div><dt>Unnamed enemy</dt><dd>${fmt.pct(p.vague)}</dd></div>
      <div><dt>At government</dt><dd>${fmt.pct(p.side)}</dd></div>
    </dl>
    <h3 class="lab">Main topics</h3>${hbars(p.topics, D.topics, p.txt)}
    <h3 class="lab">Targets named</h3>${hbars(p.targets, D.targets, p.txt, 3)}
    <h3 class="lab">Heated share, month by month</h3>
    <div class="months">${rates.map((r, j) => `<span style="height:${r == null ? 0 : (100 * r / mx).toFixed(1)}%"
      title="${esc(D.months[j])}: ${r == null ? 'too few posts' : fmt.pct(r, 1) + ' heated'}"></span>`).join('')}</div>
    ${p.node ? `<p style="margin-top:14px"><a class="btn" href="./#${encodeURIComponent(p.node.id)}">See in the network →</a></p>` : ''}
  </div>`;
}
side.addEventListener('click', e => {
  if (e.target.closest('.close')) { choose(null); return; }
  const b = e.target.closest('[data-i]');
  if (b) choose(P[+b.dataset.i]);
});
document.querySelector('.side .tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-o]');
  if (!b) return;
  S.order = b.dataset.o;
  document.querySelectorAll('.side .tabs [data-o]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  if (S.sel) choose(null); else sidebar();
});

/* ------------------------------------------------------------ lower sections */
function lower() {
  const rows = D.topics.map((name, k) => {
    const n = P.reduce((s, p) => s + p.topics[k], 0), h = P.reduce((s, p) => s + p.topics_heated[k], 0);
    return { name, n, rate: n ? h / n : 0 };
  }).filter(r => r.n >= 20).sort((a, b) => b.rate - a.rate);
  const mt = Math.max(0.001, ...rows.map(r => r.rate));
  $('topics').innerHTML = rows.map(r => `<div class="hbar"><span>${esc(r.name)} <small class="lab">${fmt.int(r.n)} posts</small></span>
    <b class="hot">${fmt.pct(r.rate, 1)}</b><i><b style="width:${(100 * r.rate / mt).toFixed(1)}%"></b></i></div>`).join('');
  const hot = P.reduce((s, p) => s + p.heated, 0) || 1;
  const tg = D.targets.map((name, k) => ({ name, n: P.reduce((s, p) => s + p.targets_heated[k], 0) }))
    .sort((a, b) => b.n - a.n);
  const mg = Math.max(1, ...tg.map(r => r.n));
  $('targets').innerHTML = tg.map(r => `<div class="hbar"><span>${esc(r.name)}</span><b>${fmt.pct(r.n / hot)}</b>
    <i><b style="width:${(100 * r.n / mg).toFixed(1)}%"></b></i></div>`).join('') +
    `<p class="lab" style="margin-top:8px">Share of all ${fmt.int(hot)} heated posts naming each target</p>`;
}

/* ------------------------------------------------------------ list + filters */
function filterSet() {
  const q = S.q.trim().toLowerCase();
  return new Set(P.filter(p => (!S.tone || p.tone === S.tone) &&
    (!q || (p.label + ' ' + p.name + ' ' + (p.node ? p.node.name : '')).toLowerCase().includes(q))));
}
function list() {
  const ok = filterSet();
  const items = P.filter(p => ok.has(p)).sort((a, b) => b.txt - a.txt);
  $('fCount').textContent = `${items.length} of ${P.length}`;
  $('listEmpty').hidden = items.length > 0;
  const t = Kit.theme.get();
  $('list').innerHTML = items.map(p => `<button class="pcard" type="button" data-i="${p.i}">
    <b>${esc(p.label)}</b><span class="tn" style="color:${TONE[t][p.tone]}">${esc(p.tone)}</span>
    <small>${fmt.pct(p.acc, 1)} heated · ${fmt.pct(p.pol)} politics · ${fmt.int(p.txt)} posts</small></button>`).join('');
}
$('list').addEventListener('click', e => {
  const b = e.target.closest('[data-i]');
  if (b) { choose(P[+b.dataset.i]); $('cp').scrollIntoView({ behavior: Kit.reducedMotion() ? 'auto' : 'smooth' }); }
});
$('fq').addEventListener('input', e => { S.q = e.target.value; list(); draw(); });
$('fTone').addEventListener('click', e => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  S.tone = b.dataset.t;
  $('fTone').querySelectorAll('[data-t]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  list();
  draw();
});

/* ------------------------------------------------------------ selection + address */
function choose(p) {
  S.sel = p;
  history.replaceState(null, '', p ? '#' + encodeURIComponent(p.key) : location.pathname + location.search);
  draw();
  sidebar();
}
function openHash() {
  let h = location.hash.slice(1);
  try { h = decodeURIComponent(h); } catch (e) { /* keep as is */ }
  const p = byKey.get(h) || byKey.get(h.toLowerCase()) || null;
  if (p !== S.sel) choose(p);
}
addEventListener('hashchange', openHash);
addEventListener('keydown', e => {
  if (e.key === 'Escape' && S.sel && document.activeElement.tagName !== 'INPUT') choose(null);
});

/* ------------------------------------------------------------ controls */
$('axis').addEventListener('click', e => {
  const b = e.target.closest('[data-y]');
  if (!b) return;
  S.axis = b.dataset.y;
  $('axis').querySelectorAll('[data-y]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  draw();
});
$('colorBy').addEventListener('click', e => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  S.color = b.dataset.c;
  $('colorBy').querySelectorAll('[data-c]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  recolor();
  draw();
  sidebar();
});
const themeLabel = () => { $('btnTheme').textContent = Kit.theme.get() === 'dark' ? 'Light' : 'Dark'; };
$('btnTheme').onclick = () => Kit.theme.toggle();
Kit.theme.on(() => { themeLabel(); recolor(); draw(); sidebar(); list(); });

/* ------------------------------------------------------------ boot */
const hotTotal = D.profiles.reduce((s, p) => s + p.heated, 0);
$('cN').textContent = P.length;
$('cPosts').textContent = fmt.int(D.total_posts);
$('cAcc').textContent = fmt.pct(hotTotal / D.total_posts, 1);
$('cpPeriod').textContent = `Text analysis · ${D.months[0]} – ${D.months[D.months.length - 1]}`;
$('cpLede').textContent = `${P.length} ${meta.platform} profiles: ${D.tones.informative} informative, ` +
  `${D.tones.mixed} mixed, ${D.tones.militant} militant.`;
$('cp').hidden = false;
themeLabel();
recolor();
timeline();
lower();
list();
openHash();
if (!S.sel) { draw(); sidebar(); }
let rz;
addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(draw, 120); });
const gate = $('gate');
gate.classList.add('gone');
setTimeout(() => { gate.hidden = true; }, 450);
}
})();
