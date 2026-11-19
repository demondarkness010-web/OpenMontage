"""Run one Relief job inside Blender:  blender -b --factory-startup -noaudio -P worker.py -- job.json

The whole job is validated first (see relief_ops.validate_job); if any step is invalid nothing
runs. Then each step runs in order and report.json (next to job.json) is rewritten after every
step, so the server can show progress and still has a report if Blender is killed. A failed step
stops the job unless it is a validate/render step, whose failures are recorded and the job goes on.
"""
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import relief_ops  # noqa: E402

t0 = time.time()
job_path = sys.argv[sys.argv.index("--") + 1]
report_path = os.path.join(os.path.dirname(os.path.abspath(job_path)), "report.json")
report = {"ok": False, "status": "validating", "steps": [], "blender": None}


def save():
    report["seconds"] = round(time.time() - t0, 1)
    tmp = report_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    # Windows refuses to replace a file another process has open, and the server reads this
    # one while it polls progress. Retry briefly instead of failing the job (a garden relief
    # export once died here with "Access is denied").
    for attempt in range(50):
        try:
            os.replace(tmp, report_path)
            return
        except PermissionError:
            if attempt == 49:
                raise
            time.sleep(0.1)


try:
    import bpy
    report["blender"] = bpy.app.version_string
    with open(job_path, encoding="utf-8") as f:
        job = json.load(f)
    workdir, steps = relief_ops.validate_job(job)
    ctx = {"input": job.get("input"), "workdir": workdir, "report": report}
    report["status"] = "running"
    report["plan"] = [op for op, _ in steps]
    save()
    soft = ("validate", "render_views")  # failures here are findings, not reasons to stop
    for i, (op, params) in enumerate(steps):
        entry = {"op": op, "status": "running", "params": params}
        report["steps"].append(entry)
        report["current"] = i
        save()
        s0 = time.time()
        try:
            entry["result"] = relief_ops.RUN[op](ctx, params)
            entry["status"] = "ok"
        except Exception as e:  # noqa: BLE001
            entry["status"] = "failed"
            entry["error"] = str(e) if isinstance(e, relief_ops.JobError) else f"{type(e).__name__}: {e}"
            if not isinstance(e, relief_ops.JobError):
                entry["trace"] = traceback.format_exc()[-1200:]
            if op not in soft:
                raise relief_ops.JobError(f"{op} failed: {entry['error']}") from None
        finally:
            entry["seconds"] = round(time.time() - s0, 2)
            save()
    failed = [s["op"] for s in report["steps"] if s["status"] == "failed"]
    report["ok"] = not failed
    report["status"] = "done" if not failed else "done_with_problems"
except Exception as e:  # noqa: BLE001
    report["status"] = "failed"
    report["error"] = str(e) if isinstance(e, relief_ops.JobError) else f"{type(e).__name__}: {e}"
finally:
    report.pop("current", None)
    save()
