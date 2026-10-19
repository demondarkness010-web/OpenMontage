"""Database-backed job queue with leases, retries and cancellation.

Works with a single SQLite file and any number of worker threads/processes:
a job is claimed by a conditional UPDATE (only one claimer wins), kept alive
by a lease that the running task refreshes on every progress report, and
re-queued if a worker dies and its lease lapses.
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import Any, Optional

from sqlalchemy import select, update

from ..config import settings
from ..models import Job, SessionLocal, utcnow

log = logging.getLogger("capclip.queue")

PRIORITY = {"analyze": 50, "export": 80, "render": 100}


class JobCancelled(Exception):
    pass


class PermanentJobError(Exception):
    """Raised for failures that retrying cannot fix (bad input, unsupported file)."""


def enqueue(db, kind: str, project_id: str, *, clip_id: str | None = None, export_id: str | None = None,
            payload: dict[str, Any] | None = None, priority: int | None = None) -> Job:
    job = Job(
        kind=kind,
        project_id=project_id,
        clip_id=clip_id,
        export_id=export_id,
        payload=payload or {},
        priority=priority if priority is not None else PRIORITY.get(kind, 100),
        max_attempts=settings.job_max_attempts,
    )
    db.add(job)
    db.flush()
    return job


def cancel_jobs(db, *, project_id: str | None = None, clip_id: str | None = None, kinds: tuple[str, ...] | None = None) -> int:
    q = select(Job).where(Job.status.in_(("queued", "running")))
    if project_id:
        q = q.where(Job.project_id == project_id)
    if clip_id:
        q = q.where(Job.clip_id == clip_id)
    if kinds:
        q = q.where(Job.kind.in_(kinds))
    n = 0
    for job in db.scalars(q):
        n += 1
        if job.status == "queued":
            job.status = "cancelled"
            job.finished_at = utcnow()
            job.message = "Cancelled before start"
        else:
            job.cancel_requested = True
    return n


def claim_next(worker_id: str) -> Optional[str]:
    now = utcnow()
    with SessionLocal() as db:
        # Recover jobs whose worker died (lease expired while running).
        stale = db.scalars(select(Job).where(Job.status == "running", Job.lease_until < now)).all()
        for job in stale:
            if job.cancel_requested:
                job.status, job.finished_at = "cancelled", now
            elif job.attempts >= job.max_attempts:
                job.status, job.finished_at = "failed", now
                job.error = (job.error or "") + "\nWorker lost the job lease too many times."
            else:
                job.status, job.message = "queued", "Recovered after a worker interruption"
                log.warning("re-queued stale job %s", job.id)
        db.commit()

        candidates = db.scalars(
            select(Job.id).where(Job.status == "queued", Job.run_after <= now).order_by(Job.priority, Job.created_at).limit(5)
        ).all()
        for job_id in candidates:
            res = db.execute(
                update(Job)
                .where(Job.id == job_id, Job.status == "queued")
                .values(
                    status="running",
                    attempts=Job.attempts + 1,
                    started_at=now,
                    lease_until=now + timedelta(seconds=settings.job_lease_seconds),
                    message=f"Started by {worker_id}",
                )
            )
            db.commit()
            if res.rowcount == 1:
                return job_id
    return None


class JobContext:
    """Handed to every task: progress reporting, lease refresh, cancellation."""

    def __init__(self, job_id: str):
        self.job_id = job_id
        self._last_write = 0.0
        self._cancelled = False
        self._stage_started = time.time()
        self._stage = ""

    def progress(self, stage: str, fraction: float, message: str = "", *, eta: float | None = None, force: bool = False,
                 project_update: dict[str, Any] | None = None) -> None:
        now = time.time()
        if stage != self._stage:
            self._stage, self._stage_started, force = stage, now, True
        if not force and now - self._last_write < 0.75:
            return
        self._last_write = now
        from ..models import Project  # local import avoids a cycle at module load

        with SessionLocal() as db:
            job = db.get(Job, self.job_id)
            if job is None:
                raise JobCancelled()
            job.stage, job.progress = stage, max(0.0, min(1.0, fraction))
            if message:
                job.message = message
            job.lease_until = utcnow() + timedelta(seconds=settings.job_lease_seconds)
            if job.cancel_requested:
                self._cancelled = True
            if project_update is not None:
                project = db.get(Project, job.project_id)
                if project is not None:
                    for k, v in project_update.items():
                        setattr(project, k, v)
                    if eta is not None:
                        project.eta_seconds = eta
            db.commit()
        if self._cancelled:
            raise JobCancelled()

    def heartbeat(self) -> None:
        self.progress(self._stage or "running", self.current_progress(), force=False)

    def current_progress(self) -> float:
        with SessionLocal() as db:
            job = db.get(Job, self.job_id)
            return job.progress if job else 0.0

    def cancelled(self) -> bool:
        if self._cancelled:
            return True
        now = time.time()
        if now - self._last_write < 1.0:
            return False
        with SessionLocal() as db:
            job = db.get(Job, self.job_id)
            self._cancelled = bool(job is None or job.cancel_requested)
            if job is not None:
                job.lease_until = utcnow() + timedelta(seconds=settings.job_lease_seconds)
                db.commit()
        self._last_write = now
        return self._cancelled

    def check_cancel(self) -> None:
        if self.cancelled():
            raise JobCancelled()


def finish(job_id: str, status: str, *, error: str | None = None, message: str = "") -> Job | None:
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if job is None:
            return None
        job.finished_at = utcnow()
        job.lease_until = None
        if status == "retry":
            if job.attempts < job.max_attempts:
                backoff = min(300, 10 * (2 ** (job.attempts - 1)))
                job.status = "queued"
                job.run_after = utcnow() + timedelta(seconds=backoff)
                job.message = f"Attempt {job.attempts} failed; retrying in {backoff}s"
                job.error = error
                job.finished_at = None
            else:
                job.status, job.error = "failed", error
                job.message = message or f"Failed after {job.attempts} attempts"
        else:
            job.status = status
            job.error = error
            if message:
                job.message = message
            if status == "succeeded":
                job.progress = 1.0
        db.commit()
        db.refresh(job)
        return job
