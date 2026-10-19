"""Edit decision list (EDL) for a clip, computed from the transcript.

A clip's ``edit`` document is the single source of truth for what gets
rendered. ``compute_plan`` turns it into concrete keep-segments (source time)
and an output-time word timeline that the caption builder and renderer share,
so preview, captions and the final MP4 can never drift apart.

Edit document fields (all optional except start/end):
    start, end            source-time bounds chosen by the analyzer / user
    max_pause             pauses longer than this are tightened (seconds)
    remove_fillers        drop "um", "uh", ... (bool)
    removed_words         global word indices the user/AI removed
    restored_words        global word indices the user explicitly kept
    restored_gaps         gap ids (index of the word before the gap) to keep
    word_overrides        {global index: corrected text}
    speed                 playback speed 0.5 - 2.0
    volume_db             gain applied before loudness normalisation
    caption               caption style (see captions.py)
    framing               {"layout": auto|fill|blur|split|fit, "subject_x": 0-1|None, "zoom": 1.0}
    hook                  {"text": str, "show": bool, "duration": float}
    burned_text           {"strategy": auto|mask|crop|reposition|none}
"""

from __future__ import annotations

import re
from typing import Any

FILLERS = {"um", "uh", "erm", "uhm", "uhh", "umm", "hmm", "mm", "ah", "er", "eh"}
LEAD_PAD = 0.10
TRAIL_PAD = 0.14
START_PAD = 0.12
END_TAIL = 0.45
MIN_GAP_KEEP = 0.06

DEFAULT_EDIT: dict[str, Any] = {
    "max_pause": 0.38,
    "remove_fillers": True,
    "removed_words": [],
    "restored_words": [],
    "restored_gaps": [],
    "word_overrides": {},
    "speed": 1.0,
    "volume_db": 0.0,
    "framing": {"layout": "auto", "subject_x": None, "zoom": 1.0},
    "hook": {"text": "", "show": True, "duration": 3.0},
    "burned_text": {"strategy": "auto"},
}


def normalize_token(text: str) -> str:
    return re.sub(r"[^\w']", "", text.lower())


def is_filler(text: str) -> bool:
    return normalize_token(text) in FILLERS


def flatten_words(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Global word list. Each word gets its global index ``i`` and segment index."""
    out: list[dict[str, Any]] = []
    for si, seg in enumerate(segments):
        for w in seg["words"]:
            out.append({**w, "i": len(out), "seg": si, "speaker": seg.get("speaker")})
    return out


def words_in_range(words: list[dict[str, Any]], start: float, end: float) -> list[dict[str, Any]]:
    return [w for w in words if w["s"] >= start - 0.05 and w["e"] <= end + 0.05]


def detect_repeats(ws: list[dict[str, Any]]) -> set[int]:
    """Immediate stutters/restarts: "I I think", "the the", "we were - we were going"."""
    remove: set[int] = set()
    toks = [normalize_token(w["w"]) for w in ws]
    i = 0
    while i < len(ws) - 1:
        matched = False
        for n in (3, 2, 1):
            if i + 2 * n > len(ws):
                continue
            a, b = toks[i:i + n], toks[i + n:i + 2 * n]
            if a == b and all(a) and (n > 1 or len(a[0]) <= 4 or a[0] in {"i", "we", "the", "a", "and", "so", "it", "that"}):
                gap = ws[i + n]["s"] - ws[i + n - 1]["e"]
                if gap < 0.8:
                    remove.update(ws[k]["i"] for k in range(i, i + n))
                    i += n
                    matched = True
                    break
        if not matched:
            i += 1
    return remove


def merged_edit(edit: dict[str, Any]) -> dict[str, Any]:
    out = {**DEFAULT_EDIT, **(edit or {})}
    for key in ("framing", "hook", "burned_text"):
        out[key] = {**DEFAULT_EDIT[key], **((edit or {}).get(key) or {})}
    return out


def compute_plan(words: list[dict[str, Any]], edit: dict[str, Any]) -> dict[str, Any]:
    e = merged_edit(edit)
    start, end = float(e["start"]), float(e["end"])
    speed = max(0.5, min(2.0, float(e.get("speed") or 1.0)))
    span = words_in_range(words, start, end)
    if not span:
        return {"segments": [{"start": start, "end": end}], "words": [], "gaps": [], "duration": (end - start) / speed,
                "source_duration": end - start, "removed": [], "speed": speed}

    removed = {int(i) for i in e.get("removed_words", [])}
    restored = {int(i) for i in e.get("restored_words", [])}
    auto_removed: set[int] = set()
    if e.get("remove_fillers", True):
        auto_removed |= {w["i"] for w in span if is_filler(w["w"])}
        auto_removed |= detect_repeats(span)
    removed |= auto_removed - restored
    removed -= restored
    overrides = {int(k): v for k, v in (e.get("word_overrides") or {}).items()}
    restored_gaps = {int(g) for g in e.get("restored_gaps", [])}
    max_pause = max(0.15, float(e.get("max_pause") or 0.38))

    kept = [w for w in span if w["i"] not in removed]
    if not kept:
        kept = span[:1]

    segments: list[dict[str, float]] = []
    gaps: list[dict[str, Any]] = []
    seg_start = max(start, kept[0]["s"] - START_PAD)
    for a, b in zip(kept, kept[1:]):
        gap = b["s"] - a["e"]
        skipped = b["i"] - a["i"] > 1  # removed words sit between a and b
        gap_id = a["i"]
        cut = (gap > max_pause or skipped) and gap_id not in restored_gaps
        if gap > max_pause or skipped:
            gaps.append({"id": gap_id, "after_word": a["i"], "start": round(a["e"], 3), "end": round(b["s"], 3),
                         "length": round(gap, 3), "cut": cut, "reason": "removed words" if skipped else "pause"})
        if cut:
            cut_from = a["e"] + min(TRAIL_PAD, gap / 2)
            cut_to = b["s"] - min(LEAD_PAD, gap / 2)
            if skipped:
                # Cut right up to the removed words; never clip a kept syllable.
                first_removed = next((w for w in span if a["i"] < w["i"] < b["i"]), None)
                last_removed = next((w for w in reversed(span) if a["i"] < w["i"] < b["i"]), None)
                if first_removed:
                    cut_from = min(cut_from, max(a["e"] + 0.02, first_removed["s"] - 0.01))
                if last_removed:
                    cut_to = max(cut_to, min(b["s"] - 0.02, last_removed["e"] + 0.01))
            if cut_to - cut_from > MIN_GAP_KEEP:
                segments.append({"start": round(seg_start, 3), "end": round(cut_from, 3)})
                seg_start = cut_to
    seg_end = min(end + END_TAIL, kept[-1]["e"] + END_TAIL)
    seg_end = max(seg_end, kept[-1]["e"] + 0.05)
    segments.append({"start": round(seg_start, 3), "end": round(seg_end, 3)})
    segments = [s for s in segments if s["end"] - s["start"] > 0.04]

    # Map kept words onto the output timeline.
    out_words = []
    offset = 0.0
    seg_offsets = []
    for s in segments:
        seg_offsets.append(offset)
        offset += s["end"] - s["start"]
    total_src = offset
    si = 0
    for w in kept:
        while si < len(segments) - 1 and w["s"] >= segments[si]["end"]:
            si += 1
        seg = segments[si]
        os_ = (seg_offsets[si] + max(0.0, w["s"] - seg["start"])) / speed
        oe = (seg_offsets[si] + min(seg["end"] - seg["start"], w["e"] - seg["start"])) / speed
        out_words.append({"i": w["i"], "w": overrides.get(w["i"], w["w"]), "orig": w["w"], "s": round(os_, 3),
                          "e": round(max(oe, os_ + 0.04), 3), "src_s": w["s"], "src_e": w["e"], "p": w.get("p", 1.0)})
    return {
        "segments": segments,
        "words": out_words,
        "gaps": gaps,
        "duration": round(total_src / speed, 3),
        "source_duration": round(segments[-1]["end"] - segments[0]["start"], 3),
        "removed": sorted(removed),
        "auto_removed": sorted(auto_removed - restored),
        "speed": speed,
    }


def source_to_output(plan: dict[str, Any], t: float) -> float | None:
    off = 0.0
    for s in plan["segments"]:
        if s["start"] <= t <= s["end"]:
            return (off + t - s["start"]) / plan["speed"]
        off += s["end"] - s["start"]
    return None
