"""Shared render settings.

`RenderSettings` is the single schema describing "how should this frame become ASCII".
The browser sends exactly the same field set it feeds its own shader, which is what keeps
the live preview and the exported video looking identical.

The luminance/adjustment math in `adjust_luma` is the canonical definition; the GLSL in
`web/js/gl/renderer.js` and the CPU path in `web/js/sample.js` mirror it. If you change the
math here, change it in both of those.
"""

from __future__ import annotations

from typing import Literal

import numpy as np
from pydantic import BaseModel, Field

# Rec. 709 luma weights, matching the browser.
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

ColorMode = Literal["color", "grayscale", "mono"]
ExportFormat = Literal["mp4", "webm", "gif"]
DitherMode = Literal["none", "bayer", "floyd", "atkinson"]
FxMode = Literal["none", "noise"]

# The canonical 8x8 ordered-dither matrix, spelled out rather than derived so that the
# numpy, JS and GLSL copies cannot disagree about the construction.
BAYER8 = np.array([
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
], dtype=np.float64) / 64.0


def hex_to_rgb(value: str) -> np.ndarray:
    """'#0d1117' -> float32 array in 0..1."""
    v = value.lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    return np.array([int(v[i : i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float32)


class RenderSettings(BaseModel):
    # Grid. The client sends both dimensions so the server never has to re-derive rows
    # from font metrics and risk landing on a different number.
    cols: int = Field(120, ge=8, le=600)
    rows: int = Field(60, ge=4, le=600)

    # Glyphs. `charset` is ordered dark -> light.
    charset: str = Field(" .:-=+*#%@", min_length=1, max_length=256)
    invert: bool = False
    font: str = "dejavu"
    cell_height: int = Field(16, ge=4, le=128)

    # Color.
    color_mode: ColorMode = "color"
    ink: str = "#e6edf3"
    bg: str = "#0d1117"

    # Adjustments.
    brightness: float = Field(0.0, ge=-1.0, le=1.0)
    contrast: float = Field(1.0, ge=0.0, le=3.0)
    gamma: float = Field(1.0, ge=0.1, le=3.0)
    saturation: float = Field(1.0, ge=0.0, le=2.0)

    # Dithering.
    dither: DitherMode = "none"
    dither_strength: float = Field(0.8, ge=0.0, le=1.5)

    # The noise field.
    fx: FxMode = "none"
    fx_strength: float = Field(0.35, ge=0.0, le=1.0)
    noise_scale: float = Field(24.0, ge=2.0, le=120.0)
    noise_speed: float = Field(0.35, ge=0.0, le=3.0)
    fx_dir_x: float = Field(0.0, ge=-1.0, le=1.0)
    fx_dir_y: float = Field(-1.0, ge=-1.0, le=1.0)


class ExportRequest(BaseModel):
    media_id: str
    settings: RenderSettings
    format: ExportFormat = "mp4"
    fps: float = Field(24.0, gt=0, le=60)
    start: float = Field(0.0, ge=0)
    end: float | None = None


def adjust(cells: np.ndarray, s: RenderSettings) -> tuple[np.ndarray, np.ndarray]:
    """Apply the image adjustments to a (rows, cols, 3) float32 array in 0..1.

    Returns `(rgb, luma)` where `luma` already has gamma and inversion applied and is what
    selects the glyph.
    """
    rgb = cells.astype(np.float32, copy=False)

    gray = rgb @ LUMA
    rgb = gray[..., None] + (rgb - gray[..., None]) * s.saturation
    rgb = (rgb - 0.5) * s.contrast + 0.5 + s.brightness
    np.clip(rgb, 0.0, 1.0, out=rgb)

    luma = np.power(rgb @ LUMA, s.gamma, dtype=np.float32)
    if s.invert:
        luma = 1.0 - luma
    return rgb, luma


def glyph_indices(luma: np.ndarray, ramp_len: int) -> np.ndarray:
    """Map 0..1 luminance onto glyph indices, matching the shader's clamped floor."""
    idx = (luma * ramp_len).astype(np.int32)
    return np.clip(idx, 0, ramp_len - 1)


# --------------------------------------------------------------------------- noise field


def hash2(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Integer hash to 0..1, bit-for-bit identical to the JS and GLSL versions.

    The usual `fract(sin(...))` hash differs between GPU vendors and between GPU and CPU,
    which would let the preview and the export drift apart. This is exact 32-bit
    arithmetic, and only the top 24 bits become a float so a shader's 32-bit floats can
    represent the result exactly.
    """
    with np.errstate(over="ignore"):
        # The xor with the golden-ratio constant stops the origin hashing to a flat zero.
        h = (
            (x.astype(np.int32).astype(np.uint32) * np.uint32(0x27D4EB2D))
            ^ (y.astype(np.int32).astype(np.uint32) * np.uint32(0x165667B1))
        ) ^ np.uint32(0x9E3779B9)
        h = (h ^ (h >> np.uint32(15))) * np.uint32(0x2545F491)
        h = h ^ (h >> np.uint32(13))
    return (h >> np.uint32(8)).astype(np.float64) / 16777216.0


def value_noise(px: np.ndarray, py: np.ndarray) -> np.ndarray:
    ix = np.floor(px)
    iy = np.floor(py)
    fx = px - ix
    fy = py - iy
    u = fx * fx * (3.0 - 2.0 * fx)
    v = fy * fy * (3.0 - 2.0 * fy)
    xi = ix.astype(np.int64)
    yi = iy.astype(np.int64)
    a = hash2(xi, yi)
    b = hash2(xi + 1, yi)
    c = hash2(xi, yi + 1)
    d = hash2(xi + 1, yi + 1)
    top = a + (b - a) * u
    return top + ((c + (d - c) * u) - top) * v


def fbm(px: np.ndarray, py: np.ndarray) -> np.ndarray:
    """Three octaves of value noise, normalised to 0..1."""
    total = np.zeros_like(px)
    amp = 0.5
    norm = 0.0
    fx, fy = px, py
    for _ in range(3):
        total += amp * value_noise(fx, fy)
        norm += amp
        amp *= 0.5
        fx = fx * 2.0
        fy = fy * 2.0
    return total / norm


def noise_offset(cols: int, rows: int, t: float, s: RenderSettings) -> np.ndarray:
    """Signed luminance offset from the drifting noise field, one value per cell."""
    if s.fx != "noise" or s.fx_strength == 0.0:
        return np.zeros((rows, cols), dtype=np.float64)
    scale = max(1.0, s.noise_scale)
    xs = np.arange(cols, dtype=np.float64)[None, :] / scale - s.fx_dir_x * t * s.noise_speed
    ys = np.arange(rows, dtype=np.float64)[:, None] / scale - s.fx_dir_y * t * s.noise_speed
    px, py = np.broadcast_arrays(xs, ys)
    return (fbm(px, py) - 0.5) * s.fx_strength


# ----------------------------------------------------------------------------- dithering


def _error_diffuse(luma: np.ndarray, ramp_len: int, mode: str, strength: float) -> np.ndarray:
    """Floyd-Steinberg / Atkinson error diffusion over the cell grid.

    Sequential by nature — each cell's error lands on cells not yet visited — so unlike
    everything else here it cannot be vectorised or run in the shader. The grid is only a
    few thousand cells, so the scalar loop stays cheap.
    """
    buf = luma.astype(np.float64, copy=True)
    rows, cols = buf.shape
    out = np.zeros((rows, cols), dtype=np.int32)
    atkinson = mode == "atkinson"

    for y in range(rows):
        for x in range(cols):
            old = buf[y, x]
            idx = min(ramp_len - 1, max(0, int(old * ramp_len)))
            out[y, x] = idx
            err = (old - (idx + 0.5) / ramp_len) * strength

            if atkinson:
                e = err / 8.0
                spread = ((1, 0, e), (2, 0, e), (-1, 1, e), (0, 1, e), (1, 1, e), (0, 2, e))
            else:
                spread = ((1, 0, err * 7 / 16), (-1, 1, err * 3 / 16),
                          (0, 1, err * 5 / 16), (1, 1, err / 16))
            for dx, dy, amount in spread:
                nx, ny = x + dx, y + dy
                if 0 <= nx < cols and ny < rows:
                    buf[ny, nx] += amount
    return out


def compute_indices(cells: np.ndarray, s: RenderSettings, t: float = 0.0) -> np.ndarray:
    """Glyph index per cell, with the noise field and dither applied.

    The CPU twin of the shader, and the only implementation for error diffusion.
    `cells` is a (rows, cols, 3) float32 array in 0..1.
    """
    rows, cols = cells.shape[:2]
    ramp_len = len(s.charset)
    _, luma = adjust(cells, s)
    luma = luma.astype(np.float64) + noise_offset(cols, rows, t, s)

    if s.dither in ("floyd", "atkinson"):
        return _error_diffuse(luma, ramp_len, s.dither, s.dither_strength)

    if s.dither == "bayer":
        tile = np.tile(BAYER8, (rows // 8 + 1, cols // 8 + 1))[:rows, :cols]
        luma = luma + (tile - 0.5) * s.dither_strength / ramp_len

    return glyph_indices(luma, ramp_len)
