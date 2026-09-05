"""Server-side ASCII frame renderer.

Mirrors `web/js/gl/renderer.js` so that an exported video matches the live preview. The
glyph blit is a numpy gather rather than a per-character loop: `atlas[idx]` expands a
(rows, cols) index grid straight into (rows, cols, cell_h, cell_w) coverage.
"""

from __future__ import annotations

import numpy as np

from .atlas import GlyphAtlas
from .settings import LUMA, RenderSettings, adjust, glyph_indices, hex_to_rgb

# Rendering the whole frame at once costs rows*cols*cell_h*cell_w*3 floats, which runs to
# tens of megabytes on a large grid. Filling the output one text row at a time keeps the
# working set small and cache-friendly at no measurable cost in speed.


def output_size(settings: RenderSettings, atlas: GlyphAtlas) -> tuple[int, int]:
    """(width, height) in pixels of a rendered frame."""
    return settings.cols * atlas.cell_w, settings.rows * atlas.cell_h


def render(cells: np.ndarray, settings: RenderSettings, atlas: GlyphAtlas) -> np.ndarray:
    """Render one frame.

    `cells` is a (rows, cols, 3) uint8 array of per-cell average colors — the same thing the
    browser gets from drawing the source into a cols x rows canvas.
    """
    rows, cols = settings.rows, settings.cols
    ch, cw = atlas.cell_h, atlas.cell_w

    rgb, luma = adjust(cells.astype(np.float32) / 255.0, settings)
    idx = glyph_indices(luma, len(atlas.charset))

    if settings.color_mode == "color":
        ink = rgb
    elif settings.color_mode == "grayscale":
        # Deliberately not `luma`: that carries gamma and inversion, which belong to glyph
        # selection. Grayscale ink is just the adjusted colour with saturation removed.
        ink = np.repeat((rgb @ LUMA)[..., None], 3, axis=2)
    else:
        ink = np.broadcast_to(hex_to_rgb(settings.ink), (rows, cols, 3))
    bg = hex_to_rgb(settings.bg)

    out = np.empty((rows * ch, cols * cw, 3), dtype=np.uint8)
    for r in range(rows):
        cov = atlas.coverage[idx[r]]                       # (cols, ch, cw)
        band = bg + cov[..., None] * (ink[r][:, None, None, :] - bg)  # (cols, ch, cw, 3)
        # (cols, ch, cw, 3) -> (ch, cols*cw, 3)
        out[r * ch : (r + 1) * ch] = np.rint(
            band.transpose(1, 0, 2, 3).reshape(ch, cols * cw, 3) * 255.0
        ).astype(np.uint8)
    return out


def to_chars(cells: np.ndarray, settings: RenderSettings) -> list[str]:
    """The plain-text form of a frame, used for text exports and for parity checks."""
    _, luma = adjust(cells.astype(np.float32) / 255.0, settings)
    idx = glyph_indices(luma, len(settings.charset))
    ramp = settings.charset
    return ["".join(ramp[i] for i in row) for row in idx]


def ramp_density(atlas: GlyphAtlas) -> np.ndarray:
    """Mean ink coverage of each glyph, for sorting a ramp dark -> light."""
    return atlas.coverage.mean(axis=(1, 2))
