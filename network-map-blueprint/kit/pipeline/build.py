"""Build one edition of the network map from editorial CSV files.

    python build.py ../sample/project.json

Reads the inputs named in the project file, computes clusters, bridges and
layout, packs the photo atlas, scores the Compass captions, then writes the
bundle and edition-dependent files into the site directory. A cluster report
for the editors is written to <project dir>/out/clusters.csv.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

import graphmetrics as gm
from atlas import build_atlas
from compass import Lexicon, compute as compute_compass
from publish import write_bundle, write_text_files

ID_RE = re.compile(r"^[a-z0-9._-]+$")


class InputError(Exception):
    pass


def read_csv(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def num(v: str, kind=int):
    v = (v or "").strip()
    return None if v == "" else kind(v)      # blank means "not measured", never zero


def load_accounts(path: Path, categories: dict) -> list[dict]:
    rows, seen, errors = read_csv(path), set(), []
    for r in rows:
        r["id"] = r["id"].strip().lower()
        if not ID_RE.match(r["id"]):
            errors.append(f"bad id {r['id']!r} (use lower-case letters, digits, . _ -)")
        if r["id"] in seen:
            errors.append(f"duplicate id {r['id']!r}")
        if r["category"] not in categories:
            errors.append(f"{r['id']}: unknown category {r['category']!r}")
        seen.add(r["id"])
    if errors:
        raise InputError("accounts.csv:\n  " + "\n  ".join(errors))
    return rows


def load_edges(path: Path, ids: set[str]) -> list[tuple[str, str]]:
    edges, errors = set(), []
    for k, r in enumerate(read_csv(path), start=2):
        a, b = r["source"].strip().lower(), r["target"].strip().lower()
        missing = [x for x in (a, b) if x not in ids]
        if missing:
            errors.append(f"line {k}: unknown account(s) {missing}")
        elif a != b:
            edges.add((a, b) if a < b else (b, a))
    if errors:
        raise InputError("collaborations.csv:\n  " + "\n  ".join(errors[:30]))
    return sorted(edges)


def name_clusters(G, comms, misc, groups_rows, names, group_ids) -> list[dict]:
    """Default name = hub; editorial rows (anchor → label, group) override it.

    Anchoring labels to a member account, not a cluster number, keeps them
    stable across editions: cluster numbers change every run, members do not.
    """
    clusters = []
    for members in comms:
        rows = [r for r in groups_rows if r["anchor"].lower() in members]
        gset = {r["group"] for r in rows if r.get("group")}
        if len(gset) > 1:
            print(f"warning: cluster with {sorted(r['anchor'] for r in rows)} has groups {gset}; "
                  "using the first", file=sys.stderr)
        group = rows[0]["group"] if rows and rows[0].get("group") else None
        if group and group not in group_ids:
            raise InputError(f"groups.csv: unknown group {group!r}")
        hub = gm.hub_of(G, members, names)
        # two named clusters merged in one edition keep both names
        label = " / ".join(dict.fromkeys(r["label"] for r in rows if r["label"])) or names[hub]
        clusters.append({"label": label, "hub": hub, "size": len(members), "group": group,
                         "misc": False, "members": members})
    clusters.sort(key=lambda c: (-c["size"], c["label"]))
    if misc:
        clusters.append({"label": "Isolated & small groups", "hub": None, "size": len(misc),
                         "group": None, "misc": True, "members": misc})
    return clusters


def build(project_path: Path) -> dict:
    P = json.loads(project_path.read_text(encoding="utf-8"))
    root = project_path.parent
    inp = {k: (root / v if v else None) for k, v in P["inputs"].items()}
    site = (root / P.get("output", "../site")).resolve()

    categories = {c["key"]: c for c in P["categories"]}
    group_ids = {g["id"] for g in P["groups"]}
    accounts = load_accounts(inp["accounts"], categories)
    ids = [a["id"] for a in accounts]
    names = {a["id"]: a["name"] or a["id"] for a in accounts}
    edges = load_edges(inp["collaborations"], set(ids))

    metrics = {}
    if inp.get("metrics") and inp["metrics"].exists():
        for r in read_csv(inp["metrics"]):
            metrics[r["id"].strip().lower()] = (num(r["followers"]), num(r["interactions"]),
                                                num(r["follower_growth"], float))

    G = gm.build_graph(ids, edges)
    lv = P.get("louvain", {})
    comms, misc = gm.detect_communities(G, lv.get("resolution", 1.0), lv.get("seed", 7),
                                        lv.get("min_cluster_size", 3))
    overrides = {}
    if inp.get("overrides") and inp["overrides"].exists():
        overrides = json.loads(inp["overrides"].read_text(encoding="utf-8"))
    comms, corrections = gm.apply_overrides(comms, misc, overrides, set(ids))
    groups_rows = read_csv(inp["groups"]) if inp.get("groups") and inp["groups"].exists() else []
    clusters = name_clusters(G, comms, misc, groups_rows, names, group_ids)
    cluster_of = {n: i for i, c in enumerate(clusters) for n in c["members"]}

    bt = gm.betweenness(G, lv.get("seed", 7))
    cut = gm.cut_counts(G)
    pos = gm.layout(G, P.get("layout", {}))
    faces, tile_of = build_atlas(inp.get("photos"), ids, site, P.get("atlas", {}).get("tile", 96))

    acc_by_id = {a["id"]: a for a in accounts}
    order = sorted(ids, key=lambda i: (cluster_of[i], -G.degree(i), i))
    index = {n: k for k, n in enumerate(order)}
    nodes = []
    for n in order:
        fol, itr, gro = metrics.get(n, (None, None, None))
        nodes.append({
            "id": n, "name": names[n], "dn": acc_by_id[n].get("display_name") or None,
            "c": cluster_of[n], "cat": acc_by_id[n]["category"],
            "x": pos[n][0], "y": pos[n][1], "deg": G.degree(n),
            "bt": round(bt[n], 6), "cut": cut[n],
            "fol": fol, "itr": itr, "gro": gro, "p": tile_of.get(n, -1),
        })

    compass = None
    if inp.get("posts") and inp["posts"].exists() and inp.get("lexicon"):
        lexicon = Lexicon(json.loads(inp["lexicon"].read_text(encoding="utf-8")))
        compass = compute_compass(inp["posts"], lexicon, index, P.get("compass", {}))

    measured = [x for x in nodes if x["itr"] is not None]
    meta = {k: P[k] for k in ("title", "subtitle", "site_url", "language", "edition", "period",
                              "platform", "profile_url", "authors", "credits", "contact",
                              "content_signal") if k in P}
    meta["site_url"] = meta["site_url"].rstrip("/") + "/"
    data = {
        "meta": meta,
        "method": {"resolution": lv.get("resolution", 1.0), "seed": lv.get("seed", 7),
                   "layout": P.get("layout", {}).get("algorithm", "forceatlas2")},
        "categories": [{**{k: c[k] for k in ("key", "label", "light", "dark")},
                        "size": sum(a["category"] == c["key"] for a in accounts)}
                       for c in P["categories"]],
        "groups": P["groups"],
        "clusters": [{k: c[k] for k in ("label", "hub", "size", "group", "misc")} for c in clusters],
        "nodes": nodes,
        "links": [[index[a], index[b]] for a, b in edges],
        "faces": faces,
        "totals": {"followers": sum(x["fol"] or 0 for x in nodes),
                   "interactions": sum(x["itr"] for x in measured),
                   "measured": len(measured)},
        "corrections": corrections,
        "compass": compass,
    }

    data_hash = write_bundle(data, site, P.get("bundle", "plain"))
    write_text_files(data, site, data_hash)
    write_report(root / "out", data, clusters, G)
    return data


def write_report(out: Path, data: dict, clusters: list[dict], G) -> None:
    out.mkdir(exist_ok=True)
    with open(out / "clusters.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["index", "label", "group", "size", "hub", "top_members"])
        for i, c in enumerate(clusters):
            top = sorted(c["members"], key=lambda n: -G.degree(n))[:6]
            w.writerow([i, c["label"], c["group"] or "", c["size"], c["hub"] or "", " ".join(top)])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("project", type=Path, help="project JSON file")
    args = ap.parse_args()
    try:
        data = build(args.project.resolve())
    except InputError as e:
        sys.exit(f"input error: {e}")
    named = [c for c in data["clusters"] if not c["misc"]]
    cp = data["compass"]
    print(f'{len(data["nodes"])} accounts, {len(data["links"])} collaborations, '
          f'{len(named)} clusters, {len(data["corrections"])} editorial corrections, '
          f'{data["faces"]["n"] if data["faces"] else 0} photos, '
          f'compass: {len(cp["profiles"]) if cp else 0} profiles')


if __name__ == "__main__":
    main()
