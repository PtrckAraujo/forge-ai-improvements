# Ecosistema Politico — reverse-engineering blueprint

How [ecosistemapolitico.it](https://ecosistemapolitico.it/) is built, written so the same kind of
product can be rebuilt for another country, platform or topic. The clean-room starter kit in
[`kit/`](kit/) implements the architecture described here. It contains none of the site's code,
data or photos.

**Evidence.** This blueprint is based on two capture archives taken on 29 October 2026:

- a headless-Chromium capture: HAR files, saved pages, rendered DOM, 32 screenshots, and the
  site's own `robots.txt`, `sitemap.xml` and `llms-full.txt`;
- a technical follow-up: the runtime schema, rendering rules, a state specification, and
  responsive, motion and visual-regression tests.

The archives are not committed here. Statements are marked **verified** (seen in the shipped
code, headers or runtime) or **inferred** (deduced from client code comments or the published
methodology, with nothing to check them against). The edition captured is dated **2026-10-08**.

---

## 1. What the product is

An interactive map of **who collaborates with whom on Instagram** in Italian politics. Each
account is a node. Each observed collaboration between two accounts is an undirected edge
(collaborations are recorded by the editorial team, not inferred).

| Edition 2026-10-08 | Value |
|---|---|
| Accounts (nodes) | 1,192: 512 politicians, 184 content creators, 171 other, 162 new media, 65 parties, 59 journalists, 39 traditional media |
| Collaborations (edges) | 2,367 |
| Louvain clusters | 31, gathered by the editors into 8 political groups (7 on a left–right arc, plus independents) |
| Period | 01.01.2026 – 06.10.2026 |
| Headline metric | 1.5 billion interactions (reactions + comments + shares) |
| Media Compass | Tone analysis of 52,607 post captions from 112 accounts (1 Mar – 27 Sep 2026) |
| Authors | Liberi Network × Arcadia; data illustration by Under The Stars |

There are two views (two URLs):

1. **Map (`/`)**: the network on a Canvas. It has search, profile cards, a comparison of up
   to 6 profiles, category and cluster filters, rankings (interactions and "bridges"), a
   cluster × cluster matrix, a profile-photo mode, and light and dark themes.
2. **Media Compass (`/compass`)**: an SVG scatter plot of 112 accounts. The x-axis is the
   share of "heated" posts. The y-axis is selectable: politics share, *against whom*, or
   *unnamed enemy*. It has a month-by-month timeline with playback, topic and target
   breakdowns, and a filterable list of profiles.

---

## 2. Architecture at a glance

```
   EDITORIAL SOURCES (private)            BUILD (private, "build_data.py")           STATIC SITE (public)
 ┌──────────────────────────────┐   ┌────────────────────────────────────┐   ┌─────────────────────────────┐
 │ account list + category      │   │ undirected graph                   │   │ index.html / compass.html   │
 │ observed collaborations      │──▶│ Louvain (tuned resolution)         │──▶│ css/style.css               │
 │ metrics (followers, interac- │   │ editorial corrections + names      │   │ js/graph.js  (map engine)   │
 │   tions, follower growth)    │   │ groups → colours                   │   │ js/compass.js               │
 │ cluster doc (CLUSTER.docx)   │   │ betweenness, articulation "cut"    │   │ data.enc.js (AES-GCM+gzip)  │
 │ profile photos               │   │ force layout → fixed x,y           │   │ img/faces-<hash>.webp atlas │
 │ caption export (Compass)     │   │ photo atlas, Compass keyword stats │   │ fonts/*.woff2 (hashed)      │
 └──────────────────────────────┘   │ encrypt, template SEO blocks       │   │ robots/sitemap/llms-full    │
                                    └────────────────────────────────────┘   └──────────────┬──────────────┘
                                                                                             │ Cloudflare CDN
                                                                                             ▼
                                                    browser: WebCrypto decrypt → Canvas 2D map / SVG Compass
```

Key properties (**verified**):

- **Fully static.** There is no backend, API or database at runtime, no cookies and no
  analytics. During recorded sessions the page made **no third-party requests** (it doesn't
  contact Instagram either: photos come from a single self-hosted atlas).
- **No framework, no bundler, no minification.** There are three hand-written scripts loaded
  with plain `<script>` tags in this order: `data.enc.js`, `js/compass.js`, `js/graph.js`.
  Each is an IIFE in `'use strict'` mode. They share three globals: `window.MAPPATURA_ENC`
  (the encrypted payload), `window.INTRO` (intro promise) and `window.COMPASS` (the Compass
  module API, consumed by `graph.js`). Comments are in Italian and extensive.
- **The map page weighs about 2.3 MB before compression**, and the photo atlas is 1.8 MB of
  that. Less goes over the wire: text files are served `zstd`-compressed.

| File | Bytes | Role |
|---|---:|---|
| `index.html` | 51,580 | map page: SEO head, intro, all panels' markup |
| `compass.html` | 49,194 | the same app with a different `<title>`/OG/canonical (Compass route) |
| `js/graph.js` | 130,789 | 3,053 lines: decrypt, theme, map engine, UI, routing, boot |
| `js/compass.js` | 64,709 | 1,390 lines: Compass page, teaser, mini-compass |
| `css/style.css` | 86,488 | 1,777 lines, tokens and light/dark themes |
| `data.enc.js` | 97,797 | the whole dataset, encrypted and gzipped |
| `img/faces-f074976a.webp` | 1,827,458 | 3,168×3,072 atlas, 96 px tiles, 33×32 grid, 1,053 faces |
| `fonts/archivo-*.woff2`, `fonts/bebas-*.woff2` | 48,744 / 23,068 | body and display fonts, self-hosted |

---

## 3. Hosting and delivery (verified from response headers)

- **Cloudflare** serves every response (`server: cloudflare`, `cf-cache-status: HIT` even on
  HTML), with `zstd` compression for text. It advertises HTTP/3 (`alt-svc: h3`); the
  captures don't show which protocol the browser actually used.
- `/compass` is served from `compass.html`. Extension-less "pretty URLs" plus edge-cached
  HTML with weak ETags match **Cloudflare Pages** defaults (*inferred*; any static host with a
  rewrite works).
- **Security headers** (Pages `_headers` file or equivalent):
  - `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-…' 'sha256-…'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
    The two hashes allow exactly the two inline scripts (the theme pre-paint and the intro).
  - `Strict-Transport-Security: max-age=31536000`, `X-Frame-Options: DENY`,
    `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
    `Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()`.
- **Cache policy:**

| Asset class | Cache-Control | Why |
|---|---|---|
| Fonts and photo atlas (content-hashed names) | `public, max-age=31536000, immutable` | the name changes when the content changes |
| Logos and icons | `public, max-age=604800` | rarely change |
| HTML, CSS, JS, `data.enc.js`, sitemap, `llms-full.txt` | `no-cache` (ETag revalidation) | names are not hashed, so they must revalidate |
| `site.webmanifest` | `max-age=0, must-revalidate` | |
| `robots.txt` | `max-age=3600` | |

**Replication note:** hash the JS/CSS/data filenames as well, and all of them can be
`immutable`.

---

## 4. Data pipeline (inferred: the build script is private)

The client names the build script (`build_data.py`) and a cluster document (`CLUSTER.docx`,
mapped to a `GRUPPI` table in the build). Together with the published methodology, the
pipeline is:

1. **Account list.** Each account is added by the editorial team, with a declared
   **category**: Politician, Party, Journalist, Traditional media, New media, Content creator
   or Other. The category describes what the account *does*, not its side.
2. **Collaborations.** An edge is recorded **only when an actual collaboration between two
   accounts is observed**. On Instagram this most likely means collab (co-authored) posts,
   but that is *inferred*. Nothing is inferred from affinity or membership. Accounts with no
   collaborations remain as isolated nodes.
3. **Metrics per account for the period:** followers, interactions (reactions + comments +
   shares) and follower growth. When a value couldn't be measured it is stored as **`null`
   (shown "n/r")**, which is different from 0.
4. **Graph.** Build an undirected simple graph from the edges. Everything structural
   (clusters, bridges, positions) is computed from the edges *only*, never from metrics or
   political affiliation.
5. **Communities.** Louvain modularity with a **hand-tuned resolution**. The methodology says
   the value is "written in clear in the code that generates the data". It is tuned so that
   communities recognisable by eye stay separate as the network grows, because a larger
   network makes Louvain absorb small groups.
6. **Cluster names.** By default a cluster is named after its **most-connected member**
   (`clusters[].hub`). The editors can override this with a clearer label. When an edition
   merges two named clusters, both names are kept, joined by `/`.
7. **Editorial corrections, published openly.** This edition has two: one cluster merged into
   another despite few links between them, and one account moved into a different cluster.
8. **Political groups.** Each cluster is assigned by the editors to one of 8 groups. The group
   decides the hue and the cluster gets a shade of it (§8.4).
9. **Bridge metrics.**
   - `bt` = **betweenness centrality**.
   - `cut` = **"stacca N"**: how many accounts would be cut off from the rest of the network
     if this account were removed. This is the articulation-point fragment size.
10. **Layout.** A **force-directed** layout runs at build time and the coordinates are shipped
    as `x, y`, in a box of about ±1200 × ±944. There is **no physics in the browser**. The
    algorithm, seed and parameters are **unknown**.
11. **Photo atlas.** Public profile pictures are cropped to 96 px squares and packed
    row-major into one WebP with a content-hashed name. Each node gets a tile index `p`
    (−1 means no photo).
12. **Media Compass.** A caption export (emoji are lost) goes through keyword scoring (§9),
    giving per-profile and per-month aggregates.
13. **Bundle.** The JSON is gzipped, encrypted with AES-256-GCM, base64-encoded and written as
    `window.MAPPATURA_ENC = {…}` (§6).
14. **SEO templating.** Blocks between `<!-- SEO:testa -->…<!-- /SEO:testa -->` (head) and
    `<!-- SEO:testo -->…<!-- /SEO:testo -->` (a visually hidden text summary) are rewritten in
    both HTML files with the edition's numbers. `llms-full.txt` and `sitemap.xml` get the
    edition date.

---

## 5. Data model (verified at runtime: shape only)

The decrypted object has these top-level keys: `nodes`, `links`, `clusters`, `gruppi`,
`categories`, `faces`, `totals`, `generated`, `periodo`, `compass`. Field names are short to
keep the payload small.

### 5.1 `nodes[]` (1,192)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | stable key; used in URL hashes (lower-case handle) |
| `name` | string | account handle; label and search key |
| `dn` | string \| null | display name (null for 761 of 1,192) |
| `c` | int | index into `clusters` |
| `cat` | string | category key |
| `x`, `y` | number | precomputed layout coordinates (world units) |
| `deg` | int | number of collaborations (degree) |
| `bt` | number | betweenness centrality |
| `cut` | int | accounts cut off if this one is removed (0 if not an articulation point) |
| `fol` | int \| null | followers (null = n/r, 138 nodes) |
| `itr` | int \| null | interactions in the period (null = n/r, 138 nodes; 0 for 15) |
| `gro` | number \| null | follower growth as a fraction (×100 for display; null for 672) |
| `p` | int | atlas tile index, −1 if no photo (139 nodes) |

### 5.2 Other collections

- `links[]`: `[i, j]` index pairs into `nodes` (2,367). The client builds adjacency lists
  and sorts edges by ascending endpoint degree, so hubs draw last.
- `clusters[]` (31): `{ id, label, hub, size, gruppo, isolated }`. `isolated` marks the
  "no collaborations" bucket, which is drawn neutral.
- `gruppi[]` (8): `{ id, nome }`. Group ids are short codes on the left–right arc plus
  independents.
- `categories[]` (7): `{ name, size }`.
- `faces`: `{ file, tile, cols, rows, n }`. The tile for `p` is at
  `col = p % cols`, `row = floor(p / cols)`.
- `totals`: `{ followers, interactions, measured }`.
- `generated` (edition date) and `periodo` (period label).

### 5.3 `compass`

| Field | Meaning |
|---|---|
| `profili[]` (112) | per profile: `n` (index of the network node, or null), `nome`, `post`, `txt` (posts with text), `nacc` (heated posts), `acc` (heated share), `tono` (`Informativo` \| `Misto` \| `Militante`), `temi[]` (posts per topic), `tacc[]` (heated posts per topic), `bers[]` (posts naming each target), `bacc[]` (heated posts naming each target), `gov`/`opp` (heated posts aimed at government/right vs opposition/left), `vago` (unnamed-enemy share or null), `premio` (nullable extra metric), `mesi[]` (per month `[posts, heated, politics]`), `itr` |
| `temi[]` | 17 topic names |
| `bersagli[]` | coded targets (government, parties, judiciary, press, migrants, EU, USA, Russia, Israel, "strong powers"…) |
| `lato` | the two sides' definitions |
| `mesi[]` | `YYYY-MM` list |
| `soglie` | thresholds: `informativo` 0.02, `militante` 0.10, `min_post` 20, `min_accesi` 8, `min_lati` 5, `min_mese` 8 |
| `post`, `periodo`, `fonte` | totals and labels |

---

## 6. The "encrypted" data bundle (verified mechanism)

```js
window.MAPPATURA_ENC = { v: 2, z: "gzip", salt: "<b64 16B>", iv: "<b64 12B>", ct: "<b64>" };
```

- key = `SHA-256(PEPPER ‖ salt)`, used as a raw AES-256-GCM key. `PEPPER` is a constant
  string in `graph.js`, and the salt changes with every build.
- The browser decrypts with WebCrypto, gunzips with `DecompressionStream('gzip')`, then calls
  `JSON.parse`.
- Decryption runs **in parallel with the title intro** (`Promise.all([decrypt, INTRO.fine])`),
  so the map is ready when the animation ends.
- There are explicit error states in the intro box: insecure context ("open via https or a
  local server"), old browser (no `DecompressionStream`), and data unavailable.

**What it's for:** per-profile data isn't served as readable text, so search engines and
naïve scrapers see nothing. The site states that individual data "is not published as text
nor downloadable". The code comments say plainly that it is **not a vault**: the key ships
with the page. Treat it as **obfuscation and a statement of intent**, not access control. One
cost: it needs a secure context, so `file://` and LAN-HTTP previews fail.

---

## 7. Front-end architecture (verified)

### 7.1 Boot sequence

1. **Pre-paint theme** (inline script 1). Reads `localStorage['mm-theme']` or
   `prefers-color-scheme`, then sets `<html data-theme>`, so there is no theme flash.
2. **Intro** (inline script 2). The title types itself letter by letter (first letter at
   380 ms, 50 ms per letter, 170 ms per space, 1,150 ms hold), then the partner logos appear.
   It shows once per session (`sessionStorage['mm-intro']`). It is skipped by click, key or
   wheel, by a deep-link hash, by the `/compass` route, or by reduced motion. It exposes
   `window.INTRO.fine` (a promise).
3. **Decrypt** runs alongside the intro (§6), then `openMap(data)`.
4. `openMap` switches transitions off for one frame (two rAFs plus a 300 ms timer), so panels
   don't animate from "hidden" to their initial state. It then unhides the UI and calls
   `start(DATA)`.
5. `start` builds the model: adjacency, sizes, colours, search keys. It sets defaults: degree
   sizing, **colour by category**, photos off, the right rail open on desktop and closed below
   761 px. It fits the camera, wires the UI, and calls `COMPASS.init(...)` with a small
   adapter (nodes, colours, photo cropper, theme hook).
6. **Opening animation.** A background grid draws in (1,150 ms), then the network "grows" in
   a **BFS wave**:
   - Each connected component is seeded at its highest-degree node, and BFS depth is computed
     from there.
   - Smaller components are delayed in proportion to their distance from the main seed.
   - Reveal time = `0.62·rank + 0.38·depth` over 1,500 ms. Labels fade in after 78% of the
     wave.
7. `openHash()` runs on load, `hashchange` and `popstate`.

### 7.2 Engine sections (`graph.js`)

They run in this order: 1 opening/decrypt · 1bis iOS viewport defence · 2 theme · 3 graph
model (colours, shades, model, state) · 4 drawing · 5 frame loop · 6 input · 7 profile card ·
7bis comparison · 8 cluster focus · 9 search and zoom UI · 9bis other views (editorial, info,
feedback form, mobile notice, mobile menu, matrix, rankings, category list, rail tabs) ·
10 boot (routing, Compass adapter).

### 7.3 State and URL contract

| Route | Meaning |
|---|---|
| `/#<id>` | select a profile (decoded defensively and lower-cased) |
| `/#<idA>+<idB>+…` | compare up to 6 profiles |
| `/compass`, `/compass#<id>` | Compass page, optionally with a profile selected |
| `#compass/<key>` (legacy) | migrated to `/compass#<key>` |

- Selection uses `history.replaceState`, so selecting doesn't add Back steps. Opening the
  Compass from the UI uses `pushState({cp:1})`, so Back returns to the map.
- **Only selection and comparison are serialised.** Filters, toggles, camera and Compass axis
  or month are not.
- **Reset** clears focus and reframes. It does *not* restore toggles or theme.
- Storage keys: `mm-theme` (localStorage), `mm-intro` (sessionStorage), `mm-notice`
  (localStorage, the mobile notice dismissal).

### 7.4 Frame loop

A `requestAnimationFrame` loop runs continuously but only redraws when `needsDraw` is set, or
while something is animating: camera, intro, focus glow, selection pulse, bridge mode. The
frame delta is capped at 64 ms. The backing store uses `DPR = min(devicePixelRatio, 2)`.

---

## 8. Map rendering rules (verified, condensed)

### 8.1 Camera

- `screen = world·k + offset`. Wheel zoom is `exp(−Δy·0.0022)` (×0.012 with Ctrl), anchored
  at the cursor and clamped to `0.12…6`. The +/− buttons use ×1.35 and ÷1.35.
- Pan starts after 3 px of movement. Pinch zooms about the midpoint, with no inertia.
- `flyTo` uses linear interpolation with cubic ease-out. Durations: 560 ms default, 520 ms for
  selection, 600 ms for fit/reset.
- **Selection offsets the target** so the node isn't hidden under the card: +186/k world-x on
  desktop, +0.26·H/k world-y on mobile.
- Double-click flies to the node at zoom ≥ 2.2.
- **Fit** works on a "free box": the viewport minus the left options column (294 px), the
  right rail (312 px) or card (406 px), and the top bar. On narrow screens it uses the top 36%
  or 50% when a sheet is open. Tall portrait screens get up to ×1.9 extra fill.

### 8.2 Nodes are **squares**

Sizes are given as half-side lengths.

- **Degree mode:** `r = 3 + 2.1·√deg`.
- **Interaction mode:** two segments.
  - Up to the 95th percentile: `r = 3.4 + 20·√(itr/P95)` (area roughly proportional).
  - Above it: `r = 23.4 + 14·log(itr/P95)/log(max/P95)` (logarithmic, so a few giants don't
    flatten everyone else).
  - `itr = null` is drawn as a **hollow square** ("n/r"). `itr = 0` is a tiny filled square.
- On-screen half-side is `max(1.5, r·k)`. Photo mode forces a minimum of 7 px.
- **Bridge mode:**
  - Size is multiplied by `1 + 0.9·√(bt/max)`.
  - Opacity is `0.16 + 0.84·√(bt/max)`.
  - The top 22 bridge nodes get pulsing rings.
  - Cross-cluster edges become prominent (alpha 0.8); same-cluster edges fade (0.13).

### 8.3 Edges

- Straight lines with butt caps, no arrows, no weights.
- An edge whose two ends are in the **same bucket** (same category or same cluster, depending
  on colour mode) takes the bucket colour, desaturated (alpha 0.95). Cross-bucket edges are
  **neutral grey** (alpha 0.62) and draw underneath. Grey lines are the ones holding the
  network together, and they are meant to read as exceptions.
- Rest width is `max(0.6, 0.85·k)`.
- On focus (hover or select), unrelated edges fade to alpha 0.35. Incident edges light up
  with the selected node's colour (alpha 0.35–0.9 with the glow). A pulse travels along
  selected edges on a 2.2 s cycle.

### 8.4 Colour

- **Category mode:** a fixed dictionary per theme. The neutral is `#B6B0A9` (light) or
  `#5A626C` (dark).
- **Cluster mode:** colour comes from **group hue × cluster shade**, computed in **OKLCH**:
  - Each group has a hue and chroma: red for the far left, through orange, yellow and blue, to
    violet for the far right. Independents are green. Unassigned clusters are a warm grey.
  - Within a group, clusters are sorted by size. The largest gets the strongest shade.
    Lightness spans up to 0.26 in light mode (0.32 in dark) around 0.60 light / 0.72 dark.
  - The hue rotates 16–30° across the group's clusters, so neighbouring clusters stay
    distinguishable.
  - Colours are gamut-mapped by reducing chroma in 0.004 steps.
  - The fallback when groups are absent is a 30-colour palette maximising pairwise Lab ΔE
    (≥21).
- **Intensity shows weight:** within a bucket, `t = √(weight / bucketMax)`. A higher `t` gives
  a more saturated, darker (light theme) or brighter (dark theme) colour. Weight is degree or
  interactions, following the size mode, so changing the size mode re-tints nodes.

### 8.5 Labels

- At rest, a label shows when the node's degree exceeds a zoom-dependent threshold: 15 when
  zoomed out, then 9, 5, 2, and 0 above 2.4×. Below 520 px of width the threshold is +4.
- Placement is **greedy**:
  - Priority labels go first: selected, hovered, compared.
  - Then by weight.
  - A candidate is rejected if its box overlaps an earlier label box.
- Labels use the monospace font at 9–11.5 px, with a 3 px halo in the background colour.

### 8.6 Picking

A linear scan over the nodes. A node is hit when the pointer is within the square's
half-side + 4 px (at least 8 px). Among hits, the one with the smallest Manhattan distance
wins. There is no spatial index; at about 1,200 nodes that is fine.

### 8.7 Photos

- **Canvas:** `drawImage(atlas, col·tile, row·tile, tile, tile, X−R, Y−R, 2R, 2R)`, with a
  frame in the node colour.
- **HTML avatars:** CSS `background-size: cols·s × rows·s` and
  `background-position: −col·s −row·s`.
- **Compass (SVG):** the whole atlas as an `<image>`, offset and clipped to a circle.
- The atlas is requested at startup with low fetch priority.

---

## 9. Media Compass (verified UI, published method)

### 9.1 Scoring method (keyword lexicon, per post caption)

- **Heated** words and phrases fall into three families: insults and contempt, attacks on
  "the system" (*regime, propaganda, censorship*), and calls to mobilise. Bursts of
  exclamation marks also count.
- **Strong terms score 2, others 1.** A post is heated at **≥ 2 points**. Each term counts
  once per post.
- **History guard:** in posts about history (a year before 2000, fascism, the Risorgimento),
  "system" words don't count.
- **Profile tone** comes from the heated share: **informative < 2%**, **militant ≥ 10%**,
  **mixed** in between. Profiles with fewer than 20 text posts are excluded.
- **Politics share** is the share of posts about government, parties, elections, laws or
  leaders.
- **Unnamed enemy** is the share of *heated* posts that name none of the coded targets. It is
  only computed with ≥ 8 heated posts; otherwise it is "n.d.".
- **Against whom** is the share of heated, side-naming posts aimed at government/right
  rather than opposition/left. It needs ≥ 5 such posts.
- **Monthly:** months with fewer than 8 text posts for a profile hide that dot. A month bar
  only appears when the month has ≥ 200 posts in total.
- **Topics** (17): a post can count for several. For each topic, the heated rate = heated
  posts / posts on that topic.
- **Stated limits:** it misreads irony, quotes and emoji. It is for comparing profiles, not
  judging single posts.

### 9.2 Plot

- An SVG scatter plot.
  - `x = √(acc / axisMax)`. The axis max is the first of 0.1…1 that is ≥ 1.04 × the data max.
  - `y` is linear 0–100%.
  - Radius is `(3.4 + 14·√(post/maxPost))`, ×0.72 on narrow screens.
- Background bands mark the informative, mixed and militant zones, at 2% and 10%.
- **Collision relaxation:** up to 70 all-pairs passes, each pushing overlapping pairs apart by
  a quarter of the overlap. Each dot is capped at 10 px from its true position.
- Profiles with no value for the chosen axis go into a **"n.d." strip** below the axis, using
  a separate beeswarm packing.
- Labels: greedy placement (right, left, above, below), up to 28 on desktop and 10 on mobile.
- Timeline: one bar per month, with height equal to the heated share. ▶ plays the months every
  2.1 s, and dots animate with 720 ms CSS transforms.
- Colour by cluster, by tone (3 fixed colours) or by category.
- Sidebar: rankings (most heated, most political, most posts) or a profile detail.
- Below the plot: "on which topics tones rise", "who attacks whom", and the full list with
  search, tone, topic and category filters (filters also dim the plot).
- The map's profile card embeds a **mini-compass** (112×74 SVG). The map shows a **teaser
  card** with rotating questions ("Who raises the tone?", "Against whom?") linking to the
  Compass.

---

## 10. UI inventory and layout (verified)

```
┌ ECOSISTEMA POLITICO ─────────┬─[ / search profile ][ compare ][ reset ]─┬─ partner logos ┐  top bar 52px
│┌ VIEW ─────────────── (–) ┐  │                                          │ ┌ CATEGORIES│CLUSTERS│BRIDGES│RANKING ┐
││ MAP                       │  │                                          │ │ list / ranking with bars             │
││ ▢ size = interactions     │  │          canvas: the network             │ │ click = isolate on map               │
││ ■ colour = category       │  │      (grid of registration crosses)      │ │                                       │
││ ▢ profile photos          │  │                                          │ │ ── or the PROFILE CARD (372px): ──    │
││ PANELS                    │  │                                          │ │ photo · handle · display name · cat   │
││ ■ clusters & rankings     │  │                                          │ │ [instagram ↗] [compare with…]         │
││ ▢ cluster matrix          │  │                                          │ │ collabs · followers · interactions ·  │
││ stats: nodes, links,      │  │                                          │ │ growth · bridge rank · "detaches N"   │
││ clusters, avg, total itr, │  │                                          │ │ mini-compass · collaborator chips     │
││ selection                 │  │                                          │ └───────────────────────────────────────┘
││ [info] [dark] 08/10/2026  │  │                                          │
│└───────────────────────────┘  │                                          │
│ EDITORIAL · why this map (+)  │ [+][−][fit] 32%   ┌ size legend ┐ ┌ NEW · COMPASS teaser ┐
└───────────────────────────────┴──────────────────────────────────────────┴─────────────────┘
```

- **Left column ("Vista", 258 px):** map toggles, panel toggles, live stats, the info button
  (the full methodology), the theme toggle, and the edition date. Below it, a collapsible
  **editorial** box.
- **Right rail (282 px), four tabs:**
  - *Categories*: counts; click to isolate.
  - *Clusters*: grouped by political group; click a group to light up all its clusters, or a
    cluster to isolate and frame it.
  - *Bridges*: betweenness bar plus "detaches N".
  - *Ranking*: interactions.

  Tabs also switch the map mode: Categories → colour by category; Clusters → colour by
  cluster; Ranking → size by interactions; Bridges → bridge mode.
- **Profile card (372 px):** replaces the rail while a profile is selected.
- **Comparison (up to 6):**
  - Each profile gets a role colour, and shared collaborators are striped.
  - Stats: shared by all, shared by some, Jaccard %.
  - With 3 or more profiles, an overlap matrix appears.
- **Cluster matrix:** an HTML table of cluster × cluster collaboration counts.
  - Diagonal cells are tinted with the cluster colour.
  - Off-diagonal cells are grey, with alpha by value.
  - A "closure" column shows the share of each cluster's collaborations that stay inside it.
  - Clicking a cell returns to the map and frames that pair of clusters.
- **Size legend:** appears in interaction mode (10K … 100M, n/r).
- **Feedback ("Segnala") form:** **there is no backend**. Submitting opens a `mailto:` with the
  text prefilled *and* copies it to the clipboard (for webmail users). The address is split in
  the source to dodge scrapers.
- **Mobile (≤ 760 px):**
  - A "View" menu button replaces the options, tools and search.
  - The search input is *moved* into the menu, keeping its handlers.
  - The rail becomes a bottom inset capped at 46% of the height, and cards become bottom
    sheets at 62%.
  - A dismissible notice recommends a computer.
  - iOS page-zoom defences: prevent gesture events, track `visualViewport`, and temporarily
    set `maximum-scale=1`.
- **Keyboard:**
  - `/` focuses search. Arrow keys and Enter work in the suggestions.
  - Escape works through a priority stack: menu → info → card → editorial → matrix →
    comparison → pair → selection → cluster → category.
- **Search:** case-insensitive substring match. Prefix matches rank first, then by degree,
  capped at 30 results.

---

## 11. Design system (verified)

- **Look:** a "technical sheet" aesthetic.
  - Boxes have hairline borders and **registration crosses** at the corners.
  - The background grid is made of small crosses (SVG data-URI tokens).
  - UI labels are UPPERCASE monospace with wide letter-spacing.
  - Nodes are squares, not circles.
  - A single hot accent (magenta `#EC008C`, or `#FF2FA6` in dark) is used for key numbers.
- **Fonts:**
  - *Archivo* (variable 400–700) for body text.
  - *Bebas Neue* for display titles ("MEDIA COMPASS", the teaser).
  - System `ui-monospace` for data and labels.
  - Both web fonts are self-hosted WOFF2 with hashed names, and Bebas is preloaded.
- **Tokens** (`:root[data-theme=…]`):
  - `--bg #F1EFED` / `#0B0D10`
  - `--surface #FFF` / `#12151A`
  - `--ink #14161A` / `#E9E7E4`
  - `--muted`, `--line`, `--edge`, `--edge-off`, `--node-off`, `--accent`, `--accent-2`,
    `--halo`
  - layout: `--bar-h 52px`, `--rail-w 282px`, `--opts-w 258px`, `--card-w 372px`
  - motion: `--ease cubic-bezier(.2,.9,.3,1)`, `--t 160ms`
- **Breakpoints:** 560 / 760 (desktop ↔ mobile switch) / 1000 / 1100 / 1280 px, plus
  `min-height: 1000px`. `pointer: coarse` forces 16 px inputs (to avoid iOS focus zoom).
- **Motion:**
  - Boxes "compose" in sequence: border lines draw (210 ms, staggered), then the background,
    then the content.
  - Ranking bars grow with a stagger.
  - Reduced motion is honoured by CSS and the intro (but only partly; see §13).

---

## 12. SEO and discoverability (verified)

- **Per-route head:** `<title>`, description, canonical, OG and Twitter tags with a 1200×630
  image per route (`og.png`, `og-compass.png`), and `robots: index, follow,
  max-image-preview:large`.
- **JSON-LD `@graph`:** six nodes linked by `@id`: the WebSite, a WebPage for the map and
  one for the Compass, an Organization for each author (Liberi Network, Arcadia), and the
  Dataset the pages are `about`. `dateModified` is set to the edition date.
- **A visually hidden summary** (`<section class="vh">`) describes the network in words:
  counts, groups and clusters with sizes, a Compass summary, and links. Crawlers get real
  content even though the data itself is encrypted.
- `<noscript>` points to the methodology.
- `llms-full.txt` holds the **complete methodology and numbers in Markdown**, for AI
  assistants. `robots.txt` declares `Content-Signal: search=yes, ai-input=yes, ai-train=yes`.
- `sitemap.xml` lists two URLs with `lastmod` set to the edition date.
- PWA manifest: standalone, theme colour `#F1EFED`, 192 and 512 icons.

---

## 13. Quirks a replica should fix (verified by the follow-up tests)

1. **Reset isn't a factory reset.** It keeps toggles, theme and rail tab. Decide deliberately.
2. **Reduced motion is partial.** Camera flights, selection ripples, edge pulses and Compass
   playback ignore it. A CSS pseudo-element animation still runs. The Compass header counters
   stay "—" under reduced motion, because the counter setter is skipped.
3. **The hash doesn't encode the whole UI.** Category, cluster and pair focus aren't
   serialised, and a stale profile hash can survive a filter change.
4. **Hit area and drawn size differ** in photo, bridge and comparison modes, where nodes are
   enlarged but picking uses the base size.
5. `fit()` has no zoom clamp, while `zoomAt()` does.
6. The CSS avatar helper doesn't check that the atlas loaded, so a failed atlas leaves empty
   avatars instead of initials.
7. Unknown hash ids don't clear an existing selection. In `#a+b`, a leading unknown id can
   block the fallback selection.
8. The Compass SVG `aria-label` doesn't update when the axis changes. Custom `role=button`
   rows handle Enter but not Space.

---

## 14. Rights, privacy and compliance for a replica

*This is not legal advice. Get a qualified opinion for the actual deployment.*

- **Do not reuse the site's data, code, photos or design assets.** EU database right
  (Italian L. 633/1941 art. 102-bis/ter) protects against extracting substantial parts.
  Art. 64-ter permits *studying* a program to learn its ideas, which is what this blueprint
  does. The site states that per-profile data is not published for download.
- **Political opinions are special-category data** (GDPR art. 9). A map that places named
  people into political groups processes them. Work out the lawful basis and any art. 9
  condition before you start: journalistic purposes (art. 85 plus national law) are the usual
  route for newsrooms. Keep a published methodology, a correction and removal channel, and
  data minimisation (the site does all three).
- **Platform terms.** Automated collection from Instagram is restricted by Meta's terms. The
  site says its links are compiled editorially. Use official APIs or manual curation, and keep
  a log of evidence (post URL per edge).
- **Profile photos** are third-party images. The site serves them self-hosted. Assess your
  rights, or use initials, or opt-in photos.
- **Transparency practices worth copying:**
  - an edition date and "how to cite" line;
  - editorial corrections disclosed by name;
  - "n/r" kept separate from zero;
  - a statement of what each metric does *not* mean.

---

## 15. Replication playbook

Use the starter kit in [`kit/`](kit/README.md):

1. **Define scope:** platform, period, actor list and categories, what counts as a
   "collaboration", and your editorial group taxonomy.
2. **Curate data:** prepare `accounts.csv`, `collaborations.csv` (one evidence URL per edge),
   and optionally `metrics.csv`, `groups.csv`, `overrides.json`, photos, and `posts.csv` plus
   `lexicon.json` for a Compass.
3. **Build:** `python kit/pipeline/build.py my-project/project.json`. This runs Louvain
   (tune `resolution`), betweenness, cut counts, the force layout, the atlas, the Compass,
   the bundle, and the SEO files.
4. **Tune:** look at the map, adjust the resolution and editorial overrides, and record every
   override in the methodology.
5. **Ship:** deploy `kit/site/` to any static host. The `_headers` file is ready for
   Cloudflare Pages or Netlify.
6. **Each edition:** re-run the build. Bump the edition date, and the hashed filenames take
   care of caching.

## 16. Unknowns

These are not recoverable from the public site:

- the force-layout engine and its parameters;
- the Louvain resolution value and seed;
- the collection tooling and how edges are evidenced;
- the full Compass lexicon and the topic and target dictionaries;
- the image sourcing and cropping policy;
- the exact hosting product.

The kit picks documented defaults for each of these.
