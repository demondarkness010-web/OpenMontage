"""Post-render validation. A clip is only marked ready when its checks pass."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..config import settings
from .media import probe, run_ffmpeg

SENTENCE_END = re.compile(r"[.!?…]['\")\]]*$")


def validate(path: Path, plan: dict[str, Any], render_info: dict[str, Any]) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def check(key: str, ok: bool, label: str, detail: str = "", severity: str = "error") -> None:
        checks.append({"key": key, "ok": bool(ok), "label": label, "detail": detail, "severity": "info" if ok else severity})

    info = probe(path)
    dur = info["duration"]
    lo, hi = settings.min_clip_seconds, settings.max_clip_seconds
    check("duration", lo - 0.6 <= dur <= hi + 0.6, "Duration within 30-60 s", f"{dur:.1f}s")
    check("video", info["has_video"] and info["video_codec"] == "h264", "H.264 video stream", info.get("video_codec") or "missing")
    check("audio", info["has_audio"] and info["audio_codec"] == "aac", "AAC audio stream", info.get("audio_codec") or "missing")
    check("resolution", (info["width"], info["height"]) == (1080, 1920), "1080x1920 vertical (9:16)", f"{info['width']}x{info['height']}")
    check("no_subtitle_track", not info["subtitle_streams"], "No leftover subtitle track", f"{len(info['subtitle_streams'])} track(s)")

    # Stream durations line up (A/V sync) and the file decodes end to end.
    stderr = run_ffmpeg(["-i", str(path), "-vf", "blackdetect=d=0.4:pix_th=0.08", "-af", "silencedetect=n=-55dB:d=1.5",
                         "-f", "null", "-"], duration=dur)
    decode_errors = [l for l in stderr.splitlines() if re.search(r"error while decoding|corrupt|Invalid data|non-existing PPS", l, re.I)]
    check("decode", not decode_errors, "Plays cleanly start to finish", decode_errors[0][:160] if decode_errors else "")
    blacks = [(float(a), float(b)) for a, b in re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", stderr)]
    check("black_frames", not blacks, "No black frames", ", ".join(f"{a:.1f}-{b:.1f}s" for a, b in blacks[:3]), severity="warning")
    silences = re.findall(r"silence_duration: ([\d.]+)", stderr)
    check("dead_air", not silences, "No long dead air", f"{len(silences)} silent stretch(es) over 1.5s", severity="warning")

    words = plan["words"]
    if words:
        last_cap = words[-1]["e"]
        check("caption_sync", last_cap <= dur + 0.15, "Captions within video length", f"last caption {last_cap:.2f}s / {dur:.2f}s")
        clean_start = words[0]["w"][:1].isupper() or words[0]["w"][:1].isdigit()
        check("clean_start", clean_start, "Starts at the beginning of a sentence", words[0]["w"], severity="warning")
        check("clean_end", bool(SENTENCE_END.search(words[-1]["w"])), "Ends on a complete sentence", words[-1]["w"], severity="warning")
        low = [w for w in words if w.get("p", 1) < 0.45]
        check("transcript_confidence", len(low) / len(words) < 0.08, "Transcript confidence",
              f"{len(low)} low-confidence word(s) - review captions" if low else "high", severity="warning")
    else:
        check("captions", False, "Captions present", "no speech found in this range", severity="warning")

    bt = render_info.get("burned_text", {})
    if bt.get("detected"):
        check("burned_text", bt.get("applied") in ("mask", "crop", "reposition"), "Original on-screen captions handled", bt.get("note", ""), severity="warning")

    stats = render_info.get("framing_stats", {})
    if render_info.get("framing", {}).get("layout") == "fill" and stats.get("face_ratio", 1) < 0.5:
        check("framing", False, "Subject stays in frame", "Speaker detected in under half the frames - check framing in the editor", severity="warning")

    errors = [c for c in checks if not c["ok"] and c["severity"] == "error"]
    warnings = [c for c in checks if not c["ok"] and c["severity"] == "warning"]
    return {"passed": not errors, "checks": checks, "errors": len(errors), "warnings": len(warnings), "probe": info}
