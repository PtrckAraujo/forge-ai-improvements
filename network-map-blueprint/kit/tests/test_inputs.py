"""Regression tests for input handling and edition outputs.

Each test builds a throw-away copy of the sample project with one thing
changed. Run from the kit directory:  python -m unittest discover tests
"""
from __future__ import annotations

import csv
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KIT / "pipeline"))

import build  # noqa: E402
import graphmetrics as gm  # noqa: E402
from errors import InputError  # noqa: E402


class SampleCopy(unittest.TestCase):
    """A private copy of site/ and sample/, with a fast layout."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        shutil.copytree(KIT / "site", self.tmp / "site")
        shutil.copytree(KIT / "sample", self.tmp / "sample",
                        ignore=shutil.ignore_patterns("out", "photos"))
        self.sample = self.tmp / "sample"
        self.site = self.tmp / "site"
        self.P = json.loads((self.sample / "project.json").read_text())
        self.P["bundle"] = "plain"
        self.P["layout"]["iterations"] = 20

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def build(self) -> dict:
        project = self.sample / "project.json"
        project.write_text(json.dumps(self.P))
        return build.build(project)

    def rows(self, name: str) -> list[list[str]]:
        with open(self.sample / name, newline="", encoding="utf-8") as f:
            return list(csv.reader(f))

    def write(self, name: str, rows: list[list[str]]) -> None:
        with open(self.sample / name, "w", newline="", encoding="utf-8") as f:
            csv.writer(f, lineterminator="\n").writerows(rows)

    def assertInputError(self, *fragments: str) -> str:
        with self.assertRaises(InputError) as cm:
            self.build()
        for frag in fragments:
            self.assertIn(frag, str(cm.exception))
        return str(cm.exception)

    def data_js(self) -> dict:
        text = (self.site / "data.js").read_text(encoding="utf-8")
        return json.loads(text[len("window.MAP_DATA = "):-2])

    def isolate(self) -> str:
        linked = {x for r in self.rows("collaborations.csv")[1:] for x in r[:2]}
        return next(r[0] for r in self.rows("accounts.csv")[1:] if r[0] not in linked)


class CompassLinking(SampleCopy):
    def test_handles_match_accounts_case_insensitively(self):
        rows = self.rows("posts.csv")
        for r in rows[1:]:
            r[0] = "  " + r[0].upper() + " "
        self.write("posts.csv", rows)
        data = self.build()
        profiles = data["compass"]["profiles"]
        self.assertTrue(profiles)
        self.assertTrue(all(p["n"] is not None for p in profiles), "every profile links to its node")
        self.assertEqual(len({p["name"] for p in profiles}), len(profiles), "one profile per account")
        for p in profiles:
            self.assertEqual(data["nodes"][p["n"]]["id"], p["name"])

    def test_months_carry_side_and_unnamed_counts(self):
        cp = self.build()["compass"]
        for p in cp["profiles"]:
            self.assertTrue(all(len(m) == 6 for m in p["months"]))
            col = lambda k: sum(m[k] for m in p["months"])
            self.assertEqual(col(0), p["txt"])
            self.assertEqual(col(1), p["heated"])
            self.assertEqual(col(3), p["gov"])
            self.assertEqual(col(4), p["opp"])
            if p["vague"] is not None:
                self.assertAlmostEqual(col(5) / p["heated"], p["vague"], places=3)

    def test_bad_post_date_is_input_error(self):
        rows = self.rows("posts.csv")
        rows[1][1] = "29/10/2026"
        self.write("posts.csv", rows)
        self.assertInputError("posts.csv", "line 2", "YYYY-MM-DD")


class Overrides(SampleCopy):
    def test_override_into_isolated_account_is_input_error(self):
        o = json.loads((self.sample / "overrides.json").read_text())
        o["move"][0]["to"] = self.isolate()
        (self.sample / "overrides.json").write_text(json.dumps(o))
        self.assertInputError("overrides.json", "has no cluster in this edition", "update or remove")

    def test_override_unknown_account_is_input_error(self):
        o = json.loads((self.sample / "overrides.json").read_text())
        o["merge"][0]["from"] = "no.such.account"
        (self.sample / "overrides.json").write_text(json.dumps(o))
        self.assertInputError("overrides.json", "'no.such.account' is not in accounts.csv")

    def test_override_ids_are_normalised(self):
        o = json.loads((self.sample / "overrides.json").read_text())
        o["move"][0]["id"] = " " + o["move"][0]["id"].upper()
        (self.sample / "overrides.json").write_text(json.dumps(o))
        self.assertEqual(len(self.build()["corrections"]), 2)

    def test_malformed_override_is_input_error(self):
        real = self.rows("accounts.csv")[1][0]
        (self.sample / "overrides.json").write_text(json.dumps({"move": [{"id": real}]}))
        self.assertInputError("overrides.json", "needs a 'to' account")


class Metrics(SampleCopy):
    def test_decimal_count_is_input_error(self):
        rows = self.rows("metrics.csv")
        rows[1][1] = "1234.0"
        self.write("metrics.csv", rows)
        self.assertInputError("metrics.csv line 2, followers", "'1234.0' is not a whole number")

    def test_unknown_account_is_input_error(self):
        rows = self.rows("metrics.csv")
        rows.append(["ghost.account", "10", "10", ""])
        self.write("metrics.csv", rows)
        self.assertInputError("metrics.csv", "'ghost.account'")


class Groups(SampleCopy):
    def test_anchor_typo_is_input_error(self):
        rows = self.rows("groups.csv")
        rows[1][0] += "x"
        self.write("groups.csv", rows)
        self.assertInputError("groups.csv", "line 2", "is not in accounts.csv")

    def test_unknown_group_is_input_error(self):
        rows = self.rows("groups.csv")
        rows[1][2] = "middle"
        self.write("groups.csv", rows)
        self.assertInputError("groups.csv", "line 2", "'middle'")

    def test_first_non_empty_group_wins(self):
        G = gm.build_graph("abcd", [("a", "b"), ("b", "c"), ("c", "a")])
        rows = [{"anchor": "a", "label": "Alpha", "group": "", "line": 2},
                {"anchor": "b", "label": "", "group": "left", "line": 3}]
        clusters = build.name_clusters(G, [{"a", "b", "c"}], {"d"}, rows, {n: n for n in "abcd"})
        self.assertEqual(clusters[0]["group"], "left")
        self.assertEqual(clusters[0]["label"], "Alpha")


class ProjectFile(SampleCopy):
    def test_bad_colour_is_input_error(self):
        self.P["categories"][0]["light"] = "red;background:url(x)"
        self.assertInputError("project.json", "categories.politician", "#RRGGBB")

    def test_missing_title_is_input_error(self):
        del self.P["title"]
        self.assertInputError("project.json", "title: required text")

    def test_named_but_missing_input_is_input_error(self):
        (self.sample / "metrics.csv").unlink()
        self.assertInputError("metrics.csv", "file not found")

    def test_cli_prints_input_error_without_traceback(self):
        rows = self.rows("metrics.csv")
        rows[1][2] = "lots"
        self.write("metrics.csv", rows)
        (self.sample / "project.json").write_text(json.dumps(self.P))
        r = subprocess.run([sys.executable, str(KIT / "pipeline" / "build.py"),
                            str(self.sample / "project.json")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertTrue(r.stderr.startswith("input error: metrics.csv line 2, interactions"), r.stderr)
        self.assertNotIn("Traceback", r.stderr)


class Outputs(SampleCopy):
    def test_json_ld_cannot_be_closed_by_a_value(self):
        self.P["title"] = "Map</script><script>alert(1)</script><!--"
        self.build()
        html = (self.site / "index.html").read_text()
        block = re.search(r'<script type="application/ld\+json">(.*?)</script>', html, re.S).group(1)
        ld = json.loads(block)                       # the whole object, not a truncated one
        self.assertEqual(ld["@graph"][0]["name"], self.P["title"])
        self.assertNotIn("<script>alert", html)

    def test_compass_page_is_rewritten_without_a_compass(self):
        self.P["inputs"]["posts"] = None
        data = self.build()
        self.assertIsNone(data["compass"])
        page = (self.site / "compass.html").read_text()
        self.assertIn('content="This edition has no Media Compass."', page)
        self.assertIn('<meta name="robots" content="noindex">', page)
        index = (self.site / "index.html").read_text()
        v = re.search(r'data\.js\?v=([0-9a-f]+)', index).group(1)
        self.assertIn(f"data.js?v={v}", page)
        self.assertNotIn("compass", (self.site / "sitemap.xml").read_text())

    def test_stale_atlas_is_removed_when_photos_are_dropped(self):
        stale = self.site / "img" / "faces-deadbeef.webp"
        stale.write_bytes(b"old")
        data = self.build()                          # the copy has no photos directory
        self.assertIsNone(data["faces"])
        self.assertEqual(list((self.site / "img").glob("faces-*.webp")), [])

    def test_photo_file_names_match_case_insensitively(self):
        from PIL import Image
        (self.sample / "photos").mkdir()
        first = self.rows("accounts.csv")[1][0]
        Image.new("RGB", (40, 40), "teal").save(self.sample / "photos" / (first.upper() + ".PNG"))
        data = self.build()
        self.assertEqual(data["faces"]["n"], 1)
        self.assertEqual(next(n for n in data["nodes"] if n["id"] == first)["p"], 0)


class SampleFiles(unittest.TestCase):
    def test_generator_writes_lf_line_endings(self):
        import make_sample
        tmp = Path(tempfile.mkdtemp())
        try:
            make_sample.build(tmp)
            for path in tmp.glob("*.csv"):
                self.assertNotIn(b"\r\n", path.read_bytes(), path.name)
            for path in (KIT / "sample").glob("*.csv"):      # and the committed copy
                self.assertEqual((tmp / path.name).read_bytes(), path.read_bytes(), path.name)
        finally:
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
