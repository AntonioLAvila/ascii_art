"""Glyph atlas rasterisation for the server-side renderer.

Produces an `(n_glyphs, cell_h, cell_w)` float32 coverage array — 0 where the cell is bare,
1 where the glyph fully covers the pixel. `ascii_core` then indexes straight into it, which
turns "draw ten thousand characters" into one numpy gather.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import fonts

# Rasterise the probe at a large size so the derived metrics are not quantised.
_PROBE_SIZE = 200


class GlyphAtlas:
    def __init__(self, coverage: np.ndarray, charset: str):
        self.coverage = coverage  # (n, cell_h, cell_w) float32
        self.charset = charset

    @property
    def cell_h(self) -> int:
        return self.coverage.shape[1]

    @property
    def cell_w(self) -> int:
        return self.coverage.shape[2]


@lru_cache(maxsize=32)
def build(font_key: str, charset: str, cell_height: int) -> GlyphAtlas:
    font_path = str(fonts.get(font_key).path)

    probe = ImageFont.truetype(font_path, _PROBE_SIZE)
    ascent, descent = probe.getmetrics()
    advance = probe.getlength("M") or _PROBE_SIZE * 0.6

    # Scale the point size so ascent+descent lands on the requested cell height, then take
    # the cell width from the font's own advance so the aspect ratio is the font's, not ours.
    size = max(4, round(_PROBE_SIZE * cell_height / (ascent + descent)))
    font = ImageFont.truetype(font_path, size)
    f_ascent, _ = font.getmetrics()
    cell_w = max(1, round(advance * size / _PROBE_SIZE))

    coverage = np.zeros((len(charset), cell_height, cell_w), dtype=np.float32)
    for i, ch in enumerate(charset):
        img = Image.new("L", (cell_w, cell_height), 0)
        ImageDraw.Draw(img).text((0, f_ascent), ch, fill=255, font=font, anchor="ls")
        coverage[i] = np.asarray(img, dtype=np.float32) / 255.0
    return GlyphAtlas(coverage, charset)
