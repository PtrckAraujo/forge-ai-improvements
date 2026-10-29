/* ══════════════════════════════════════════════════════════════════════════
   NETWORK MAP: Canvas 2D, no dependencies.
   Positions come precomputed from the build: the browser never simulates, it
   draws, focuses and animates a fixed layout.
   ══════════════════════════════════════════════════════════════════════════ */
(() => {
'use strict';

const { fmt, esc, clamp } = Kit;
const $ = id => document.getElementById(id);
const wide = () => innerWidth > 760;

Kit.loadData().then(start).catch(err => {
  console.error(err);
  $('gateMsg').textContent = Kit.loadError(err);
});

function start(DATA) {

/* ═════════════════════════════════════════════════════ 1. MODEL */
const meta = DATA.meta;
const nodes = DATA.nodes;
const clusters = DATA.clusters;
const catOf = Object.fromEntries(DATA.categories.map(c => [c.key, c]));
const groupOf = Object.fromEntries((DATA.groups || []).map(g => [g.id, g]));
const byId = new Map(nodes.map(n => [n.id, n]));

nodes.forEach((n, i) => {
  n.i = i;
  n.adj = [];
  n.key = (n.name + ' ' + (n.dn || '')).toLowerCase();
});
const links = DATA.links.map(([a, b]) => {
  nodes[a].adj.push(nodes[b]);
  nodes[b].adj.push(nodes[a]);
  return { a: nodes[a], b: nodes[b], col: null };
});
links.sort((x, y) => (x.a.deg + x.b.deg) - (y.a.deg + y.b.deg));   // hubs' edges on top

/* Two-segment size scale for interactions: area ∝ value up to the 95th
   percentile, logarithmic above it, so a few giants don't flatten everyone. */
const itrs = nodes.map(n => n.itr).filter(v => typeof v === 'number' && v > 0).sort((a, b) => a - b);
const P95 = itrs.length ? itrs[Math.min(itrs.length - 1, Math.floor(itrs.length * 0.95))] : 1;
const IMAX = itrs.length ? itrs[itrs.length - 1] : 1;
function rItr(v) {
  if (typeof v !== 'number') return 2.8;          // n/r: drawn hollow, never as zero
  if (v <= 0) return 2.4;
  if (v <= P95) return 3.4 + 20 * Math.sqrt(v / P95);
  return 23.4 + (IMAX > P95 ? 14 * Math.log(v / P95) / Math.log(IMAX / P95) : 0);
}
nodes.forEach(n => {
  n.rDeg = 3 + 2.1 * Math.sqrt(n.deg);
  n.rI = rItr(n.itr);
  n.na = typeof n.itr !== 'number';
});
const BT_MAX = Math.max(1e-9, ...nodes.map(n => n.bt));
const bridges = nodes.filter(n => n.bt > 0).sort((a, b) => b.bt - a.bt);
bridges.forEach((n, k) => { n.bRank = k + 1; });
const topBridges = new Set(bridges.slice(0, 20));
const byItr = nodes.filter(n => typeof n.itr === 'number').sort((a, b) => b.itr - a.itr);

const cp = DATA.compass;
const cpOf = new Map();
if (cp) cp.profiles.forEach(p => { if (p.n != null) cpOf.set(nodes[p.n], p); });

/* ═════════════════════════════════════════════════════ 2. STATE */
const S = { itr: false, cat: true, photos: false, rail: wide(), matrix: false, bridge: false, tab: 'cat' };
let sel = null, hover = null, focus = null;      // focus: { kind, key, set, edge }
let needsDraw = true, touched = false;

const atlas = Kit.atlas(DATA, () => { needsDraw = true; if (sel) fillCard(sel); });
let tk = Kit.tokens(), dark = false, clusterCol = [];
const MONO = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace';

const rOf = n => (S.itr ? n.rI : n.rDeg);
const weightOf = n => (S.itr ? (n.itr || 0) : n.deg);

/* Colour = the active bucket (category or cluster); intensity = weight
   inside that bucket. Edges inside a bucket take its tint, edges between
   buckets stay grey: they are the ones holding the network together. */
function recolor() {
  tk = Kit.tokens();
  dark = Kit.theme.get() === 'dark';
  clusterCol = Kit.clusterColors(DATA, dark ? 'dark' : 'light');
  const bucket = n => (S.cat ? n.cat : n.c);
  const max = new Map();
  nodes.forEach(n => max.set(bucket(n), Math.max(max.get(bucket(n)) || 0, weightOf(n))));
  nodes.forEach(n => {
    const base = S.cat ? (catOf[n.cat] || {})[dark ? 'dark' : 'light'] : clusterCol[n.c];
    n.base = base || tk.nodeOff;
    n.bucket = base ? bucket(n) : null;
    n.col = base ? Kit.shade(base, Math.sqrt(Math.min(1, weightOf(n) / (max.get(bucket(n)) || 1))),
                             dark, S.cat ? 1 : 0.5)
                 : tk.nodeOff;
  });
  links.forEach(l => {
    l.col = l.a.bucket != null && l.a.bucket === l.b.bucket ? Kit.soften(l.a.base, dark) : null;
  });
  drawOrder = nodes.slice().sort((a, b) => rOf(a) - rOf(b));
  needsDraw = true;
}
let drawOrder = nodes;

function active() {
  if (focus) return focus.set;
  const n = sel || hover;
  if (!n) return null;
  const s = new Set(n.adj);
  s.add(n);
  return s;
}
function edgeOn(l) {
  if (focus) return focus.edge(l);
  const n = sel || hover;
  return !!n && (l.a === n || l.b === n);
}

/* ═════════════════════════════════════════════════════ 3. CAMERA */
const cv = $('graph'), ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;
const view = { x: 0, y: 0, k: 1 };
let cam = null;
const sx = n => n.x * view.k + view.x;
const sy = n => n.y * view.k + view.y;

function resize() {
  const was = { W, H };
  W = innerWidth; H = innerHeight;
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W * DPR);
  cv.height = Math.round(H * DPR);
  if (!touched) fitAll(0);
  else if (sel) centerOn(sel, 0, view.k);
  else { view.x += (W - was.W) / 2; view.y += (H - was.H) / 2; }
  needsDraw = true;
}

/* The part of the screen not covered by panels: framing aims there. Offsets
   ignore CSS transforms, so a panel sliding in is measured where it lands. */
function freeBox() {
  const vis = id => { const e = $(id); return e && !e.hidden && getComputedStyle(e).display !== 'none' ? e : null; };
  const bar = $('bar');
  const b = { l: 16, t: bar.offsetTop + bar.offsetHeight + 12, r: W - 16, b: H - 16 };
  const side = vis('card') || vis('rail');
  if (wide()) {
    const o = vis('opts');
    if (o) b.l = o.offsetLeft + o.offsetWidth + 16;
    if (side) b.r = side.offsetLeft - 16;
  } else if (side) {
    b.b = side.offsetTop - 8;
  }
  if (b.r - b.l < 120) { b.l = 16; b.r = W - 16; }
  if (b.b - b.t < 120) { b.t = 60; b.b = H - 16; }
  return b;
}

function flyTo(wx, wy, k, ms = 560, px = W / 2, py = H / 2) {
  const to = { x: px - wx * k, y: py - wy * k, k };
  if (ms <= 0 || Kit.reducedMotion()) {
    Object.assign(view, to);
    cam = null;
    zoomLabel();
  } else {
    cam = { from: { ...view }, to, t0: performance.now(), ms };
  }
  needsDraw = true;
}
function stepCamera(now) {
  const p = clamp((now - cam.t0) / cam.ms, 0, 1), e = 1 - (1 - p) ** 3;
  for (const key of ['x', 'y', 'k']) view[key] = cam.from[key] + (cam.to[key] - cam.from[key]) * e;
  if (p >= 1) cam = null;
  zoomLabel();
}
function fitNodes(list, ms = 600, { pad = 34, min = 160, kmax = 2 } = {}) {
  if (!list.length) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of list) {
    x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x);
    y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
  }
  const b = freeBox();
  const w = Math.max(x1 - x0, min), h = Math.max(y1 - y0, min);
  const k = clamp(Math.min((b.r - b.l - 2 * pad) / w, (b.b - b.t - 2 * pad) / h), 0.08, kmax);
  flyTo((x0 + x1) / 2, (y0 + y1) / 2, k, ms, (b.l + b.r) / 2, (b.t + b.b) / 2);
}
const fitAll = ms => fitNodes(nodes, ms, { pad: wide() ? 30 : 16, min: 1, kmax: 6 });
function centerOn(n, ms = 520, k = Math.max(view.k, 1.05)) {
  const b = freeBox();
  flyTo(n.x, n.y, k, ms, (b.l + b.r) / 2, (b.t + b.b) / 2);
}
function zoomAt(f, px, py) {
  const k = clamp(view.k * f, 0.08, 8);
  const wx = (px - view.x) / view.k, wy = (py - view.y) / view.k;
  view.k = k;
  view.x = px - wx * k;
  view.y = py - wy * k;
  cam = null;
  touched = true;
  needsDraw = true;
  zoomLabel();
}
function zoomLabel() { $('sZoom').textContent = Math.round(view.k * 100) + '%'; }

/* ═════════════════════════════════════════════════════ 4. OPENING */
/* The network grows outward from each component's hub, breadth-first, so
   the eye reads the structure before the details. */
let intro = null;
function buildWave() {
  const seen = new Set(), comps = [];
  for (const s of nodes.slice().sort((a, b) => b.deg - a.deg)) {
    if (seen.has(s)) continue;
    const comp = [s];
    s.depth = 0;
    seen.add(s);
    for (let q = 0; q < comp.length; q++) {
      for (const m of comp[q].adj) {
        if (!seen.has(m)) { seen.add(m); m.depth = comp[q].depth + 1; comp.push(m); }
      }
    }
    comps.push(comp);
  }
  const s0 = comps[0][0];
  const far = Math.max(1, ...comps.map(c => Math.hypot(c[0].x - s0.x, c[0].y - s0.y)));
  comps.forEach((comp, ci) => {
    const maxD = Math.max(1, ...comp.map(n => n.depth));
    const delay = ci === 0 ? 0 : 0.25 + 0.4 * Math.hypot(comp[0].x - s0.x, comp[0].y - s0.y) / far;
    comp.forEach(n => {
      n.rv = Math.min(0.88, delay + (ci === 0 ? 0.8 : 0.3) * n.depth / maxD);
    });
  });
}
const reveal = (n, p) => clamp((p - n.rv) / 0.12, 0, 1);

/* ═════════════════════════════════════════════════════ 5. DRAWING */
let ripple = null;

function draw(now) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const p = intro ? clamp((now - intro.t0) / intro.dur, 0, 1) : 1;
  const act = active();
  const k = view.k;
  const vis = n => { const X = sx(n), Y = sy(n); return X > -60 && X < W + 60 && Y > -60 && Y < H + 60; };
  const seg = l => { ctx.moveTo(sx(l.a), sy(l.a)); ctx.lineTo(sx(l.b), sy(l.b)); };

  /* ---- edges */
  ctx.lineCap = 'butt';
  const restW = Math.max(0.6, 0.85 * k);
  if (intro && p < 1) {
    ctx.lineWidth = restW;
    for (const l of links) {
      const a = Math.min(reveal(l.a, p), reveal(l.b, p));
      if (!a) continue;
      ctx.globalAlpha = a * (l.col ? 0.9 : 0.55);
      ctx.strokeStyle = l.col || tk.edge;
      ctx.beginPath(); seg(l); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else if (!act && S.bridge) {
    ctx.lineWidth = restW;
    ctx.strokeStyle = Kit.alpha(tk.edge, 0.14);
    ctx.beginPath();
    for (const l of links) if (l.a.c === l.b.c) seg(l);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, 1.3 * k);
    ctx.strokeStyle = Kit.alpha(tk.ink, 0.62);
    ctx.beginPath();
    for (const l of links) if (l.a.c !== l.b.c) seg(l);
    ctx.stroke();
  } else if (!act) {
    ctx.lineWidth = restW;
    ctx.strokeStyle = Kit.alpha(tk.edge, 0.6);
    ctx.beginPath();
    for (const l of links) if (!l.col && (vis(l.a) || vis(l.b))) seg(l);
    ctx.stroke();
    ctx.globalAlpha = 0.92;
    for (const l of links) {
      if (!l.col || !(vis(l.a) || vis(l.b))) continue;
      ctx.strokeStyle = l.col;
      ctx.beginPath(); seg(l); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else {
    ctx.lineWidth = restW;
    ctx.strokeStyle = Kit.alpha(tk.edgeOff, 0.4);
    ctx.beginPath();
    const on = [];
    for (const l of links) {
      if (edgeOn(l)) on.push(l);
      else seg(l);
    }
    ctx.stroke();
    const who = sel || (!focus && hover);
    ctx.lineWidth = Math.max(1, 1.5 * k);
    for (const l of on) {
      ctx.strokeStyle = who ? who.col : (l.col || tk.edge);
      ctx.globalAlpha = who ? 0.85 : 0.9;
      ctx.beginPath(); seg(l); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ---- nodes */
  const photos = S.photos && atlas.ok;
  for (const n of drawOrder) {
    const X = sx(n), Y = sy(n);
    n._vis = X > -60 && X < W + 60 && Y > -60 && Y < H + 60;
    if (!n._vis) continue;
    let R = Math.max(1.5, rOf(n) * k);
    if (S.photos) R = Math.max(R, 7);
    let a = 1;
    const on = !act || act.has(n);
    if (!act && S.bridge) {
      const b = Math.sqrt(n.bt / BT_MAX);
      R *= 1 + 0.9 * b;
      a = 0.16 + 0.84 * b;
    }
    if (!on) a = 0.2;
    if (intro && p < 1) {
      const r = reveal(n, p);
      if (!r) { n._R = 0; continue; }
      a *= r;
      R *= 0.35 + 0.65 * r;
    }
    n._R = R;
    ctx.globalAlpha = a;
    const col = on ? n.col : tk.nodeOff;
    if (photos && atlas.has(n)) {
      const [cx, cy, s] = atlas.cell(n);
      if (!on) ctx.globalAlpha = a * 0.55;
      ctx.drawImage(atlas.img, cx, cy, s, s, X - R, Y - R, 2 * R, 2 * R);
      ctx.globalAlpha = a;
      ctx.lineWidth = Math.max(1, Math.min(2.4, 0.2 * R));
      ctx.strokeStyle = col;
      ctx.strokeRect(X - R + ctx.lineWidth / 2, Y - R + ctx.lineWidth / 2, 2 * R - ctx.lineWidth, 2 * R - ctx.lineWidth);
    } else if (S.itr && n.na) {
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = col;
      ctx.strokeRect(X - R + 0.6, Y - R + 0.6, 2 * R - 1.2, 2 * R - 1.2);
    } else {
      ctx.fillStyle = col;
      ctx.fillRect(X - R, Y - R, 2 * R, 2 * R);
      if (act && on && R > 3) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = tk.halo;
        ctx.strokeRect(X - R - 0.5, Y - R - 0.5, 2 * R + 1, 2 * R + 1);
      }
    }
    if (!act && S.bridge && topBridges.has(n)) {
      const pulse = Kit.reducedMotion() ? 0 : (Math.sin(now / 420 + n.i) + 1) / 2;
      ctx.globalAlpha = 0.5 + 0.4 * pulse;
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = tk.accent;
      const g = R + 4 + 3 * pulse;
      ctx.strokeRect(X - g, Y - g, 2 * g, 2 * g);
    }
  }
  ctx.globalAlpha = 1;

  if (sel) drawMarker(sel, now);
  drawLabels(act, p);
}

/* selection: registration crosshair, corner brackets and a one-off ripple */
function drawMarker(n, now) {
  const X = sx(n), Y = sy(n), R = Math.max(n._R || 4, 4) + 6;
  ctx.save();
  ctx.strokeStyle = Kit.alpha(tk.accent, 0.35);
  ctx.setLineDash([2, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Y); ctx.lineTo(X - R - 4, Y); ctx.moveTo(X + R + 4, Y); ctx.lineTo(W, Y);
  ctx.moveTo(X, 0); ctx.lineTo(X, Y - R - 4); ctx.moveTo(X, Y + R + 4); ctx.lineTo(X, H);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = tk.ink;
  ctx.lineWidth = 1.4;
  const c = Math.min(6, R);
  ctx.beginPath();
  for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.moveTo(X + dx * R, Y + dy * (R - c));
    ctx.lineTo(X + dx * R, Y + dy * R);
    ctx.lineTo(X + dx * (R - c), Y + dy * R);
  }
  ctx.stroke();
  if (ripple) {
    const q = (now - ripple) / 900;
    if (q >= 1) ripple = null;
    else {
      const g = R + 30 * q;
      ctx.globalAlpha = 1 - q;
      ctx.strokeStyle = tk.accent;
      ctx.strokeRect(X - g, Y - g, 2 * g, 2 * g);
    }
  }
  ctx.restore();
}

/* Labels: priority ones first, then by weight; a greedy pass drops any label
   that would overlap one already placed. */
function drawLabels(act, p) {
  if (p < 0.78) return;
  const k = view.k;
  let thr = k > 2.4 ? 0 : k > 1.5 ? 2 : k > 0.9 ? 5 : k > 0.55 ? 9 : 15;
  if (W < 520) thr += 4;
  if (act) thr = Math.max(0, thr - 6);
  const pri = new Set([sel, hover].filter(Boolean));
  if (sel && !focus) sel.adj.forEach(m => pri.add(m));
  const cands = [];
  for (const n of nodes) {
    if (!n._vis || !n._R) continue;
    if (pri.has(n)) { cands.push([n, 2]); continue; }
    if (act && !act.has(n)) continue;
    if (!act && S.bridge && !topBridges.has(n)) continue;
    if (n.deg >= thr || (S.itr && n._R > 9)) cands.push([n, 0]);
  }
  cands.sort((a, b) => b[1] - a[1] || (a[0] === sel ? -1 : b[0] === sel ? 1 : 0) || weightOf(b[0]) - weightOf(a[0]));
  const boxes = [];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = intro && p < 1 ? (p - 0.78) / 0.22 : 1;
  for (const [n, prio] of cands.slice(0, 400)) {
    const strong = n === sel || n === hover;
    const size = strong ? 12 : Math.min(11.5, Math.max(9, 8.4 + 0.1 * n.deg + 0.5 * k));
    ctx.font = `${strong ? 600 : 400} ${size}px ${MONO}`;
    const text = n.name, w = ctx.measureText(text).width;
    const X = sx(n), Y = sy(n) + Math.max(S.photos ? 7 : 1.5, n._R) + 4;
    const box = [X - w / 2 - 2, Y - 1, X + w / 2 + 2, Y + size + 1];
    if (!strong && boxes.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    if (!strong && prio < 2 && boxes.length > 140) break;
    boxes.push(box);
    ctx.strokeStyle = tk.halo;
    ctx.lineWidth = 3;
    ctx.strokeText(text, X, Y);
    ctx.fillStyle = tk.ink;
    ctx.fillText(text, X, Y);
  }
  ctx.globalAlpha = 1;
}

/* ═════════════════════════════════════════════════════ 6. LOOP */
function frame(now) {
  if (cam) { stepCamera(now); needsDraw = true; }
  if (intro) {
    needsDraw = true;
    if (now - intro.t0 > intro.dur) intro = null;
  }
  if (ripple || (S.bridge && !active() && !Kit.reducedMotion())) needsDraw = true;
  if (needsDraw) { needsDraw = false; draw(now); }
  requestAnimationFrame(frame);
}

/* ═════════════════════════════════════════════════════ 7. INPUT */
/* Hits use the size actually drawn (photos and bridge mode enlarge squares),
   and the closest centre relative to the square's size wins. */
function pick(px, py) {
  let best = null, bd = Infinity;
  for (const n of nodes) {
    if (!n._vis || !n._R) continue;
    const R = Math.max(n._R + 3, 7);
    const dx = Math.abs(sx(n) - px), dy = Math.abs(sy(n) - py);
    if (dx < R && dy < R) {
      const d = Math.max(dx, dy) / R;
      if (d < bd) { bd = d; best = n; }
    }
  }
  return best;
}

const tip = $('tip');
function showTip(n, x, y) {
  if (!n) { tip.hidden = true; return; }
  tip.innerHTML = `<b>${esc(n.name)}</b> <span>${n.deg}</span>`;
  tip.hidden = false;
  tip.style.left = Math.min(x + 14, W - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.max(8, y - 34) + 'px';
}

const pts = new Map();
let down = null, panning = false, pinch = null;
const skipIntro = () => { if (intro) { intro = null; needsDraw = true; } };

cv.addEventListener('pointerdown', e => {
  skipIntro();
  cv.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  cam = null;
  if (pts.size === 1) {
    down = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, hit: pick(e.clientX, e.clientY) };
    panning = false;
  } else if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    down = null;
  }
});
cv.addEventListener('pointermove', e => {
  if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pts.size === 2) {
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    view.x += mx - pinch.mx;
    view.y += my - pinch.my;
    zoomAt(d / (pinch.d || d), mx, my);
    pinch = { d, mx, my };
    return;
  }
  if (down) {
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!panning && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) { panning = true; showTip(null); }
    if (panning) {
      view.x = down.vx + dx;
      view.y = down.vy + dy;
      touched = true;
      needsDraw = true;
    }
    return;
  }
  if (e.pointerType !== 'mouse') return;
  const h = pick(e.clientX, e.clientY);
  if (h !== hover) { hover = h; needsDraw = true; cv.style.cursor = h ? 'pointer' : ''; }
  showTip(h, e.clientX, e.clientY);
});
/* A double-click arrives as two clicks and then a dblclick. The second click
   must not toggle the selection the first one made (select, then deselect):
   it is skipped, and the dblclick zooms on the node of the first click, which
   may have slid away under the camera by then. */
const DBL_MS = 400, DBL_PX = 10;
let lastClick = null, dblNode = null;
function endPointer(e, click) {
  pts.delete(e.pointerId);
  if (pinch && pts.size < 2) { pinch = null; return; }
  if (click && down && !panning) {
    const n = down.hit, now = performance.now();
    if (lastClick && now - lastClick.t < DBL_MS &&
        Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < DBL_PX) {
      dblNode = lastClick.n;
      lastClick = null;
    } else {
      lastClick = { t: now, x: e.clientX, y: e.clientY, n };
      if (n) n === sel ? clearSelection() : select(n);
      else if (sel) clearSelection();
    }
  }
  down = null;
}
cv.addEventListener('pointerup', e => endPointer(e, true));
cv.addEventListener('pointercancel', e => endPointer(e, false));
cv.addEventListener('pointerleave', () => {
  if (hover) { hover = null; needsDraw = true; }
  showTip(null);
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  skipIntro();
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022)), e.clientX, e.clientY);
}, { passive: false });
cv.addEventListener('dblclick', e => {
  const n = dblNode || pick(e.clientX, e.clientY);
  dblNode = null;
  if (!n) return;
  if (n !== sel) select(n, { fly: false });
  touched = true;
  centerOn(n, 560, Math.max(view.k, 2.2));
});
$('zIn').onclick = () => zoomAt(1.35, W / 2, H / 2);
$('zOut').onclick = () => zoomAt(1 / 1.35, W / 2, H / 2);
$('zFit').onclick = () => { touched = false; fitAll(600); };

/* ═════════════════════════════════════════════════════ 8. SELECTION AND FOCUS */
const card = $('card'), rail = $('rail');

function syncSide() {
  card.hidden = !sel;
  rail.hidden = !!sel || !S.rail;
  document.body.classList.toggle('has-card', !!sel);
}

function select(n, { fly = true } = {}) {
  sel = n;
  focus = null;
  if (S.matrix) setOpt('matrix', false);
  showTip(null);
  fillCard(n);
  syncSide();
  markRail();
  setHash(n.id);
  $('sSel').textContent = n.name;
  ripple = Kit.reducedMotion() ? null : performance.now();
  if (fly) { touched = true; centerOn(n); }
  needsDraw = true;
}
function clearSelection() {
  sel = null;
  syncSide();
  setHash(focus ? focusHash() : '');
  $('sSel').textContent = 'none';
  needsDraw = true;
}

function profileUrl(n) {
  return meta.profile_url ? meta.profile_url.replace('{name}', encodeURIComponent(n.name)) : null;
}
function fillCard(n) {
  const c = clusters[n.c], cat = catOf[n.cat] || { label: n.cat };
  const cpp = cpOf.get(n);
  const url = profileUrl(n);
  const gro = n.gro == null ? 'n/r' : (n.gro > 0 ? '+' : '') + fmt.pct(n.gro, 1);
  card.innerHTML = `
    <header class="card-head"><i class="sw" style="background:${clusterCol[n.c] || tk.nodeOff}"></i>
      <span class="lab">Cluster ${esc(c.label)}</span>
      <button class="close" type="button" aria-label="Close">×</button></header>
    <div class="who"><div class="face" aria-hidden="true"></div>
      <div><h2>${esc(n.name)}</h2>${n.dn ? `<p>${esc(n.dn)}</p>` : ''}
      <span class="pill"><i style="background:${(catOf[n.cat] || {})[dark ? 'dark' : 'light'] || tk.nodeOff}"></i>${esc(cat.label)}</span></div></div>
    <div class="actions">${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(meta.platform || 'Profile')} ↗</a>` : ''}
      ${cpp ? `<a class="btn" href="compass.html#${encodeURIComponent(n.id)}">Media Compass →</a>` : ''}</div>
    <dl class="metrics">
      <div><dt>Collaborations</dt><dd>${n.deg}</dd></div>
      <div><dt>Followers</dt><dd class="${n.fol == null ? 'na' : ''}">${fmt.short(n.fol)}</dd></div>
      <div><dt>Interactions</dt><dd class="${n.itr == null ? 'na' : ''}">${fmt.short(n.itr)}</dd></div>
      <div><dt>Follower growth</dt><dd class="${n.gro == null ? 'na' : ''}">${gro}</dd></div>
    </dl>
    ${n.bRank ? `<p class="bridge">Bridge role: <b>#${n.bRank}</b> in the network${n.cut ? ` · <span class="hot">without it ${n.cut} profile${n.cut > 1 ? 's are' : ' is'} cut off</span>` : ''}</p>` : ''}
    ${cpp ? `<p class="cp-line"><span class="lab">Media Compass</span> Tone <b>${esc(cpp.tone)}</b> · ${fmt.pct(cpp.acc, 1)} heated posts · ${fmt.pct(cpp.pol)} about politics</p>` : ''}
    <p class="lab between"><span>Collaborations</span><span>${n.deg}</span></p>
    <div class="chips">${n.adj.slice().sort((a, b) => b.deg - a.deg).map(m =>
      `<button type="button" data-id="${esc(m.id)}"><i style="background:${m.col}"></i>${esc(m.name)}</button>`).join('')}</div>`;
  atlas.face(card.querySelector('.face'), n, 58);
}
card.addEventListener('click', e => {
  if (e.target.closest('.close')) { clearSelection(); return; }
  const chip = e.target.closest('[data-id]');
  if (chip) select(byId.get(chip.dataset.id));
});

function focusHash() {
  if (!focus) return '';
  return focus.kind === 'pair' ? `pair/${focus.key[0]}/${focus.key[1]}` : `${focus.kind}/${focus.key}`;
}
/* Isolate a category, cluster, group or pair of clusters: everything else
   dims, nothing is removed or moved. Same call again = off. */
function focusOn(kind, key, { frame = true } = {}) {
  const same = focus && focus.kind === kind && String(focus.key) === String(key);
  sel = null;
  syncSide();
  $('sSel').textContent = 'none';
  if (same) {
    focus = null;
  } else {
    let set, edge = l => set.has(l.a) && set.has(l.b);
    if (kind === 'cat') set = new Set(nodes.filter(n => n.cat === key));
    else if (kind === 'cluster') set = new Set(nodes.filter(n => n.c === +key));
    else if (kind === 'group') set = new Set(nodes.filter(n => clusters[n.c].group === key));
    else if (kind === 'pair') {
      const [a, b] = key.map(Number);
      set = new Set(nodes.filter(n => n.c === a || n.c === b));
      edge = l => (l.a.c === a && l.b.c === b) || (l.a.c === b && l.b.c === a);
    }
    if (set && set.size) {
      focus = { kind, key, set, edge };
      // the list that names this focus is the one on show, with its colouring
      const tab = kind === 'cat' ? 'cat' : 'cluster';
      if (S.tab !== tab) showTab(tab);
      if (kind === 'cat' && !S.cat) setOpt('cat', true);
      if (kind !== 'cat' && S.cat) setOpt('cat', false);
      if (frame && kind !== 'cat') { touched = true; fitNodes([...set]); }
    } else {
      focus = null;                          // unknown key (e.g. a stale link): clear, don't keep it
    }
  }
  setHash(focusHash());
  markRail();
  needsDraw = true;
}

/* ═════════════════════════════════════════════════════ 9. ADDRESS */
/* #<id> selects; #cluster/3, #group/left, #cat/journalist, #pair/2/5 focus.
   replaceState: choosing things does not pile up Back steps. */
function setHash(h) {
  const url = h ? '#' + h.split('/').map(encodeURIComponent).join('/') : location.pathname + location.search;
  if (url !== location.hash) history.replaceState(null, '', url);
}
function openHash() {
  let h = location.hash.slice(1);
  try { h = decodeURIComponent(h); } catch (e) { /* malformed: use as is */ }
  const [kind, ...rest] = h.split('/');
  if (!h) { if (sel) clearSelection(); if (focus) focusOn(focus.kind, focus.key); return; }
  if (kind === 'pair' && rest.length === 2) return focusOn('pair', rest, {});
  if (['cluster', 'group', 'cat'].includes(kind) && rest.length) return focusOn(kind, rest.join('/'));
  const n = byId.get(h.toLowerCase());
  if (n) { if (n !== sel) select(n); }
  else if (sel) clearSelection();            // unknown id: say nothing is selected
}
addEventListener('hashchange', openHash);

/* ═════════════════════════════════════════════════════ 10. SEARCH */
const q = $('q'), sugg = $('sugg');
let sIdx = -1, sList = [];
function suggest() {
  const s = q.value.trim().toLowerCase();
  if (!s) { closeSugg(); return; }
  sList = nodes.filter(n => n.key.includes(s))
    .sort((a, b) => (b.name.toLowerCase().startsWith(s) - a.name.toLowerCase().startsWith(s)) ||
                    b.deg - a.deg || a.name.localeCompare(b.name))
    .slice(0, 30);
  sIdx = -1;
  sugg.innerHTML = sList.length
    ? sList.map((n, i) => `<li role="option" id="sg${i}" data-i="${i}"><i style="background:${n.col}"></i>
        <b>${esc(n.name)}</b>${n.dn ? `<span>${esc(n.dn)}</span>` : ''}<em>${n.deg}</em></li>`).join('')
    : '<li class="none" aria-disabled="true">No profile found</li>';
  sugg.hidden = false;
  q.setAttribute('aria-expanded', 'true');
}
function closeSugg() {
  sugg.hidden = true;
  q.setAttribute('aria-expanded', 'false');
  q.removeAttribute('aria-activedescendant');
}
function moveSugg(d) {
  if (!sList.length) return;
  sIdx = (sIdx + d + sList.length) % sList.length;
  [...sugg.children].forEach((li, i) => li.classList.toggle('on', i === sIdx));
  q.setAttribute('aria-activedescendant', 'sg' + sIdx);
  sugg.children[sIdx].scrollIntoView({ block: 'nearest' });
}
function choose(n) {
  closeSugg();
  q.blur();
  setMenu(false);
  select(n);
}
q.addEventListener('input', suggest);
q.addEventListener('focus', () => { if (q.value.trim()) suggest(); });
q.addEventListener('blur', () => setTimeout(closeSugg, 150));
q.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSugg(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSugg(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); const n = sList[Math.max(0, sIdx)]; if (n) choose(n); }
  else if (e.key === 'Escape') { closeSugg(); q.blur(); }
});
sugg.addEventListener('pointerdown', e => {
  const li = e.target.closest('[data-i]');
  if (li) { e.preventDefault(); choose(sList[+li.dataset.i]); }
});

/* ═════════════════════════════════════════════════════ 11. OPTIONS */
const optBtns = [...document.querySelectorAll('.opt[data-opt]')];
function setOpt(key, val) {
  S[key] = val;
  optBtns.filter(b => b.dataset.opt === key).forEach(b => b.setAttribute('aria-pressed', String(val)));
  if (key === 'itr' || key === 'cat') recolor();
  if (key === 'itr') sizeLegend();
  if (key === 'rail') syncSide();
  if (key === 'matrix') {
    $('matrix').hidden = !val;
    document.body.classList.toggle('alt', val);
    if (val) { buildMatrix(); showTip(null); }
  }
  needsDraw = true;
}
optBtns.forEach(b => b.addEventListener('click', () => {
  setOpt(b.dataset.opt, !S[b.dataset.opt]);
  if (b.dataset.opt === 'matrix' || b.dataset.opt === 'rail') setMenu(false);
}));

function sizeLegend() {
  const box = $('sizeLegend');
  box.hidden = !S.itr;
  if (!S.itr) return;
  const vals = [1e4, 1e5, 1e6, 1e7, 1e8, 1e9].filter(v => v <= IMAX * 1.5);
  box.innerHTML = `<p class="lab">Size = interactions</p><div class="sq">${vals.map(v => {
      const s = Math.round(2 * rItr(v));
      return `<span><i style="width:${s}px;height:${s}px"></i>${fmt.short(v)}</span>`;
    }).join('')}<span><i class="na"></i>n/r</span></div>
    <p class="note">Above ${fmt.short(P95)} (95th percentile) squares grow on a log scale.</p>`;
}

/* ═════════════════════════════════════════════════════ 12. RAIL */
const railBody = $('railBody');
const TABS = {
  cat: {
    sub: 'Declared categories: what each account does',
    foot: 'Click a category to isolate it on the map',
    render: () => DATA.categories.map(c => row('cat', c.key, c[dark ? 'dark' : 'light'], esc(c.label), c.size)).join(''),
  },
  cluster: {
    sub: 'Found by the algorithm · grouped by the editors',
    foot: 'Click a group or a cluster to light it up',
    render() {
      const out = [];
      const ordered = [...(DATA.groups || []).map(g => g.id), null];
      for (const g of ordered) {
        const cs = clusters.map((c, i) => [c, i]).filter(([c]) => !c.misc && (c.group || null) === g);
        if (!cs.length) continue;
        const name = g ? groupOf[g].name : (DATA.groups || []).length ? 'Unassigned' : 'Clusters';
        out.push(`<button class="grp" type="button" data-kind="group" data-key="${esc(g || '')}" ${g ? '' : 'disabled'}>
          <span>${esc(name)}</span><em>${cs.reduce((s, [c]) => s + c.size, 0)}</em></button>`);
        cs.forEach(([c, i]) => out.push(row('cluster', i, clusterCol[i], esc(c.label), c.size)));
      }
      const misc = clusters.findIndex(c => c.misc);
      if (misc >= 0) out.push(row('cluster', misc, tk.nodeOff, esc(clusters[misc].label), clusters[misc].size));
      return out.join('');
    },
  },
  bridge: {
    sub: 'Who holds the network together · on the map, links between clusters light up',
    foot: 'Bar = betweenness · "cuts" = profiles isolated without it',
    render: () => bars(bridges.slice(0, 60), n => n.bt / BT_MAX,
                       n => (n.cut ? `<em class="hot">cuts ${n.cut}</em>` : '<em>—</em>')),
  },
  rank: {
    sub: 'Interactions in the period: reactions, comments, shares',
    foot: 'n/r profiles are not ranked: not measured is not zero',
    render: () => bars(byItr.slice(0, 60), n => n.itr / (byItr[0].itr || 1), n => `<em>${fmt.short(n.itr)}</em>`),
  },
};
function row(kind, key, col, label, count) {
  return `<button class="row" type="button" data-kind="${kind}" data-key="${esc(key)}">
    <i style="background:${col || tk.nodeOff}"></i><span>${label}</span><em>${count}</em></button>`;
}
function bars(list, frac, right) {
  return list.map((n, i) => `<button class="row rank" type="button" data-id="${esc(n.id)}">
    <small>${i + 1}</small><span>${esc(n.name)}</span>${right(n)}
    <i class="track"><b style="width:${(100 * frac(n)).toFixed(1)}%;background:${n.col}"></b></i></button>`).join('');
}
/* Opening a tab sets the matching view once (categories → colour by
   category, ranking → size by interactions…). Afterwards the user's own
   switches win: re-rendering the list (theme change) applies no preset. */
function showTab(t) {
  S.tab = t;
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  if (t === 'cat' && !S.cat) setOpt('cat', true);
  if ((t === 'cluster' || t === 'bridge') && S.cat) setOpt('cat', false);
  if (t === 'rank' && !S.itr) setOpt('itr', true);
  if (S.bridge !== (t === 'bridge')) { S.bridge = t === 'bridge'; needsDraw = true; }
  renderRail();
  railBody.scrollTop = 0;
}
function renderRail() {
  $('railSub').textContent = TABS[S.tab].sub;
  $('railFoot').textContent = TABS[S.tab].foot;
  const top = railBody.scrollTop;
  railBody.innerHTML = TABS[S.tab].render();
  railBody.scrollTop = top;
  markRail();
}
function markRail() {
  railBody.querySelectorAll('[data-kind]').forEach(b => {
    const on = !!focus && b.dataset.kind === focus.kind && b.dataset.key === String(focus.key);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b) showTab(b.dataset.tab);
});
railBody.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.id) select(byId.get(b.dataset.id));
  else if (b.dataset.kind) focusOn(b.dataset.kind, b.dataset.key);
});

/* ═════════════════════════════════════════════════════ 13. MATRIX */
let matrixBuilt = false;
function buildMatrix() {
  if (matrixBuilt) return;
  matrixBuilt = true;
  const idx = clusters.map((c, i) => i).filter(i => !clusters[i].misc);
  const pos = new Map(idx.map((ci, k) => [ci, k]));
  const M = idx.map(() => idx.map(() => 0));
  let inside = 0, total = 0, best = null;
  for (const l of links) {
    const a = pos.get(l.a.c), b = pos.get(l.b.c);
    if (a == null || b == null) continue;
    total++;
    M[a][b]++;
    if (a !== b) M[b][a]++; else inside++;
  }
  idx.forEach((_, a) => idx.forEach((_, b) => {
    if (a < b && (!best || M[a][b] > best[2])) best = [a, b, M[a][b]];
  }));
  const maxIn = Math.max(1, ...idx.map((_, a) => M[a][a]));
  const maxOut = Math.max(1, ...M.flatMap((r, a) => r.filter((_, b) => b !== a)));
  const lab = ci => esc(clusters[ci].label);
  $('mxBrief').innerHTML = total
    ? `<b>${fmt.pct(inside / total)}</b> of collaborations stay inside their own cluster (${inside} of ${total}).` +
      (best && best[2] ? ` The strongest bridge is <b>${lab(idx[best[0]])} ↔ ${lab(idx[best[1]])}</b>, with ${best[2]} collaborations.` : '')
    : '';
  const head = `<thead><tr><th></th>${idx.map(ci => `<th scope="col"><span><i style="background:${clusterCol[ci]}"></i>${lab(ci)}</span></th>`).join('')}<th scope="col"><span>closure</span></th></tr></thead>`;
  const body = idx.map((ci, a) => {
    const all = M[a].reduce((s, v) => s + v, 0);
    return `<tr><th scope="row"><i style="background:${clusterCol[ci]}"></i>${lab(ci)}</th>${M[a].map((v, b) => {
      if (!v) return '<td class="z">·</td>';
      const bg = a === b ? Kit.alpha(clusterCol[ci], 0.18 + 0.6 * v / maxIn) : Kit.alpha(tk.muted, 0.08 + 0.55 * v / maxOut);
      return `<td data-a="${idx[a]}" data-b="${idx[b]}" style="background:${bg}" title="${lab(ci)} × ${lab(idx[b])}: ${v}">${v}</td>`;
    }).join('')}<td class="cl">${all ? fmt.pct(M[a][a] / all) : '—'}</td></tr>`;
  }).join('');
  $('mx').innerHTML = head + '<tbody>' + body + '</tbody>';
}
$('mx').addEventListener('click', e => {
  const td = e.target.closest('td[data-a]');
  if (!td) return;
  setOpt('matrix', false);
  focusOn('pair', [td.dataset.a, td.dataset.b]);
});

/* ═════════════════════════════════════════════════════ 14. OTHER UI */
function fillInfo() {
  const m = DATA.method, named = clusters.filter(c => !c.misc).length;
  const corr = DATA.corrections || [];
  $('infoBody').innerHTML = `
    <p class="lede">${esc(meta.title)} maps who collaborates with whom on ${esc(meta.platform)}:
      ${fmt.int(nodes.length)} accounts, ${fmt.int(links.length)} observed collaborations, ${named} clusters.
      Period ${esc(meta.period.from)} – ${esc(meta.period.to)}.</p>
    <h3>How to read it</h3>
    <p>Each square is an account, each line an observed collaboration. Positions come from a force-directed
      layout: close means connected, not similar, and distances have no geographic meaning.</p>
    <p><b>Clusters</b> are found by the Louvain algorithm on collaborations only (resolution ${m.resolution}).
      A cluster says who works with whom, not what anyone thinks. The editors name clusters and gather them in groups.</p>
    <p><b>Bridges</b> are ranked by betweenness: how many shortest paths between other accounts pass through them.
      "Cuts N" counts the accounts that would be isolated from the rest if that account disappeared.</p>
    <p><b>n/r</b> means not measured, which is not zero: with size = interactions those accounts are hollow squares.</p>
    ${corr.length ? `<h3>Editorial corrections in this edition</h3><ul>${corr.map(c => `<li>${c.type === 'merge'
        ? `Cluster of <b>${esc(c.from)}</b> merged into the cluster of <b>${esc(c.into)}</b>.`
        : `<b>${esc(c.id)}</b> moved to the cluster of <b>${esc(c.to)}</b>.`} ${esc(c.reason || '')}</li>`).join('')}</ul>` : ''}
    <h3>Edition</h3>
    <p>Data of ${esc(meta.edition)}. Cite as «${esc(meta.title)}, ${esc((meta.authors || []).join(', '))}, edition of ${esc(meta.edition)}».
      ${meta.credits ? esc(meta.credits) : ''}</p>
    ${meta.contact ? `<p>Corrections and removal requests: <a href="mailto:${esc(meta.contact)}?subject=${encodeURIComponent('[' + meta.title + '] correction')}">${esc(meta.contact)}</a>.</p>` : ''}
    <p><a href="llms-full.txt">Full method (text)</a></p>`;
}
$('btnInfo').onclick = () => { fillInfo(); $('info').showModal(); };

function themeLabel() { $('btnTheme').textContent = Kit.theme.get() === 'dark' ? 'Light' : 'Dark'; }
$('btnTheme').onclick = () => Kit.theme.toggle();
Kit.theme.on(() => {
  recolor();
  themeLabel();
  renderRail();
  if (sel) fillCard(sel);
  if (matrixBuilt) { matrixBuilt = false; if (S.matrix) buildMatrix(); }
});

$('btnReset').onclick = () => {
  sel = null; focus = null; hover = null;
  if (S.matrix) setOpt('matrix', false);
  syncSide();
  setHash('');
  $('sSel').textContent = 'none';
  markRail();
  touched = false;
  fitAll(600);
};
function setMenu(open) {
  document.body.classList.toggle('menu-open', open);
  $('btnMenu').setAttribute('aria-expanded', String(open));
}
$('btnMenu').onclick = () => setMenu(!document.body.classList.contains('menu-open'));

addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    if (!wide()) setMenu(true);
    q.focus();
    return;
  }
  if (e.key !== 'Escape' || typing || $('info').open) return;
  skipIntro();
  if (document.body.classList.contains('menu-open')) setMenu(false);
  else if (S.matrix) setOpt('matrix', false);
  else if (sel) clearSelection();
  else if (focus) focusOn(focus.kind, focus.key);
});

function teaser() {
  if (!cp) return;
  const t = $('teaser'), h = t.querySelector('b');
  t.hidden = false;
  $('teaserSub').textContent = `${cp.profiles.length} profiles · ${fmt.int(cp.total_posts)} posts read`;
  const lines = ['Who raises the tone?', 'Against whom?', 'Who names no enemy?'];
  let i = 0;
  if (!Kit.reducedMotion()) setInterval(() => { h.textContent = lines[++i % lines.length]; }, 5200);
}

/* ═════════════════════════════════════════════════════ 15. BOOT */
document.title = document.title || meta.title;
$('brandTitle').textContent = meta.title;
$('brandSub').textContent = meta.subtitle || '';
$('gateTitle').textContent = meta.title;
$('sNodes').textContent = fmt.int(nodes.length);
$('sLinks').textContent = fmt.int(links.length);
$('sClusters').textContent = clusters.filter(c => !c.misc).length;
$('sAvg').textContent = nodes.length ? (2 * links.length / nodes.length).toFixed(1) : '—';
$('sItr').textContent = fmt.short(DATA.totals.interactions);
$('sDate').textContent = meta.edition;
$('sDate').setAttribute('datetime', meta.edition);
['bar', 'opts', 'stage'].forEach(id => { $(id).hidden = false; });
themeLabel();
optBtns.forEach(b => b.setAttribute('aria-pressed', String(!!S[b.dataset.opt])));
recolor();
buildWave();
syncSide();
showTab('cat');
teaser();
resize();
addEventListener('resize', resize);

if (location.hash.length > 1) openHash();
else if (!Kit.reducedMotion()) intro = { t0: performance.now() + 250, dur: 1500 };

const gate = $('gate');
gate.classList.add('gone');
setTimeout(() => { gate.hidden = true; }, 450);
requestAnimationFrame(frame);
}
})();
