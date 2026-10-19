"""Worker loop. Run standalone (``python -m capclip.jobs.worker``) or embedded
in the API process (CAPCLIP_EMBEDDED_WORKER=true, the default for local use)."""

from __future__ import annotations

import logging
import os
import shutil
import socket
import threading
import time
import traceback

from ..config import settings
from ..models import Job, Project, SessionLocal, init_db
from . import queue
from .queue import JobCancelled, JobContext, PermanentJobError

log = logging.getLogger("capclip.worker")


def _on_analyze_end(job: Job, status: str, error: str | None) -> None:
    with SessionLocal() as db:
        project = db.get(Project, job.project_id)
        if project is None:
            return
        if status == "cancelled":
            project.status, project.message, project.eta_seconds = "cancelled", "Processing cancelled", None
        elif status == "failed":
            # Keep `stage` pointing at the step that failed so the UI can say where.
            project.status, project.eta_seconds = "failed", None
            project.error = error
            project.message = (error or "Processing failed").splitlines()[0][:300]
        elif status == "retry":
            project.message = "A processing step failed; retrying automatically"
        db.commit()


def run_job(job_id: str) -> None:
    from . import tasks

    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if job is None:
            return
        db.expunge(job)
    ctx = JobContext(job_id)
    handler = tasks.HANDLERS.get(job.kind)
    done = threading.Event()

    def keepalive() -> None:
        # Long blocking steps (model download, a single huge ffmpeg pass) may not
        # report progress for minutes; keep the lease alive while we're alive.
        from datetime import timedelta

        from ..models import utcnow

        while not done.wait(max(5, settings.job_lease_seconds // 4)):
            try:
                with SessionLocal() as db:
                    j = db.get(Job, job_id)
                    if j is None or j.status != "running":
                        return
                    j.lease_until = utcnow() + timedelta(seconds=settings.job_lease_seconds)
                    db.commit()
            except Exception:  # noqa: BLE001
                log.exception("lease keepalive failed for %s", job_id)

    threading.Thread(target=keepalive, daemon=True, name=f"lease-{job_id}").start()
    try:
        if handler is None:
            raise PermanentJobError(f"Unknown job kind {job.kind}")
        handler(ctx, job)
        queue.finish(job_id, "succeeded", message="Done")
    except JobCancelled:
        log.info("job %s cancelled", job_id)
        queue.finish(job_id, "cancelled", message="Cancelled")
        if job.kind == "analyze":
            _on_analyze_end(job, "cancelled", None)
        elif job.kind in tasks.FAILURE_HOOKS:
            tasks.FAILURE_HOOKS[job.kind](job_id, "Cancelled")
    except PermanentJobError as exc:
        log.warning("job %s failed permanently: %s", job_id, exc)
        queue.finish(job_id, "failed", error=str(exc), message=str(exc)[:300])
        if job.kind == "analyze":
            _on_analyze_end(job, "failed", str(exc))
        elif job.kind in tasks.FAILURE_HOOKS:
            tasks.FAILURE_HOOKS[job.kind](job_id, str(exc))
    except Exception as exc:  # noqa: BLE001 - any other failure is retried
        tb = traceback.format_exc()
        log.error("job %s error: %s\n%s", job_id, exc, tb)
        finished = queue.finish(job_id, "retry", error=f"{exc.__class__.__name__}: {exc}\n{tb[-2000:]}")
        final = finished is not None and finished.status == "failed"
        friendly = f"{exc.__class__.__name__}: {str(exc).splitlines()[0][:240] if str(exc) else ''}"
        if job.kind == "analyze":
            _on_analyze_end(job, "failed" if final else "retry", friendly)
        elif final and job.kind in tasks.FAILURE_HOOKS:
            tasks.FAILURE_HOOKS[job.kind](job_id, friendly)
    finally:
        done.set()
        # Temp files from a crashed render are never needed again.
        if job.kind == "render" and job.clip_id:
            from .. import storage

            shutil.rmtree(storage.DATA / "work" / job.project_id / "clips" / job.clip_id, ignore_errors=True)


class Worker:
    def __init__(self, concurrency: int | None = None):
        self.concurrency = max(1, concurrency or settings.worker_concurrency)
        self.stop = threading.Event()
        self.threads: list[threading.Thread] = []
        self.name = f"{socket.gethostname()}:{os.getpid()}"

    def _loop(self, slot: int) -> None:
        wid = f"{self.name}/{slot}"
        last_sweep = 0.0
        while not self.stop.is_set():
            try:
                if slot == 0 and time.time() - last_sweep > 1800:
                    last_sweep = time.time()
                    from .tasks import retention_sweep

                    retention_sweep()
                job_id = queue.claim_next(wid)
                if job_id:
                    run_job(job_id)
                    continue
            except Exception:  # noqa: BLE001
                log.exception("worker loop error")
            self.stop.wait(1.0)

    def start(self) -> None:
        for i in range(self.concurrency):
            t = threading.Thread(target=self._loop, args=(i,), name=f"capclip-worker-{i}", daemon=True)
            t.start()
            self.threads.append(t)
        log.info("worker started with %d slot(s)", self.concurrency)

    def shutdown(self) -> None:
        self.stop.set()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_db()
    w = Worker()
    w.start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        w.shutdown()


if __name__ == "__main__":
    main()
