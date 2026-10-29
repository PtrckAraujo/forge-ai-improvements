# Network map blueprint

How [ecosistemapolitico.it](https://ecosistemapolitico.it/) works, and a kit to build the same
kind of site for another country, platform or topic.

- **[BLUEPRINT.md](BLUEPRINT.md)** is the reverse-engineering report: architecture, hosting,
  data pipeline, data model, rendering rules, UI, Media Compass method, design system, SEO,
  quirks, rights and privacy, and what is still unknown.
- **[kit/](kit/README.md)** is a clean-room starter. A Python pipeline (Louvain, betweenness,
  articulation "cut" counts, force layout, photo atlas, keyword tone scoring, an optional
  obfuscated bundle, SEO files) feeds a dependency-free static site (a Canvas 2D map and an SVG
  Compass). It ships with a synthetic sample and tests.

The blueprint is based on browser captures of the public site taken on 2026-10-29. Those
captures are not stored here, and nothing from the original site is reused here: no code, no
data, no photos, no logos. The kit is original code that follows the documented ideas.
