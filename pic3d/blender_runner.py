"""Relief's connection to Blender: find it, check it works, and run jobs in it safely.

Nothing here sends code to Blender. A job is a JSON list of named operations (see
blender/relief_ops.py) that Blender's side validates before running anything. Each job gets its
own folder, a timeout and cancellation, and only one Blender runs at a time (this laptop has 4 GB
of RAM and Blender uses 0.5-1 GB).
"""
import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE / "blender"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
lock = threading.Lock()  # one Blender at a time


def find_blender(env_value: str | None = None) -> str | None:
    """$BLENDER_PATH (or .env), else the newest portable copy in OpenMontage/.runtime/blender/, else PATH."""
    if env_value and Path(env_value).is_file():
        return env_value
    found = sorted((HERE.parent / ".runtime" / "blender").glob("blender-*/blender*.exe"),
                   key=lambda p: [int(n) for n in re.findall(r"\d+", p.parent.name)[:3]], reverse=True)
    found = [p for p in found if p.name.lower() == "blender.exe"]
    if found:
        return str(found[0])
    return shutil.which("blender")


def run(exe: str, script: str, args: list[str], workdir: Path, timeout: float,
        cancelled=lambda: False, on_progress=None) -> dict:
    """Run a Blender script headless. Returns {"returncode", "killed", "stderr", "seconds"}."""
    cmd = [exe, "-b", "--factory-startup", "-noaudio", "-P", str(SCRIPTS / script), "--", *args]
    t0 = time.time()
    log = open(workdir / "blender.log", "wb")
    try:
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, creationflags=NO_WINDOW,
                                cwd=str(workdir))
        killed = None
        while proc.poll() is None:
            if cancelled():
                killed = "cancelled"
            elif time.time() - t0 > timeout:
                killed = f"timed out after {int(timeout)} s"
            if killed:
                proc.kill()
                proc.wait(10)
                break
            if on_progress:
                on_progress()
            time.sleep(0.5)
    finally:
        log.close()
    tail = ""
    try:
        tail = (workdir / "blender.log").read_bytes()[-1500:].decode("utf-8", "replace")
    except OSError:
        pass
    return {"returncode": proc.returncode, "killed": killed, "log_tail": tail, "seconds": round(time.time() - t0, 1)}


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def run_job(exe: str, spec: dict, workdir: Path, timeout: float, cancelled=lambda: False, on_progress=None) -> dict:
    """Run a JSON operation job (blender/worker.py) in `workdir`. Returns its report."""
    workdir.mkdir(parents=True, exist_ok=True)
    for old in ("report.json", "report.json.tmp"):
        (workdir / old).unlink(missing_ok=True)
    spec = {**spec, "workdir": str(workdir)}
    (workdir / "job.json").write_text(json.dumps(spec, indent=1), encoding="utf-8")

    def progress():
        if on_progress:
            r = read_json(workdir / "report.json")
            if r:
                on_progress(r)

    with lock:
        if cancelled():
            return {"ok": False, "status": "cancelled", "steps": []}
        proc = run(exe, "worker.py", [str(workdir / "job.json")], workdir, timeout, cancelled, progress)
    report = read_json(workdir / "report.json") or {"ok": False, "steps": []}
    report["process"] = proc
    if proc["killed"]:
        report.update(ok=False, status="cancelled" if proc["killed"] == "cancelled" else "failed",
                      error=f"Blender was stopped: {proc['killed']}.")
    elif report.get("status") in (None, "validating", "running"):
        # Blender exited without finishing its report: it crashed.
        last = (proc["log_tail"].strip().splitlines() or ["no output"])[-1]
        report.update(ok=False, status="failed", error=f"Blender stopped unexpectedly ({last[:200]}).")
    return report


# --------------------------------------------------------------------------- diagnostics

class Diagnostics:
    """What we know about the Blender install. `check()` really runs Blender; results are cached."""

    def __init__(self, exe: str | None, cache: Path):
        self.exe, self.cache = exe, cache
        self.running = False
        self.data = read_json(cache) or {}

    def status(self) -> dict:
        exe = self.exe
        data = dict(self.data) if self.data.get("exe") == exe else {}
        out = {
            "found": bool(exe and Path(exe).is_file()),
            "path": str(Path(exe).relative_to(HERE.parent)) if exe and HERE.parent in Path(exe).parents else exe,
            "checking": self.running,
            "checked": data.get("checked"),
            "version": data.get("version"),
            "python": data.get("python"),
            "startup_seconds": data.get("startup_seconds"),
            "checks": data.get("checks") or {},
            "error": data.get("error"),
        }
        checks = out["checks"]
        out["working"] = bool(out["found"] and checks and all(
            checks.get(k, {}).get("ok") for k in ("mesh_edit", "gltf_round_trip")))
        out["can_render"] = bool(checks.get("workbench_render", {}).get("ok"))
        gpu = checks.get("cycles_gpu", {}).get("value")
        out["render_device"] = "GPU" if isinstance(gpu, dict) and gpu else ("CPU" if checks.get("cycles_gpu", {}).get("ok") else None)
        out["write_ok"] = data.get("write_ok")
        try:
            out["disk_free_gb"] = round(shutil.disk_usage(self.cache.parent).free / 1e9, 1)
        except OSError:
            out["disk_free_gb"] = None
        return out

    def check(self, timeout: float = 240):
        if not self.exe:
            self.data = {"exe": None, "checked": time.time(), "error": "Blender isn't installed."}
            return self.status()
        self.running = True
        work = self.cache.parent / "blender-jobs" / "_diagnose"
        try:
            work.mkdir(parents=True, exist_ok=True)
            probe = work / "write-test.txt"
            try:
                probe.write_text("ok", encoding="utf-8")
                probe.unlink()
                write_ok = True
            except OSError:
                write_ok = False
            out = work / "diagnose.json"
            out.unlink(missing_ok=True)
            with lock:
                proc = run(self.exe, "diagnose.py", [str(out)], work, timeout)
            got = read_json(out) or {}
            data = {"exe": self.exe, "checked": time.time(), "version": got.get("version"),
                    "python": got.get("python"), "checks": got.get("checks") or {}, "write_ok": write_ok,
                    "startup_seconds": None, "seconds": proc["seconds"]}
            spent = sum(c.get("seconds") or 0 for c in data["checks"].values())
            data["startup_seconds"] = round(max(proc["seconds"] - spent, 0), 1)
            if proc["killed"]:
                data["error"] = f"The check was stopped: {proc['killed']}. Finished: {', '.join(data['checks']) or 'nothing'}."
            elif not got.get("finished"):
                last = (proc["log_tail"].strip().splitlines() or ["no output"])[-1]
                data["error"] = f"Blender stopped before finishing the checks ({last[:200]})."
            self.data = data
            self.cache.write_text(json.dumps(data, indent=1), encoding="utf-8")
        finally:
            self.running = False
        return self.status()
