"""HTTP API (FastAPI). All heavy work is delegated to background jobs."""

from __future__ import annotations

import logging
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from . import storage
from .config import settings
from .jobs import queue
from .jobs.tasks import load_context, regenerate_metadata
from .models import Clip, ExportFile, Job, Project, SessionLocal, SourceVideo, User, UserPreference, init_db
from .pipeline import captions, llm, transcribe, youtube
from .pipeline.edit import compute_plan, merged_edit
from .pipeline.media import MediaError, ffmpeg_filters, probe, tool_available

log = logging.getLogger("capclip.api")
COOKIE = "capclip_session"
_worker = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _worker
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_db()
    if settings.embedded_worker:
        from .jobs.worker import Worker

        _worker = Worker()
        _worker.start()
    yield
    if _worker:
        _worker.shutdown()


app = FastAPI(title="CapClip API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


# ---------------------------------------------------------------------------
# Session / users

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def current_user(request: Request, response: Response, db=Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE)
    user = db.scalar(select(User).where(User.session_token == token)) if token else None
    if user is not None:
        return user
    # Adopt a well-formed token minted by the web middleware; otherwise mint one.
    adopt = bool(token and re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token))
    if not adopt:
        token = secrets.token_urlsafe(32)
    user = User(session_token=token)
    user.preferences = UserPreference(retention_days=settings.retention_days)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # A concurrent first request created this workspace a moment ago.
        db.rollback()
        user = db.scalar(select(User).where(User.session_token == token))
    if not adopt:
        response.set_cookie(COOKIE, token, httponly=True, samesite="lax", max_age=60 * 60 * 24 * 365, path="/")
    return user


def owned_project(db, user: User, pid: str) -> Project:
    p = db.get(Project, pid)
    if p is None or p.user_id != user.id:
        raise HTTPException(404, "Project not found")
    return p


def owned_clip(db, user: User, cid: str) -> Clip:
    c = db.get(Clip, cid)
    if c is None or c.project.user_id != user.id:
        raise HTTPException(404, "Clip not found")
    return c


# ---------------------------------------------------------------------------
# Serialisers

def _iso(dt) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def clip_out(c: Clip, detail: bool = False) -> dict[str, Any]:
    edit = merged_edit(c.edit)
    rendered_version = (c.qa or {}).get("rendered_edit_version")
    caption = captions.resolve_style(edit.get("caption"))
    out = {
        "id": c.id, "project_id": c.project_id, "index": c.index, "status": c.status, "title": c.title, "hook": c.hook,
        "reason": c.reason, "category": c.category, "score": c.score, "source_start": c.source_start, "source_end": c.source_end,
        "duration": c.duration, "caption_preset": caption["preset"], "caption_preset_label": caption["label"], "analyzer": c.analyzer,
        "publish": c.publish, "warnings": c.warnings or [], "render_version": c.render_version, "edit_version": c.edit_version,
        "needs_render": c.render_version == 0 or (rendered_version is not None and rendered_version != c.edit_version) or c.status == "draft",
        "video_url": storage.signed_url(c.render_path) if c.render_path else None,
        "download_url": storage.signed_url(c.render_path, download_name=_dl_name(c, "mp4")) if c.render_path else None,
        "thumb_url": storage.signed_url(c.thumb_path) if c.thumb_path else None,
        "srt_url": None, "qa": c.qa or {}, "created_at": _iso(c.created_at), "updated_at": _iso(c.updated_at),
        "project_title": c.project.title if c.project else None,
    }
    srt = next((t for t in c.caption_tracks if t.kind == "srt"), None)
    if srt:
        out["srt_url"] = storage.signed_url(srt.path, download_name=_dl_name(c, "srt"))
    if detail:
        out["edit"] = edit
        out["ai_edit"] = merged_edit(c.ai_edit)
    return out


def _dl_name(c: Clip, ext: str) -> str:
    slug = re.sub(r"[^\w\s-]", "", (c.title or "clip").lower()).strip()
    slug = re.sub(r"[\s_-]+", "-", slug)[:48] or "clip"
    return f"capclip-{c.index + 1:02d}-{slug}.{ext}"


def project_out(p: Project, detail: bool = False, db=None) -> dict[str, Any]:
    src = p.source
    clips = p.clips
    out = {
        "id": p.id, "title": p.title, "status": p.status, "stage": p.stage, "progress": p.progress, "eta_seconds": p.eta_seconds,
        "message": p.message, "error": p.error if p.status == "failed" else None, "source_kind": p.source_kind,
        "youtube_url": p.youtube_url, "youtube_id": p.youtube_id, "options": p.options, "warnings": p.warnings or [],
        "summary": p.summary or {}, "created_at": _iso(p.created_at), "updated_at": _iso(p.updated_at),
        "clip_count": len(clips), "clips_ready": sum(1 for c in clips if c.status == "ready"),
        "thumbnail": (src.meta or {}).get("thumbnail") if src else None,
        "cover_url": next((storage.signed_url(c.thumb_path) for c in clips if c.thumb_path), None),
        "source": None,
    }
    if src:
        out["source"] = {
            "origin": src.origin, "filename": src.original_filename, "duration": src.duration, "width": src.width, "height": src.height,
            "fps": src.fps, "size_bytes": src.size_bytes, "has_file": bool(src.path and Path(src.path).exists()), "meta": src.meta or {},
            "analysis": src.analysis or {}, "subtitle_streams": src.subtitle_streams or [], "rights_attested": src.rights_attested,
            "proxy_url": storage.signed_url(src.proxy_path) if detail and src.proxy_path else None,
        }
    if detail:
        out["clips"] = [clip_out(c) for c in clips]
        jobs = sorted(p.jobs, key=lambda j: j.created_at, reverse=True)
        out["jobs"] = [job_out(j) for j in jobs[:50]]
    return out


def job_out(j: Job) -> dict[str, Any]:
    return {"id": j.id, "kind": j.kind, "status": j.status, "stage": j.stage, "progress": j.progress, "message": j.message,
            "error": (j.error or "").splitlines()[0][:300] if j.error else None, "attempts": j.attempts, "max_attempts": j.max_attempts,
            "project_id": j.project_id, "clip_id": j.clip_id, "created_at": _iso(j.created_at), "started_at": _iso(j.started_at),
            "finished_at": _iso(j.finished_at), "cancel_requested": j.cancel_requested}


# ---------------------------------------------------------------------------
# System

@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/system/status")
def system_status():
    ff = tool_available(settings.ffmpeg_binary)
    filters = ffmpeg_filters() if ff else set()
    return {
        "ffmpeg": {"available": ff, "libass": "ass" in filters, "loudnorm": "loudnorm" in filters},
        "transcription": transcribe.describe(),
        "ai": llm.describe(),
        "retrieval": youtube.retrieval_status(),
        "limits": {"max_upload_mb": settings.max_upload_mb, "max_source_minutes": settings.max_source_minutes,
                   "min_clip_seconds": settings.min_clip_seconds, "max_clip_seconds": settings.max_clip_seconds,
                   "max_clips_per_project": settings.max_clips_per_project or None, "retention_days": settings.retention_days},
        "caption_presets": [{"id": k, **v} for k, v in captions.PRESETS.items()],
        "fonts": captions.available_fonts(),
        "speaker_labels": False,
        "inpainting": False,
    }


# ---------------------------------------------------------------------------
# YouTube validation + projects

class ValidateIn(BaseModel):
    url: str


@app.post("/api/youtube/validate")
def validate_url(body: ValidateIn):
    try:
        vid = youtube.parse_video_id(body.url)
    except youtube.InvalidYouTubeURL as exc:
        raise HTTPException(422, str(exc)) from exc
    meta = youtube.fetch_metadata(vid)
    return {"video_id": vid, "url": youtube.canonical_url(vid), "metadata": meta, "retrieval": youtube.retrieval_status()}


class ProjectIn(BaseModel):
    youtube_url: Optional[str] = None
    title: Optional[str] = None
    rights_attested: bool = False
    caption_preset: Optional[str] = None
    burned_text_strategy: Optional[Literal["auto", "mask", "crop", "reposition", "none"]] = None
    language: Optional[str] = Field(default=None, max_length=8)


@app.post("/api/projects", status_code=201)
def create_project(body: ProjectIn, user: User = Depends(current_user), db=Depends(get_db)):
    meta: dict[str, Any] = {}
    vid = None
    if body.youtube_url:
        try:
            vid = youtube.parse_video_id(body.youtube_url)
        except youtube.InvalidYouTubeURL as exc:
            raise HTTPException(422, str(exc)) from exc
        meta = youtube.fetch_metadata(vid)
        if meta.get("available") is False:
            raise HTTPException(422, meta.get("reason") or "That video isn't publicly available.")
        if meta.get("duration") and meta["duration"] > settings.max_source_minutes * 60:
            raise HTTPException(422, f"This video is {meta['duration'] / 60:.0f} minutes; the limit is {settings.max_source_minutes} minutes.")
    if body.caption_preset and body.caption_preset not in captions.PRESETS:
        raise HTTPException(422, "Unknown caption preset")
    project = Project(
        user_id=user.id, title=(body.title or meta.get("title") or "Untitled project")[:300], source_kind="youtube" if vid else "upload",
        youtube_url=youtube.canonical_url(vid) if vid else None, youtube_id=vid,
        options={k: v for k, v in {"caption_preset": body.caption_preset, "burned_text_strategy": body.burned_text_strategy,
                                   "language": body.language}.items() if v},
    )
    project.source = SourceVideo(origin="youtube" if vid else "upload", meta=meta, rights_attested=body.rights_attested)
    db.add(project)
    retrieval = youtube.retrieval_status()
    if vid and retrieval["youtube_download_enabled"] and body.rights_attested:
        project.status, project.stage, project.message = "queued", "queued", "Waiting for a worker"
        db.flush()
        queue.enqueue(db, "analyze", project.id)
    else:
        project.status, project.stage = "awaiting_source", "awaiting_source"
        if vid and not retrieval["youtube_download_enabled"]:
            project.message = "Direct YouTube retrieval isn't enabled on this server. Upload the video file for this link to continue."
        elif vid and not body.rights_attested:
            project.message = "Confirm you have the rights to process this video, or upload the file."
        else:
            project.message = "Upload a video file to continue."
    db.commit()
    db.refresh(project)
    return project_out(project, detail=True)


@app.get("/api/projects")
def list_projects(status: Optional[str] = None, user: User = Depends(current_user), db=Depends(get_db)):
    q = select(Project).where(Project.user_id == user.id).order_by(Project.created_at.desc())
    if status:
        q = q.where(Project.status.in_(status.split(",")))
    return [project_out(p) for p in db.scalars(q)]


@app.get("/api/projects/{pid}")
def get_project(pid: str, user: User = Depends(current_user), db=Depends(get_db)):
    return project_out(owned_project(db, user, pid), detail=True)


class ProjectPatch(BaseModel):
    title: Optional[str] = Field(default=None, max_length=300)


@app.patch("/api/projects/{pid}")
def patch_project(pid: str, body: ProjectPatch, user: User = Depends(current_user), db=Depends(get_db)):
    p = owned_project(db, user, pid)
    if body.title:
        p.title = body.title
    db.commit()
    return project_out(p, detail=True)


ALLOWED_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"}
CHUNK_MAX = 16 * 1024 * 1024


@app.put("/api/projects/{pid}/upload")
async def upload_chunk(pid: str, request: Request, offset: int = Query(..., ge=0), total: int = Query(..., gt=0),
                       filename: str = Query(..., max_length=400), user: User = Depends(current_user), db=Depends(get_db)):
    """Resumable chunked upload: PUT successive byte ranges; the last chunk triggers processing."""
    p = owned_project(db, user, pid)
    if p.status not in ("awaiting_source", "failed", "draft", "cancelled"):
        raise HTTPException(409, "This project already has a source being processed.")
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(415, f"Unsupported file type {ext or '(none)'}. Use MP4, MOV, MKV, WEBM or AVI.")
    if total > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"File is larger than the {settings.max_upload_mb} MB limit.")
    part = storage.project_dir(pid, "uploads") / "source.part"
    current = part.stat().st_size if part.exists() else 0
    if offset == 0 and current:
        part.unlink()
        current = 0
    if offset != current:
        return JSONResponse({"received": current, "complete": False}, status_code=409)
    body = await request.body()
    if len(body) > CHUNK_MAX:
        raise HTTPException(413, "Chunk too large")
    with open(part, "ab") as fh:
        fh.write(body)
    received = current + len(body)
    if received < total:
        return {"received": received, "complete": False}
    if received != total:
        part.unlink(missing_ok=True)
        raise HTTPException(400, "Upload size mismatch; please retry.")
    dest_dir = storage.project_dir(pid, "sources")
    for old in dest_dir.glob("source.*"):
        old.unlink(missing_ok=True)
    dest = dest_dir / f"source{ext}"
    part.replace(dest)
    try:
        info = probe(dest)
    except MediaError as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(422, "That file couldn't be read as a video. " + str(exc)[:200]) from exc
    if not info["has_video"]:
        dest.unlink(missing_ok=True)
        raise HTTPException(422, "That file has no video stream.")
    if info["duration"] > settings.max_source_minutes * 60:
        dest.unlink(missing_ok=True)
        raise HTTPException(422, f"Video is {info['duration'] / 60:.0f} minutes; the limit is {settings.max_source_minutes} minutes.")
    src = p.source or SourceVideo(project_id=p.id)
    src.path, src.original_filename, src.size_bytes, src.duration = str(dest), filename, received, info["duration"]
    src.width, src.height, src.fps = info["width"], info["height"], info["fps"]
    p.source = src
    if p.title in ("Untitled project", "") and p.source_kind == "upload":
        p.title = Path(filename).stem[:300]
    p.status, p.stage, p.progress, p.message, p.error = "queued", "queued", 0.0, "Waiting for a worker", None
    queue.enqueue(db, "analyze", p.id)
    db.commit()
    return {"received": received, "complete": True, "project": project_out(p, detail=True)}


@app.post("/api/projects/{pid}/start")
def start_project(pid: str, user: User = Depends(current_user), db=Depends(get_db)):
    """Start (or retry) analysis. Cached transcript/frames are reused on retry."""
    p = owned_project(db, user, pid)
    if p.status in ("queued", "processing"):
        raise HTTPException(409, "Already processing")
    has_file = p.source and p.source.path and Path(p.source.path).exists()
    if not has_file:
        if p.source_kind != "youtube" or not youtube.retrieval_status()["youtube_download_enabled"]:
            raise HTTPException(409, "Upload the video file first.")
        if not (p.source and p.source.rights_attested):
            raise HTTPException(409, "Confirm you have the rights to process this video.")
    # Re-analysis replaces the clips, so pending renders of the old ones are moot.
    queue.cancel_jobs(db, project_id=p.id, kinds=("render",))
    p.status, p.stage, p.progress, p.message, p.error = "queued", "queued", 0.0, "Waiting for a worker", None
    queue.enqueue(db, "analyze", p.id)
    db.commit()
    return project_out(p, detail=True)


@app.post("/api/projects/{pid}/attest")
def attest(pid: str, user: User = Depends(current_user), db=Depends(get_db)):
    p = owned_project(db, user, pid)
    if p.source:
        p.source.rights_attested = True
    db.commit()
    return project_out(p, detail=True)


@app.post("/api/projects/{pid}/cancel")
def cancel_project(pid: str, user: User = Depends(current_user), db=Depends(get_db)):
    p = owned_project(db, user, pid)
    n = queue.cancel_jobs(db, project_id=pid)
    if p.status in ("queued", "processing"):
        p.status, p.message = ("cancelled", "Cancelled") if p.status == "queued" else (p.status, "Cancelling…")
    for c in p.clips:
        if c.status == "queued":
            c.status = "draft"
    db.commit()
    return {"cancelled_jobs": n, "project": project_out(p, detail=True)}


@app.delete("/api/projects/{pid}", status_code=204)
def delete_project(pid: str, user: User = Depends(current_user), db=Depends(get_db)):
    p = owned_project(db, user, pid)
    queue.cancel_jobs(db, project_id=pid)
    db.delete(p)
    db.commit()
    storage.purge_project_files(pid)
    return Response(status_code=204)


@app.get("/api/projects/{pid}/transcript")
def get_transcript(pid: str, user: User = Depends(current_user), db=Depends(get_db)):
    p = owned_project(db, user, pid)
    return {"segments": [{"index": s.index, "start": s.start, "end": s.end, "text": s.text, "speaker": s.speaker,
                          "word_offset": s.word_offset, "words": s.words} for s in p.segments]}


# ---------------------------------------------------------------------------
# Clips

@app.get("/api/clips")
def list_clips(project_id: Optional[str] = None, status: Optional[str] = None, user: User = Depends(current_user), db=Depends(get_db)):
    q = select(Clip).join(Project).where(Project.user_id == user.id)
    if project_id:
        q = q.where(Clip.project_id == project_id)
    if status:
        q = q.where(Clip.status.in_(status.split(",")))
    return [clip_out(c) for c in db.scalars(q.order_by(Clip.created_at.desc()))]


def clip_detail(db, c: Clip) -> dict[str, Any]:
    """Everything the editor needs. Every endpoint that changes a clip returns this,
    so the editor can swap its state wholesale after a save/render/reset."""
    ctx = load_context(db, c.project_id)
    out = clip_out(c, detail=True)
    out["plan"] = compute_plan(ctx["words"], out["edit"])
    out["ai_plan_duration"] = compute_plan(ctx["words"], out["ai_edit"])["duration"]
    src = c.project.source
    out["source"] = {"proxy_url": storage.signed_url(src.proxy_path), "width": src.width, "height": src.height, "duration": src.duration,
                     "burned_text": (src.analysis or {}).get("burned_text")}
    # Words around the clip so the editor can extend the range.
    pad = 30.0
    out["context_words"] = [w for w in ctx["words"] if c.source_start - pad <= w["s"] <= c.source_end + pad]
    from .pipeline import reframe

    out["framing_stats"] = reframe.analyse_range(ctx["frames"], c.source_start, c.source_end)
    out["face_track"] = [{"t": f["t"], "faces": f["faces"]} for f in ctx["frames"] if c.source_start - pad <= f["t"] <= c.source_end + pad]
    return out


@app.get("/api/clips/{cid}")
def get_clip(cid: str, user: User = Depends(current_user), db=Depends(get_db)):
    return clip_detail(db, owned_clip(db, user, cid))


class EditIn(BaseModel):
    edit: dict[str, Any]


def _validate_edit(edit: dict[str, Any], source_duration: float) -> dict[str, Any]:
    e = merged_edit(edit)
    try:
        e["start"], e["end"] = float(e["start"]), float(e["end"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(422, "Edit needs numeric start and end") from exc
    if not (0 <= e["start"] < e["end"] <= source_duration + 0.5):
        raise HTTPException(422, "Range is outside the source video")
    e["speed"] = max(0.5, min(2.0, float(e.get("speed") or 1)))
    e["volume_db"] = max(-20.0, min(20.0, float(e.get("volume_db") or 0)))
    e["max_pause"] = max(0.15, min(3.0, float(e.get("max_pause") or 0.38)))
    if e.get("caption", {}).get("preset") and e["caption"]["preset"] not in captions.PRESETS:
        raise HTTPException(422, "Unknown caption preset")
    layout = (e.get("framing") or {}).get("layout", "auto")
    if layout not in ("auto", "fill", "blur", "split", "fit"):
        raise HTTPException(422, "Unknown layout")
    return e


@app.post("/api/clips/{cid}/plan")
def preview_plan(cid: str, body: EditIn, user: User = Depends(current_user), db=Depends(get_db)):
    c = owned_clip(db, user, cid)
    e = _validate_edit(body.edit, c.project.source.duration)
    ctx = load_context(db, c.project_id)
    plan = compute_plan(ctx["words"], e)
    lo, hi = settings.min_clip_seconds, settings.max_clip_seconds
    return {"plan": plan, "valid": lo - 0.5 <= plan["duration"] <= hi + 0.5,
            "message": None if lo - 0.5 <= plan["duration"] <= hi + 0.5 else f"Final duration {plan['duration']:.1f}s - Shorts must be {lo:.0f}-{hi:.0f}s."}


class ClipPatch(BaseModel):
    edit: Optional[dict[str, Any]] = None
    title: Optional[str] = Field(default=None, max_length=300)
    publish: Optional[dict[str, Any]] = None
    render: bool = False


@app.put("/api/clips/{cid}")
def save_clip(cid: str, body: ClipPatch, user: User = Depends(current_user), db=Depends(get_db)):
    c = owned_clip(db, user, cid)
    if c.status == "rendering":
        raise HTTPException(409, "This clip is rendering; wait for it to finish before saving new edits.")
    if body.edit is not None:
        e = _validate_edit(body.edit, c.project.source.duration)
        ctx = load_context(db, c.project_id)
        plan = compute_plan(ctx["words"], e)
        lo, hi = settings.min_clip_seconds, settings.max_clip_seconds
        if body.render and not (lo - 0.5 <= plan["duration"] <= hi + 0.5):
            raise HTTPException(422, f"Final duration is {plan['duration']:.1f}s; Shorts must be {lo:.0f}-{hi:.0f}s.")
        if e != merged_edit(c.edit):  # metadata-only saves keep the render current
            c.edit = e
            c.source_start, c.source_end = e["start"], e["end"]
            c.hook = (e.get("hook") or {}).get("text", c.hook)
            c.edit_version += 1
    if body.title is not None:
        c.title = body.title
    if body.publish is not None:
        allowed = {"title", "hook", "titles", "description", "hashtags", "keywords", "pinned_comment", "thumbnail_text"}
        c.publish = {**(c.publish or {}), **{k: v for k, v in body.publish.items() if k in allowed}}
        if "title" in body.publish and body.title is None:
            c.title = body.publish["title"]
    if body.render:
        _enqueue_render(db, c)
    db.commit()
    db.refresh(c)
    return clip_detail(db, c)


def _enqueue_render(db, c: Clip) -> None:
    queue.cancel_jobs(db, clip_id=c.id, kinds=("render",))
    c.status = "queued"
    queue.enqueue(db, "render", c.project_id, clip_id=c.id, priority=90)
    p = c.project
    if p.status == "completed":
        p.status, p.stage, p.message = "rendering", "rendering", "Re-rendering edited clips"


@app.post("/api/clips/{cid}/render")
def render_clip(cid: str, user: User = Depends(current_user), db=Depends(get_db)):
    c = owned_clip(db, user, cid)
    ctx = load_context(db, c.project_id)
    plan = compute_plan(ctx["words"], merged_edit(c.edit))
    lo, hi = settings.min_clip_seconds, settings.max_clip_seconds
    if not (lo - 0.5 <= plan["duration"] <= hi + 0.5):
        raise HTTPException(422, f"Final duration is {plan['duration']:.1f}s; Shorts must be {lo:.0f}-{hi:.0f}s.")
    _enqueue_render(db, c)
    db.commit()
    return clip_detail(db, c)


@app.post("/api/clips/{cid}/reset")
def reset_clip(cid: str, user: User = Depends(current_user), db=Depends(get_db)):
    c = owned_clip(db, user, cid)
    c.edit = dict(c.ai_edit)
    c.source_start, c.source_end = c.ai_edit["start"], c.ai_edit["end"]
    c.edit_version += 1
    db.commit()
    return clip_detail(db, c)


class RegenIn(BaseModel):
    mode: Literal["metadata", "full"] = "full"


@app.post("/api/clips/{cid}/regenerate")
def regenerate(cid: str, body: RegenIn, user: User = Depends(current_user), db=Depends(get_db)):
    c = owned_clip(db, user, cid)
    if c.status == "rendering":
        raise HTTPException(409, "Clip is rendering")
    try:
        meta = regenerate_metadata(db, c)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Couldn't regenerate metadata: {str(exc)[:200]}") from exc
    c.publish = meta
    c.title = meta.get("title") or c.title
    c.hook = meta.get("hook") or c.hook
    if body.mode == "full":
        edit = dict(c.ai_edit)
        edit["hook"] = {**(edit.get("hook") or {}), "text": c.hook}
        c.edit = edit
        c.source_start, c.source_end = edit["start"], edit["end"]
        c.edit_version += 1
        _enqueue_render(db, c)
    db.commit()
    return clip_detail(db, c)


@app.delete("/api/clips/{cid}", status_code=204)
def delete_clip(cid: str, user: User = Depends(current_user), db=Depends(get_db)):
    c = owned_clip(db, user, cid)
    queue.cancel_jobs(db, clip_id=c.id)
    for path in (c.render_path, c.thumb_path, *[t.path for t in c.caption_tracks]):
        if path:
            Path(path).unlink(missing_ok=True)
    pid = c.project_id
    db.delete(c)
    db.commit()
    from .jobs.tasks import _refresh_project

    _refresh_project(db, pid)
    return Response(status_code=204)


@app.get("/api/clips/{cid}/download")
def download_clip(cid: str, user: User = Depends(current_user), db=Depends(get_db)):
    c = owned_clip(db, user, cid)
    if not c.render_path or not Path(c.render_path).exists():
        raise HTTPException(404, "This clip hasn't been rendered yet")
    return RedirectResponse(storage.signed_url(c.render_path, download_name=_dl_name(c, "mp4")))


# ---------------------------------------------------------------------------
# Exports

class ExportIn(BaseModel):
    project_id: str
    clip_ids: list[str] = Field(min_length=1)
    include_srt: bool = True


def export_out(e: ExportFile, db) -> dict[str, Any]:
    p = db.get(Project, e.project_id)
    return {"id": e.id, "project_id": e.project_id, "project_title": p.title if p else None, "status": e.status, "clip_count": len(e.clip_ids),
            "include_srt": e.include_srt, "size_bytes": e.size_bytes, "error": e.error, "created_at": _iso(e.created_at),
            "download_url": storage.signed_url(e.path, download_name=f"capclip-{(p.title if p else 'export')[:40]}.zip".replace(" ", "-")) if e.path else None}


@app.post("/api/exports", status_code=201)
def create_export(body: ExportIn, user: User = Depends(current_user), db=Depends(get_db)):
    p = owned_project(db, user, body.project_id)
    ids = [c.id for c in p.clips if c.id in set(body.clip_ids)]
    ready = [c for c in p.clips if c.id in ids and c.status == "ready"]
    if not ready:
        raise HTTPException(422, "Select at least one finished clip to export.")
    ex = ExportFile(user_id=user.id, project_id=p.id, clip_ids=[c.id for c in ready], include_srt=body.include_srt)
    db.add(ex)
    db.flush()
    queue.enqueue(db, "export", p.id, export_id=ex.id)
    db.commit()
    return export_out(ex, db)


@app.get("/api/exports")
def list_exports(user: User = Depends(current_user), db=Depends(get_db)):
    rows = db.scalars(select(ExportFile).where(ExportFile.user_id == user.id).order_by(ExportFile.created_at.desc()).limit(100))
    return [export_out(e, db) for e in rows]


@app.get("/api/exports/{eid}")
def get_export(eid: str, user: User = Depends(current_user), db=Depends(get_db)):
    e = db.get(ExportFile, eid)
    if e is None or e.user_id != user.id:
        raise HTTPException(404, "Export not found")
    return export_out(e, db)


# ---------------------------------------------------------------------------
# Jobs

@app.get("/api/jobs")
def list_jobs(active: bool = False, user: User = Depends(current_user), db=Depends(get_db)):
    q = select(Job).join(Project).where(Project.user_id == user.id)
    if active:
        q = q.where(Job.status.in_(("queued", "running")))
    rows = db.scalars(q.order_by(Job.created_at.desc()).limit(200)).all()
    titles = {p.id: p.title for p in db.scalars(select(Project).where(Project.id.in_({j.project_id for j in rows})))}
    clip_titles = {c.id: c.title for c in db.scalars(select(Clip).where(Clip.id.in_({j.clip_id for j in rows if j.clip_id})))}
    return [{**job_out(j), "project_title": titles.get(j.project_id), "clip_title": clip_titles.get(j.clip_id)} for j in rows]


@app.post("/api/jobs/{jid}/cancel")
def cancel_job(jid: str, user: User = Depends(current_user), db=Depends(get_db)):
    j = db.get(Job, jid)
    if j is None or j.project.user_id != user.id:
        raise HTTPException(404, "Job not found")
    if j.status == "queued":
        j.status, j.message = "cancelled", "Cancelled before start"
        if j.kind == "analyze":
            j.project.status, j.project.message = "cancelled", "Cancelled"
        if j.kind == "render" and j.clip_id:
            clip = db.get(Clip, j.clip_id)
            if clip:
                clip.status = "draft"
    elif j.status == "running":
        j.cancel_requested = True
    db.commit()
    return job_out(j)


# ---------------------------------------------------------------------------
# Account

@app.get("/api/me")
def me(user: User = Depends(current_user), db=Depends(get_db)):
    prefs = user.preferences
    usage = storage.dir_size(settings.data_dir / "renders")  # coarse; per-user quota would live here
    n_projects = db.scalar(select(func.count()).select_from(Project).where(Project.user_id == user.id))
    return {"id": user.id, "display_name": user.display_name, "email": user.email, "created_at": _iso(user.created_at),
            "projects": n_projects, "storage_bytes": usage,
            "preferences": {"caption_preset": prefs.caption_preset, "caption_overrides": prefs.caption_overrides,
                            "burned_text_strategy": prefs.burned_text_strategy, "auto_render": prefs.auto_render,
                            "export_srt": prefs.export_srt, "remove_fillers": prefs.remove_fillers, "retention_days": prefs.retention_days}}


class MeIn(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=120)
    email: Optional[str] = Field(default=None, max_length=255)
    preferences: Optional[dict[str, Any]] = None


@app.put("/api/me")
def update_me(body: MeIn, user: User = Depends(current_user), db=Depends(get_db)):
    if body.display_name is not None:
        user.display_name = body.display_name.strip() or "Creator"
    if body.email is not None:
        user.email = body.email.strip() or None
    if body.preferences:
        prefs = user.preferences
        p = body.preferences
        if "caption_preset" in p and p["caption_preset"] in captions.PRESETS:
            prefs.caption_preset = p["caption_preset"]
        if "burned_text_strategy" in p and p["burned_text_strategy"] in ("auto", "mask", "crop", "reposition", "none"):
            prefs.burned_text_strategy = p["burned_text_strategy"]
        for key in ("auto_render", "export_srt", "remove_fillers"):
            if key in p:
                setattr(prefs, key, bool(p[key]))
        if "retention_days" in p:
            prefs.retention_days = int(max(1, min(365, int(p["retention_days"]))))
        if "caption_overrides" in p and isinstance(p["caption_overrides"], dict):
            prefs.caption_overrides = p["caption_overrides"]
    db.commit()
    return me(user, db)


@app.delete("/api/me/data", status_code=204)
def delete_my_data(user: User = Depends(current_user), db=Depends(get_db)):
    for p in list(db.scalars(select(Project).where(Project.user_id == user.id))):
        queue.cancel_jobs(db, project_id=p.id)
        storage.purge_project_files(p.id)
        db.delete(p)
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Signed media

@app.get("/media/{relpath:path}")
def media(relpath: str, exp: int, sig: str, dl: str = ""):
    if not storage.verify(relpath, exp, sig, dl):
        raise HTTPException(403, "This link has expired or is invalid.")
    try:
        path = storage.resolve(relpath)
    except ValueError as exc:
        raise HTTPException(400, "Bad path") from exc
    if not path.is_file():
        raise HTTPException(404, "File not found")
    media_type = {".mp4": "video/mp4", ".jpg": "image/jpeg", ".srt": "application/x-subrip", ".zip": "application/zip",
                  ".ass": "text/plain"}.get(path.suffix.lower())
    headers = {"Cache-Control": "private, max-age=3600"}
    if dl:
        return FileResponse(path, media_type=media_type, filename=dl, headers=headers)
    return FileResponse(path, media_type=media_type, headers=headers)
