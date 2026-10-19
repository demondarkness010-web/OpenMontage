"""Speech-to-text providers with word-level timestamps.

Providers are interchangeable: each returns a list of segments
``{"start", "end", "text", "speaker", "words": [{"w","s","e","p"}]}``.

* ``local``  - faster-whisper (CTranslate2). Free, offline, CPU or CUDA.
* ``openai`` - OpenAI Whisper API (needs OPENAI_API_KEY); audio is chunked to
  stay under the 25 MB request limit.
"""

from __future__ import annotations

import logging
import os
import math
import time
from pathlib import Path
from typing import Any, Callable

import httpx

from ..config import settings
from ..jobs.queue import JobContext, PermanentJobError
from .media import run_ffmpeg

log = logging.getLogger("capclip.transcribe")

ProgressFn = Callable[[float, str], None]

_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}


def _total_ram_gb() -> float:
    try:
        if os.name == "nt":
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(stat)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return stat.ullTotalPhys / 2**30
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    except Exception:  # noqa: BLE001
        return 8.0


def model_name() -> str:
    """'auto' picks the largest model this machine can run comfortably."""
    if settings.whisper_model != "auto":
        return settings.whisper_model
    ram, cores = _total_ram_gb(), os.cpu_count() or 2
    if ram < 6 or cores <= 2:
        return "base"
    return "small"


def active_provider() -> str:
    pref = settings.transcription_provider
    if pref == "openai" and settings.openai_api_key:
        return "openai"
    if pref == "local":
        return "local"
    if pref == "auto":
        if _local_available():
            return "local"
        if settings.openai_api_key:
            return "openai"
    return "local" if _local_available() else "none"


def _local_available() -> bool:
    try:
        import faster_whisper  # noqa: F401

        return True
    except ImportError:
        return False


def describe() -> dict[str, Any]:
    p = active_provider()
    return {
        "provider": p,
        "model": model_name() if p == "local" else "whisper-1" if p == "openai" else None,
        "word_timestamps": p in {"local", "openai"},
        "speaker_labels": False,
        "configured": p != "none",
        "hint": None if p != "none" else "Install faster-whisper (pip install faster-whisper) or set OPENAI_API_KEY.",
    }


def transcribe(audio_path: Path, duration: float, ctx: JobContext, on_progress: ProgressFn, language: str | None = None) -> dict[str, Any]:
    provider = active_provider()
    if provider == "none":
        raise PermanentJobError("No transcription engine is configured. Install faster-whisper or set OPENAI_API_KEY.")
    if provider == "openai":
        segments, lang = _openai(audio_path, duration, ctx, on_progress, language)
    else:
        segments, lang = _local(audio_path, duration, ctx, on_progress, language)
    segments = [_clean_segment(s) for s in segments if s.get("words")]
    return {"provider": provider, "language": lang, "segments": segments}


def _clean_segment(seg: dict[str, Any]) -> dict[str, Any]:
    words = []
    for w in seg["words"]:
        text = (w.get("w") or "").strip()
        if not text:
            continue
        s, e = float(w["s"]), float(w["e"])
        if e <= s:
            e = s + 0.08
        words.append({"w": text, "s": round(s, 3), "e": round(e, 3), "p": round(float(w.get("p", 1.0)), 3)})
    # Enforce monotonic timestamps (models occasionally emit overlaps).
    for i in range(1, len(words)):
        if words[i]["s"] < words[i - 1]["e"]:
            words[i]["s"] = words[i - 1]["e"]
            words[i]["e"] = max(words[i]["e"], words[i]["s"] + 0.05)
    text = " ".join(w["w"] for w in words)
    return {
        "start": words[0]["s"] if words else seg["start"],
        "end": words[-1]["e"] if words else seg["end"],
        "text": text,
        "speaker": seg.get("speaker"),
        "words": words,
    }


def _local(audio_path: Path, duration: float, ctx: JobContext, on_progress: ProgressFn, language: str | None):
    from faster_whisper import WhisperModel

    device, compute = settings.whisper_device, settings.whisper_compute_type
    if device == "auto":
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:  # pragma: no cover - depends on host
            device = "cpu"
    if compute == "auto":
        compute = "float16" if device == "cuda" else "int8"
    name = model_name()
    key = (name, device, compute)
    on_progress(0.0, f"Loading speech model ({name}, {device})")
    model = _MODEL_CACHE.get(key)
    if model is None:
        try:
            # Cached copy first: avoids a (sometimes very slow) hub round-trip on every start.
            model = WhisperModel(name, device=device, compute_type=compute, cpu_threads=os.cpu_count() or 2, local_files_only=True)
        except Exception:  # noqa: BLE001 - not cached yet: download it once
            on_progress(0.0, f"Downloading speech model ({name}) - first run only")
            model = WhisperModel(name, device=device, compute_type=compute, cpu_threads=os.cpu_count() or 2)
        _MODEL_CACHE[key] = model
    # Feed decoded samples rather than a path: our WAV is already 16 kHz mono,
    # and this sidesteps faster-whisper's PyAV decoder (version-sensitive).
    seg_iter, info = model.transcribe(
        _load_wav(audio_path),
        language=language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=5 if name not in ("tiny", "base") or (os.cpu_count() or 2) > 4 else 1,
        condition_on_previous_text=False,
    )
    total = info.duration or duration or 1.0
    out = []
    started = time.time()
    for seg in seg_iter:
        ctx.check_cancel()
        words = [{"w": w.word, "s": w.start, "e": w.end, "p": w.probability} for w in (seg.words or [])]
        out.append({"start": seg.start, "end": seg.end, "text": seg.text, "words": words})
        frac = min(1.0, seg.end / total)
        elapsed = time.time() - started
        eta = elapsed / frac * (1 - frac) if frac > 0.02 else None
        on_progress(frac, f"Transcribing speech · {_fmt(seg.end)} of {_fmt(total)}" + (f" · ~{_fmt(eta)} left" if eta else ""))
    return out, info.language


def _load_wav(path: Path):
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as wf:
        if wf.getframerate() != 16000 or wf.getnchannels() != 1 or wf.getsampwidth() != 2:
            raise PermanentJobError("Internal audio must be 16 kHz mono PCM.")
        data = wf.readframes(wf.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def _openai(audio_path: Path, duration: float, ctx: JobContext, on_progress: ProgressFn, language: str | None):
    work = audio_path.parent / "openai_chunks"
    work.mkdir(exist_ok=True)
    chunk_len = 20 * 60  # 20 minutes of 32 kbps mono mp3 ~= 4.8 MB
    n = max(1, math.ceil(duration / chunk_len))
    out: list[dict[str, Any]] = []
    lang = language
    for i in range(n):
        ctx.check_cancel()
        offset = i * chunk_len
        chunk = work / f"chunk_{i:03d}.mp3"
        run_ffmpeg(["-ss", f"{offset}", "-t", f"{chunk_len}", "-i", str(audio_path), "-ac", "1", "-ar", "16000", "-b:a", "32k", str(chunk)], ctx=ctx)
        on_progress(i / n, f"Transcribing speech (cloud) · part {i + 1} of {n}")
        data = {"model": "whisper-1", "response_format": "verbose_json", "timestamp_granularities[]": ["word", "segment"]}
        if language:
            data["language"] = language
        for attempt in range(3):
            try:
                with httpx.Client(timeout=600) as client, open(chunk, "rb") as fh:
                    r = client.post(
                        "https://api.openai.com/v1/audio/transcriptions",
                        headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                        data=data,
                        files={"file": (chunk.name, fh, "audio/mpeg")},
                    )
                if r.status_code in (401, 403):
                    raise PermanentJobError("The OpenAI API key was rejected for transcription.")
                r.raise_for_status()
                break
            except httpx.HTTPError:
                if attempt == 2:
                    raise
                time.sleep(3 * (attempt + 1))
        payload = r.json()
        lang = lang or payload.get("language")
        words = payload.get("words", [])
        for seg in payload.get("segments", []):
            seg_words = [
                {"w": w["word"], "s": w["start"] + offset, "e": w["end"] + offset, "p": 1.0}
                for w in words
                if w["start"] >= seg["start"] - 0.01 and w["start"] < seg["end"]
            ]
            out.append({"start": seg["start"] + offset, "end": seg["end"] + offset, "text": seg["text"], "words": seg_words})
    on_progress(1.0, "Transcription complete")
    return out, lang


def _fmt(seconds: float | None) -> str:
    if seconds is None:
        return "?"
    seconds = int(max(0, seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
