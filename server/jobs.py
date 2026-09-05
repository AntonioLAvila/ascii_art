"""Background export jobs.

Encoding a clip takes tens of seconds, which must not sit on the event loop, so each job
runs on a worker thread and the HTTP layer just reads its progress record.
"""

from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

JOB_TTL = 60 * 30  # seconds a finished job's file is kept around


@dataclass
class Job:
    id: str
    total: int
    state: str = "running"  # running | done | error
    frame: int = 0
    error: str | None = None
    path: Path | None = None
    filename: str = ""
    created: float = field(default_factory=time.time)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "frame": self.frame,
            "total": self.total,
            "error": self.error,
            "filename": self.filename,
        }


class JobRegistry:
    def __init__(self, workers: int = 2):
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="export")

    def submit(self, total: int, filename: str, work: Callable[[Job], Path]) -> Job:
        job = Job(id=uuid.uuid4().hex, total=total, filename=filename)
        with self._lock:
            self._jobs[job.id] = job
        self._pool.submit(self._run, job, work)
        return job

    def _run(self, job: Job, work: Callable[[Job], Path]) -> None:
        try:
            job.path = work(job)
            job.frame = job.total
            job.state = "done"
        except Exception as exc:  # surfaced to the UI verbatim; ffmpeg errors are useful
            job.error = str(exc) or exc.__class__.__name__
            job.state = "error"
        finally:
            self._reap()

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _reap(self) -> None:
        cutoff = time.time() - JOB_TTL
        with self._lock:
            stale = [j for j in self._jobs.values() if j.created < cutoff]
            for job in stale:
                if job.path and job.path.exists():
                    job.path.unlink(missing_ok=True)
                self._jobs.pop(job.id, None)


registry = JobRegistry()
