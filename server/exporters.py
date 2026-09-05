"""Encode rendered ASCII frames into a video or GIF.

Frames are piped into ffmpeg's stdin as rawvideo, so nothing is ever written to disk as an
intermediate image sequence.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable, Iterable

import numpy as np

from .media import FFMPEG, MediaError

Progress = Callable[[int], None]

SUFFIX = {"mp4": ".mp4", "webm": ".webm", "gif": ".gif"}
MIME = {
    "mp4": "video/mp4",
    "webm": "video/webm",
    "gif": "image/gif",
}


def _codec_args(fmt: str) -> list[str]:
    if fmt == "mp4":
        # yuv420p is what makes the file playable everywhere; it needs even dimensions.
        return [
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        ]
    if fmt == "webm":
        return [
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-row-mt", "1",
            "-pix_fmt", "yuv420p",
        ]
    if fmt == "gif":
        # One pass that builds a palette from the whole clip and then applies it. A single
        # unpaletted pass banded badly on gradients, which ASCII output is full of.
        return [
            "-vf", "split[a][b];[a]palettegen=stats_mode=diff[p];"
                   "[b][p]paletteuse=dither=bayer:bayer_scale=3",
            "-loop", "0",
        ]
    raise ValueError(f"unknown format {fmt!r}")


def encode(
    frames: Iterable[np.ndarray],
    dst: Path,
    fmt: str,
    fps: float,
    width: int,
    height: int,
    on_frame: Progress | None = None,
) -> Path:
    cmd = [
        FFMPEG, "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", f"{fps:g}", "-i", "-",
        *_codec_args(fmt), "-an", str(dst),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None

    count = 0
    try:
        for frame in frames:
            proc.stdin.write(frame.tobytes())
            count += 1
            if on_frame:
                on_frame(count)
    except BrokenPipeError:
        pass  # ffmpeg died; the stderr below carries the real reason
    finally:
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        err = proc.stderr.read() if proc.stderr else b""
        if proc.stderr:
            proc.stderr.close()
        code = proc.wait()

    if code != 0 or not dst.exists():
        raise MediaError(err.decode("utf-8", "replace").strip() or "encoding failed")
    if count == 0:
        raise MediaError("no frames were produced for this time range")
    return dst
