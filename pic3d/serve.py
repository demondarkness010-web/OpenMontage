"""Relief dev server: static files plus a small API for cloud image-to-3D.

    python serve.py [port] [--mock]

Static: serves this folder with the cross-origin isolation headers onnxruntime-web
needs for multithreaded WASM, and with correct MIME types (Windows can map .js to
text/plain, which breaks ES modules).

API (all JSON, localhost only). The fal.ai key never leaves this process:
    GET    /api/config              which providers are configured
    POST   /api/generate            {model, options, image (data URL), name} -> job
    GET    /api/jobs                history, newest first
    GET    /api/jobs/<id>           poll; downloads the GLB into ./generated when done
    POST   /api/jobs/<id>/cancel    cancel a queued job
    POST   /api/jobs/<id>/clean     inspect, repair (with rollback), re-check a finished model in Blender (a new job)
    POST   /api/jobs/<id>/inspect   measure a model in Blender: geometry checks, web/game/print scores, pictures
    POST   /api/jobs/<id>/export    {formats:[glb,obj,stl,fbx,ply,usdz,blend], size_cm?} export + re-import check
    GET    /api/blender/status      what Blender is installed and what the last check found
    POST   /api/blender/check       run Blender's self-check again (takes ~20-40 s)
    GET    /api/blender/tasks/<id>  progress and report of an inspect/export
    POST   /api/blender/tasks/<id>/cancel
    DELETE /api/jobs/<id>           remove from history and delete the local files

--mock (or RELIEF_MOCK=1) fakes the provider so the UI can be exercised for free.
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import json
import math
import os
import random
import re
import socketserver
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(ARGS[0]) if ARGS else 5190
MOCK = "--mock" in sys.argv or os.environ.get("RELIEF_MOCK") == "1"
# Mock runs keep their own folder so fake models never mix with real history.
GEN_DIR = "generated-mock" if MOCK else "generated"
GENERATED = ROOT / GEN_DIR
JOBS_FILE = GENERATED / "jobs.json"

# Each engine: fal endpoint, which input field takes the image, and the option keys
# the browser may set. Anything else in a request is dropped.
MODELS = {
    "hunyuan": {
        "label": "Hunyuan3D 3.1 Pro",
        "endpoint": "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d",
        "image_field": "input_image_url",
        "options": {"generate_type", "enable_pbr", "face_count"},
    },
    "tripo": {
        "label": "Tripo H3.1",
        "endpoint": "tripo3d/h3.1/image-to-3d",
        "image_field": "image_url",
        "options": {"texture", "pbr", "texture_quality", "geometry_quality", "quad", "face_limit", "texture_alignment"},
    },
    "meshy": {
        "label": "Meshy 7.1",
        "endpoint": "fal-ai/meshy/v7.1/image-to-3d",
        "image_field": "image_url",
        "options": {"should_texture", "enable_pbr", "target_polycount", "topology", "symmetry_mode"},
    },
    # Built in the browser; the server only keeps the file and the history entry.
    "flat": {"label": "Flat object", "provider": "local", "options": {"shape", "thickness", "back", "stand"}},
    "relief": {"label": "Depth relief", "provider": "local", "options": {"quality", "depth", "resolution"}},
    # Free: open-source models on Hugging Face Spaces (ZeroGPU, daily quota).
    "trellis2": {
        "label": "TRELLIS.2",
        "provider": "hf",
        "space": "microsoft-trellis-2",
        "options": {"resolution", "texture_size", "faces", "seed"},
    },
    "hunyuan21": {
        "label": "Hunyuan3D-2.1",
        "provider": "hf",
        "space": "tencent-hunyuan3d-2-1",
        "options": {"octree", "rembg", "seed"},
    },
    "sf3d": {
        "label": "Stable Fast 3D",
        "provider": "hf",
        "space": "stabilityai-stable-fast-3d",
        "options": {"texture_size", "remesh", "seed"},
    },
    "trellis": {
        "label": "TRELLIS",
        "provider": "hf",
        "space": "trellis-community-trellis",
        "options": {"steps", "texture_size", "simplify", "seed"},
    },
    "triposg": {
        "label": "TripoSG",
        "provider": "hf",
        "space": "vast-ai-triposg",
        "options": {"faces", "seed"},
    },
    "hy2mini": {
        "label": "Hunyuan3D-2mini Turbo",
        "provider": "hf",
        "space": "tencent-hunyuan3d-2mini-turbo",
        "options": {"octree", "rembg", "seed"},
    },
    "instantmesh": {
        "label": "InstantMesh",
        "provider": "hf",
        "space": "tencentarc-instantmesh",
        "options": {"steps", "rembg", "seed"},
    },
    "hunyuan2": {
        "label": "Hunyuan3D-2",
        "provider": "hf",
        "space": "tencent-hunyuan3d-2",
        "options": {"octree", "rembg", "seed"},
    },
}


# --------------------------------------------------------------------------- keys


def load_key(*names: str) -> str | None:
    for name in names:
        if os.environ.get(name):
            return os.environ[name].strip()
    pattern = re.compile(r"\s*(?:export\s+)?(" + "|".join(names) + r")\s*=\s*(.*)\s*$")
    for env_file in (ROOT / ".env", ROOT.parent / ".env"):
        if not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            m = pattern.match(line)
            if m and m.group(2).strip().strip("'\""):
                return m.group(2).strip().strip("'\"")
    return None


FAL_KEY = load_key("FAL_KEY", "FAL_AI_API_KEY")
HF_TOKEN = load_key("HF_TOKEN", "HUGGINGFACE_TOKEN", "HUGGING_FACE_HUB_TOKEN")


# --------------------------------------------------------------------------- http helpers


def http_json(method: str, url: str, body=None, auth=True, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if auth:
        req.add_header("Authorization", f"Key {FAL_KEY}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        try:
            parsed = json.loads(detail)
            detail = parsed.get("detail", parsed)
            if isinstance(detail, list) and detail and isinstance(detail[0], dict):
                detail = "; ".join(str(d.get("msg", d)) for d in detail)
        except ValueError:
            pass
        if "balance" in str(detail).lower():
            raise RuntimeError(
                "Your fal.ai balance is empty. Add credit at fal.ai/dashboard/billing, then try again."
            ) from None
        if e.code in (401, 403):
            raise RuntimeError(f"fal.ai refused the key ({detail}). Check FAL_KEY in .env.") from None
        raise RuntimeError(f"{e.code}: {detail}") from None


def fal_upload(data: bytes, content_type: str, name: str) -> str:
    init = http_json(
        "POST",
        "https://rest.alpha.fal.ai/storage/upload/initiate",
        {"content_type": content_type, "file_name": name},
    )
    req = urllib.request.Request(init["upload_url"], data=data, method="PUT")
    req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=120):
        pass
    return init["file_url"]


def download(url: str, dest: Path):
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=300) as res, open(tmp, "wb") as f:
        while chunk := res.read(1 << 16):
            f.write(chunk)
    tmp.replace(dest)


def file_url(value):
    if isinstance(value, dict):
        return value.get("url")
    if isinstance(value, str):
        return value
    return None


# --------------------------------------------------------------------------- jobs

jobs_lock = threading.Lock()
job_locks: dict[str, threading.Lock] = {}


def load_jobs() -> dict:
    try:
        return json.loads(JOBS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


JOBS = load_jobs()
for _job in JOBS.values():
    if _job.get("provider") in ("hf", "blender") and _job.get("status") in ("queued", "running", "downloading"):
        _job.update(status="failed", error="Interrupted: the Relief server restarted during generation.")


def save_jobs():
    # dict() copies are atomic under the GIL, so the snapshot can't change mid-dump
    # even though worker threads update their job dicts without the lock.
    snapshot = {k: dict(v) for k, v in list(JOBS.items())}
    try:
        GENERATED.mkdir(exist_ok=True)
        tmp = JOBS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot, indent=1), encoding="utf-8")
        tmp.replace(JOBS_FILE)
    except OSError as e:  # disk full or file locked: keep serving; history catches up next save
        sys.stderr.write(f"[relief] couldn't save history: {e}\n")


# Engines whose Spaces reserve the least GPU time per run (ZeroGPU checks the
# reservation, not the real run time, against what's left).
LIGHT_ENGINES = ("sf3d",)

# What we last learned about this machine's free ZeroGPU allowance (shared by every
# ZeroGPU Space): when it resets and how many seconds were left. Kept across restarts.
QUOTA_FILE = GENERATED / "quota.json"


def load_quota() -> dict:
    try:
        return json.loads(QUOTA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


QUOTA = load_quota()


def note_quota(message: str | None):
    """Record a ZeroGPU quota message, or clear the record after a successful run."""
    if message is None:
        QUOTA.clear()
    else:
        reset = re.search(r"Try again in (\d+):(\d+):(\d+)", message)
        if reset:
            secs = int(reset.group(1)) * 3600 + int(reset.group(2)) * 60 + int(reset.group(3))
            if secs > 0:  # some Spaces report 0:00:00 when they can't tell; keep what we know
                QUOTA["resetAt"] = time.time() + secs
        left = re.search(r"(\d+)s requested vs\.? (\d+)s left", message)
        if left:
            QUOTA["requested"], QUOTA["left"] = int(left.group(1)), int(left.group(2))
        QUOTA["checked"] = time.time()
    try:
        GENERATED.mkdir(exist_ok=True)
        QUOTA_FILE.write_text(json.dumps(QUOTA), encoding="utf-8")
    except OSError:
        pass


def quota_status() -> dict | None:
    reset = QUOTA.get("resetAt")
    if reset and reset > time.time():
        return {"resetAt": reset, "left": QUOTA.get("left")}
    if QUOTA.get("left") is not None and time.time() - QUOTA.get("checked", 0) < 6 * 3600:
        return {"resetAt": None, "left": QUOTA["left"]}
    return None


PUBLIC = ("id", "model", "label", "name", "status", "created", "finished", "cost", "options", "glb",
          "source", "thumbnail", "formats", "error", "queue_position", "log", "mock", "provider", "size_cm",
          "cleaned_from", "report", "inspection", "exports")


def save_local_job(body: dict) -> dict:
    """Keep a model that the browser built itself (no provider involved)."""
    model = MODELS.get(body.get("model"))
    if not model or model.get("provider") != "local":
        raise ValueError("Unknown model.")
    m = re.match(r"data:(image/(?:jpeg|png|webp));base64,(.*)$", body.get("image", ""), re.S)
    if not m:
        raise ValueError("Send the photo as a base64 data URL.")
    content_type, image = m.group(1), base64.b64decode(m.group(2))
    glb = base64.b64decode(body.get("glb") or "")
    if glb[:4] != b"glTF" or len(glb) > 40 * 1024 * 1024:
        raise ValueError("That isn't a GLB model (or it's over 40 MB).")
    job_id = uuid.uuid4().hex[:12]
    GENERATED.mkdir(exist_ok=True)
    ext = {"image/png": ".png", "image/webp": ".webp"}.get(content_type, ".jpg")
    (GENERATED / f"{job_id}-source{ext}").write_bytes(image)
    (GENERATED / f"{job_id}.glb").write_bytes(glb)
    try:
        size_cm = float(body.get("size_cm"))
        size_cm = size_cm if math.isfinite(size_cm) and 0.5 <= size_cm <= 10000 else None
    except (TypeError, ValueError):
        size_cm = None
    now = time.time()
    job = {
        "id": job_id, "model": body["model"], "label": model["label"], "endpoint": "browser",
        "provider": "local", "name": str(body.get("name") or "image")[:80], "status": "done",
        "created": now - float(body.get("seconds") or 0), "finished": now, "cost": 0,
        "options": {k: v for k, v in (body.get("options") or {}).items() if k in model["options"]},
        "source": f"/{GEN_DIR}/{job_id}-source{ext}", "glb": f"/{GEN_DIR}/{job_id}.glb",
        "mock": MOCK, "size_cm": size_cm,
    }
    with jobs_lock:
        JOBS[job_id] = job
        save_jobs()
    return job


def public(job: dict) -> dict:
    return {k: job.get(k) for k in PUBLIC}


def create_job(body: dict) -> dict:
    model = MODELS.get(body.get("model"))
    if not model or model.get("provider") == "local":
        raise ValueError("Unknown model.")
    m = re.match(r"data:(image/[\w.+-]+);base64,(.*)$", body.get("image", ""), re.S)
    if not m:
        raise ValueError("Send the image as a base64 data URL.")
    content_type, image = m.group(1), base64.b64decode(m.group(2))
    if len(image) > 8 * 1024 * 1024:
        raise ValueError("Image is larger than 8 MB.")
    try:
        size_cm = float(body.get("size_cm"))
        size_cm = size_cm if math.isfinite(size_cm) and 0.5 <= size_cm <= 10000 else None
    except (TypeError, ValueError):
        size_cm = None

    job_id = uuid.uuid4().hex[:12]
    GENERATED.mkdir(exist_ok=True)
    ext = {"image/png": ".png", "image/webp": ".webp"}.get(content_type, ".jpg")
    (GENERATED / f"{job_id}-source{ext}").write_bytes(image)

    options = {k: v for k, v in (body.get("options") or {}).items() if k in model["options"]}
    job = {
        "id": job_id,
        "model": body["model"],
        "label": model["label"],
        "endpoint": model.get("endpoint") or f"hf.co/spaces/{model.get('space')}",
        "provider": model.get("provider", "fal"),
        "name": str(body.get("name") or "image")[:80],
        "status": "queued",
        "created": time.time(),
        "cost": body.get("cost"),
        "options": options,
        "source": f"/{GEN_DIR}/{job_id}-source{ext}",
        "mock": MOCK,
        "size_cm": size_cm,
    }

    if not MOCK and model.get("provider") == "hf":
        with jobs_lock:
            JOBS[job_id] = job
        threading.Thread(target=run_hf_job, args=(job, image, content_type, ext), daemon=True).start()
        with jobs_lock:
            save_jobs()
        return job

    if not MOCK:
        if not FAL_KEY:
            raise ValueError("No fal.ai key. Add FAL_KEY to the .env file next to this app or in the repo root.")
        try:
            image_url = fal_upload(image, content_type, f"{job_id}{ext}")
            payload = {model["image_field"]: image_url, **options}
            queued = http_json("POST", f"https://queue.fal.run/{model['endpoint']}", payload)
        except Exception:
            (GENERATED / f"{job_id}-source{ext}").unlink(missing_ok=True)  # no orphan files
            raise
        job["request_id"] = queued.get("request_id")
        job["status_url"] = queued["status_url"]
        job["response_url"] = queued["response_url"]
        job["cancel_url"] = queued.get("cancel_url")

    with jobs_lock:
        JOBS[job_id] = job
        save_jobs()
    return job


def poll_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise KeyError(job_id)
    if job["status"] in ("done", "failed", "cancelled"):
        return job
    lock = job_locks.setdefault(job_id, threading.Lock())
    if not lock.acquire(blocking=False):
        return job  # another request is already polling/downloading
    try:
        if job.get("mock"):
            mock_progress(job)
        elif job.get("provider") in ("hf", "blender"):
            pass  # its worker thread updates the job in place
        else:
            status = http_json("GET", job["status_url"] + "?logs=1", timeout=30)
            state = str(status.get("status", "")).upper()
            logs = status.get("logs") or []
            if logs:
                job["log"] = str(logs[-1].get("message", ""))[:200]
            if state == "IN_QUEUE":
                job["status"] = "queued"
                job["queue_position"] = status.get("queue_position")
            elif state == "IN_PROGRESS":
                job["status"] = "running"
                job["queue_position"] = None
            elif state == "COMPLETED":
                job["status"] = "downloading"
                try:
                    finish(job, http_json("GET", job["response_url"], timeout=60))
                except Exception as e:  # noqa: BLE001 - surface provider errors to the UI
                    job["status"] = "failed"
                    job["error"] = str(e)
        if job.get("provider") != "hf":
            with jobs_lock:
                save_jobs()
        return job
    finally:
        lock.release()


def finish(job: dict, result: dict):
    urls = result.get("model_urls") or {}
    glb = file_url(result.get("model_glb")) or file_url(result.get("model_mesh")) or file_url(urls.get("glb"))
    if not glb:
        raise RuntimeError("The provider returned no GLB model.")
    dest = GENERATED / f"{job['id']}.glb"
    download(glb, dest)
    thumb = file_url(result.get("thumbnail")) or file_url(result.get("rendered_image"))
    if thumb:
        try:
            download(thumb, GENERATED / f"{job['id']}-thumb.png")
            job["thumbnail"] = f"/{GEN_DIR}/{job['id']}-thumb.png"
        except Exception:  # noqa: BLE001 - thumbnail is optional
            job["thumbnail"] = None
    job["formats"] = {k: file_url(v) for k, v in urls.items() if file_url(v) and k != "glb"}
    job["glb"] = f"/{GEN_DIR}/{job['id']}.glb"
    job["status"] = "done"
    job["finished"] = time.time()
    job["seed"] = result.get("seed")


def run_hf_job(job: dict, image: bytes, content_type: str, ext: str):
    """Run a free generation on a Hugging Face Space (blocking; runs in a thread)."""
    from hfspace import QuotaError, Space

    opts = job["options"]
    try:
        seed = int(opts.get("seed", 0) or 0)
    except (TypeError, ValueError):
        seed = 0
    seed = seed or random.randint(1, 2**31 - 2)

    def note(log=None, **fields):
        if job.get("cancel_requested"):
            raise InterruptedError
        job.update(fields)
        if log is not None:
            job["log"] = log

    phase = {"label": None}  # what the current Space call does, shown once a GPU picks it up

    def step(label):
        phase["label"] = label
        note(label)

    def on_event(kind, info):
        if kind == "queue":
            eta = info.get("eta")
            note(status="queued", queue_position=info.get("rank"),
                 log=f"Waiting for a free GPU (~{round(eta)} s)" if eta else "Waiting for a free GPU")
        elif kind == "start":
            note(phase["label"], status="running", queue_position=None)
        elif kind == "progress" and info.get("desc"):
            done, total = info.get("index"), info.get("length")
            pct = f" {round(100 * done / total)}%" if done is not None and total else ""
            note(log=f"{info['desc']}{pct}")

    def run(api, data, label):
        step(label)
        return space.call(api, data, on_event)

    model = job["model"]
    try:
        note("Connecting to the free Space")
        space = Space(MODELS[model]["space"], token=HF_TOKEN)
        if space.has("start_session"):
            space.call("start_session", [])
        note("Uploading image")
        img = space.upload(image, f"input{ext}", content_type)
        if model == "trellis2":
            pre = run("preprocess_image", [img], "Removing the background")
            res = str(opts.get("resolution", "512"))
            run("image_to_3d", [pre[0], seed, res, 7.5, 0.7, 12, 5.0, 7.5, 0.5, 12, 3.0, 1.0, 0.0, 12, 3.0],
                "Generating 3D structure and texture")
            out = run("extract_glb", [int(opts.get("faces", 300000)), int(opts.get("texture_size", 2048))],
                      "Baking the textured GLB")
            files = [out[0]]
        elif model == "trellis":
            pre = run("preprocess_image", [img], "Removing the background")
            steps = int(opts.get("steps", 12))
            out = run("generate_and_extract_glb",
                      [pre[0], [], seed, 7.5, steps, 3.0, steps, "stochastic",
                       float(opts.get("simplify", 0.95)), int(opts.get("texture_size", 1024))],
                      "Generating the textured model")
            files = [out[2], out[3]]
        elif model == "sf3d":
            # The app works in two clicks: cut out the object (kept in the session), then run.
            fr, remesh, tex = 0.85, str(opts.get("remesh", "None")), int(opts.get("texture_size", 1024))
            run("run_button", ["Remove Background", img, fr, remesh, -1, tex], "Removing the background")
            out = run("run_button", ["Run", img, fr, remesh, -1, tex], "Generating the textured model")
            files = [out[4]]
        elif model == "triposg":
            seg = run("run_segmentation", [img], "Cutting out the object")
            out = run("image_to_3d", [seg[0], seed, 50, 7.0, True, int(opts.get("faces", 100000))],
                      "Generating the 3D shape")
            files = [out[0]]
        elif model == "hy2mini":
            out = run("shape_generation",
                      [None, img, None, None, None, None, 5, 5.0, seed, int(opts.get("octree", 256)),
                       bool(opts.get("rembg", True)), 8000, False],
                      "Generating the 3D shape (turbo)")
            files = [out[0]]
        elif model == "instantmesh":
            pre = run("preprocess", [img, bool(opts.get("rembg", True))], "Removing the background")
            mvs = run("generate_mvs", [pre[0], int(opts.get("steps", 75)), seed], "Generating six views")
            out = run("make3d", [mvs[0]], "Reconstructing the mesh")
            files = [out[1]]  # [obj, glb]
        elif model == "hunyuan2":
            out = run("generation_all",
                      [None, img, None, None, None, None, 30, 5.0, seed, int(opts.get("octree", 256)),
                       bool(opts.get("rembg", True)), 8000, False],
                      "Generating the 3D shape and texture")
            files = [out[1], out[0]]  # textured file first, shape-only as a fallback
        else:  # hunyuan21
            out = run("shape_generation",
                      [img, None, None, None, None, 30, 5.0, seed, int(opts.get("octree", 256)),
                       bool(opts.get("rembg", True)), 8000, False],
                      "Generating the 3D shape")
            files = [out[0]]
        url = next((u for u in map(space.file_url, files) if u), None)
        if not url:
            raise RuntimeError("The Space finished but returned no model file.")
        note("Downloading the model", status="downloading")
        space.download(url, GENERATED / f"{job['id']}.glb")
        note(None, status="done", glb=f"/{GEN_DIR}/{job['id']}.glb", finished=time.time(), formats={}, seed=seed)
        job["log"] = None
        note_quota(None)
    except InterruptedError:
        job.update(status="cancelled", log=None)
    except QuotaError as e:
        text = str(e)
        sys.stderr.write(f"[relief] quota refusal from {model}: {text[:300]}\n")
        note_quota(text)
        hint = "" if HF_TOKEN else " A free Hugging Face token (HF_TOKEN in .env) gives you more daily GPU time."
        wait = re.search(r"Try again in ([\d:]+)", text)
        tail = f" It resets in {wait.group(1)}." if wait and wait.group(1).strip("0:") else ""
        left = re.search(r"(\d+)s requested vs\.? (\d+)s left", text)
        if "runs limit" in text.lower():
            # A cap on the number of GPU runs, separate from the minutes: it refuses every
            # ZeroGPU engine at once, however light, until it rolls over.
            msg = ("You've used today's free GPU runs on Hugging Face, so every engine that runs on its shared "
                   "GPUs is refusing until the limit rolls over (about a day after your first run). "
                   "Stable Fast 3D, Flat object and Depth relief still work.")
        elif "larger than the maximum" in text:
            msg = "This setting needs more GPU time per run than free users get. Pick a lower resolution."
        elif left and int(left.group(2)) > 0:
            # ZeroGPU bills big GPUs at a higher rate, so "60 s requested vs 85 s left" can still fail.
            lighter = [MODELS[m]["label"] for m in LIGHT_ENGINES if m != model]
            msg = (f"Only about {left.group(2)} s of today's free GPU time is left, and {MODELS[model]['label']} "
                   f"needs more than that per run."
                   + (f" {' or '.join(lighter)} needs the least, so try that." if lighter else "")
                   + (f" It refills in {wait.group(1)}." if wait and wait.group(1).strip("0:") else "") + hint)
        else:
            msg = f"Today's free GPU time on Hugging Face is used up.{tail}{hint}"
        job.update(status="failed", error=msg, log=None)
    except Exception as e:  # noqa: BLE001 - report Space errors to the UI
        job.update(status="failed", error=f"{MODELS[job['model']]['label']} failed: {e}", log=None)
    if job.get("cancel_requested"):
        job.update(status="cancelled", error=None, log=None)
    with jobs_lock:
        save_jobs()


def cancel_job(job_id: str) -> dict:
    job = JOBS[job_id]
    if job["status"] in ("done", "failed", "cancelled"):
        return job  # finished first; keep the real outcome
    if job.get("provider") == "hf" and not job.get("mock"):
        # A Space can't be stopped remotely; stop following it and drop the result.
        job["cancel_requested"] = True
    elif job["status"] in ("queued", "running") and not job.get("mock") and job.get("response_url"):
        url = job.get("cancel_url") or job["response_url"] + "/cancel"
        try:
            http_json("PUT", url, timeout=20)
        except RuntimeError as e:
            # 400 means it already started; fal bills started jobs, so say so.
            raise ValueError(f"Couldn't cancel: the job may already be running ({e}).") from None
    job["status"] = "cancelled"
    with jobs_lock:
        save_jobs()
    return job


# --------------------------------------------------------------------------- Blender

import blender_runner  # noqa: E402

BLENDER = blender_runner.find_blender(os.environ.get("BLENDER_PATH") or load_key("BLENDER_PATH"))
BLENDER_JOBS = GENERATED / "blender-jobs"
BLENDER_DIAG = blender_runner.Diagnostics(BLENDER, GENERATED / "blender-status.json")
TASKS: dict[str, dict] = {}  # inspections and exports (they belong to a History entry, not new ones)
EXPORT_FORMATS = ("glb", "obj", "stl", "fbx", "ply", "usdz", "blend")
STEP_LABELS = {"load": "Loading the model", "prepare": "Preparing the mesh", "inspect": "Measuring the mesh",
               "repair": "Repairing, with a checkpoint before every change", "render_views": "Rendering check pictures",
               "export": "Exporting", "validate": "Re-importing the file to check it"}


def need_blender():
    if not BLENDER:
        raise ValueError("Blender isn't installed. Unzip the portable Blender into OpenMontage/.runtime/blender/, "
                         "or set BLENDER_PATH in .env to blender.exe.")


def finished_glb(job_id: str) -> tuple[dict, Path]:
    src = JOBS[job_id]
    if src["status"] != "done" or not src.get("glb"):
        raise ValueError("Only a finished model can be used.")
    glb = ROOT / src["glb"].lstrip("/")
    if not glb.is_file():
        raise ValueError("That model's file is missing.")
    return src, glb


def progress_text(report: dict) -> str:
    plan, steps = report.get("plan") or [], report.get("steps") or []
    if not steps:
        return "Starting Blender"
    cur = steps[-1]
    label = STEP_LABELS.get(cur["op"], cur["op"])
    fmt = (cur.get("params") or {}).get("format")
    if fmt:
        label += f" ({fmt.upper()})"
    return f"Step {len(steps)} of {len(plan)}: {label}"


def task_url(workdir: Path, rel: str) -> str:
    return f"/{GEN_DIR}/blender-jobs/{workdir.name}/{rel}"


def tidy_report(report: dict, workdir: Path) -> dict:
    """The worker's report with web links for its files, and without the bulky log."""
    out = {k: v for k, v in report.items() if k != "process"}
    proc = report.get("process") or {}
    out["blender_seconds"] = proc.get("seconds")
    out["report_url"] = task_url(workdir, "report.json")
    out["renders"] = [task_url(workdir, r) for r in report.get("renders") or []]
    for e in (out.get("exports") or {}).values():
        e["url"] = task_url(workdir, e["file"])
    for s in out.get("steps") or []:
        s.pop("trace", None)
    return out


def profile_summary(inspection: dict | None) -> dict | None:
    if not inspection or not inspection.get("ok"):
        return None
    return {k: {"score": v["score"], "verdict": v["verdict"], "failed": v["failed"], "warnings": v["warnings"]}
            for k, v in (inspection.get("profiles") or {}).items() if isinstance(v, dict)}


def start_task(kind: str, job_id: str, steps: list, timeout: float, on_done=None) -> dict:
    """Run a Blender job that belongs to an existing History entry (inspect / export)."""
    need_blender()
    src, glb = finished_glb(job_id)
    for t in TASKS.values():
        if t["job_id"] == job_id and t["kind"] == kind and t["status"] in ("queued", "running"):
            raise ValueError(f"Blender is already doing that ({t['progress'] or 'waiting'}).")
    workdir = BLENDER_JOBS / f"{job_id}-{kind}"
    import shutil
    shutil.rmtree(workdir, ignore_errors=True)
    task = {"id": uuid.uuid4().hex[:12], "kind": kind, "job_id": job_id, "status": "queued",
            "progress": "Waiting for Blender" if blender_runner.lock.locked() else "Starting Blender",
            "created": time.time(), "report": None, "error": None}
    TASKS[task["id"]] = task

    def work():
        def prog(r):
            task.update(status="running", progress=progress_text(r))
        try:
            report = blender_runner.run_job(BLENDER, {"input": str(glb), "steps": steps}, workdir, timeout,
                                            lambda: task["status"] == "cancelled", prog)
        except Exception as e:  # noqa: BLE001
            task.update(status="failed", error=f"Couldn't run Blender: {e}", progress=None)
            return
        if task["status"] == "cancelled":
            return
        task["report"] = tidy_report(report, workdir)
        ok = report.get("status") in ("done", "done_with_problems")
        task.update(status="done" if ok else "failed", error=report.get("error"), progress=None,
                    finished=time.time())
        if ok and on_done and job_id in JOBS:
            on_done(task)
            with jobs_lock:
                save_jobs()
    threading.Thread(target=work, daemon=True).start()
    return task


def start_inspect(job_id: str) -> dict:
    steps = [{"op": "load"}, {"op": "inspect", "label": "model", "deep": True},
             {"op": "render_views", "views": ["front", "three_quarter", "back"], "size": 480, "shading": "clay"}]

    def done(task):
        rep = task["report"]
        m = (rep.get("inspections") or {}).get("model")
        JOBS[job_id]["inspection"] = {"checked": time.time(), "summary": profile_summary(m),
                                      "renders": rep.get("renders"), "report_url": rep.get("report_url")}
    return start_task("inspect", job_id, steps, 600, done)


def start_export(job_id: str, body: dict) -> dict:
    formats = body.get("formats")
    if not isinstance(formats, list) or not formats or any(f not in EXPORT_FORMATS for f in formats):
        raise ValueError(f"Pick formats from: {', '.join(EXPORT_FORMATS)}.")
    size_cm = body.get("size_cm")
    if size_cm is not None and (isinstance(size_cm, bool) or not isinstance(size_cm, (int, float))
                                or not 0.5 <= size_cm <= 10000):
        raise ValueError("size_cm must be 0.5–10000.")
    # No "prepare": exporting must not touch the model (prepare clears the imported normals).
    steps = [{"op": "load"}]
    for f in dict.fromkeys(formats):
        steps.append({"op": "export", "format": f, "size_cm": float(size_cm or 0) if f == "stl" else 0.0})
        steps.append({"op": "validate", "format": f})

    def done(task):
        out = {}
        for f, e in (task["report"].get("exports") or {}).items():
            v = e.get("validated") or {}
            out[f] = {"url": e.get("url"), "bytes": e.get("bytes"), "ok": bool(v.get("ok")),
                      "problems": [] if v.get("ok") else (v.get("problems") or ["it couldn't be checked"])}
        JOBS[job_id]["exports"] = out
    return start_task("export", job_id, steps, 900, done)


def cancel_task(task_id: str) -> dict:
    task = TASKS[task_id]
    if task["status"] in ("queued", "running"):
        task.update(status="cancelled", progress=None)
    return task


def start_clean(job_id: str) -> dict:
    """Clean and repair a finished model with Blender. The result is a new History entry beside the original."""
    need_blender()
    src, glb = finished_glb(job_id)
    new_id = uuid.uuid4().hex[:12]
    source = None
    if src.get("source"):
        old = ROOT / src["source"].lstrip("/")
        if old.is_file():
            # Its own copy, so deleting either entry leaves the other's photo alone.
            dest = GENERATED / f"{new_id}-source{old.suffix}"
            dest.write_bytes(old.read_bytes())
            source = f"/{GEN_DIR}/{dest.name}"
    job = {
        "id": new_id, "model": src["model"], "label": f"{src.get('label') or src['model']} + Blender fix",
        "endpoint": "blender",
        "provider": "blender", "name": src["name"], "status": "queued", "created": time.time(),
        "cost": 0, "options": src.get("options") or {}, "source": source, "mock": False,
        "size_cm": src.get("size_cm"), "cleaned_from": job_id,
        "log": "Waiting for Blender" if blender_runner.lock.locked() else "Starting Blender",
    }
    with jobs_lock:
        JOBS[new_id] = job
        save_jobs()
    threading.Thread(target=run_clean, args=(job, glb), daemon=True).start()
    return job


CLEAN_STEPS = [
    {"op": "load"}, {"op": "prepare"},
    {"op": "inspect", "label": "before", "deep": True},
    {"op": "render_views", "views": ["three_quarter"], "size": 480, "shading": "clay", "tag": "before"},
    {"op": "repair", "max_triangles": 150_000},
    {"op": "inspect", "label": "after", "deep": True},
    {"op": "render_views", "views": ["three_quarter"], "size": 480, "shading": "clay", "tag": "after"},
    {"op": "export", "format": "glb"}, {"op": "validate", "format": "glb"},
]
KEY_METRICS = ("triangles", "vertices", "boundary_edges", "holes", "non_manifold_edges", "flipped_edges",
               "islands", "specks", "degenerate_triangles", "duplicate_vertices", "loose_edges", "loose_vertices",
               "self_intersecting_triangles", "watertight", "dimensions_m")


def run_clean(job: dict, glb: Path):
    workdir = BLENDER_JOBS / job["id"]

    def prog(r):
        job.update(status="running", log=progress_text(r))
    try:
        report = blender_runner.run_job(BLENDER, {"input": str(glb), "steps": CLEAN_STEPS}, workdir, 900,
                                        lambda: job["status"] == "cancelled", prog)
        if job["status"] != "cancelled":
            rep = tidy_report(report, workdir)
            exp = (rep.get("exports") or {}).get("glb") or {}
            valid = (exp.get("validated") or {}).get("ok")
            out = workdir / (exp.get("file") or "missing")
            if report.get("status") in ("done", "done_with_problems") and valid and out.is_file():
                dest = GENERATED / f"{job['id']}.glb"
                dest.write_bytes(out.read_bytes())
                summary = clean_summary(rep)
                job.update(status="done", glb=f"/{GEN_DIR}/{dest.name}", finished=time.time(), formats={}, log=None,
                           report=summary,
                           inspection={"checked": time.time(), "summary": summary["profiles_after"],
                                       "renders": [summary["renders"]["after"]] if summary["renders"]["after"] else [],
                                       "report_url": rep["report_url"]})
            elif report.get("status") in ("done", "done_with_problems"):
                why = "; ".join((exp.get("validated") or {}).get("problems") or []) or "the GLB wasn't written"
                job.update(status="failed", error=f"Blender's result didn't pass its own check: {why}", log=None)
            else:
                job.update(status="failed", error=f"Blender couldn't fix this model: {report.get('error')}", log=None)
    except Exception as e:  # noqa: BLE001
        job.update(status="failed", error=f"Couldn't run Blender: {e}", log=None)
    with jobs_lock:
        save_jobs()


def clean_summary(rep: dict) -> dict:
    """What the History entry keeps: measured before/after, each repair step, the GLB check, pictures."""
    insp = rep.get("inspections") or {}
    b, a = insp.get("before") or {}, insp.get("after") or {}
    glb = (rep.get("exports") or {}).get("glb") or {}
    renders = rep.get("renders") or []
    return {
        "ok": True, "seconds": rep.get("blender_seconds"),
        "before": {k: b.get(k) for k in KEY_METRICS}, "after": {k: a.get(k) for k in KEY_METRICS},
        "profiles_before": profile_summary(b), "profiles_after": profile_summary(a),
        "repair": rep.get("repair") or [], "validated": glb.get("validated"),
        "renders": {"before": next((u for u in renders if "/before-" in u), None),
                    "after": next((u for u in renders if "/after-" in u), None)},
        "report_url": rep.get("report_url"),
    }


def delete_job(job_id: str):
    with jobs_lock:
        JOBS.pop(job_id, None)
        save_jobs()
    for f in GENERATED.glob(f"{job_id}*"):
        try:
            f.unlink()
        except OSError:
            pass
    import shutil
    for d in BLENDER_JOBS.glob(f"{job_id}*"):
        shutil.rmtree(d, ignore_errors=True)


# --------------------------------------------------------------------------- mock provider


def mock_progress(job: dict):
    age = time.time() - job["created"]
    if age < 3:
        job["status"], job["queue_position"] = "queued", 1
    elif age < 9:
        job["status"], job["queue_position"] = "running", None
        job["log"] = ["Generating geometry", "Refining mesh", "Baking textures"][min(2, int((age - 3) / 2))]
    else:
        GENERATED.mkdir(exist_ok=True)
        (GENERATED / f"{job['id']}.glb").write_bytes(mock_glb())
        job.update(status="done", glb=f"/{GEN_DIR}/{job['id']}.glb", finished=time.time(), formats={}, log=None)


def mock_glb() -> bytes:
    """A vertex-coloured torus knot, built by hand so mock mode needs no assets."""
    tubular, radial, p, q, r_tube = 220, 24, 2, 3, 0.16
    pos, nor, col, idx = [], [], [], []

    def knot(u):
        cu, su, qu = math.cos(u), math.sin(u), q / p * u
        cs = math.cos(qu)
        return (0.5 * (2 + cs) * cu, 0.5 * (2 + cs) * su, 0.5 * math.sin(qu))

    for i in range(tubular + 1):
        u = i / tubular * p * math.pi * 2
        p1, p2 = knot(u), knot(u + 0.01)
        t = [p2[k] - p1[k] for k in range(3)]
        n = [p2[k] + p1[k] for k in range(3)]
        b = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]]
        n = [b[1] * t[2] - b[2] * t[1], b[2] * t[0] - b[0] * t[2], b[0] * t[1] - b[1] * t[0]]
        bl, nl = math.hypot(*b) or 1, math.hypot(*n) or 1
        b, n = [x / bl for x in b], [x / nl for x in n]
        for j in range(radial + 1):
            v = j / radial * math.pi * 2
            cx, cy = -r_tube * math.cos(v), r_tube * math.sin(v)
            nx = [cx * n[k] + cy * b[k] for k in range(3)]
            pos += [(p1[k] + nx[k]) * 0.55 for k in range(3)]
            ln = math.hypot(*nx) or 1
            nor += [x / ln for x in nx]
            h = i / tubular
            col += [0.95, 0.55 + 0.35 * math.sin(h * 6.28), 0.25 + 0.2 * math.cos(h * 12.56), 1.0]
    for i in range(1, tubular + 1):
        for j in range(1, radial + 1):
            a, b_, c, d = (radial + 1) * (i - 1) + j - 1, (radial + 1) * i + j - 1, (radial + 1) * i + j, (radial + 1) * (i - 1) + j
            idx += [a, b_, d, b_, c, d]

    count = len(pos) // 3
    bins = [struct.pack(f"<{len(pos)}f", *pos), struct.pack(f"<{len(nor)}f", *nor),
            struct.pack(f"<{len(col)}f", *col), struct.pack(f"<{len(idx)}I", *idx)]
    views, offset, blob = [], 0, b""
    for data in bins:
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data)})
        blob += data
        offset += len(data)
    xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
    gltf = {
        "asset": {"version": "2.0", "generator": "relief-mock"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "MockModel"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2}, "indices": 3, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.1, "roughnessFactor": 0.45}}],
        "buffers": [{"byteLength": len(blob)}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": count, "type": "VEC3",
             "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
            {"bufferView": 1, "componentType": 5126, "count": count, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": count, "type": "VEC4"},
            {"bufferView": 3, "componentType": 5125, "count": len(idx), "type": "SCALAR"},
        ],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    blob += b"\0" * (-len(blob) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(blob), 0x004E4942) + blob)


# --------------------------------------------------------------------------- text to image

# Free text-to-image (Pollinations, no key; 1 image per ~45 s per IP). The suffix steers
# the picture toward what image-to-3D models want: one whole object on a plain background.
IMAGINE_URL = "https://image.pollinations.ai/prompt/{prompt}?width=768&height=768&nologo=true&enhance=true&seed={seed}"
IMAGINE_SUFFIX = (", single object fully in frame, centered, three-quarter view, plain light grey background, "
                  "soft studio lighting, product photo, sharp focus")


class RateLimited(Exception):
    def __init__(self, message: str, retry_after: int):
        super().__init__(message)
        self.retry_after = retry_after


def imagine(prompt: str, seed: int) -> bytes:
    prompt = " ".join(str(prompt or "").split())[:300]
    if len(prompt) < 3:
        raise ValueError("Describe the object in a few words.")
    if MOCK:
        time.sleep(1.2)
        return (ROOT / "samples" / "owl.jpg").read_bytes()
    url = IMAGINE_URL.format(prompt=urllib.parse.quote(prompt + IMAGINE_SUFFIX, safe=""), seed=int(seed) % 2**31)
    req = urllib.request.Request(url, headers={"User-Agent": "relief-local/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data, kind = r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        if e.code in (402, 429):
            wait = int(e.headers.get("Retry-After") or 45)
            raise RateLimited(f"The free image AI allows one picture every 45 seconds. Try again in {wait} s.", wait)
        raise RuntimeError(f"The image AI returned an error ({e.code}). Try again in a minute.")
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("Couldn't reach the image AI. Check your internet connection.")
    if not kind.startswith("image/"):
        raise RuntimeError("The image AI didn't return a picture. Try a different description.")
    return data

# --------------------------------------------------------------------------- photo understanding

# Before a 3D run, a vision AI studies the photo and writes down what the object is and how
# its hidden sides most likely look. The app turns that into an engine choice and settings.
# Both Spaces run their model off ZeroGPU, so this doesn't touch the daily 3D quota.
VISION_SPACE = ("lmms-lab-llava-onevision-1-5", "LLaVA-OneVision-1.5-8B-Instruct")
CAPTION_SPACE = ("prithivmlmods-florence-2-image-caption", "Florence-2-large")
TEXT_AI_URL = "https://text.pollinations.ai/openai"  # keyless; text only

ANALYZE_FIELDS = """{
 "subject": one of "one object","several objects","scene" (scene = a place such as a garden, greenhouse, room, courtyard, street or landscape, not one thing you could pick up or move),
 "object": "short name, e.g. red toy robot; for a scene, name the place, e.g. greenhouse garden",
 "category": one of "character","animal","vehicle","furniture","product","toy","food","plant","building","tool","jewelry","sculpture","scene","other",
 "style": one of "realistic","stylized","cartoon","low-poly",
 "medium": one of "photo","drawing","3d render" (drawing = illustration, anime or manga art, cartoon art, painting, concept art),
 "materials": ["main materials with finish, e.g. glossy red plastic"],
 "colors": ["main colours"],
 "finish": one of "matte","glossy","metallic","mixed",
 "symmetry": one of "left-right","radial","none",
 "view": one of "front","three-quarter","side","top","back",
 "back": "what the hidden back side most likely looks like",
 "underside": "what the hidden bottom most likely looks like",
 "thin_parts": true or false (antennas, straps, wires, thin legs, rods, handles),
 "open_frame": true or false (built from bars, wires, tubes or mesh with see-through gaps, like a shopping cart, chair, bicycle, cage, basket, rack or lamp frame),
 "transparent": true or false,
 "fine_texture": true or false (printed patterns, labels, detailed paint the 3D model must keep),
 "hard_surface": true or false (machined, mechanical, sharp-edged rather than organic),
 "complexity": one of "simple","medium","complex",
 "flat": true or false (a thin flat object such as a coin, vinyl record, plate, card, painting, poster, sticker, badge or phone case),
 "size_cm": number, the real-world size of its longest side in centimetres (use the standard size for that kind of object),
 "depth_cm": number, its real-world thickness front to back in centimetres (use the standard thickness for that kind of object; flat things are thin),
 "problems": ["photo problems for 3D: cropped, several objects, busy background, blurry, dark, odd angle; empty if none"],
 "description": "one detailed sentence describing the full object from all sides for an image generator"
}"""
# "Study the main object" alone made the AI name one pot in a whole garden ("stone planter"),
# so it first has to say whether the photo is one object, several, or a place.
ANALYZE_PROMPT = ("You are preparing this photo for an image-to-3D model. First decide whether it shows one object, "
                  "several objects, or a whole place (a scene). Then study the main object, or the place if it is a "
                  "scene, and reply with ONLY a JSON object, no other text:\n" + ANALYZE_FIELDS)

ENUMS = {
    "subject": ("one object", "several objects", "scene"),
    "category": ("character", "animal", "vehicle", "furniture", "product", "toy", "food", "plant", "building",
                 "tool", "jewelry", "sculpture", "scene", "other"),
    "style": ("realistic", "stylized", "cartoon", "low-poly"),
    "medium": ("photo", "drawing", "3d render"),
    "finish": ("matte", "glossy", "metallic", "mixed"),
    "symmetry": ("left-right", "radial", "none"),
    "view": ("front", "three-quarter", "side", "top", "back"),
    "complexity": ("simple", "medium", "complex"),
}
ANALYSES: dict[str, dict] = {}  # sha1 of the image -> analysis (one photo is studied once)


def _clean_text(v, limit=160) -> str:
    return " ".join(str(v or "").split())[:limit]


def normalize_analysis(raw: dict) -> dict:
    """Coerce whatever the AI wrote into the fixed shape the planner expects."""
    out = {"object": _clean_text(raw.get("object"), 60) or "object"}
    for key, allowed in ENUMS.items():
        v = str(raw.get(key) or "").strip().lower()
        out[key] = v if v in allowed else ("other" if key == "category" else allowed[0] if key != "symmetry" else "none")
    for key in ("materials", "colors", "problems"):
        v = raw.get(key)
        items = v if isinstance(v, list) else [v] if v else []
        out[key] = [t for t in (_clean_text(i, 60) for i in items[:6]) if t and t.lower() not in ("none", "n/a")]
    for key, lo, hi in (("size_cm", 0.5, 10000), ("depth_cm", 0.01, 10000)):
        try:
            v = float(raw.get(key))
            out[key] = round(min(hi, max(lo, v)), 2) if math.isfinite(v) else None
        except (TypeError, ValueError):
            out[key] = None
    if out["size_cm"] and out["depth_cm"]:
        out["depth_cm"] = min(out["depth_cm"], out["size_cm"])
    for key in ("thin_parts", "open_frame", "transparent", "fine_texture", "hard_surface", "flat"):
        v = raw.get(key)
        out[key] = v is True or str(v).lower() in ("true", "yes", "1")
    out["back"] = _clean_text(raw.get("back")) or "much like the front, simpler"
    out["underside"] = _clean_text(raw.get("underside")) or "flat, so it can stand"
    out["description"] = _clean_text(raw.get("description"), 300) or out["object"]
    if out["subject"] == "scene":
        out["category"] = "scene"
    if out["subject"] == "several objects" and not any("several" in p.lower() for p in out["problems"]):
        out["problems"].append("several objects")
    return out


def _first_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        raise ValueError("no JSON in the reply")
    return json.loads(m.group(0))


def _ask_vision(image: bytes, content_type: str) -> dict:
    from hfspace import Space
    space = Space(VISION_SPACE[0], token=HF_TOKEN, timeout=90)
    f = space.upload(image, "photo" + (".png" if "png" in content_type else ".jpg"), content_type)
    out = space.call("chat", [{"text": ANALYZE_PROMPT, "files": [f]}, VISION_SPACE[1]])
    reply = out[0] if out and isinstance(out[0], str) else json.dumps(out[0] if out else "")
    return _first_json(reply)


def _ask_caption_then_text(image: bytes, content_type: str) -> dict:
    from hfspace import Space
    space = Space(CAPTION_SPACE[0], token=HF_TOKEN, timeout=120)
    f = space.upload(image, "photo.jpg", content_type)
    caption = str((space.call("describe_image", [f, CAPTION_SPACE[1]]) or [""])[0])
    if not caption.strip():
        raise ValueError("empty caption")
    body = {"model": "openai-fast", "messages": [{"role": "user", "content": (
        "A photo is about to be turned into a 3D model. Here is a description of the photo:\n"
        f"\"{caption[:1200]}\"\nInfer the main object and reply with ONLY a JSON object:\n{ANALYZE_FIELDS}")}]}
    for attempt in range(2):
        req = urllib.request.Request(TEXT_AI_URL, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": "relief-local/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                reply = json.loads(r.read())["choices"][0]["message"]["content"]
            return _first_json(reply)
        except urllib.error.HTTPError as e:
            if e.code != 503 or attempt:
                raise
            time.sleep(10)  # "at its limit right now, retry after 10s"
    raise RuntimeError("unreachable")


def analyze(body: dict) -> dict:
    m = re.match(r"data:(image/(?:jpeg|png|webp));base64,(.*)$", body.get("image", ""), re.S)
    if not m:
        raise ValueError("Send the photo as a base64 data URL.")
    content_type, image = m.group(1), base64.b64decode(m.group(2))
    if len(image) > 4_000_000:
        raise ValueError("The photo is too large to study; send a smaller copy.")
    key = hashlib.sha1(image).hexdigest()
    if key in ANALYSES:
        return ANALYSES[key]
    if MOCK:
        time.sleep(1.2)
        raw = {"object": "red toy robot", "category": "toy", "style": "stylized", "materials": ["glossy red plastic", "rubber wheels"],
               "colors": ["red", "black", "silver"], "finish": "glossy", "symmetry": "left-right", "view": "three-quarter",
               "back": "a plain rounded shell with a small hatch", "underside": "flat base with the wheel axles",
               "thin_parts": False, "open_frame": False, "transparent": False, "fine_texture": False, "hard_surface": True, "complexity": "medium",
               "flat": False, "size_cm": 18, "depth_cm": 9,
               "problems": [], "description": "A stylized glossy red toy robot with a round head, black eyes and three rubber wheels."}
        result = {**normalize_analysis(raw), "source": "Mock analysis"}
    else:
        errors = []
        result = None
        for label, fn in (("LLaVA-OneVision-1.5", _ask_vision), ("Florence-2 + GPT-OSS", _ask_caption_then_text)):
            try:
                result = {**normalize_analysis(fn(image, content_type)), "source": label}
                break
            except Exception as e:  # noqa: BLE001 - try the next AI
                errors.append(f"{label}: {e}")
                sys.stderr.write(f"[relief] analyze via {label} failed: {e}\n")
        if result is None:
            raise RuntimeError("The free vision AI couldn't study the photo right now. You can still generate; "
                               "the engine settings stay as they are.")
    if len(ANALYSES) > 200:
        ANALYSES.clear()
    ANALYSES[key] = result
    return result


# --------------------------------------------------------------------------- photo cleanup

# Every engine (and the vision AI) works best with the object centered, filling most of the
# frame, on a plain background. This tidies a photo toward that automatically:
#   fast path:  the background is already plain -> pure pixel math, no AI model, ~1-6 s.
#   slow path:  a busy background -> a small local segmentation model, ~20-40 s on a weak CPU,
#               so it only runs when the browser explicitly asks for it (force=True).
CLEAN_BG = "f2f0ec"   # soft neutral studio backdrop, matches IMAGINE_SUFFIX's "plain light grey"
CLEAN_PAD = 0.12       # fraction of the object's own size left empty on each side


def clean_photo(image: bytes, content_type: str, force: bool) -> dict | None:
    """Returns {"image": <bytes>, "content_type": "image/jpeg", "model": str} or None when
    nothing useful could be done (not asked to try the slow path, and the photo isn't plain)."""
    import sys as _sys
    import tempfile
    from pathlib import Path as _Path

    if str(ROOT.parent) not in _sys.path:
        _sys.path.insert(0, str(ROOT.parent))
    from tools.enhancement.cutout_engine import cutout
    from PIL import Image

    ext = {"image/png": ".png", "image/webp": ".webp"}.get(content_type, ".jpg")
    tmp = _Path(tempfile.mkdtemp(prefix="relief-clean-"))
    try:
        src = tmp / f"in{ext}"
        src.write_bytes(image)
        out = tmp / "out.png"
        try:
            result = cutout(src, out, model="lite", trim=False, decontaminate=True,
                            plain_bg=("auto" if force else "on"))
        except ValueError:
            return None  # background isn't plain, and the slow path wasn't asked for
        cut = Image.open(out).convert("RGBA")
        # Which picture edges the object runs into: that part is cut off, and the engine will
        # either end it abruptly or invent it. Checked before cropping, while the edges exist.
        alpha = cut.getchannel("A")
        w, h = cut.size
        solid = lambda box, n: sum(1 for v in alpha.crop(box).getdata() if v > 128) / n > 0.01  # noqa: E731
        cut_off = [side for side, box, n in (
            ("top", (0, 0, w, 1), w), ("bottom", (0, h - 1, w, h), w),
            ("left", (0, 0, 1, h), h), ("right", (w - 1, 0, w, h), h)) if solid(box, n)]
        bbox = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
        if not bbox:
            return None
        cut = cut.crop(bbox)
        if cut.width < 4 or cut.height < 4:
            return None
        pad = round(max(cut.width, cut.height) * CLEAN_PAD)
        canvas = Image.new("RGBA", (cut.width + pad * 2, cut.height + pad * 2),
                           tuple(int(CLEAN_BG[i:i + 2], 16) for i in (0, 2, 4)) + (255,))
        canvas.alpha_composite(cut, (pad, pad))
        buf = tmp / "final.jpg"
        canvas.convert("RGB").save(buf, "JPEG", quality=92)
        return {"image": buf.read_bytes(), "content_type": "image/jpeg", "model": result.model, "cut_off": cut_off}
    finally:
        for f in tmp.glob("*"):
            f.unlink(missing_ok=True)
        tmp.rmdir()


# --------------------------------------------------------------------------- server


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".wasm": "application/wasm",
        ".jpg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".glb": "model/gltf-binary",
        ".stl": "model/stl",
        ".obj": "model/obj",
        ".fbx": "application/octet-stream",
        ".ply": "application/octet-stream",
        ".usdz": "model/vnd.usdz+zip",
        ".blend": "application/octet-stream",
        ".zip": "application/zip",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/jobs/" in str(args[0] if args else ""):
            return  # polling is noisy
        sys.stderr.write("[relief] " + (fmt % args) + "\n")

    # -- request checks

    def allowed(self, write=False) -> bool:
        hosts = {f"localhost:{PORT}", f"127.0.0.1:{PORT}", f"[::1]:{PORT}"}
        if self.headers.get("Host", "") not in hosts:
            self.reply({"error": "Wrong host."}, 403)
            return False
        if write:
            origin = self.headers.get("Origin")
            if origin and origin.split("://", 1)[-1] not in hosts:
                self.reply({"error": "Cross-site requests are not allowed."}, 403)
                return False
            has_body = int(self.headers.get("Content-Length") or 0) > 0
            if has_body and not self.headers.get("Content-Type", "").startswith("application/json"):
                self.reply({"error": "Send JSON."}, 415)
                return False
        return True

    # -- routing

    def do_GET(self):
        if not self.allowed():
            return None
        if any(part.startswith(".") for part in urllib.parse.urlsplit(self.path).path.split("/")):
            return self.reply({"error": "Not found."}, 404)
        if self.path == "/api/config":
            return self.reply({"fal": bool(FAL_KEY) or MOCK, "hf": True, "hfToken": bool(HF_TOKEN), "mock": MOCK,
                               "blender": bool(BLENDER),
                               "hfQuota": None if MOCK else quota_status()})
        if self.path == "/api/blender/status":
            return self.reply(BLENDER_DIAG.status())
        m = re.fullmatch(r"/api/blender/tasks/(\w+)", self.path)
        if m:
            task = TASKS.get(m.group(1))
            return self.reply(task) if task else self.reply({"error": "Task not found."}, 404)
        if self.path == "/api/jobs":
            jobs = sorted(JOBS.values(), key=lambda j: j["created"], reverse=True)
            return self.reply([public(j) for j in jobs])
        m = re.fullmatch(r"/api/jobs/(\w+)", self.path)
        if m:
            return self.guard(lambda: public(poll_job(m.group(1))))
        if self.path.startswith("/api/"):
            return self.reply({"error": "Not found."}, 404)
        return super().do_GET()

    def do_POST(self):
        if not self.allowed(write=True):
            return None
        if self.path == "/api/generate":
            return self.guard(lambda: public(create_job(self.body())), 201)
        if self.path == "/api/local-jobs":
            return self.guard(lambda: public(save_local_job(self.body())), 201)
        if self.path == "/api/imagine":
            try:
                body = self.body()
                data = imagine(body.get("prompt"), body.get("seed") or int(time.time()))
            except RateLimited as e:
                return self.reply({"error": str(e), "retryAfter": e.retry_after}, 429)
            except ValueError as e:
                return self.reply({"error": str(e)}, 400)
            except Exception as e:  # noqa: BLE001
                return self.reply({"error": str(e)}, 502)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None
        if self.path == "/api/cleanup":
            try:
                body = self.body()
                m = re.match(r"data:(image/(?:jpeg|png|webp));base64,(.*)$", body.get("image", ""), re.S)
                if not m:
                    raise ValueError("Send the photo as a base64 data URL.")
                image = base64.b64decode(m.group(2))
                if len(image) > 8 * 1024 * 1024:
                    raise ValueError("Photo is too large.")
                if MOCK:
                    return self.reply({"image": None, "changed": False})
                cleaned = clean_photo(image, m.group(1), bool(body.get("force")))
                if not cleaned:
                    return self.reply({"image": None, "changed": False})
                data_url = f"data:{cleaned['content_type']};base64," + base64.b64encode(cleaned["image"]).decode()
                return self.reply({"image": data_url, "changed": True, "model": cleaned["model"],
                                   "cut_off": cleaned["cut_off"]})
            except ValueError as e:
                return self.reply({"error": str(e)}, 400)
            except Exception as e:  # noqa: BLE001
                return self.reply({"error": str(e)}, 502)
        if self.path == "/api/analyze":
            try:
                return self.reply(analyze(self.body()))
            except ValueError as e:
                return self.reply({"error": str(e)}, 400)
            except Exception as e:  # noqa: BLE001
                return self.reply({"error": str(e)}, 502)
        m = re.fullmatch(r"/api/jobs/(\w+)/cancel", self.path)
        if m:
            return self.guard(lambda: public(cancel_job(m.group(1))))
        m = re.fullmatch(r"/api/jobs/(\w+)/clean", self.path)
        if m:
            return self.guard(lambda: public(start_clean(m.group(1))), 201)
        m = re.fullmatch(r"/api/jobs/(\w+)/inspect", self.path)
        if m:
            return self.guard(lambda: start_inspect(m.group(1)), 201)
        m = re.fullmatch(r"/api/jobs/(\w+)/export", self.path)
        if m:
            return self.guard(lambda: start_export(m.group(1), self.body()), 201)
        m = re.fullmatch(r"/api/blender/tasks/(\w+)/cancel", self.path)
        if m:
            return self.guard(lambda: cancel_task(m.group(1)))
        if self.path == "/api/blender/check":
            if BLENDER_DIAG.running:
                return self.reply(BLENDER_DIAG.status())
            threading.Thread(target=BLENDER_DIAG.check, daemon=True).start()
            time.sleep(0.05)
            return self.reply({**BLENDER_DIAG.status(), "checking": True}, 202)
        return self.reply({"error": "Not found."}, 404)

    def do_DELETE(self):
        if not self.allowed(write=True):
            return None
        m = re.fullmatch(r"/api/jobs/(\w+)", self.path)
        if m:
            return self.guard(lambda: (delete_job(m.group(1)), {"ok": True})[1])
        return self.reply({"error": "Not found."}, 404)

    # -- helpers

    def body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 64 * 1024 * 1024:
            raise ValueError("Request too large.")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_HEAD(self):
        if self.allowed():
            super().do_HEAD()

    def guard(self, fn, ok=200):
        try:
            return self.reply(fn(), ok)
        except KeyError:
            return self.reply({"error": "Job not found."}, 404)
        except ValueError as e:
            return self.reply({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001 - report provider/network errors to the UI
            return self.reply({"error": str(e)}, 502)

    def reply(self, data, code=200):
        raw = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        mode = "MOCK provider (no charges)" if MOCK else (
            f"fal.ai key {'found' if FAL_KEY else 'missing'}, Hugging Face token {'found' if HF_TOKEN else 'missing (free tier limits)'}")
        print(f"Relief running at http://localhost:{PORT}  [{mode}]")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
