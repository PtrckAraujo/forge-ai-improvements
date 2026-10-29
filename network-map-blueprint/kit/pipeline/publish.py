"""Write the site's data bundle and the edition-dependent text files.

Two bundle modes:

* ``plain``      → ``window.MAP_DATA = {...}``. Simple, debuggable.
* ``obfuscated`` → ``window.MAP_DATA_ENC = {v, z, salt, iv, ct}``: gzip, then
  AES-256-GCM with key = SHA-256(pepper ‖ salt). The pepper lives in
  ``site/js/core.js`` and the salt changes every build. This keeps per-profile
  data out of search engines and casual scrapers. It is NOT access control:
  the browser must hold the key to draw the map.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import html
import json
import os
import re
from pathlib import Path

from errors import InputError


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def read_pepper(core_js: Path) -> str:
    m = re.search(r"const PEPPER = '([^']+)'", core_js.read_text(encoding="utf-8"))
    if not m:
        raise InputError(f"{core_js}: no `const PEPPER = '...'` line, needed for the obfuscated bundle")
    return m.group(1)


def write_bundle(data: dict, site: Path, mode: str) -> str:
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if mode == "plain":
        body = b"window.MAP_DATA = " + raw + b";\n"
    elif mode == "obfuscated":
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        pepper = read_pepper(site / "js" / "core.js").encode("utf-8")
        salt, iv = os.urandom(16), os.urandom(12)
        key = hashlib.sha256(pepper + salt).digest()
        ct = AESGCM(key).encrypt(iv, gzip.compress(raw, mtime=0), None)
        env = {"v": 1, "z": "gzip", "salt": _b64(salt), "iv": _b64(iv), "ct": _b64(ct)}
        body = ("window.MAP_DATA_ENC = " + json.dumps(env) + ";\n").encode("ascii")
    else:
        raise InputError(f"project.json: bundle must be plain or obfuscated, not {mode!r}")
    (site / "data.js").write_bytes(body)
    return hashlib.sha256(body).hexdigest()[:10]


def _replace_block(text: str, name: str, content: str, page: str) -> str:
    pattern = re.compile(rf"(<!-- SEO:{name} -->)(.*?)(<!-- /SEO:{name} -->)", re.S)
    if not pattern.search(text):
        raise InputError(f"site/{page}: markers <!-- SEO:{name} --> … <!-- /SEO:{name} --> not found")
    return pattern.sub(lambda m: m.group(1) + "\n" + content + "\n" + m.group(3), text)


def _e(s) -> str:
    return html.escape(str(s), quote=True)


def _json_in_script(obj) -> str:
    """JSON safe inside <script>: '<', '>' and '&' as unicode escapes, so a
    value containing '</script>' or '<!--' cannot end the element."""
    return (json.dumps(obj, ensure_ascii=False)
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))


def _head(meta: dict, title: str, description: str, url: str, image: str,
          noindex: bool = False) -> str:
    e = _e
    ld = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "WebSite", "@id": meta["site_url"] + "#site", "name": meta["title"],
             "url": meta["site_url"], "inLanguage": meta["language"]},
            {"@type": "WebPage", "@id": url + "#page", "name": title, "url": url,
             "isPartOf": {"@id": meta["site_url"] + "#site"},
             "dateModified": meta["edition"], "description": description},
            {"@type": "Dataset", "@id": meta["site_url"] + "#data", "name": meta["title"],
             "description": description, "dateModified": meta["edition"],
             "temporalCoverage": f'{meta["period"]["from"]}/{meta["period"]["to"]}',
             "creator": [{"@type": "Organization", "name": a} for a in meta.get("authors", [])]},
        ],
    }
    return "\n".join([
        f"<title>{e(title)}</title>",
        f'<meta name="description" content="{e(description)}">',
        f'<link rel="canonical" href="{e(url)}">',
        '<meta property="og:type" content="website">',
        f'<meta property="og:site_name" content="{e(meta["title"])}">',
        f'<meta property="og:title" content="{e(title)}">',
        f'<meta property="og:description" content="{e(description)}">',
        f'<meta property="og:url" content="{e(url)}">',
        f'<meta property="og:image" content="{e(image)}">',
        '<meta name="twitter:card" content="summary_large_image">',
        *(['<meta name="robots" content="noindex">'] if noindex else []),
        '<script type="application/ld+json">' + _json_in_script(ld) + "</script>",
    ])


def _fmt(n: float) -> str:
    return f"{n:,.0f}"


def describe(data: dict) -> dict:
    """The numbers every text output repeats, computed once."""
    nodes, meta = data["nodes"], data["meta"]
    cats = ", ".join(f'{c["label"]} {c["size"]}' for c in
                     sorted(data["categories"], key=lambda c: -c["size"]))
    named = [c for c in data["clusters"] if not c["misc"]]
    # clusters listed along the editorial group order, unassigned last
    order = {g["id"]: i for i, g in enumerate(data["groups"])}
    by_group: dict[str, list[dict]] = {}
    for c in sorted(named, key=lambda c: order.get(c["group"], len(order))):
        by_group.setdefault(c["group"] or "", []).append(c)
    return {
        "by_group": by_group,
        "map_desc": (f'Who collaborates with whom on {meta["platform"]}: {_fmt(len(nodes))} '
                     f'accounts and {_fmt(len(data["links"]))} collaborations in '
                     f'{len(named)} clusters.'),
        "cats": cats,
        "named": named,
    }


def write_text_files(data: dict, site: Path, data_hash: str) -> None:
    meta, d = data["meta"], describe(data)
    base = meta["site_url"]
    groups = {g["id"]: g["name"] for g in data["groups"]}
    cp = data.get("compass")
    cp_desc = (f'The tone of {_fmt(cp["total_posts"])} posts from {len(cp["profiles"])} '
               f'accounts: how heated, how political, and against whom.' if cp else "")

    # crawlable summary: the encrypted bundle hides the data, not the story
    items = []
    for gid, cs in d["by_group"].items():
        name = groups.get(gid, "Unassigned")
        items.append(f'<li><b>{html.escape(name)}</b>: ' + ", ".join(
            f'{html.escape(c["label"])} ({c["size"]})' for c in cs) + ".</li>")
    text_block = "\n".join([
        '<section class="vh" aria-labelledby="seoTitle">',
        f'<h2 id="seoTitle">{html.escape(meta["title"])} in words</h2>',
        f'<p>{_e(d["map_desc"])} Categories: {_e(d["cats"])}. '
        f'Period {_e(meta["period"]["from"])} – {_e(meta["period"]["to"])}. '
        f'Edition of <time datetime="{_e(meta["edition"])}">{_e(meta["edition"])}</time>.</p>',
        "<h3>Groups and clusters</h3><ul>", *items, "</ul>",
        f'<p>Full method: <a href="llms-full.txt">llms-full.txt</a>.</p>',
        "</section>",
    ])

    pages = [("index.html", meta["title"] + " · " + meta["subtitle"], d["map_desc"], base,
              base + "img/og.png", False)]
    # compass.html is rewritten every edition: without a Compass it must not keep the
    # previous edition's description, and it leaves the index
    if cp or (site / "compass.html").exists():
        pages.append(("compass.html", "Media Compass · " + meta["title"],
                      cp_desc or "This edition has no Media Compass.",
                      base + "compass", base + "img/og-compass.png", not cp))
    for fname, title, desc, url, image, noindex in pages:
        p = site / fname
        if not p.exists():
            raise InputError(f"site/{fname}: page template not found")
        text = p.read_text(encoding="utf-8")
        text = _replace_block(text, "head", _head(meta, title, desc, url, image, noindex), fname)
        text = _replace_block(text, "text", text_block, fname)
        text = re.sub(r'src="data\.js(\?v=[0-9a-f]*)?"', f'src="data.js?v={data_hash}"', text)
        p.write_text(text, encoding="utf-8")

    urls = [base] + ([base + "compass"] if cp else [])
    (site / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        "".join(f"  <url><loc>{_e(u)}</loc><lastmod>{_e(meta['edition'])}</lastmod></url>\n" for u in urls) +
        "</urlset>\n", encoding="utf-8")
    (site / "robots.txt").write_text(
        "User-agent: *\nAllow: /\n" +
        (f"Content-Signal: {' '.join(meta['content_signal'].split())}\n" if meta.get("content_signal") else "") +
        f"\nSitemap: {base}sitemap.xml\n", encoding="utf-8")
    (site / "llms-full.txt").write_text(methodology(data, d, groups), encoding="utf-8")


def methodology(data: dict, d: dict, groups: dict) -> str:
    meta, cfg = data["meta"], data["method"]
    lines = [
        f'# {meta["title"]} — {meta["subtitle"]}', "",
        f'> {d["map_desc"]} Categories: {d["cats"]}. Period {meta["period"]["from"]} – '
        f'{meta["period"]["to"]}.', "",
        f'Site: {meta["site_url"]}',
        f'Authors: {", ".join(meta.get("authors", []))}',
        f'Source: {meta["platform"]}. Edition: {meta["edition"]}.',
        f'How to cite: «{meta["title"]}, {", ".join(meta.get("authors", []))}, edition of '
        f'{meta["edition"]}».', "",
        "## Method", "",
        "**Collection.** Every account is added by the editors with a declared category, "
        "which says what the account does, not which side it is on. A link is recorded only "
        "when an actual collaboration between two accounts is observed; nothing is inferred "
        "from affinity or membership. Accounts without collaborations stay on the map as "
        "isolated nodes.", "",
        "**Metrics.** Followers, interactions and follower growth refer to the declared "
        "period. Where a value could not be measured the map shows n/r, which is not zero.", "",
        "**Clusters.** Found by the Louvain algorithm on the collaboration graph only "
        f'(resolution {cfg["resolution"]}, seed {cfg["seed"]}). A cluster is not a coalition: '
        "it says who works with whom, not what anyone thinks. By default a cluster is named "
        "after its most connected member; editorial labels change the name, not the members.", "",
        "**Bridges.** Betweenness centrality: how many shortest paths between other accounts "
        "pass through an account. 'Detaches N' counts the accounts that would be cut off from "
        "the rest of the network if that account disappeared.", "",
        "**Positions.** A force-directed layout computed once per edition "
        f'({cfg["layout"]}). Distances have no geographic meaning.', "",
    ]
    if data["corrections"]:
        lines += ["## Editorial corrections", ""]
        for c in data["corrections"]:
            what = (f'cluster of {c["from"]} merged into the cluster of {c["into"]}'
                    if c["type"] == "merge" else f'{c["id"]} moved to the cluster of {c["to"]}')
            lines.append(f'- {what}. {c.get("reason", "")}'.rstrip())
        lines.append("")
    lines += ["## Groups and clusters", ""]
    for gid, cs in d["by_group"].items():
        total = sum(c["size"] for c in cs)
        lines.append(f'- **{groups.get(gid, "Unassigned")}** ({total} accounts): ' +
                     ", ".join(f'{c["label"]} ({c["size"]})' for c in cs))
    cp = data.get("compass")
    if cp:
        T = cp["thresholds"]
        lines += ["", "## Media Compass", "",
                  f'{_fmt(cp["total_posts"])} captions from {len(cp["profiles"])} accounts. '
                  f'A post is heated at {T["heated_at"]}+ points (strong terms 2, others 1, '
                  f'each counted once). Tone: informative below {T["informative"]:.0%}, '
                  f'militant from {T["militant"]:.0%}. Profiles with fewer than '
                  f'{T["min_posts"]} text posts are excluded. Keyword counting misreads irony '
                  "and quotes: it compares profiles, it does not judge single posts.",
                  "", "Topics: " + ", ".join(cp["topics"]) + "."]
    lines += ["", "## The data", "",
              "Per-profile data is consulted in the interactive map only. For corrections or "
              "removal requests use the contact in the site's information panel.", ""]
    return "\n".join(lines)
