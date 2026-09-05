"""FastAPI application: the JSON API plus the static frontend."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .routes import reap_stale_media, router

WEB_ROOT = Path(__file__).resolve().parent.parent / "web"


@asynccontextmanager
async def lifespan(_: FastAPI):
    reap_stale_media()
    yield


app = FastAPI(title="ASCII Art Generator", docs_url="/api/docs", redoc_url=None,
              lifespan=lifespan)
app.include_router(router)


class NoCacheStatic(StaticFiles):
    """Serve the frontend without caching so a reload always picks up edits."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-store"
        return response


app.mount("/", NoCacheStatic(directory=WEB_ROOT, html=True), name="web")
