"""Monospace font discovery.

The browser @font-faces the very same TTF that Pillow rasterises for exports, so a glyph
looks the same in the preview and in the rendered video. Fonts are discovered rather than
vendored: whatever is present on the machine gets offered, and DejaVu Sans Mono ships with
essentially every Linux install so the list is never empty.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

HOME = Path.home()

# (key, label, candidate paths in preference order)
_CANDIDATES: list[tuple[str, str, list[Path]]] = [
    (
        "dejavu",
        "DejaVu Sans Mono",
        [
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
            Path("/usr/share/fonts/TTF/DejaVuSansMono.ttf"),
            HOME / ".local/share/fonts/DejaVuSansMono.ttf",
        ],
    ),
    (
        "jetbrains",
        "JetBrains Mono",
        [
            HOME / ".local/share/fonts/JetBrainsMono/JetBrainsMonoNerdFontMono-Regular.ttf",
            HOME / ".local/share/fonts/JetBrainsMonoNerdFontMono-Regular.ttf",
            Path("/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf"),
        ],
    ),
    (
        "liberation",
        "Liberation Mono",
        [Path("/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf")],
    ),
    (
        "noto",
        "Noto Sans Mono",
        [Path("/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf")],
    ),
    (
        "ubuntu",
        "Ubuntu Mono",
        [Path("/usr/share/fonts/truetype/ubuntu/UbuntuMono-R.ttf")],
    ),
]


@dataclass(frozen=True)
class Font:
    key: str
    label: str
    path: Path

    def as_dict(self) -> dict[str, str]:
        return {"key": self.key, "label": self.label, "url": f"/api/fonts/{self.key}.ttf"}


def _discover() -> dict[str, Font]:
    found: dict[str, Font] = {}
    for key, label, paths in _CANDIDATES:
        for p in paths:
            if p.is_file():
                found[key] = Font(key, label, p)
                break
    return found


_FONTS = _discover()


def available() -> list[Font]:
    return list(_FONTS.values())


def get(key: str) -> Font:
    """Look up a font, falling back to the first available one."""
    if key in _FONTS:
        return _FONTS[key]
    if not _FONTS:
        raise RuntimeError("no monospace TTF found on this system")
    return next(iter(_FONTS.values()))
