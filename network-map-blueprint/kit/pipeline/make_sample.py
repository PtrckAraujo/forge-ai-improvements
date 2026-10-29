"""Generate a fully synthetic sample project for the network-map kit.

Every account, name, metric, caption and avatar produced here is invented.
The generator is seeded, so running it twice gives byte-identical files.

    python make_sample.py ../sample
"""
from __future__ import annotations

import csv
import json
import random
import sys
from datetime import date, timedelta
from pathlib import Path

SEED = 20261029

SYLLABLES = ["ar", "be", "ca", "do", "el", "fi", "ga", "ho", "il", "ju", "ka", "lo",
             "ma", "ne", "or", "pa", "qui", "ra", "so", "ti", "ul", "ve", "wa", "xe",
             "yo", "za", "mir", "tan", "vel", "dor", "sen", "lia", "ron", "bel"]
WORDS = ["civic", "voice", "daily", "forum", "agora", "pulse", "lens", "square",
         "signal", "compass", "ledger", "bridge", "harbor", "beacon", "atlas",
         "chronicle", "dispatch", "plaza", "radar", "commons"]

CATEGORIES = ["politician", "party", "journalist", "traditional_media",
              "new_media", "creator", "other"]
CATEGORY_WEIGHTS = [0.40, 0.04, 0.08, 0.05, 0.15, 0.16, 0.12]

# (group id, number of communities, typical community size)
GROUP_PLAN = [("far_left", 1, 22), ("left", 1, 28), ("centre_left", 3, 30),
              ("centre", 2, 20), ("centre_right", 2, 16), ("right", 3, 26),
              ("far_right", 1, 12), ("independent", 3, 22)]

TOPIC_SNIPPETS = {
    "politics": ["the government announced", "the party congress", "the new election law",
                 "a vote in parliament", "the minister said", "coalition talks"],
    "economy": ["wages and jobs", "the budget deficit", "energy prices", "small businesses"],
    "foreign": ["the summit abroad", "the war in the east", "a new trade deal"],
    "justice": ["the court ruling", "a judiciary reform", "the prosecutor's office"],
    "climate": ["the heatwave", "a new solar plant", "emission targets"],
    "health": ["hospital waiting lists", "the vaccine campaign", "public health funding"],
    "tech": ["an AI regulation", "data privacy", "the new phone app"],
    "culture": ["a film festival", "the football final", "a music award"],
    "history": ["in 1936 the propaganda of the regime", "the 1848 uprisings",
                "memories of the 1945 liberation"],
}
NEUTRAL = ["Here is our summary of", "Read our explainer on", "Live tonight: a debate on",
           "Three numbers to understand", "Our interview about", "What we know about"]
HEATED_STRONG = ["shame on you", "clowns", "disgusting", "traitors", "pathetic liars"]
HEATED_WEAK = ["regime", "propaganda", "censorship", "take to the streets", "sign now",
               "wake up"]
TARGETS = ["the government", "the opposition", "the press", "the judges", "brussels",
           "big banks", "the prime minister", "the opposition leader"]


def handle(rng: random.Random, used: set[str]) -> str:
    while True:
        style = rng.random()
        if style < 0.45:
            h = "".join(rng.choice(SYLLABLES) for _ in range(rng.randint(2, 3)))
            h += rng.choice(["", "_", "."]) + rng.choice(SYLLABLES + WORDS)
        elif style < 0.8:
            h = rng.choice(WORDS) + rng.choice([".", "_", ""]) + rng.choice(WORDS)
        else:
            h = "the" + rng.choice(["", "_"]) + rng.choice(WORDS) + rng.choice(["", "_news", "_hq", "pod"])
        if h not in used and 4 <= len(h) <= 24:
            used.add(h)
            return h


def display_name(h: str) -> str:
    parts = [p for p in h.replace(".", " ").replace("_", " ").split() if p]
    return " ".join(p.capitalize() for p in parts)


def build(out: Path) -> None:
    rng = random.Random(SEED)
    out.mkdir(parents=True, exist_ok=True)
    used: set[str] = set()

    accounts: list[dict] = []
    communities: list[tuple[str, list[str]]] = []

    def new_account(category: str | None = None) -> str:
        h = handle(rng, used)
        cat = category or rng.choices(CATEGORIES, CATEGORY_WEIGHTS)[0]
        accounts.append({"id": h, "name": h,
                         "display_name": display_name(h) if rng.random() < 0.45 else "",
                         "category": cat})
        return h

    for group, count, size in GROUP_PLAN:
        for _ in range(count):
            n = max(6, int(rng.gauss(size, size * 0.25)))
            hub_cat = "party" if group != "independent" else rng.choice(["new_media", "creator"])
            members = [new_account(hub_cat)] + [new_account() for _ in range(n - 1)]
            communities.append((group, members))

    edges: set[tuple[str, str]] = set()

    def link(a: str, b: str) -> None:
        if a != b:
            edges.add((a, b) if a < b else (b, a))

    for _, members in communities:
        hub = members[0]
        for m in members[1:]:
            if rng.random() < 0.7:
                link(hub, m)
        # preferential attachment inside the community
        weights = [len(members) - i for i in range(len(members))]
        for _ in range(int(len(members) * 1.3)):
            a, b = rng.choices(members, weights, k=2)
            link(a, b)

    # bridges: accounts that collaborate across communities, more often nearby on the arc
    for _ in range(70):
        i = rng.randrange(len(communities))
        j = min(len(communities) - 1, max(0, i + rng.choice([-2, -1, 1, 1, 2, 5])))
        a = rng.choice(communities[i][1][:8])
        b = rng.choice(communities[j][1])
        link(a, b)

    # a few creators that work with everybody
    for _ in range(4):
        star = new_account("creator")
        for _ in range(rng.randint(6, 12)):
            link(star, rng.choice(rng.choice(communities)[1]))

    # pendant chains: removing their anchor detaches them (articulation points)
    for _ in range(10):
        anchor = rng.choice(rng.choice(communities)[1])
        prev = anchor
        for _ in range(rng.randint(1, 3)):
            leaf = new_account()
            link(prev, leaf)
            prev = leaf

    # isolated accounts: mapped, but no observed collaborations
    for _ in range(14):
        new_account()

    start = date(2026, 1, 1)
    with open(out / "accounts.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, ["id", "name", "display_name", "category"])
        w.writeheader()
        w.writerows(accounts)

    with open(out / "collaborations.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["source", "target", "date", "evidence_url"])
        for k, (a, b) in enumerate(sorted(edges)):
            d = start + timedelta(days=rng.randrange(270))
            w.writerow([a, b, d.isoformat(), f"https://example.org/evidence/{k:05d}"])

    with open(out / "metrics.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "followers", "interactions", "follower_growth"])
        for a in accounts:
            if rng.random() < 0.1:
                w.writerow([a["id"], "", "", ""])        # not measured: n/r, not zero
                continue
            fol = int(rng.lognormvariate(10.2, 1.6))
            itr = 0 if rng.random() < 0.02 else int(fol * rng.lognormvariate(1.2, 1.1))
            gro = "" if rng.random() < 0.5 else f"{rng.gauss(0.08, 0.15):.4f}"
            w.writerow([a["id"], fol, itr, gro])

    # editorial cluster naming: anchor = any member of the cluster to name
    labels = ["Red Forum", "Left Alliance", "Progressive Party", "Civic List", "Green Wave",
              "Liberal Centre", "Reform Bloc", "Popular Union", "Moderates",
              "National Front", "Patriots", "Heritage League", "Identity Network",
              "Indie Media", "Podcast Circle", "Satire Desk"]
    with open(out / "groups.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["anchor", "label", "group"])
        for (group, members), label in zip(communities, labels):
            w.writerow([members[0], label, group])

    overrides = {
        "_comment": "Editorial corrections. Each one is disclosed in the methodology output.",
        "merge": [{"into": communities[10][1][0], "from": communities[11][1][0],
                   "reason": "Same movement; the two pages split in March."}],
        "move": [{"id": communities[6][1][3], "to": communities[7][1][0],
                  "reason": "Spokesperson of the party, collaborations are mostly elsewhere."}],
    }
    (out / "overrides.json").write_text(json.dumps(overrides, indent=2) + "\n", encoding="utf-8")

    write_posts(out, rng, communities)
    write_avatars(out, rng, accounts)


def write_posts(out: Path, rng: random.Random, communities) -> None:
    """Synthetic captions for the Compass: a mix of calm, heated and history posts."""
    rows = []
    picks = []
    for group, members in communities:
        picks += rng.sample(members[:10], k=min(3, len(members)))
    temper = {a: rng.choice([0.0, 0.0, 0.01, 0.03, 0.05, 0.08, 0.15, 0.3]) for a in picks}
    for a in picks:
        n = rng.randint(12, 130)
        for _ in range(n):
            month = rng.randint(3, 9)
            day = rng.randint(1, 28)
            topic = rng.choice(list(TOPIC_SNIPPETS))
            text = f"{rng.choice(NEUTRAL)} {rng.choice(TOPIC_SNIPPETS[topic])}."
            if rng.random() < 0.35:
                text += f" Also: {rng.choice(TOPIC_SNIPPETS[rng.choice(list(TOPIC_SNIPPETS))])}."
            if rng.random() < temper[a]:
                text += " " + rng.choice(HEATED_STRONG).capitalize() + ","
                if rng.random() < 0.6:
                    text += f" {rng.choice(TARGETS)}"
                if rng.random() < 0.5:
                    text += f", {rng.choice(HEATED_WEAK)}"
                text += "!!!" if rng.random() < 0.4 else "."
            elif rng.random() < 0.08:
                text += f" Pure {rng.choice(HEATED_WEAK)}."     # a single weak word: not heated
            if rng.random() < 0.05:
                text = ""                                        # image-only post
            rows.append([a, f"2026-{month:02d}-{day:02d}", text])
    rows.sort()
    with open(out / "posts.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["account", "date", "caption"])
        w.writerows(rows)


def write_avatars(out: Path, rng: random.Random, accounts: list[dict]) -> None:
    """Abstract placeholder avatars (initials on a colour field) for ~85% of accounts."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("Pillow not installed: skipping sample avatars")
        return
    photos = out / "photos"
    photos.mkdir(exist_ok=True)
    for a in accounts:
        if rng.random() < 0.15:
            continue
        hue = rng.randrange(360)
        img = Image.new("RGB", (160, 160), f"hsl({hue}, 45%, 62%)")
        d = ImageDraw.Draw(img)
        d.rectangle([24, 24, 136, 136], outline=f"hsl({hue}, 45%, 35%)", width=6)
        d.text((80, 80), a["id"][:2].upper(), fill="white", anchor="mm", font_size=64)
        img.save(photos / f"{a['id']}.png", optimize=True)


if __name__ == "__main__":
    build(Path(sys.argv[1] if len(sys.argv) > 1 else "../sample"))
