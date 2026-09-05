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
