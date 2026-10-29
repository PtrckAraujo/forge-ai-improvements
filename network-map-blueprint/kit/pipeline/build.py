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
from errors import InputError
from publish import write_bundle, write_text_files

ID_RE = re.compile(r"^[a-z0-9._-]+$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def read_csv(path: Path, required: set[str]) -> list[dict]:
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            missing = required - set(reader.fieldnames or [])
            if missing:
                raise InputError(f"{path.name}: missing column(s) {sorted(missing)}")
            return list(reader)
    except FileNotFoundError:
        raise InputError(f"{path}: file not found") from None


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise InputError(f"{path}: file not found") from None
    except json.JSONDecodeError as e:
        raise InputError(f"{path.name}: invalid JSON at line {e.lineno}, column {e.colno}: "
                         f"{e.msg}") from None


def num(v: str, kind, where: str):
    v = (v or "").strip()
    if v == "":
        return None                          # blank means "not measured", never zero
    try:
        return kind(v)
    except ValueError:
        what = "a whole number" if kind is int else "a number"
        raise InputError(f"{where}: {v!r} is not {what} (leave the cell empty if not measured)") from None


def validate_project(P: dict) -> None:
    """Fail early, with the key to fix, instead of deep inside the build."""
    errors = []
    for key in ("title", "subtitle", "site_url", "language", "edition", "platform"):
        if not isinstance(P.get(key), str) or not P[key].strip():
            errors.append(f"{key}: required text")
    if not DATE_RE.match(str(P.get("edition", ""))):
        errors.append("edition: use YYYY-MM-DD")
    period = P.get("period")
    if not isinstance(period, dict) or not all(DATE_RE.match(str(period.get(k, ""))) for k in ("from", "to")):
        errors.append("period: needs from and to as YYYY-MM-DD")
    for key in ("site_url", "profile_url"):
        if P.get(key) and not re.match(r"^https?://", P[key]):
            errors.append(f"{key}: must start with https:// or http://")
    if P.get("profile_url") and "{name}" not in P["profile_url"]:
        errors.append("profile_url: must contain {name}")
    inputs = P.get("inputs")
    if not isinstance(inputs, dict) or not inputs.get("accounts") or not inputs.get("collaborations"):
        errors.append("inputs: accounts and collaborations are required")
    cats = P.get("categories")
    if not isinstance(cats, list) or not cats:
        errors.append("categories: at least one {key, label, light, dark}")
    else:
        for c in cats:
            if not isinstance(c, dict) or not c.get("key") or not c.get("label"):
                errors.append(f"categories: {c!r} needs key and label")
            elif not all(HEX_RE.match(str(c.get(t, ""))) for t in ("light", "dark")):
                errors.append(f"categories.{c['key']}: light and dark must be #RRGGBB colours")
    for g in P.get("groups", []):
        if not isinstance(g, dict) or not g.get("id") or not g.get("name"):
            errors.append(f"groups: {g!r} needs id and name")
        elif not (isinstance(g.get("hue"), (int, float)) and isinstance(g.get("chroma"), (int, float))
                  and 0 <= g["chroma"] <= 0.4):
            errors.append(f"groups.{g['id']}: hue must be a number and chroma a number in 0..0.4")
    if P.get("bundle", "plain") not in ("plain", "obfuscated"):
        errors.append("bundle: plain or obfuscated")
    if errors:
        raise InputError("project.json:\n  " + "\n  ".join(errors))


def load_accounts(path: Path, categories: dict) -> list[dict]:
    rows, seen, errors = read_csv(path, {"id", "name", "category"}), set(), []
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
    for k, r in enumerate(read_csv(path, {"source", "target"}), start=2):
        a, b = r["source"].strip().lower(), r["target"].strip().lower()
        missing = [x for x in (a, b) if x not in ids]
        if missing:
            errors.append(f"line {k}: unknown account(s) {missing}")
        elif a != b:
            edges.add((a, b) if a < b else (b, a))
    if errors:
        raise InputError("collaborations.csv:\n  " + "\n  ".join(errors[:30]))
    return sorted(edges)


def load_metrics(path: Path, ids: set[str]) -> dict[str, tuple]:
    metrics, unknown = {}, []
    for k, r in enumerate(read_csv(path, {"id", "followers", "interactions", "follower_growth"}), start=2):
        i = r["id"].strip().lower()
        if i not in ids:
            unknown.append(f"line {k}: {i!r}")
            continue
        where = f"{path.name} line {k}"
        metrics[i] = (num(r["followers"], int, where + ", followers"),
                      num(r["interactions"], int, where + ", interactions"),
                      num(r["follower_growth"], float, where + ", follower_growth"))
    if unknown:
        raise InputError(f"{path.name}: accounts not in accounts.csv:\n  " + "\n  ".join(unknown[:30]))
    return metrics


def load_groups(path: Path, ids: set[str], group_ids: set[str]) -> list[dict]:
    """Editorial cluster names: every anchor must be a real account, every group a real group.

    A typo would otherwise silently drop a label and its group from the map.
    """
    rows, errors = read_csv(path, {"anchor", "label", "group"}), []
    for k, r in enumerate(rows, start=2):
        r["anchor"] = r["anchor"].strip().lower()
        r["label"], r["group"] = (r["label"] or "").strip(), (r["group"] or "").strip()
        if r["anchor"] not in ids:
            errors.append(f"line {k}: anchor {r['anchor']!r} is not in accounts.csv")
        if r["group"] and r["group"] not in group_ids:
            errors.append(f"line {k}: group {r['group']!r} is not one of {sorted(group_ids)}")
        r["line"] = k
    if errors:
        raise InputError(f"{path.name}:\n  " + "\n  ".join(errors))
    return rows


def name_clusters(G, comms, misc, groups_rows, names) -> list[dict]:
    """Default name = hub; editorial rows (anchor → label, group) override it.

    Anchoring labels to a member account, not a cluster number, keeps them
    stable across editions: cluster numbers change every run, members do not.
    """
    for r in groups_rows:
        if r["anchor"] in misc:
            print(f"warning: groups.csv line {r['line']}: {r['anchor']!r} has no cluster this "
                  f"edition (isolated or in a small group); label {r['label']!r} is not used",
                  file=sys.stderr)
    clusters = []
    for members in comms:
        rows = [r for r in groups_rows if r["anchor"] in members]
        groups = list(dict.fromkeys(r["group"] for r in rows if r["group"]))
        group = groups[0] if groups else None
        if len(groups) > 1:
            print(f"warning: one cluster holds anchors {[r['anchor'] for r in rows]} with groups "
                  f"{groups}; using {group!r} (the first in groups.csv)", file=sys.stderr)
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
    P = read_json(project_path)
    validate_project(P)
    root = project_path.parent
    inp = {k: (root / v if v else None) for k, v in P["inputs"].items()}
    site = (root / P.get("output", "../site")).resolve()

    categories = {c["key"]: c for c in P["categories"]}
    group_ids = {g["id"] for g in P.get("groups", [])}
    accounts = load_accounts(inp["accounts"], categories)
    ids = [a["id"] for a in accounts]
    names = {a["id"]: (a["name"] or "").strip() or a["id"] for a in accounts}
    edges = load_edges(inp["collaborations"], set(ids))

    metrics = load_metrics(inp["metrics"], set(ids)) if inp.get("metrics") else {}

    G = gm.build_graph(ids, edges)
    lv = P.get("louvain", {})
    comms, misc = gm.detect_communities(G, lv.get("resolution", 1.0), lv.get("seed", 7),
                                        lv.get("min_cluster_size", 3))
    overrides = read_json(inp["overrides"]) if inp.get("overrides") else {}
    comms, corrections = gm.apply_overrides(comms, misc, overrides, set(ids))
    groups_rows = load_groups(inp["groups"], set(ids), group_ids) if inp.get("groups") else []
    clusters = name_clusters(G, comms, misc, groups_rows, names)
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
    if inp.get("posts") and inp.get("lexicon"):
        if not inp["posts"].exists():
            raise InputError(f"{inp['posts']}: file not found")
        lexicon = Lexicon(read_json(inp["lexicon"]))
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
        "groups": P.get("groups", []),
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
        w = csv.writer(f, lineterminator="\n")
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
