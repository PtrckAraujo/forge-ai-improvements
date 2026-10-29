# Network map kit

A clean-room starter for building a site like *Ecosistema Politico*: an interactive map of who
collaborates with whom, plus an optional Media Compass of post tone. It implements the
architecture described in [`../BLUEPRINT.md`](../BLUEPRINT.md) with original code. It contains
none of that site's code, data or images. Every account in `sample/` is invented.

```
editorial CSVs ──▶ pipeline/build.py ──▶ site/ (static: HTML, CSS, JS, data.js, photo atlas)
                    Louvain · betweenness · cut counts · force layout · atlas · Compass · SEO files
```

## Quick start

Python 3.10 or later:

```bash
pip install -r pipeline/requirements.txt
```

```bash
python pipeline/make_sample.py sample
```

```bash
python pipeline/build.py sample/project.json
```

```bash
cd site && python -m http.server 8000 --bind 127.0.0.1
```

Open http://127.0.0.1:8000/ for the map and http://127.0.0.1:8000/compass.html for the
Compass. Serve over `localhost` or https: an obfuscated bundle is decrypted with WebCrypto,
which needs a secure context. A built sample is already committed, so the last command works
on its own.

## Layout

| Path | What |
|---|---|
| `pipeline/build.py` | reads the project file, runs every step, writes the site files and `out/clusters.csv` |
| `pipeline/graphmetrics.py` | graph, Louvain, editorial overrides, betweenness, cut counts, layout |
| `pipeline/compass.py` | keyword scoring of captions (heated posts, topics, targets, sides, months) |
| `pipeline/atlas.py` | packs profile photos into one content-hashed WebP |
| `pipeline/publish.py` | `data.js` (plain or obfuscated), SEO blocks, `sitemap.xml`, `robots.txt`, `llms-full.txt` |
| `pipeline/make_sample.py` | seeded generator for the synthetic sample |
| `sample/` | sample project: `project.json`, CSVs, `overrides.json`, `lexicon.json` |
| `site/` | the static site: `index.html` (map), `compass.html`, `css/`, `js/`, `_headers` |
| `tests/` | `test_pipeline.py` (unittest) and `smoke.js` (Playwright browser test) |

## Inputs

All inputs are CSV, UTF-8, with a header row. Blank cells mean "not measured" and are kept as
`null`, never as 0.

| File | Columns | Notes |
|---|---|---|
| `accounts.csv` | `id, name, display_name, category` | `id` is lower-case `[a-z0-9._-]` and is used in URLs; `category` is a key from the project's `categories` |
| `collaborations.csv` | `source, target, date, evidence_url` | one row per *observed* collaboration; duplicates and self-links are dropped; evidence stays private (it is not shipped) |
| `metrics.csv` | `id, followers, interactions, follower_growth` | growth is a fraction (`0.12` = +12%); optional file |
| `groups.csv` | `anchor, label, group` | names a cluster and assigns its editorial group, by **any member account** (cluster numbers change between runs, members don't); two anchors landing in the same cluster give the label "A / B" |
| `overrides.json` | `{"merge": [{into, from, reason}], "move": [{id, to, reason}]}` | editorial corrections on top of the algorithm; each one is listed in the info panel and `llms-full.txt` |
| `photos/<id>.(png\|jpg\|webp)` | | optional; centre-cropped to `atlas.tile` px |
| `posts.csv` | `account, date, caption` | optional, for the Compass; empty caption = image-only post |
| `lexicon.json` | | heated terms (strong = 2 points, weak = 1), system terms, history guard, topics, targets, sides; see `sample/lexicon.json` |

## `project.json`

- **Edition:** `title`, `subtitle`, `site_url`, `language`, `edition` (date), `period.from`
  and `period.to`, `platform`, `profile_url` (with `{name}`), `authors`, `credits`, `contact`
  (corrections mailbox), `content_signal` (written into `robots.txt`).
- **Taxonomy:**
  - `categories[]`: `{key, label, light, dark}` colours.
  - `groups[]`: `{id, name, hue, chroma}`, an OKLCH hue per editorial group. Clusters of a
    group get shades of that hue.
- **Algorithms:**
  - `louvain.resolution` is the granularity knob: higher gives more, smaller clusters.
    Re-tune it every edition and publish the value.
  - `louvain.seed`.
  - `louvain.min_cluster_size`: smaller groups go into the neutral "Isolated & small groups"
    bucket.
  - `layout.algorithm` (`forceatlas2` or `spring`), plus `iterations`, `gravity`,
    `scaling_ratio`, `seed` and `width`.
  - `atlas.tile`.
  - `compass` thresholds: `heated_at`, `informative`, `militant`, `min_posts`, `min_heated`,
    `min_sides`, `min_month`, `min_month_total`.
- **Output:** `output` (site directory) and `bundle`:
  - `plain` gives `window.MAP_DATA`.
  - `obfuscated` gives an AES-GCM and gzip envelope. The key is `SHA-256(PEPPER ‖ salt)`, with
    `PEPPER` read from `site/js/core.js`. Change `PEPPER` per project.

  Obfuscation keeps per-profile data away from crawlers; it is not access control.

## Editorial loop

1. Build, then open `sample/out/clusters.csv` (index, label, group, size, hub, top members).
2. Look at the map. If clusters you can recognise by eye are merged, raise the resolution;
   if one community is split in two, lower it.
3. Name clusters and assign groups in `groups.csv` (anchored to a member).
4. Use `overrides.json` only when the collaborations alone tell the story wrong, and write
   the reason: it is published.
5. Bump `edition` and rebuild. `data.js?v=<hash>` and the hashed atlas name take care of
   caching.

## Deploy

`site/` is a static folder. Any host works. `_headers` sets a strict same-origin CSP, HSTS
and cache rules in Cloudflare Pages and Netlify format. Cloudflare Pages also serves
`compass.html` as `/compass`.

## Customising

- **Language:** the UI strings are in the HTML and near their use in `js/map.js` and
  `js/compass.js`. Set `language` in the project and `<html lang>`.
- **Fonts:** self-host WOFF2 files (the CSP blocks font CDNs) and put the family first in
  `--font-body` or `--font-display` in `css/style.css`.
- **Colours:** use the design tokens at the top of `css/style.css`. Canvas and SVG read their
  neutrals from the same tokens.
- **Another platform:** only `platform`, `profile_url` and your definition of a
  "collaboration" change.
- **Social cards:** the generated head points to `img/og.png` and `img/og-compass.png`. Add
  both (1200×630) before launch.
- **Routes:** canonical URLs and the sitemap use `/compass`. Cloudflare Pages and Netlify map
  it to `compass.html` automatically; on other hosts, add a rewrite.

## Data contract (`data.js`)

`{ meta, method, categories[], groups[], clusters[], nodes[], links[], faces, totals, corrections[], compass }`

- `nodes[]` fields:
  - `id`, `name`, `dn` (display name)
  - `c` (cluster index), `cat`
  - `x`, `y` (precomputed layout)
  - `deg`, `bt` (betweenness), `cut` (accounts cut off if removed)
  - `fol`, `itr`, `gro` (nullable)
  - `p` (atlas tile, −1 for none)
- `links[]` are `[i, j]` index pairs.
- `clusters[]` are `{label, hub, size, group, misc}`.
- `compass.profiles[]` include `acc` (heated share), `pol`, `tone`, `vague`, `side`,
  `topics[]`, `topics_heated[]`, `targets[]`, `targets_heated[]`, and `months[]` as
  `[posts, heated, political]`.

## Tests

```bash
python -m unittest discover tests
```

The browser smoke test runs against a local server. Start one:

```bash
cd site && python -m http.server 8765 --bind 127.0.0.1 &
```

Then run the test (it needs Playwright with Chromium):

```bash
node tests/smoke.js http://127.0.0.1:8765/
```

## Where this differs from the original on purpose

The blueprint (§13) lists quirks in the original. The kit fixes these:

- **Reduced motion:** camera flights, ripples and pulses are instant or still. The CSS turns
  off every animation, pseudo-elements included.
- **Hash:** it also encodes category, cluster, group and pair focus (`#cluster/3`,
  `#pair/2/5`). An unknown id clears the selection.
- **Hit testing:** it uses the size actually drawn, so enlarged photo and bridge squares are
  easy to click.
- **Avatars:** the CSS avatar falls back to initials when the atlas didn't load.
- **CSP:** no inline scripts, so no hashes are needed.

Left out for now: multi-profile comparison, the title intro, the mobile notice, the editorial
box and the mini-compass in the profile card. The blueprint describes each one if you want to
add it.

## Before publishing real data

Read §14 of the blueprint. Placing named people into political groups processes data
revealing political opinions (GDPR art. 9). Platform terms restrict automated collection.
Profile photos have their own rights. Publish your method, your corrections and a removal
channel.
