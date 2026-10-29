"""Media Compass: keyword scoring of post captions.

A deliberately simple, explainable method that any reader can audit:

* a post is *heated* when its caption scores >= `heated_at` points: each strong
  term found is worth 2, each weak term 1, a burst of exclamation marks 1, and
  every term counts once per post however often it is repeated;
* in history posts the "system" words (regime, propaganda…) do not count:
  there they describe, they do not attack;
* a profile's tone comes from its heated share: informative below
  `informative`, militant from `militant` up, mixed in between.

It misreads irony and quotes. Publish that next to the chart: it is a way to
compare profiles, not to judge a single post.
"""
from __future__ import annotations

import csv
import re
from collections import defaultdict
from pathlib import Path

from errors import InputError

DEFAULT_THRESHOLDS = {
    "heated_at": 2,
    "informative": 0.02,
    "militant": 0.10,
    "min_posts": 20,        # fewer posts with text: the profile is left out
    "min_heated": 8,        # below this, "unnamed enemy" is n.d.
    "min_sides": 5,         # below this, "against whom" is n.d.
    "min_month": 8,         # below this, the profile goes dark in that month
    "min_month_total": 50,  # months with fewer posts overall get no timeline bar
}


MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])")


def _matcher(terms: list[str]) -> list[tuple[str, re.Pattern]]:
    return [(t, re.compile(r"(?<!\w)" + re.escape(t.lower()) + r"(?!\w)")) for t in terms]


class Lexicon:
    def __init__(self, spec: dict):
        try:
            self.strong = _matcher(spec["heated"]["strong"])
            self.weak = _matcher(spec["heated"]["weak"])
            self.system = {t.lower() for t in spec.get("system_terms", [])}
            self.history = [re.compile(p, re.I) for p in spec.get("history_guard", [])]
            self.burst = re.compile(r"!{%d,}" % int(spec.get("exclamation_burst", 3)))
            self.topics = [(name, _matcher(words)) for name, words in spec["topics"].items()]
            self.targets = [(name, _matcher(words)) for name, words in spec["targets"].items()]
            self.sides = {side: _matcher(spec["sides"][side]) for side in ("gov", "opp")}
        except KeyError as e:
            raise InputError(f"lexicon.json: missing key {e}") from None
        except re.error as e:
            raise InputError(f"lexicon.json: history_guard pattern {e.pattern!r} is not a valid "
                             f"regular expression ({e})") from None
        names = [n for n, _ in self.topics]
        if spec.get("politics_topic") not in names:
            raise InputError(f"lexicon.json: politics_topic {spec.get('politics_topic')!r} must be "
                             f"one of the topics {names}")
        self.politics_topic = names.index(spec["politics_topic"])

    def score(self, text: str) -> dict:
        low = text.lower()
        history = any(p.search(low) for p in self.history)
        pts = 0
        for weight, terms in ((2, self.strong), (1, self.weak)):
            for term, rx in terms:
                if history and term.lower() in self.system:
                    continue
                if rx.search(low):
                    pts += weight
        if self.burst.search(text):
            pts += 1
        hits = lambda ms: any(rx.search(low) for _, rx in ms)
        return {
            "points": pts,
            "topics": [i for i, (_, ms) in enumerate(self.topics) if hits(ms)],
            "targets": [i for i, (_, ms) in enumerate(self.targets) if hits(ms)],
            "sides": [s for s, ms in self.sides.items() if hits(ms)],
        }


def compute(posts_csv: Path, lexicon: Lexicon, node_index: dict[str, int],
            thresholds: dict | None = None) -> dict | None:
    T = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    by_account: dict[str, list[tuple[str, str]]] = defaultdict(list)
    errors = []
    with open(posts_csv, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        missing = {"account", "date", "caption"} - set(reader.fieldnames or [])
        if missing:
            raise InputError(f"{posts_csv.name}: missing column(s) {sorted(missing)}")
        for line, row in enumerate(reader, start=2):
            # same normalisation as accounts.csv, so the profile links to its map node
            account = (row["account"] or "").strip().lower()
            date = (row["date"] or "").strip()
            if not account or not MONTH_RE.match(date):
                errors.append(f"line {line}: need an account and a YYYY-MM-DD date, got "
                              f"{row['account']!r}, {row['date']!r}")
                continue
            by_account[account].append((date[:7], row["caption"] or ""))
    if errors:
        raise InputError(f"{posts_csv.name}:\n  " + "\n  ".join(errors[:30]))
    if not by_account:
        return None

    months = sorted({m for posts in by_account.values() for m, _ in posts})
    mi = {m: i for i, m in enumerate(months)}
    nt, ng = len(lexicon.topics), len(lexicon.targets)
    profiles = []
    total_posts = 0

    for account in sorted(by_account):
        posts = by_account[account]
        texts = [(m, t) for m, t in posts if t.strip()]
        if len(texts) < T["min_posts"]:
            continue
        total_posts += len(texts)
        topics, topics_heated = [0] * nt, [0] * nt
        targets, targets_heated = [0] * ng, [0] * ng
        # per month: posts with text, heated, political, heated at gov, at opp, unnamed
        per_month = [[0, 0, 0, 0, 0, 0] for _ in months]
        heated = gov = opp = unnamed = 0

        for month, text in texts:
            s = lexicon.score(text)
            hot = s["points"] >= T["heated_at"]
            political = lexicon.politics_topic in s["topics"]
            m = per_month[mi[month]]
            m[0] += 1
            m[1] += hot
            m[2] += political
            for k in s["topics"]:
                topics[k] += 1
                topics_heated[k] += hot
            for k in s["targets"]:
                targets[k] += 1
                targets_heated[k] += hot
            if hot:
                heated += 1
                unnamed += not s["targets"]
                m[5] += not s["targets"]
                if s["sides"] == ["gov"]:       # posts naming both sides count for neither
                    gov += 1
                    m[3] += 1
                elif s["sides"] == ["opp"]:
                    opp += 1
                    m[4] += 1

        acc = heated / len(texts)
        tone = ("informative" if acc < T["informative"]
                else "militant" if acc >= T["militant"] else "mixed")
        profiles.append({
            "n": node_index.get(account),
            "name": account,
            "posts": len(posts),
            "txt": len(texts),
            "heated": heated,
            "acc": round(acc, 4),
            "pol": round(topics[lexicon.politics_topic] / len(texts), 4),
            "tone": tone,
            "vague": round(unnamed / heated, 4) if heated >= T["min_heated"] else None,
            "side": round(gov / (gov + opp), 4) if gov + opp >= T["min_sides"] else None,
            "gov": gov, "opp": opp,
            "topics": topics, "topics_heated": topics_heated,
            "targets": targets, "targets_heated": targets_heated,
            "months": per_month,
        })

    if not profiles:
        return None
    month_totals = [sum(p["months"][i][0] for p in profiles) for i in range(len(months))]
    return {
        "months": months,
        "months_shown": [i for i, n in enumerate(month_totals) if n >= T["min_month_total"]],
        "topics": [n for n, _ in lexicon.topics],
        "politics_topic": lexicon.politics_topic,
        "targets": [n for n, _ in lexicon.targets],
        "thresholds": T,
        "total_posts": total_posts,
        "tones": {t: sum(p["tone"] == t for p in profiles)
                  for t in ("informative", "mixed", "militant")},
        "profiles": profiles,
    }
