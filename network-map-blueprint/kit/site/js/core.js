/* ══════════════════════════════════════════════════════════════════════════
   Shared by the map and the Compass: data loading, theme, colour, formats,
   the photo atlas. Exposes window.Kit.
   ══════════════════════════════════════════════════════════════════════════ */
(() => {
'use strict';

/* Key material for obfuscated bundles: the build reads this constant
   (pipeline/publish.py) and every build adds a fresh salt. Change it per
   project. It keeps per-profile data out of crawlers' reach; it is not a
   secret, since the browser needs it to draw the map. */
const PEPPER = 'change-me-per-project-7c1e94a2d05b';

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function loadData() {
  if (window.MAP_DATA) return window.MAP_DATA;
  const E = window.MAP_DATA_ENC;
  if (!E) throw new Error('missing');
  if (!window.crypto || !crypto.subtle) throw new Error('insecure');
  const pepper = new TextEncoder().encode(PEPPER), salt = b64(E.salt);
  const material = new Uint8Array(pepper.length + salt.length);
  material.set(pepper);
  material.set(salt, pepper.length);
  const key = await crypto.subtle.importKey(
    'raw', await crypto.subtle.digest('SHA-256', material), 'AES-GCM', false, ['decrypt']);
  let buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(E.iv) }, key, b64(E.ct));
  if (E.z === 'gzip') {
    if (!window.DecompressionStream) throw new Error('old');
    buf = await new Response(new Blob([buf]).stream()
      .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

function loadError(err) {
  const m = String(err && err.message);
  return m === 'insecure' ? 'Open the site over https or from http://localhost.'
       : m === 'old' ? 'This browser is too old for the map: please update it.'
       : 'Data not available: reload the page.';
}

/* ---------------------------------------------------------------- theme */
const root = document.documentElement;
const themeListeners = [];
const theme = {
  get: () => (root.dataset.theme === 'dark' ? 'dark' : 'light'),
  set(t) {
    root.dataset.theme = t;
    try { localStorage.setItem('nm-theme', t); } catch (e) {}
    themeListeners.forEach(f => f(t));
  },
  toggle() { theme.set(theme.get() === 'dark' ? 'light' : 'dark'); },
  on(f) { themeListeners.push(f); },
};

/* canvas and SVG read their neutrals from the CSS tokens: one source of truth */
function tokens() {
  const cs = getComputedStyle(root);
  const v = n => cs.getPropertyValue(n).trim();
  return { bg: v('--bg'), ink: v('--ink'), muted: v('--muted'), edge: v('--edge'),
           edgeOff: v('--edge-off'), nodeOff: v('--node-off'), halo: v('--halo'),
           accent: v('--accent'), line: v('--line'), surface: v('--surface') };
}

/* ---------------------------------------------------------------- colour */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbToHex = (r, g, b) =>
  '#' + [r, g, b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l * 100];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

/* OKLCH → sRGB hex, reducing chroma until the colour fits the gamut */
function oklch(L, C, h) {
  for (let c = C; c >= 0; c -= 0.004) {
    const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180);
    const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
                 -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
                 -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_];
    if (lin.every(v => v >= -0.0005 && v <= 1.0005)) {
      const g = v => { v = clamp(v, 0, 1); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055); };
      return rgbToHex(g(lin[0]), g(lin[1]), g(lin[2]));
    }
  }
  return '#888888';
}

/* Fallback palette when no cluster has an editorial group */
const FALLBACK = {
  light: ['#D1206F', '#2F8F4E', '#2F7FC1', '#C77A1E', '#8E3FA8', '#13706F', '#B5482F',
          '#5B6FD8', '#7F8F1E', '#B04A86', '#3A9C9C', '#8A5A2B'],
  dark:  ['#FF5FA2', '#5CC07E', '#6FB0EC', '#F0A54A', '#C58AE0', '#45C2BE', '#F07F62',
          '#93A2FF', '#B9C653', '#E07AB4', '#6FD3D3', '#C99566'],
};
const NO_GROUP = [70, 0.02];

/* Cluster colours: the editorial group gives the hue, each cluster a shade of
   it. Within a group the biggest cluster gets the strongest shade and each
   step turns the hue a little, so neighbouring clusters stay distinguishable. */
function clusterColors(data, t) {
  const groups = Object.fromEntries((data.groups || []).map(g => [g.id, g]));
  const anyGroup = data.clusters.some(c => c.group);
  const out = new Array(data.clusters.length);
  const byGroup = new Map();
  data.clusters.forEach((c, i) => {
    if (c.misc) { out[i] = null; return; }
    if (!anyGroup) { out[i] = FALLBACK[t][i % FALLBACK[t].length]; return; }
    const k = c.group || '';
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(i);
  });
  byGroup.forEach((idx, k) => {
    idx.sort((a, b) => data.clusters[b].size - data.clusters[a].size);
    const g = groups[k], [h, C] = g ? [g.hue, g.chroma] : NO_GROUP;
    const n = idx.length, span = Math.min(t === 'dark' ? 0.30 : 0.26, 0.09 * (n - 1));
    const sweep = n === 1 ? 0 : n === 2 ? 16 : 28;
    idx.forEach((ci, j) => {
      const s = n === 1 ? 0 : j / (n - 1);
      const L = t === 'dark' ? 0.80 - span * s : 0.50 + span * s;
      out[ci] = oklch(L, C * (1 - 0.25 * s), h + (s - 0.5) * sweep);
    });
  });
  return out;
}

/* Weight within a colour bucket: heavy profiles saturated and deep, the
   margins pale. `t` is in 0..1 (sqrt of weight / bucket max). */
function shade(hex, t, dark, intensity = 1) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const dl = (dark ? -14 + 22 * t : 18 - 26 * t) * intensity;
  const ds = (-16 + 20 * t) * intensity;
  return hslToHex(h, clamp(s + ds, 8, 96), clamp(l + dl, 12, 90));
}
function soften(hex, dark) {               // edge colour inside a bucket
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return hslToHex(h, s * 0.75, dark ? l * 0.8 : l + (100 - l) * 0.35);
}
function alpha(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/* ---------------------------------------------------------------- formats */
const nf = new Intl.NumberFormat(document.documentElement.lang || 'en');
const fmt = {
  int: v => (v == null ? 'n/r' : nf.format(Math.round(v))),
  short(v) {
    if (v == null) return 'n/r';
    const a = Math.abs(v);
    const [d, u] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
    const x = v / d;
    return (u && x < 10 ? x.toFixed(1) : Math.round(x)) + u;
  },
  pct(v, digits = 0) {
    if (v == null) return 'n.d.';
    const p = v * 100;
    return (p > 0 && p < 10 && digits === 0 ? p.toFixed(1) : p.toFixed(digits)) + '%';
  },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const reducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};

/* ---------------------------------------------------------------- photo atlas */
function atlas(data, onload) {
  const F = data.faces;
  const A = { ok: false, img: null, F };
  if (F && F.n) {
    const img = new Image();
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.onload = () => { A.ok = true; onload && onload(); };
    img.src = 'img/' + F.file;
    A.img = img;
  }
  A.has = n => A.ok && n && n.p >= 0 && n.p < F.n;
  A.cell = n => [(n.p % F.cols) * F.tile, Math.floor(n.p / F.cols) * F.tile, F.tile];
  /* CSS avatar: background-size scales the whole sheet so one tile = `size`.
     Falls back to initials when the atlas is missing or failed to load. */
  A.face = (el, n, size) => {
    el.style.width = el.style.height = size + 'px';
    if (!A.has(n)) {
      el.textContent = (n.dn || n.name).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase();
      el.classList.remove('has');
      return;
    }
    const col = n.p % F.cols, row = Math.floor(n.p / F.cols);
    el.textContent = '';
    el.classList.add('has');
    el.style.backgroundImage = `url("img/${F.file}")`;
    el.style.backgroundSize = `${F.cols * size}px ${F.rows * size}px`;
    el.style.backgroundPosition = `-${col * size}px -${row * size}px`;
  };
  return A;
}

window.Kit = { loadData, loadError, theme, tokens, clusterColors, shade, soften, alpha, oklch,
               fmt, esc, reducedMotion, atlas, clamp };
})();
