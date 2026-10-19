"""Job handlers: analyze a project, render a clip, build an export archive."""

from __future__ import annotations

import csv
import io
import json
import logging
import shutil
import time
import zipfile
from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select

from .. import storage
from ..config import settings
from ..models import CaptionTrack, Clip, ExportFile, Job, Project, SessionLocal, SourceVideo, TranscriptSegment, User, utcnow
from ..pipeline import analysis, captions, llm, qa, render, signals, transcribe, youtube
from ..pipeline.edit import DEFAULT_EDIT, compute_plan, flatten_words, merged_edit
from ..pipeline.media import MediaError, probe, run_ffmpeg
from .queue import JobContext, PermanentJobError, enqueue

log = logging.getLogger("capclip.tasks")

# Weights of each analysis stage in the overall project progress bar.
STAGES = [
    ("retrieving", 0.00, 0.08, "Retrieving source"),
    ("preparing", 0.08, 0.16, "Preparing media"),
    ("transcribing", 0.16, 0.58, "Transcribing speech"),
    ("audio", 0.58, 0.61, "Analysing audio"),
    ("scenes", 0.61, 0.69, "Detecting scenes"),
    ("vision", 0.69, 0.84, "Analysing frames"),
    ("selecting", 0.84, 0.97, "Selecting moments"),
    ("drafting", 0.97, 1.00, "Drafting clips"),
]
STAGE_MAP = {s[0]: s for s in STAGES}


class StageReporter:
    def __init__(self, ctx: JobContext):
        self.ctx = ctx
        self.started = time.time()

    def __call__(self, stage: str, frac: float, message: str = "", force: bool = False) -> None:
        name, a, b, label = STAGE_MAP[stage]
        overall = a + (b - a) * max(0.0, min(1.0, frac))
        elapsed = time.time() - self.started
        eta = elapsed / overall * (1 - overall) if overall > 0.2 else None
        self.ctx.progress(stage, overall, message or label, eta=eta, force=force,
                          project_update={"stage": stage, "progress": round(overall * 0.85, 4), "message": message or label, "status": "processing"})


def _work(project_id: str) -> Path:
    return storage.project_dir(project_id, "work")


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def _dump_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Analyze

def analyze_project(ctx: JobContext, job: Job) -> None:
    report = StageReporter(ctx)
    pid = job.project_id
    work = _work(pid)
    with SessionLocal() as db:
        project = db.get(Project, pid)
        source = project.source
        prefs = db.get(User, project.user_id).preferences
        if source is None:
            raise PermanentJobError("Project has no source video.")
        src_path = Path(source.path) if source.path else None
        origin, rights = source.origin, source.rights_attested
        yt_id, title = project.youtube_id, project.title
        options = dict(project.options or {})
        remove_fillers = prefs.remove_fillers if prefs else True

    # 1) Retrieve -------------------------------------------------------------
    report("retrieving", 0, "Checking source", force=True)
    if src_path is None or not src_path.exists():
        if origin != "youtube" or not yt_id:
            raise PermanentJobError("The uploaded source file is missing. Upload it again.")
        if not rights:
            raise PermanentJobError("Confirm you own or are licensed to process this video before retrieval.")
        src_path = youtube.download(yt_id, storage.project_dir(pid, "sources"), ctx)
        with SessionLocal() as db:
            s = db.get(Project, pid).source
            s.path = str(src_path)
            s.size_bytes = src_path.stat().st_size
            db.commit()
    report("retrieving", 1)

    # 2) Probe + proxy ---------------------------------------------------------
    report("preparing", 0, "Reading video", force=True)
    try:
        info = probe(src_path)
    except MediaError as exc:
        raise PermanentJobError(str(exc)) from exc
    if not info["has_video"]:
        raise PermanentJobError("This file has no video stream.")
    if not info["has_audio"]:
        raise PermanentJobError("This video has no audio track, so there is no speech to build captions and clips from.")
    duration = info["duration"]
    if duration > settings.max_source_minutes * 60:
        raise PermanentJobError(f"Video is {duration / 60:.0f} minutes long; this server's limit is {settings.max_source_minutes} minutes.")
    proxy = work / "proxy.mp4"
    if not proxy.exists():
        tmp = work / "proxy.tmp.mp4"
        can_remux = info["video_codec"] == "h264" and info["audio_codec"] == "aac" and info["height"] <= 1080 and str(src_path).lower().endswith((".mp4", ".mov", ".m4v"))
        if can_remux:
            run_ffmpeg(["-i", str(src_path), "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", str(tmp)], ctx=ctx,
                       duration=duration, on_progress=lambda f: report("preparing", 0.2 + 0.6 * f, "Preparing preview proxy"))
        else:
            run_ffmpeg(["-i", str(src_path), "-map", "0:v:0", "-map", "0:a:0", "-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264", "-preset", "veryfast",
                        "-crf", "26", "-g", "48", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-sn", str(tmp)],
                       ctx=ctx, duration=duration, on_progress=lambda f: report("preparing", 0.2 + 0.6 * f, "Preparing preview proxy"))
        tmp.replace(proxy)
    wav = work / "audio.wav"
    if not wav.exists():
        signals.extract_audio(src_path, work / "audio.tmp.wav", ctx, duration, lambda f: report("preparing", 0.8 + 0.2 * f, "Extracting audio"))
        (work / "audio.tmp.wav").replace(wav)
    with SessionLocal() as db:
        s = db.get(Project, pid).source
        s.duration, s.width, s.height, s.fps = duration, info["width"], info["height"], info["fps"]
        s.has_audio, s.subtitle_streams = info["has_audio"], info["subtitle_streams"]
        s.proxy_path, s.audio_path = str(proxy), str(wav)
        s.size_bytes = s.size_bytes or info["size"]
        db.commit()

    # 3) Transcribe -----------------------------------------------------------
    tpath = work / "transcript.json"
    transcript = _load_json(tpath)
    if transcript is None:
        report("transcribing", 0, "Loading speech model", force=True)
        transcript = transcribe.transcribe(wav, duration, ctx, lambda f, m: report("transcribing", f, m), language=options.get("language"))
        _dump_json(tpath, transcript)
    segments = transcript["segments"]
    with SessionLocal() as db:
        db.query(TranscriptSegment).filter(TranscriptSegment.project_id == pid).delete()
        offset = 0
        for i, seg in enumerate(segments):
            db.add(TranscriptSegment(project_id=pid, index=i, start=seg["start"], end=seg["end"], text=seg["text"],
                                     speaker=seg.get("speaker"), word_offset=offset, words=seg["words"]))
            offset += len(seg["words"])
        db.commit()
    words = flatten_words(segments)
    report("transcribing", 1, f"Transcribed {len(words)} words", force=True)

    # 4) Audio envelope -------------------------------------------------------
    report("audio", 0, "Measuring loudness and pauses", force=True)
    epath = work / "envelope.json"
    envelope = _load_json(epath) or signals.audio_envelope(wav)
    _dump_json(epath, envelope)

    # 5) Scenes ---------------------------------------------------------------
    spath = work / "scenes.json"
    scenes = _load_json(spath)
    if scenes is None:
        scenes = signals.detect_scenes(src_path, ctx, duration, lambda f: report("scenes", f, "Detecting scene changes"))
        _dump_json(spath, scenes)

    # 6) Frames ---------------------------------------------------------------
    fpath = work / "frames.json"
    vision = _load_json(fpath)
    if vision is None:
        vision = signals.sample_frames(src_path, work, ctx, duration, info["width"], info["height"],
                                       lambda f: report("vision", f, f"Analysing frames (faces, motion, on-screen text) · {f * 100:.0f}%"))
        _dump_json(fpath, vision)
    frames = vision["frames"]
    burned = signals.detect_burned_text(frames)

    # 7) Select ---------------------------------------------------------------
    def grab(times: list[float]) -> list[tuple[float, Path]]:
        out = []
        gdir = work / "llm_frames"
        gdir.mkdir(exist_ok=True)
        for t in times:
            p = gdir / f"{int(t * 1000):09d}.jpg"
            if not p.exists():
                try:
                    run_ffmpeg(["-ss", f"{t:.2f}", "-i", str(src_path), "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", str(p)])
                except MediaError:
                    continue
            out.append((t, p))
        return out

    base_edit = {**DEFAULT_EDIT, "remove_fillers": remove_fillers,
                 "caption": {"preset": options.get("caption_preset") or (prefs.caption_preset if prefs else "bold_viral"),
                             **(prefs.caption_overrides if prefs else {})},
                 "burned_text": {"strategy": options.get("burned_text_strategy") or (prefs.burned_text_strategy if prefs else "auto")}}
    result = analysis.analyze(words=words, envelope=envelope, frames=frames, scenes=scenes, duration=duration, source_title=title,
                              frame_grabber=grab, base_edit=base_edit, on_progress=lambda f, m: report("selecting", f, m))

    # 8) Persist clips + enqueue renders --------------------------------------
    report("drafting", 0, "Drafting clips", force=True)
    auto_render = prefs.auto_render if prefs else True
    with SessionLocal() as db:
        project = db.get(Project, pid)
        for old in list(project.clips):
            db.delete(old)
        db.flush()
        for n, p in enumerate(result["clips"]):
            publish = p["publish"]
            edit = {**p["edit"], "hook": {"text": publish.get("hook", ""), "show": True, "duration": 3.0}, "emphasis": p["emphasis"],
                    "thumbnail_time": p["thumbnail_time"]}
            clip = Clip(project_id=pid, index=n, status="queued" if auto_render else "draft", title=publish.get("title") or f"Clip {n + 1}",
                        hook=publish.get("hook", ""), reason=p["reason"], category=p["category"], score=p["score"],
                        source_start=p["start"], source_end=p["end"], duration=p["duration"], ai_edit=edit, edit=edit, publish=publish,
                        analyzer=result["analyzer"], qa={"features": p.get("features", {})})
            db.add(clip)
            db.flush()
            if auto_render:
                enqueue(db, "render", pid, clip_id=clip.id)
        src = project.source
        src.analysis = {"scenes": len(scenes), "sample_fps": vision["fps"], "frames_sampled": len(frames), "burned_text": burned,
                        "analyzer": result["analyzer"], "sentences": result["sentences"], "words": len(words),
                        "transcriber": transcript.get("provider"), "language": transcript.get("language"),
                        "face_ratio": round(sum(1 for f in frames if f["faces"]) / max(1, len(frames)), 3)}
        warnings = list(result["warnings"])
        if info["subtitle_streams"]:
            warnings.append(f"Source had {len(info['subtitle_streams'])} subtitle track(s); they are dropped and replaced with new captions.")
        if burned.get("detected"):
            what = "burned-in captions" if burned.get("kind") == "captions" else "a static on-screen overlay"
            warnings.append(f"Detected {what} near the {burned.get('position')} of the frame in {burned.get('coverage', 0) * 100:.0f}% of sampled frames. "
                            "See each clip's QA panel for how it was handled.")
        if info["height"] < 720:
            warnings.append(f"Source is {info['height']}p; vertical exports are upscaled to 1080x1920 and will look soft.")
        project.warnings = warnings
        project.summary = {"source_duration": duration, "clips_generated": len(result["clips"]), "analyzer": result["analyzer"],
                           "words": len(words), "scenes": len(scenes), "frames_sampled": len(frames)}
        if not result["clips"]:
            project.status, project.stage, project.progress = "completed", "completed", 1.0
            project.message = "No clips met the quality bar" if result["sentences"] else "No speech detected"
        else:
            project.status = "rendering" if auto_render else "completed"
            project.stage = "rendering" if auto_render else "completed"
            project.progress = 0.85 if auto_render else 1.0
            project.message = f"Rendering {len(result['clips'])} clip(s)" if auto_render else "Clips drafted; render when ready"
        project.eta_seconds = None
        db.commit()
    ctx.progress("drafting", 1.0, f"{len(result['clips'])} clip(s) drafted", force=True)


# ---------------------------------------------------------------------------
# Render

def load_context(db, project_id: str) -> dict[str, Any]:
    project = db.get(Project, project_id)
    source = project.source
    segs = [{"start": s.start, "end": s.end, "text": s.text, "speaker": s.speaker, "words": s.words} for s in project.segments]
    work = _work(project_id)
    vision = _load_json(work / "frames.json") or {"frames": []}
    return {
        "project": project, "source": source, "words": flatten_words(segs), "frames": vision["frames"],
        "scenes": _load_json(work / "scenes.json") or [], "burned": (source.analysis or {}).get("burned_text", {}), "work": work,
    }


def render_clip(ctx: JobContext, job: Job) -> None:
    with SessionLocal() as db:
        clip = db.get(Clip, job.clip_id)
        if clip is None:
            raise PermanentJobError("Clip no longer exists.")
        c = load_context(db, job.project_id)
        source = c["source"]
        if not source.path or not Path(source.path).exists():
            raise PermanentJobError("Source video file is missing.")
        clip.status = "rendering"
        db.commit()
        edit = merged_edit(clip.edit)
        version = clip.render_version + 1
        edit_version = clip.edit_version
        src = {"path": source.path, "width": source.width, "height": source.height, "fps": source.fps}
        clip_id, pid = clip.id, clip.project_id

    plan = compute_plan(c["words"], edit)
    lo, hi = settings.min_clip_seconds, settings.max_clip_seconds
    if not (lo - 0.5 <= plan["duration"] <= hi + 0.5):
        raise PermanentJobError(f"Edited clip is {plan['duration']:.1f}s; Shorts must be {lo:.0f}-{hi:.0f}s. Adjust the range in the editor.")
    out_dir = storage.project_dir(pid, "renders")
    out_path = out_dir / f"{clip_id}_v{version}.mp4"
    work = c["work"] / "clips" / clip_id
    ctx.progress("rendering", 0.02, "Building edit", force=True)
    info = render.render_clip(work=work, out_path=out_path, plan=plan, edit=edit, src=src, frames=c["frames"], scenes=c["scenes"],
                              burned=c["burned"], emphasis=set(edit.get("emphasis") or []), ctx=ctx,
                              on_progress=lambda f: ctx.progress("rendering", 0.05 + 0.8 * f, f"Rendering · {f * 100:.0f}%"))
    ctx.progress("qa", 0.88, "Checking the export", force=True)
    report = qa.validate(out_path, plan, info)

    thumb = storage.project_dir(pid, "thumbs") / f"{clip_id}_v{version}.jpg"
    from ..pipeline.edit import source_to_output

    t_out = source_to_output(plan, float(edit.get("thumbnail_time") or edit["start"])) or min(2.0, plan["duration"] / 3)
    try:
        run_ffmpeg(["-ss", f"{max(0.0, min(plan['duration'] - 0.5, t_out)):.2f}", "-i", str(out_path), "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", str(thumb)])
    except MediaError:
        thumb = None  # type: ignore[assignment]

    with SessionLocal() as db:
        clip = db.get(Clip, clip_id)
        if clip is None:
            out_path.unlink(missing_ok=True)
            return
        old_render, old_thumb = clip.render_path, clip.thumb_path
        clip.render_path = str(out_path)
        clip.thumb_path = str(thumb) if thumb else None
        clip.render_version = version
        clip.duration = report["probe"]["duration"]
        clip.qa = {**(clip.qa or {}), **{k: v for k, v in report.items() if k != "probe"}, "framing": info["framing"],
                   "burned_text": info["burned_text"], "caption_y": info["caption_y"], "rendered_edit_version": edit_version,
                   "source_segments": len(plan["segments"]), "removed_seconds": round(plan["source_duration"] - plan["duration"] * plan["speed"], 2)}
        clip.warnings = [f"{c_['label']}: {c_['detail']}" for c_ in report["checks"] if not c_["ok"]]
        clip.status = "ready" if report["passed"] else "failed"
        for t in list(clip.caption_tracks):
            db.delete(t)
        style = info["caption_style"]
        rdir = storage.project_dir(pid, "renders")
        srt_final = rdir / f"{clip_id}_v{version}.srt"
        shutil.copyfile(info["srt_path"], srt_final)
        ass_final = rdir / f"{clip_id}_v{version}.ass"
        shutil.copyfile(info["ass_path"], ass_final)
        db.add(CaptionTrack(clip_id=clip_id, kind="ass", preset=style["preset"], style=style, path=str(ass_final), render_version=version))
        db.add(CaptionTrack(clip_id=clip_id, kind="srt", preset=style["preset"], style=style, path=str(srt_final), render_version=version))
        db.commit()
        for old in (old_render, old_thumb):
            if old and old != str(out_path) and old != str(thumb):
                Path(old).unlink(missing_ok=True)
                Path(old).with_suffix(".srt").unlink(missing_ok=True)
                Path(old).with_suffix(".ass").unlink(missing_ok=True)
        _refresh_project(db, pid)
    if not report["passed"]:
        failed = [c_["label"] for c_ in report["checks"] if not c_["ok"] and c_["severity"] == "error"]
        raise PermanentJobError("Export failed quality checks: " + "; ".join(failed))
    ctx.progress("done", 1.0, "Ready", force=True)


def _refresh_project(db, pid: str) -> None:
    project = db.get(Project, pid)
    if project is None or project.status in ("processing", "queued", "cancelled"):
        return
    clips = project.clips
    if not clips:
        return
    pending = [c for c in clips if c.status in ("queued", "rendering")]
    done = [c for c in clips if c.status in ("ready", "failed", "draft")]
    project.progress = round(0.85 + 0.15 * len(done) / len(clips), 4)
    if pending:
        project.status, project.stage = "rendering", "rendering"
        project.message = f"Rendering clips · {len(done)} of {len(clips)} done"
    else:
        project.status, project.stage, project.progress = "completed", "completed", 1.0
        ok = sum(1 for c in clips if c.status == "ready")
        project.message = f"{ok} of {len(clips)} clips ready"
        project.summary = {**(project.summary or {}), "clips_ready": ok, "clips_failed": sum(1 for c in clips if c.status == "failed")}
    db.commit()


def on_render_failed(job_id: str, error: str) -> None:
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if job and job.clip_id:
            clip = db.get(Clip, job.clip_id)
            if clip and clip.status in ("rendering", "queued"):
                clip.status = "failed"
                clip.warnings = [error[:400]]
                db.commit()
            _refresh_project(db, job.project_id)


# ---------------------------------------------------------------------------
# Metadata regeneration (inline, short)

def regenerate_metadata(db, clip: Clip) -> dict[str, Any]:
    c = load_context(db, clip.project_id)
    plan = compute_plan(c["words"], merged_edit(clip.edit))
    text = " ".join(w["w"] for w in plan["words"])
    project = c["project"]
    if settings.llm_active == "anthropic":
        frame = Path(clip.thumb_path) if clip.thumb_path else None
        meta = llm.clip_metadata(text, project.title, frame)
        meta["generator"] = "ai"
        return meta
    sig = analysis.Signals(c["words"], _load_json(c["work"] / "envelope.json") or {}, c["frames"], c["scenes"])
    kept = [w for w in c["words"] if w["i"] in {x["i"] for x in plan["words"]}]
    return analysis.heuristic_metadata(kept, sig, clip.category, project.title)


# ---------------------------------------------------------------------------
# Export

def build_export(ctx: JobContext, job: Job) -> None:
    with SessionLocal() as db:
        export = db.get(ExportFile, job.export_id)
        if export is None:
            raise PermanentJobError("Export record missing.")
        export.status = "building"
        db.commit()
        clips = db.scalars(select(Clip).where(Clip.id.in_(export.clip_ids), Clip.status == "ready").order_by(Clip.index)).all()
        project = db.get(Project, export.project_id)
        if not clips:
            raise PermanentJobError("None of the selected clips have a finished render.")
        items = [(c.id, c.index, c.title, c.render_path, c.source_start, c.source_end, c.duration, c.publish, c.category, c.score,
                  next((t.path for t in c.caption_tracks if t.kind == "srt"), None)) for c in clips]
        include_srt, title, eid = export.include_srt, project.title, export.id
        yt = project.youtube_url
    out_dir = storage.project_dir(job.project_id, "exports")
    out = out_dir / f"capclip_{eid}.zip"
    tmp = out.with_suffix(".tmp")
    meta_rows = []
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for n, (cid, idx, ctitle, rpath, s, e, dur, pub, cat, score, srt) in enumerate(items):
            ctx.progress("packaging", n / len(items), f"Packaging clip {n + 1} of {len(items)}")
            stem = f"{idx + 1:02d}_{_slug(ctitle)}"
            zf.write(rpath, f"{stem}.mp4", compress_type=zipfile.ZIP_STORED)
            if include_srt and srt and Path(srt).exists():
                zf.write(srt, f"{stem}.srt")
            meta_rows.append({"file": f"{stem}.mp4", "clip_id": cid, "title": pub.get("title") or ctitle, "hook": pub.get("hook", ""),
                              "alternative_titles": pub.get("titles", []), "description": pub.get("description", ""),
                              "hashtags": pub.get("hashtags", []), "keywords": pub.get("keywords", []),
                              "pinned_comment": pub.get("pinned_comment", ""), "thumbnail_text": pub.get("thumbnail_text", ""),
                              "source_start": round(s, 2), "source_end": round(e, 2), "duration": round(dur, 2), "category": cat,
                              "ai_estimated_potential": score, "metadata_generator": pub.get("generator", "")})
        zf.writestr("metadata.json", json.dumps({"project": title, "source": yt, "generated_by": "CapClip", "clips": meta_rows}, indent=2))
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["file", "title", "hook", "description", "hashtags", "source_start", "source_end", "duration", "pinned_comment"])
        for r in meta_rows:
            w.writerow([r["file"], r["title"], r["hook"], r["description"], " ".join(r["hashtags"]), r["source_start"], r["source_end"], r["duration"], r["pinned_comment"]])
        zf.writestr("metadata.csv", buf.getvalue())
    tmp.replace(out)
    with SessionLocal() as db:
        export = db.get(ExportFile, eid)
        export.status, export.path, export.size_bytes = "ready", str(out), out.stat().st_size
        db.commit()
    ctx.progress("done", 1.0, "Archive ready", force=True)


def on_export_failed(job_id: str, error: str) -> None:
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if job and job.export_id:
            export = db.get(ExportFile, job.export_id)
            if export:
                export.status, export.error = "failed", error[:400]
                db.commit()


def _slug(text: str) -> str:
    import re

    s = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    return re.sub(r"[\s_-]+", "-", s)[:48] or "clip"


# ---------------------------------------------------------------------------
# Retention

def retention_sweep() -> None:
    cutoff_default = utcnow() - timedelta(days=settings.retention_days)
    with SessionLocal() as db:
        for project in db.scalars(select(Project).where(Project.status.notin_(("processing", "rendering", "queued")))):
            user = db.get(User, project.user_id)
            days = user.preferences.retention_days if user and user.preferences else settings.retention_days
            if project.updated_at < utcnow() - timedelta(days=days):
                storage.purge_project_files(project.id)
                db.delete(project)
                log.info("retention: deleted project %s", project.id)
        old_exports = db.scalars(select(ExportFile).where(ExportFile.created_at < utcnow() - timedelta(days=7))).all()
        for ex in old_exports:
            if ex.path:
                Path(ex.path).unlink(missing_ok=True)
            db.delete(ex)
        db.commit()
    _ = cutoff_default
    # Upload chunks abandoned for more than a day.
    for d in (settings.data_dir / "uploads").glob("*"):
        if d.is_dir() and time.time() - d.stat().st_mtime > 86400:
            storage.remove_tree(d)


HANDLERS = {"analyze": analyze_project, "render": render_clip, "export": build_export}
FAILURE_HOOKS = {"render": on_render_failed, "export": on_export_failed}
