"""Vertical reframing: layout choice and smoothed subject tracking.

Layouts
  fill   - 9:16 crop that follows the active face (talking heads, vlogs)
  split  - two stacked crops, one per speaker (interviews, podcasts)
  blur   - whole frame fitted over a blurred fill (screens, demos, wide shots)
  fit    - source is already vertical: scale to 1080x1920 with blurred fill
"""

from __future__ import annotations

import bisect
from typing import Any

import numpy as np

DEAD_ZONE = 0.07     # fraction of source width the subject may drift before the camera moves
EASE = 0.45          # seconds for a camera move
MIN_HOLD = 1.2       # seconds a framing must hold before moving again


def _frames_in(frames: list[dict[str, Any]], start: float, end: float) -> list[dict[str, Any]]:
    times = [f["t"] for f in frames]
    i = bisect.bisect_left(times, start)
    j = bisect.bisect_right(times, end)
    return frames[i:j]


def analyse_range(frames: list[dict[str, Any]], start: float, end: float) -> dict[str, Any]:
    sel = _frames_in(frames, start, end)
    if not sel:
        return {"face_ratio": 0.0, "two_face_ratio": 0.0, "text_ratio": 0.0, "motion": 0.0, "clusters": []}
    face_ratio = sum(1 for f in sel if f["faces"]) / len(sel)
    xs = [face["x"] for f in sel for face in f["faces"] if face["w"] > 0.04]
    two = 0
    for f in sel:
        big = [fc for fc in f["faces"] if fc["w"] > 0.04]
        if len(big) >= 2:
            fx = sorted(fc["x"] for fc in big)
            if fx[-1] - fx[0] > 0.3:
                two += 1
    clusters: list[float] = []
    if len(xs) >= 6:
        arr = np.array(xs)
        c1, c2 = np.percentile(arr, 20), np.percentile(arr, 80)
        for _ in range(10):
            lab = np.abs(arr - c1) <= np.abs(arr - c2)
            if lab.all() or (~lab).all():
                break
            c1, c2 = arr[lab].mean(), arr[~lab].mean()
        if abs(c2 - c1) > 0.3 and min(lab.mean(), 1 - lab.mean()) > 0.2:
            clusters = sorted([float(c1), float(c2)])
    text_ratio = sum(1 for f in sel if any(0.25 < b[1] + b[3] / 2 < 0.75 for b in f["text"])) / len(sel)
    return {
        "face_ratio": round(face_ratio, 3),
        "two_face_ratio": round(two / len(sel), 3),
        "text_ratio": round(text_ratio, 3),
        "motion": round(float(np.mean([f["motion"] for f in sel])), 4),
        "clusters": clusters,
        "face_y": float(np.median([fc["y"] for f in sel for fc in f["faces"]])) if xs else 0.4,
        "face_h": float(np.median([fc["h"] for f in sel for fc in f["faces"]])) if xs else 0.25,
    }


def choose_layout(stats: dict[str, Any], src_w: int, src_h: int) -> tuple[str, str]:
    if src_h >= src_w:
        return "fit", "Source is already vertical"
    if stats["two_face_ratio"] > 0.35 and len(stats["clusters"]) == 2:
        return "split", "Two speakers on screen most of the time - stacked split-screen"
    if stats["text_ratio"] > 0.45 and stats["face_ratio"] < 0.6:
        return "blur", "On-screen text/demo content would be cropped - full frame over blurred fill"
    if stats["face_ratio"] >= 0.35:
        return "fill", "Speaker face detected - tracked 9:16 crop"
    return "blur", "No consistent subject to track - full frame over blurred fill"


def track_keyframes(frames: list[dict[str, Any]], segments: list[dict[str, float]], scenes: list[float],
                    crop_frac: float, manual_x: float | None = None) -> list[list[tuple[float, float]]]:
    """Per segment, a list of (segment-local time, crop centre x as 0-1 of source width).

    Holds steady inside a dead zone, eases between holds, and snaps on scene cuts.
    """
    half = crop_frac / 2
    clamp = lambda x: float(min(1 - half, max(half, x)))  # noqa: E731
    if manual_x is not None:
        return [[(0.0, clamp(manual_x))] for _ in segments]
    out: list[list[tuple[float, float]]] = []
    last_x: float | None = None
    for seg in segments:
        sel = _frames_in(frames, seg["start"] - 0.25, seg["end"] + 0.25)
        samples: list[tuple[float, float]] = []
        for f in sel:
            if not f["faces"]:
                continue
            if last_x is not None:
                face = min(f["faces"], key=lambda fc: abs(fc["x"] - last_x) - fc["w"] * 0.8)
            else:
                face = max(f["faces"], key=lambda fc: fc["w"] * fc["h"])
            samples.append((max(0.0, f["t"] - seg["start"]), face["x"]))
        if not samples:
            x = last_x if last_x is not None else 0.5
            out.append([(0.0, clamp(x))])
            last_x = x
            continue
        # Median-smooth to suppress detector jitter.
        xs = np.array([s[1] for s in samples])
        k = 2
        smooth = [float(np.median(xs[max(0, i - k): i + k + 1])) for i in range(len(xs))]
        keys: list[tuple[float, float]] = []
        cur = smooth[0] if last_x is None or abs(smooth[0] - last_x) > DEAD_ZONE else last_x
        keys.append((0.0, clamp(cur)))
        last_move = -MIN_HOLD
        seg_scene_cuts = [c - seg["start"] for c in scenes if seg["start"] < c < seg["end"]]
        for (t, _), x in zip(samples, smooth):
            near_cut = any(abs(t - c) < 0.3 for c in seg_scene_cuts)
            if abs(x - cur) > DEAD_ZONE and (t - last_move >= MIN_HOLD or near_cut):
                if near_cut:
                    keys.append((max(0.0, t - 0.001), clamp(cur)))
                    keys.append((t, clamp(x)))
                else:
                    keys.append((t, clamp(cur)))
                    keys.append((t + EASE, clamp(x)))
                cur, last_move = x, t
        out.append(_dedupe(keys))
        last_x = cur
    return out


def _dedupe(keys: list[tuple[float, float]]) -> list[tuple[float, float]]:
    keys.sort(key=lambda k: k[0])
    out: list[tuple[float, float]] = []
    for t, x in keys:
        if out and t <= out[-1][0]:
            t = out[-1][0] + 0.001
        out.append((round(t, 3), round(x, 4)))
    return out[:40]


def x_expression(keys: list[tuple[float, float]], src_w_expr: str, crop_w: int, src_w: int) -> str:
    """FFmpeg crop x expression (in pixels) piecewise-linear over segment time t."""
    def px(x: float) -> float:
        return round(min(src_w - crop_w, max(0, x * src_w - crop_w / 2)), 1)

    if len(keys) == 1:
        return str(px(keys[0][1]))
    expr = str(px(keys[-1][1]))
    for (t0, x0), (t1, x1) in reversed(list(zip(keys, keys[1:]))):
        p0, p1 = px(x0), px(x1)
        if p0 == p1 or t1 - t0 < 0.01:
            seg_expr = str(p1 if t1 - t0 < 0.01 else p0)
        else:
            # smoothstep easing between keyframes
            u = f"((t-{t0})/{round(t1 - t0, 3)})"
            seg_expr = f"({p0}+({p1 - p0})*{u}*{u}*(3-2*{u}))"
        expr = f"if(lt(t,{t1}),{seg_expr},{expr})"
    first = str(px(keys[0][1]))
    return f"if(lt(t,{keys[0][0]}),{first},{expr})"
