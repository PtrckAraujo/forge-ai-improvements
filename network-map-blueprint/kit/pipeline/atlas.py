"""Pack profile pictures into one content-hashed WebP sprite sheet.

One file instead of hundreds of requests, cacheable forever (the name changes
when the pixels change), and the visitor's browser never contacts the social
platform. Tile k sits at column k % cols, row k // cols.
"""
from __future__ import annotations

import hashlib
import io
import math
from pathlib import Path

EXTS = (".webp", ".png", ".jpg", ".jpeg")


def build_atlas(photo_dir: Path, ids: list[str], out_dir: Path, tile: int = 96,
                quality: int = 82) -> tuple[dict | None, dict[str, int]]:
    """Returns (faces metadata or None, {account id: tile index})."""
    if not photo_dir or not photo_dir.is_dir():
        return None, {}
    from PIL import Image, ImageOps

    found = []
    for i in ids:
        for ext in EXTS:
            p = photo_dir / f"{i}{ext}"
            if p.exists():
                found.append((i, p))
                break
    if not found:
        return None, {}

    cols = math.ceil(math.sqrt(len(found)))
    rows = math.ceil(len(found) / cols)
    sheet = Image.new("RGB", (cols * tile, rows * tile), (200, 196, 190))
    index = {}
    for k, (account, path) in enumerate(found):
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im = ImageOps.fit(im, (tile, tile), Image.Resampling.LANCZOS, centering=(0.5, 0.4))
            sheet.paste(im, ((k % cols) * tile, (k // cols) * tile))
        index[account] = k

    buf = io.BytesIO()
    sheet.save(buf, "WEBP", quality=quality, method=6)
    data = buf.getvalue()
    name = f"faces-{hashlib.sha256(data).hexdigest()[:8]}.webp"
    img_dir = out_dir / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    for old in img_dir.glob("faces-*.webp"):
        old.unlink()
    (img_dir / name).write_bytes(data)
    return {"file": name, "tile": tile, "cols": cols, "rows": rows, "n": len(found)}, index
