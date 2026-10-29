"""Structural measures for the collaboration network.

Everything here is computed from the edges only: never from metrics, categories
or political groups. That separation is what lets the map say "clusters are
found by the algorithm, groups are an editorial choice".
"""
from __future__ import annotations

import math
from typing import Iterable

import networkx as nx

from errors import InputError


def build_graph(ids: Iterable[str], edges: Iterable[tuple[str, str]]) -> nx.Graph:
    G = nx.Graph()
    G.add_nodes_from(ids)              # isolated accounts stay on the map
    G.add_edges_from(edges)
    return G


def detect_communities(G: nx.Graph, resolution: float, seed: int,
                       min_size: int = 3) -> tuple[list[set[str]], set[str]]:
    """Louvain communities, plus the 'misc' bucket of isolates and tiny groups.

    `resolution` is the granularity knob: higher gives more, smaller clusters.
    As a network grows Louvain tends to swallow small groups into big ones, so
    re-tune it every edition until the communities you can see by eye survive,
    and publish the value you used.
    """
    comms = nx.community.louvain_communities(G, resolution=resolution, seed=seed)
    big = [set(c) for c in comms if len(c) >= min_size]
    misc = set().union(*(c for c in comms if len(c) < min_size)) if comms else set()
    return big, misc


def apply_overrides(comms: list[set[str]], misc: set[str], overrides: dict,
                    known: set[str]) -> tuple[list[set[str]], list[dict]]:
    """Editorial corrections on top of the algorithm, returned so they can be disclosed.

    Overrides outlive editions, so every failure says which entry is stale and
    why, instead of crashing: an account can disappear, or drop into the
    isolated/small-groups bucket when it loses its collaborations.
    """
    disclosed = []

    def account(entry: dict, key: str, kind: str) -> str:
        if not isinstance(entry, dict) or not entry.get(key):
            raise InputError(f"overrides.json: {kind} entry {entry!r} needs a {key!r} account")
        a = str(entry[key]).strip().lower()
        if a not in known:
            raise InputError(f"overrides.json: {kind} {key}={a!r} is not in accounts.csv")
        return a

    def find(node: str, kind: str) -> int:
        for i, c in enumerate(comms):
            if node in c:
                return i
        raise InputError(f"overrides.json: {kind} refers to {node!r}, which has no cluster in "
                         "this edition (isolated, or in a group smaller than min_cluster_size); "
                         "update or remove that override")

    for m in overrides.get("merge", []):
        into, frm = account(m, "into", "merge"), account(m, "from", "merge")
        a, b = find(into, "merge"), find(frm, "merge")
        if a != b:
            comms[a] |= comms[b]
            comms[b] = set()
        disclosed.append({**m, "type": "merge", "into": into, "from": frm})

    for mv in overrides.get("move", []):
        who, to = account(mv, "id", "move"), account(mv, "to", "move")
        target = find(to, "move")
        if who in misc:
            misc.discard(who)
        else:
            comms[find(who, "move")].discard(who)
        comms[target].add(who)
        disclosed.append({**mv, "type": "move", "id": who, "to": to})

    return [c for c in comms if c], disclosed


def cut_counts(G: nx.Graph) -> dict[str, int]:
    """How many accounts get cut off from the rest if this one disappears.

    For each articulation point, remove it and count every node outside the
    largest remaining piece of its component. O(A·(V+E)) is fine up to a few
    thousand nodes; use the block-cut tree for bigger graphs.
    """
    cut = dict.fromkeys(G, 0)
    for comp in nx.connected_components(G):
        if len(comp) < 3:
            continue
        H = G.subgraph(comp)
        for v in nx.articulation_points(H):
            rest = H.subgraph(comp - {v})
            sizes = sorted((len(c) for c in nx.connected_components(rest)), reverse=True)
            cut[v] = sum(sizes[1:])
    return cut


def betweenness(G: nx.Graph, seed: int, exact_limit: int = 5000) -> dict[str, float]:
    """Normalised betweenness ('bridge' score); sampled above `exact_limit` nodes."""
    k = None if G.number_of_nodes() <= exact_limit else min(1000, G.number_of_nodes())
    return nx.betweenness_centrality(G, k=k, normalized=True, seed=seed)


def layout(G: nx.Graph, cfg: dict) -> dict[str, tuple[float, float]]:
    """Force-directed positions, computed once at build time and shipped as data.

    The browser never simulates: it only draws these coordinates, so the map is
    identical for every visitor and every reload. Isolates are laid on a ring
    outside the network instead of being pulled into the middle by gravity.
    """
    seed = cfg.get("seed", 7)
    connected = [n for n in G if G.degree(n) > 0]
    H = G.subgraph(connected)
    if cfg.get("algorithm", "forceatlas2") == "spring":
        pos = nx.spring_layout(H, seed=seed, iterations=cfg.get("iterations", 300))
    else:
        pos = nx.forceatlas2_layout(
            H, seed=seed, max_iter=cfg.get("iterations", 400),
            scaling_ratio=cfg.get("scaling_ratio", 2.0), gravity=cfg.get("gravity", 1.0),
            strong_gravity=cfg.get("strong_gravity", False), linlog=cfg.get("linlog", False))
    pos = {n: (float(p[0]), float(p[1])) for n, p in pos.items()}

    if pos:
        cx = (min(p[0] for p in pos.values()) + max(p[0] for p in pos.values())) / 2
        cy = (min(p[1] for p in pos.values()) + max(p[1] for p in pos.values())) / 2
        pos = {n: (x - cx, y - cy) for n, (x, y) in pos.items()}
    radius = max((math.hypot(x, y) for x, y in pos.values()), default=1.0) or 1.0

    isolates = sorted(n for n in G if G.degree(n) == 0)
    for i, n in enumerate(isolates):
        a = -math.pi / 2 + 2 * math.pi * i / max(1, len(isolates))
        pos[n] = (radius * 1.06 * math.cos(a), radius * 1.06 * math.sin(a))

    xs = [p[0] for p in pos.values()] or [0.0]
    span = (max(xs) - min(xs)) or 1.0
    s = cfg.get("width", 2400) / span
    return {n: (round(x * s, 1), round(y * s, 1)) for n, (x, y) in pos.items()}


def hub_of(G: nx.Graph, members: Iterable[str], names: dict[str, str]) -> str:
    """The most connected member: the default name of a cluster."""
    return min(members, key=lambda n: (-G.degree(n), names[n]))
