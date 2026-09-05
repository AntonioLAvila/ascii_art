"""Media ingest: probing, normalisation, and raw frame extraction.

Animated input is normalised to WebM on upload. Browsers cannot seek the frames of a GIF,
but they seek video natively, so converting up front means the frontend only ever deals with
a still image or a `<video>` — one less playback engine to write, and scrubbing comes free.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterator

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

# Which scaler reduces a frame to the cell grid. The browser reaches the same grid by
# repeated halving in a canvas, so the two filters have to agree or an exported video drifts
# away from the preview. Measured against the browser's own output on a test pattern,
# swscale's `bilinear` picked the same character for 92.7% of cells and was never more than
# one ramp step away; `area`, `bicubic` and `lanczos` all scored slightly worse.
SCALE_FLAGS = "bilinear"

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".gif"}
ALLOWED_SUFFIXES = IMAGE_SUFFIXES | VIDEO_SUFFIXES


class MediaError(RuntimeError):
    pass


@dataclass
class Probe:
    kind: str  # "image" | "video"
    width: int
    height: int
    duration: float
    fps: float
    n_frames: int

    def as_dict(self) -> dict:
        return asdict(self)


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, check=False, **kw)


def _parse_rate(value: str | None) -> float:
    """ffprobe reports frame rates as 'num/den'."""
    if not value or value in ("0/0", "N/A"):
        return 0.0
    if "/" in value:
        num, den = value.split("/", 1)
        return float(num) / float(den) if float(den) else 0.0
    return float(value)


def probe(path: Path) -> Probe:
    res = _run(
        [FFPROBE, "-v", "error", "-print_format", "json",
         "-show_streams", "-show_format", "-select_streams", "v:0", str(path)]
    )
    if res.returncode != 0:
        raise MediaError(res.stderr.decode("utf-8", "replace").strip() or "ffprobe failed")

    data = json.loads(res.stdout or b"{}")
    streams = data.get("streams") or []
    if not streams:
        raise MediaError("no video stream found in this file")
    st = streams[0]

    width, height = int(st.get("width", 0)), int(st.get("height", 0))
    fps = _parse_rate(st.get("avg_frame_rate")) or _parse_rate(st.get("r_frame_rate"))
    duration = float(data.get("format", {}).get("duration") or st.get("duration") or 0.0)
    n_frames = int(st.get("nb_frames") or 0)

    # A still image decodes as a one-frame video stream; the suffix is the reliable signal
    # because ffprobe reports a nominal 25fps for PNGs.
    kind = "image" if path.suffix.lower() in IMAGE_SUFFIXES else "video"
    if kind == "video" and n_frames <= 1 and duration <= 0:
        kind = "image"
    if kind == "image":
        duration, fps, n_frames = 0.0, 0.0, 1
    elif duration and fps and not n_frames:
        n_frames = int(duration * fps)

    return Probe(kind, width, height, duration, fps, n_frames)


def normalize_to_webm(src: Path, dst: Path) -> None:
    """Transcode animated input (GIF) to VP9 WebM so the browser can seek it."""
    res = _run([
        FFMPEG, "-y", "-v", "error", "-i", str(src),
        # yuv420p needs even dimensions; GIFs frequently have odd ones.
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", "24", "-b:v", "0",
        "-row-mt", "1", "-an", str(dst),
    ])
    if res.returncode != 0:
        raise MediaError(res.stderr.decode("utf-8", "replace").strip() or "ffmpeg failed")


def frame_cells(
    path: Path, cols: int, rows: int, fps: float | None,
    start: float = 0.0, end: float | None = None,
) -> Iterator[bytes]:
    """Yield raw `cols*rows*3` RGB frames, one per output frame.

    Pass `fps=None` for a still image; resampling a source with no duration yields nothing.
    """
    cmd = [FFMPEG, "-v", "error"]
    if start > 0:
        cmd += ["-ss", f"{start:.6f}"]
    if end is not None and end > start:
        cmd += ["-t", f"{end - start:.6f}"]
    scale = f"scale={cols}:{rows}:flags={SCALE_FLAGS}"
    vf = scale if not fps else f"fps={fps},{scale}"
    cmd += ["-i", str(path), "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]

    frame_size = cols * rows * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    try:
        while True:
            buf = proc.stdout.read(frame_size)
            if not buf or len(buf) < frame_size:
                break
            yield buf
    finally:
        proc.stdout.close()
        err = proc.stderr.read() if proc.stderr else b""
        if proc.stderr:
            proc.stderr.close()
        if proc.wait() not in (0, 255) and err:
            raise MediaError(err.decode("utf-8", "replace").strip())


def count_frames(duration: float, fps: float, start: float, end: float | None) -> int:
    stop = duration if end is None else min(end, duration)
    return max(1, int(round(max(0.0, stop - start) * fps)))
