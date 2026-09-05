"""HTTP API."""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import time
from pathlib import Path
from typing import Iterator

import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from . import ascii_core, fonts, media
from .atlas import build as build_atlas
from .exporters import MIME, SUFFIX, encode
from .jobs import Job, registry
from .settings import ExportRequest, RenderSettings

MEDIA_ROOT = Path(__file__).resolve().parent.parent / "media"
MEDIA_ROOT.mkdir(exist_ok=True)

ID_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_UPLOAD = 512 * 1024 * 1024  # 512 MB
MEDIA_TTL = 60 * 60 * 24  # uploads older than a day are cleared on startup


def reap_stale_media() -> int:
    """Drop uploads left behind by earlier sessions.

    The page deletes its own previous upload as you load new files, but a crash or a closed
    tab leaves the last one behind, and those are whole videos.
    """
    cutoff = time.time() - MEDIA_TTL
    removed = 0
    for entry in MEDIA_ROOT.iterdir():
        if entry.is_dir() and ID_RE.match(entry.name) and entry.stat().st_mtime < cutoff:
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
    return removed

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- helpers

def _media_dir(media_id: str) -> Path:
    if not ID_RE.match(media_id):
        raise HTTPException(400, "bad media id")
    path = MEDIA_ROOT / media_id
    if not path.is_dir():
        raise HTTPException(404, "media not found")
    return path


def _meta(media_id: str) -> dict:
    meta_file = _media_dir(media_id) / "meta.json"
    if not meta_file.exists():
        raise HTTPException(404, "media not found")
    return json.loads(meta_file.read_text())


def _playback_path(media_id: str) -> Path:
    """The file the browser is previewing — the transcode for GIFs, the original otherwise."""
    meta = _meta(media_id)
    return _media_dir(media_id) / meta["playback"]


# --------------------------------------------------------------------------- upload

@router.post("/upload")
async def upload(file: UploadFile) -> dict:
    import uuid

    name = Path(file.filename or "upload").name
    suffix = Path(name).suffix.lower()
    if suffix not in media.ALLOWED_SUFFIXES:
        raise HTTPException(
            415, f"unsupported file type {suffix or '(none)'}; "
                 f"accepted: {', '.join(sorted(media.ALLOWED_SUFFIXES))}"
        )

    media_id = uuid.uuid4().hex
    out_dir = MEDIA_ROOT / media_id
    out_dir.mkdir(parents=True)
    source = out_dir / f"source{suffix}"

    size = 0
    with source.open("wb") as fh:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD:
                fh.close()
                shutil.rmtree(out_dir, ignore_errors=True)
                raise HTTPException(413, "file is larger than 512 MB")
            fh.write(chunk)

    try:
        probe = await asyncio.to_thread(media.probe, source)
        playback = source
        if suffix == ".gif" and probe.kind == "video":
            playback = out_dir / "playback.webm"
            await asyncio.to_thread(media.normalize_to_webm, source, playback)
            playback_probe = await asyncio.to_thread(media.probe, playback)
            probe.fps = playback_probe.fps or probe.fps
            probe.duration = playback_probe.duration or probe.duration
    except media.MediaError as exc:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise HTTPException(422, f"could not read this file: {exc}") from exc

    meta = {
        "id": media_id,
        "name": name,
        "source": source.name,
        "playback": playback.name,
        **probe.as_dict(),
    }
    (out_dir / "meta.json").write_text(json.dumps(meta))
    return {**meta, "url": f"/api/media/{media_id}/{playback.name}"}


@router.get("/media/{media_id}/{name}")
def media_file(media_id: str, name: str) -> FileResponse:
    meta = _meta(media_id)
    if name not in (meta["source"], meta["playback"]):
        raise HTTPException(404, "not found")
    # Starlette's FileResponse answers Range requests itself, which is what lets the
    # browser seek within a video instead of refetching it whole.
    return FileResponse(_media_dir(media_id) / name)


@router.delete("/media/{media_id}")
def delete_media(media_id: str) -> dict:
    shutil.rmtree(_media_dir(media_id), ignore_errors=True)
    return {"ok": True}


# --------------------------------------------------------------------------- fonts

@router.get("/fonts")
def list_fonts() -> dict:
    return {"fonts": [f.as_dict() for f in fonts.available()]}


@router.get("/fonts/{key}.ttf")
def font_file(key: str) -> FileResponse:
    font = fonts.get(key)
    return FileResponse(font.path, media_type="font/ttf",
                        headers={"Cache-Control": "public, max-age=86400"})


# --------------------------------------------------------------------------- export

def _frame_stream(
    path: Path, settings: RenderSettings, atlas, fps: float | None,
    start: float, end: float | None, job: Job,
) -> Iterator[np.ndarray]:
    shape = (settings.rows, settings.cols, 3)
    for n, buf in enumerate(
        media.frame_cells(path, settings.cols, settings.rows, fps, start, end), start=1
    ):
        job.frame = n
        yield ascii_core.render(np.frombuffer(buf, np.uint8).reshape(shape), settings, atlas)


@router.post("/export")
def start_export(req: ExportRequest) -> dict:
    meta = _meta(req.media_id)
    path = _playback_path(req.media_id)
    settings = req.settings

    atlas = build_atlas(settings.font, settings.charset, settings.cell_height)
    width, height = ascii_core.output_size(settings, atlas)

    is_still = meta["kind"] == "image"
    fps = None if is_still else req.fps
    total = 1 if is_still else media.count_frames(
        meta["duration"], req.fps, req.start, req.end
    )

    out_name = f"ascii-{Path(meta['name']).stem}{SUFFIX[req.format]}"
    out_path = _media_dir(req.media_id) / f"export-{req.format}{SUFFIX[req.format]}"

    def work(job: Job) -> Path:
        frames = _frame_stream(path, settings, atlas, fps, req.start, req.end, job)
        return encode(frames, out_path, req.format, req.fps, width, height)

    job = registry.submit(total, out_name, work)
    return {"job_id": job.id, "total": total, "width": width, "height": height}


@router.get("/export/{job_id}")
def export_status(job_id: str) -> dict:
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return job.as_dict()


@router.get("/export/{job_id}/events")
async def export_events(job_id: str) -> StreamingResponse:
    if registry.get(job_id) is None:
        raise HTTPException(404, "no such job")

    async def stream():
        last = None
        while True:
            job = registry.get(job_id)
            if job is None:
                break
            payload = job.as_dict()
            if payload != last:
                yield f"data: {json.dumps(payload)}\n\n"
                last = payload
            if job.state != "running":
                break
            await asyncio.sleep(0.2)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/export/{job_id}/download")
def export_download(job_id: str) -> FileResponse:
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    if job.state == "error":
        raise HTTPException(500, job.error or "export failed")
    if job.state != "done" or not job.path:
        raise HTTPException(409, "export is still running")
    fmt = job.path.suffix.lstrip(".")
    return FileResponse(
        job.path,
        media_type=MIME.get(fmt, "application/octet-stream"),
        filename=job.filename,
    )
