"""FFmpeg / ffprobe helpers with progress parsing and cooperative cancellation."""

from __future__ import annotations

import functools
import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Optional, Sequence

from ..config import settings
from ..jobs.queue import JobCancelled, JobContext

CREATE_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
# Heavy media work runs below normal priority so the API and UI stay responsive
# while renders/analysis saturate the CPU.
BACKGROUND_FLAGS = CREATE_FLAGS | (subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 0)


def _lower_priority() -> None:  # POSIX preexec hook
    try:
        os.nice(5)
    except OSError:
        pass


class MediaError(RuntimeError):
    pass


def probe(path: str | Path) -> dict:
    cmd = [settings.ffprobe_binary, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120, creationflags=CREATE_FLAGS)
    except FileNotFoundError as exc:
        raise MediaError("ffprobe is not installed or not on PATH (set CAPCLIP_FFPROBE).") from exc
    if out.returncode != 0:
        raise MediaError(f"Could not read media file: {out.stderr.strip()[-400:]}")
    data = json.loads(out.stdout or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    subs = [
        {"index": s.get("index"), "codec": s.get("codec_name"), "language": s.get("tags", {}).get("language")}
        for s in streams
        if s.get("codec_type") == "subtitle"
    ]
    fmt = data.get("format", {})
    duration = float(fmt.get("duration") or (video or {}).get("duration") or 0)
    fps = 0.0
    if video:
        rate = video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1"
        try:
            num, den = rate.split("/")
            fps = float(num) / float(den) if float(den) else 0.0
        except (ValueError, ZeroDivisionError):
            fps = 0.0
    width, height = (int(video.get("width", 0)), int(video.get("height", 0))) if video else (0, 0)
    rotation = 0
    if video:
        for side in video.get("side_data_list", []) or []:
            if "rotation" in side:
                rotation = int(side["rotation"])
        rotation = int(video.get("tags", {}).get("rotate", rotation) or rotation)
    if abs(rotation) in (90, 270):
        width, height = height, width
    return {
        "duration": duration,
        "width": width,
        "height": height,
        "fps": fps,
        "has_video": video is not None,
        "has_audio": audio is not None,
        "video_codec": (video or {}).get("codec_name"),
        "audio_codec": (audio or {}).get("codec_name"),
        "subtitle_streams": subs,
        "size": int(fmt.get("size") or 0),
        "format": fmt.get("format_name"),
    }


def run_ffmpeg(
    args: Sequence[str],
    *,
    ctx: Optional[JobContext] = None,
    duration: float | None = None,
    on_progress: Optional[Callable[[float], None]] = None,
    cwd: str | Path | None = None,
    timeout: float | None = None,
) -> str:
    """Run ffmpeg; report fractional progress; kill the process on cancellation.

    Returns stderr (useful for filters like silencedetect that log results).
    """
    cmd = [settings.ffmpeg_binary, "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", *args]
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(cwd) if cwd else None,
            creationflags=BACKGROUND_FLAGS,
            preexec_fn=_lower_priority if os.name != "nt" else None,
        )
    except FileNotFoundError as exc:
        raise MediaError("ffmpeg is not installed or not on PATH (set CAPCLIP_FFMPEG).") from exc

    stderr_chunks: list[str] = []

    def _drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_chunks.append(line)

    t = threading.Thread(target=_drain_stderr, daemon=True)
    t.start()
    started = time.time()
    assert proc.stdout is not None
    last_check = 0.0
    for line in proc.stdout:
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                us = int(line.split("=", 1)[1].strip())
            except ValueError:
                continue
            if duration and on_progress:
                on_progress(min(1.0, (us / 1_000_000) / duration))
        now = time.time()
        if ctx is not None and now - last_check > 1.0:
            last_check = now
            if ctx.cancelled():
                proc.kill()
                proc.wait()
                raise JobCancelled()
        if timeout and now - started > timeout:
            proc.kill()
            raise MediaError("ffmpeg timed out")
    proc.wait()
    t.join(timeout=5)
    stderr = "".join(stderr_chunks)
    if proc.returncode != 0:
        if ctx is not None and ctx.cancelled():
            raise JobCancelled()
        tail = "\n".join(l for l in stderr.strip().splitlines()[-12:])
        raise MediaError(f"ffmpeg failed (exit {proc.returncode}):\n{tail}")
    return stderr


@functools.lru_cache(maxsize=1)
def ffmpeg_filters() -> frozenset[str]:
    out = subprocess.run([settings.ffmpeg_binary, "-hide_banner", "-filters"], capture_output=True, text=True, creationflags=CREATE_FLAGS)
    names = set()
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and len(parts[0]) <= 4:
            names.add(parts[1])
    return frozenset(names)


@functools.lru_cache(maxsize=8)
def tool_available(binary: str) -> bool:
    try:
        subprocess.run([binary, "-version"], capture_output=True, timeout=20, creationflags=CREATE_FLAGS)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False
