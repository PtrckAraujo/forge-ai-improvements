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

from errors import InputError

EXTS = (".webp", ".png", ".jpg", ".jpeg")


def build_atlas(photo_dir: Path, ids: list[str], out_dir: Path, tile: int = 96,
                quality: int = 82) -> tuple[dict | None, dict[str, int]]:
    """Returns (faces metadata or None, {account id: tile index}).

    Any atlas from a previous edition is removed first, so an edition without
    photos does not leave an orphaned sheet of faces on the server.
    """
    img_dir = out_dir / "img"
    for old in img_dir.glob("faces-*.webp"):
        old.unlink()
    if not photo_dir or not photo_dir.is_dir():
        return None, {}
    from PIL import Image, ImageOps

    # file names match account ids the way every other input does: case-insensitive
    files = {}
    for p in sorted(photo_dir.iterdir()):
        if p.suffix.lower() in EXTS:
            files.setdefault(p.stem.strip().lower(), p)
    found = [(i, files[i]) for i in ids if i in files]
    if not found:
        return None, {}

    cols = math.ceil(math.sqrt(len(found)))
    rows = math.ceil(len(found) / cols)
    sheet = Image.new("RGB", (cols * tile, rows * tile), (200, 196, 190))
    index = {}
    for k, (account, path) in enumerate(found):
        try:
            with Image.open(path) as im:
                im = ImageOps.exif_transpose(im).convert("RGB")
                im = ImageOps.fit(im, (tile, tile), Image.Resampling.LANCZOS, centering=(0.5, 0.4))
        except OSError as e:
            raise InputError(f"photos/{path.name}: cannot read the image ({e})") from None
        sheet.paste(im, ((k % cols) * tile, (k // cols) * tile))
        index[account] = k

    buf = io.BytesIO()
    sheet.save(buf, "WEBP", quality=quality, method=6)
    data = buf.getvalue()
    name = f"faces-{hashlib.sha256(data).hexdigest()[:8]}.webp"
    img_dir.mkdir(parents=True, exist_ok=True)
    (img_dir / name).write_bytes(data)
    return {"file": name, "tile": tile, "cols": cols, "rows": rows, "n": len(found)}, index
