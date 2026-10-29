"""Pipeline tests. Run from the kit directory:  python -m unittest discover tests"""
from __future__ import annotations

import base64
import gzip
import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KIT / "pipeline"))

import graphmetrics as gm  # noqa: E402
from compass import Lexicon  # noqa: E402
from publish import read_pepper, write_bundle  # noqa: E402


class GraphMetrics(unittest.TestCase):
    def test_cut_counts_articulation_points(self):
        # a - b - c - d, and b - e: removing b leaves {a}, {e}, {c, d}
        G = gm.build_graph("abcde", [("a", "b"), ("b", "c"), ("c", "d"), ("b", "e")])
        cut = gm.cut_counts(G)
        self.assertEqual(cut["b"], 2)        # a and e are cut off from the larger piece
        self.assertEqual(cut["c"], 1)        # d is cut off
        self.assertEqual(cut["a"], 0)

    def test_cut_counts_cycle_has_none(self):
        G = gm.build_graph("abcd", [("a", "b"), ("b", "c"), ("c", "d"), ("d", "a")])
        self.assertEqual(set(gm.cut_counts(G).values()), {0})

    def test_communities_and_misc_bucket(self):
        k1 = [(a, b) for a in "abcde" for b in "abcde" if a < b]
        k2 = [(a, b) for a in "vwxyz" for b in "vwxyz" if a < b]
        G = gm.build_graph("abcdevwxyzq", k1 + k2 + [("a", "v")])   # q is isolated
        comms, misc = gm.detect_communities(G, resolution=1.0, seed=1)
        self.assertEqual(sorted(sorted(c) for c in comms), [list("abcde"), list("vwxyz")])
        self.assertEqual(misc, {"q"})

    def test_overrides_merge_and_move(self):
        comms = [{"a", "b"}, {"c", "d"}, {"e", "f"}]
        misc = {"q"}
        out, disclosed = gm.apply_overrides(
            comms, misc, {"merge": [{"into": "a", "from": "c"}], "move": [{"id": "q", "to": "e"}]},
            known=set("abcdefq"))
        self.assertIn({"a", "b", "c", "d"}, out)
        self.assertIn({"e", "f", "q"}, out)
        self.assertNotIn("q", misc)
        self.assertEqual([d["type"] for d in disclosed], ["merge", "move"])

    def test_override_unknown_account_fails(self):
        with self.assertRaises(ValueError):
            gm.apply_overrides([{"a"}], set(), {"move": [{"id": "zz", "to": "a"}]}, {"a"})

    def test_layout_is_deterministic_and_scaled(self):
        G = gm.build_graph("abcdefg", [("a", "b"), ("b", "c"), ("c", "a"), ("d", "e")])
        cfg = {"seed": 3, "iterations": 50, "width": 1000}
        p1, p2 = gm.layout(G, cfg), gm.layout(G, cfg)
        self.assertEqual(p1, p2)
        xs = [x for x, _ in p1.values()]
        self.assertAlmostEqual(max(xs) - min(xs), 1000, delta=0.5)
        self.assertEqual(set(p1), set("abcdefg"))        # isolates f, g are placed too


class CompassScoring(unittest.TestCase):
    LEX = Lexicon({
        "heated": {"strong": ["shame on you"], "weak": ["regime", "propaganda", "wake up"]},
        "system_terms": ["regime", "propaganda"],
        "history_guard": [r"\b1[0-9]{3}\b"],
        "exclamation_burst": 3,
        "topics": {"Politics": ["government"], "Health": ["hospital"]},
        "politics_topic": "Politics",
        "targets": {"Government": ["the government"]},
        "sides": {"gov": ["the government"], "opp": ["the opposition"]},
    })

    def test_strong_term_alone_is_heated(self):
        self.assertEqual(self.LEX.score("Shame on you, minister.")["points"], 2)

    def test_single_weak_term_is_not_heated(self):
        self.assertEqual(self.LEX.score("A report on propaganda.")["points"], 1)

    def test_terms_count_once(self):
        self.assertEqual(self.LEX.score("wake up wake up wake up")["points"], 1)

    def test_history_guard_mutes_system_words(self):
        self.assertEqual(self.LEX.score("In 1936 the regime used propaganda.")["points"], 0)
        self.assertEqual(self.LEX.score("Today the regime uses propaganda.")["points"], 2)

    def test_exclamation_burst(self):
        self.assertEqual(self.LEX.score("wake up!!!")["points"], 2)

    def test_word_boundaries(self):
        self.assertEqual(self.LEX.score("regimented schedules")["points"], 0)

    def test_topics_targets_sides(self):
        s = self.LEX.score("The government closed a hospital")
        self.assertEqual(s["topics"], [0, 1])
        self.assertEqual(s["targets"], [0])
        self.assertEqual(s["sides"], ["gov"])


class Bundle(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "js").mkdir()
        (self.tmp / "js" / "core.js").write_text("const PEPPER = 'unit-test-pepper';\n")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_plain_round_trip(self):
        write_bundle({"x": [1, "è"]}, self.tmp, "plain")
        text = (self.tmp / "data.js").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("window.MAP_DATA = "))
        self.assertEqual(json.loads(text[len("window.MAP_DATA = "):-2]), {"x": [1, "è"]})

    def test_obfuscated_round_trip_matches_browser_scheme(self):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        write_bundle({"nodes": [1, 2, 3]}, self.tmp, "obfuscated")
        text = (self.tmp / "data.js").read_text()
        env = json.loads(text[len("window.MAP_DATA_ENC = "):-2])
        b = lambda s: base64.b64decode(s)
        key = hashlib.sha256(read_pepper(self.tmp / "js" / "core.js").encode() + b(env["salt"])).digest()
        raw = gzip.decompress(AESGCM(key).decrypt(b(env["iv"]), b(env["ct"]), None))
        self.assertEqual(json.loads(raw), {"nodes": [1, 2, 3]})


class EndToEnd(unittest.TestCase):
    def test_sample_build(self):
        import build
        tmp = Path(tempfile.mkdtemp())
        try:
            shutil.copytree(KIT / "site", tmp / "site")
            shutil.copytree(KIT / "sample", tmp / "sample", ignore=shutil.ignore_patterns("out"))
            project = tmp / "sample" / "project.json"
            P = json.loads(project.read_text())
            P["bundle"] = "plain"
            project.write_text(json.dumps(P))
            data = build.build(project)

            n = len(data["nodes"])
            self.assertGreater(n, 100)
            self.assertEqual(sum(c["size"] for c in data["clusters"]), n)
            self.assertTrue(all(0 <= a < n and 0 <= b < n for a, b in data["links"]))
            self.assertTrue(all(abs(x["x"]) <= 1200.1 for x in data["nodes"]))
            self.assertEqual(sum(x["deg"] for x in data["nodes"]), 2 * len(data["links"]))
            # n/r survives as null, never as zero
            self.assertTrue(any(x["itr"] is None for x in data["nodes"]))
            self.assertEqual(len(data["corrections"]), 2)
            html = (tmp / "site" / "index.html").read_text()
            self.assertIn('<link rel="canonical" href="https://example.org/">', html)
            self.assertRegex(html, r'src="data\.js\?v=[0-9a-f]{10}"')
            self.assertIn("Editorial corrections", (tmp / "site" / "llms-full.txt").read_text())
        finally:
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
