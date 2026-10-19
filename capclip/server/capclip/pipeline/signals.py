"""Low-level audio and visual signals extracted from the full source.

* audio loudness envelope (RMS in 250 ms windows) -> energy, emphasis, silence
* scene changes (FFmpeg scene score)
* adaptive frame sampling over the whole video (denser for short videos) with
  per-frame face boxes, motion energy, brightness and text-band detection
* burned-in caption / overlay detection from those frames
"""

from __future__ import annotations

import logging
import re
import wave
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..config import settings
from ..jobs.queue import JobCancelled, JobContext
from .media import BACKGROUND_FLAGS, run_ffmpeg

log = logging.getLogger("capclip.signals")

WINDOW = 0.25  # seconds per audio energy window


def extract_audio(src: Path, out: Path, ctx: JobContext, duration: float, on_progress: Callable[[float], None]) -> Path:
    run_ffmpeg(["-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out)], ctx=ctx, duration=duration, on_progress=on_progress)
    return out


def audio_envelope(wav_path: Path) -> dict[str, Any]:
    with wave.open(str(wav_path), "rb") as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        hop = int(sr * WINDOW)
        rms: list[float] = []
        while True:
            frames = wf.readframes(hop * 240)  # read a minute at a time
            if not frames:
                break
            data = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
            usable = len(data) - len(data) % hop
            if usable:
                chunk = data[:usable].reshape(-1, hop)
                rms.extend(np.sqrt(np.mean(chunk ** 2, axis=1) + 1e-12).tolist())
            if len(data) > usable:
                tail = data[usable:]
                rms.append(float(np.sqrt(np.mean(tail ** 2) + 1e-12)))
    db = 20 * np.log10(np.maximum(np.array(rms, dtype=np.float32), 1e-6))
    speech_floor = float(np.percentile(db, 60)) if len(db) else -30.0
    return {
        "window": WINDOW,
        "db": [round(float(x), 2) for x in db],
        "duration": n / sr if sr else 0.0,
        "median_db": float(np.median(db)) if len(db) else -60.0,
        "speech_floor_db": speech_floor,
    }


def detect_scenes(src: Path, ctx: JobContext, duration: float, on_progress: Callable[[float], None], threshold: float = 0.32) -> list[float]:
    stderr = run_ffmpeg(
        ["-i", str(src), "-an", "-sn", "-vf", f"scale=160:-2,select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
        ctx=ctx,
        duration=duration,
        on_progress=on_progress,
    )
    times = [float(m.group(1)) for m in re.finditer(r"pts_time:([\d.]+)", stderr)]
    # Drop cuts closer than 0.4 s (flashes, fades)
    out: list[float] = []
    for t in times:
        if not out or t - out[-1] > 0.4:
            out.append(round(t, 3))
    return out


def sampling_fps(duration: float) -> float:
    """Adaptive sampling density: dense for short sources, sparser for long ones."""
    if duration <= 10 * 60:
        return 2.0
    if duration <= 30 * 60:
        return 1.0
    if duration <= 90 * 60:
        return 0.5
    return 0.25


def sample_frames(src: Path, out_dir: Path, ctx: JobContext, duration: float, src_w: int, src_h: int,
                  on_progress: Callable[[float], None]) -> dict[str, Any]:
    """Stream low-res grayscale frames over the entire video and analyse each one."""
    import subprocess

    import cv2

    fps = sampling_fps(duration)
    width = 640 if src_w >= src_h else 360
    height = int(round(width * src_h / max(1, src_w) / 2) * 2) or 360
    cmd = [settings.ffmpeg_binary, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(src), "-an", "-sn",
           "-vf", f"fps={fps},scale={width}:{height}", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=BACKGROUND_FLAGS)
    frame_bytes = width * height
    cascade_dir = Path(cv2.data.haarcascades)
    frontal = cv2.CascadeClassifier(str(cascade_dir / "haarcascade_frontalface_default.xml"))
    profile = cv2.CascadeClassifier(str(cascade_dir / "haarcascade_profileface.xml"))
    thumbs_dir = out_dir / "frames"
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    frames: list[dict[str, Any]] = []
    prev = None
    idx = 0
    expected = max(1, int(duration * fps))
    assert proc.stdout is not None
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            t = idx / fps
            img = np.frombuffer(buf, dtype=np.uint8).reshape(height, width)
            eq = cv2.equalizeHist(img)
            min_face = max(20, height // 14)
            faces = list(frontal.detectMultiScale(eq, scaleFactor=1.12, minNeighbors=6, minSize=(min_face, min_face)))
            if not faces:
                faces = list(profile.detectMultiScale(eq, scaleFactor=1.12, minNeighbors=6, minSize=(min_face, min_face)))
                if not faces:
                    flipped = cv2.flip(eq, 1)
                    faces = [(width - x - w, y, w, h) for (x, y, w, h) in profile.detectMultiScale(flipped, 1.12, 6, minSize=(min_face, min_face))]
            face_list = [
                {"x": round((x + w / 2) / width, 4), "y": round((y + h / 2) / height, 4), "w": round(w / width, 4), "h": round(h / height, 4)}
                for (x, y, w, h) in faces
            ]
            motion = float(np.mean(cv2.absdiff(img, prev))) / 255.0 if prev is not None else 0.0
            frames.append({
                "t": round(t, 3),
                "faces": face_list,
                "motion": round(motion, 4),
                "bright": round(float(np.mean(img)) / 255.0, 4),
                "text": _text_boxes(img),
            })
            # Keep a small JPEG every ~2 s for multimodal review and thumbnails.
            if idx % max(1, int(fps * 2)) == 0:
                cv2.imwrite(str(thumbs_dir / f"{int(round(t * 1000)):09d}.jpg"), cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), [cv2.IMWRITE_JPEG_QUALITY, 70])
            prev = img
            idx += 1
            if idx % 10 == 0:
                on_progress(min(1.0, idx / expected))
                if ctx.cancelled():
                    raise JobCancelled()
    finally:
        proc.kill()
        proc.wait()
    return {"fps": fps, "width": width, "height": height, "frames": frames}


def _text_boxes(gray: np.ndarray) -> list[list[float]]:
    """Find horizontal text-like regions (normalised x, y, w, h)."""
    import cv2

    h, w = gray.shape
    grad = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    _, bw = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    connected = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, w // 40), 3)))
    contours, _ = cv2.findContours(connected, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for c in contours:
        x, y, bw_, bh = cv2.boundingRect(c)
        if bw_ < w * 0.12 or bh < h * 0.018 or bh > h * 0.14 or bw_ / max(1, bh) < 3.0:
            continue
        roi = bw[y:y + bh, x:x + bw_]
        fill = float(np.count_nonzero(roi)) / roi.size
        if 0.25 < fill < 0.9:
            boxes.append([round(x / w, 3), round(y / h, 3), round(bw_ / w, 3), round(bh / h, 3)])
    return boxes[:6]


def detect_burned_text(frames: list[dict[str, Any]]) -> dict[str, Any]:
    """Decide whether the source carries burned-in captions (changing text in a
    consistent band) or a static overlay (logo/lower-third that never changes)."""
    if not frames:
        return {"detected": False}
    bands: dict[int, list[list[float]]] = {}
    for f in frames:
        for (x, y, w, h) in f["text"]:
            cy = y + h / 2
            if 0.12 < cy < 0.6:  # mid-frame text is usually scene content, not captions
                continue
            bands.setdefault(int(cy * 20), []).append([x, y, w, h, f["t"]])
    best_key, best = None, []
    for key, items in bands.items():
        merged = items + bands.get(key + 1, []) + bands.get(key - 1, [])
        if len(merged) > len(best):
            best_key, best = key, merged
    coverage = len({round(b[4], 2) for b in best}) / len(frames)
    if best_key is None or coverage < 0.18:
        return {"detected": False, "coverage": round(coverage, 3)}
    xs = [b[0] for b in best]
    ys = [b[1] for b in best]
    x2 = [b[0] + b[2] for b in best]
    y2 = [b[1] + b[3] for b in best]
    box = [
        max(0.0, float(np.percentile(xs, 5)) - 0.02),
        max(0.0, float(np.percentile(ys, 5)) - 0.015),
        min(1.0, float(np.percentile(x2, 95)) + 0.02),
        min(1.0, float(np.percentile(y2, 95)) + 0.015),
    ]
    widths = np.array([b[2] for b in best])
    changing = float(np.std(widths)) > 0.03  # subtitles change width line to line
    cy = (box[1] + box[3]) / 2
    return {
        "detected": True,
        "kind": "captions" if changing else "static_overlay",
        "position": "bottom" if cy > 0.5 else "top",
        "box": [round(v, 4) for v in (box[0], box[1], box[2] - box[0], box[3] - box[1])],
        "coverage": round(coverage, 3),
        "method": "frame text-band detection (OpenCV)",
    }
