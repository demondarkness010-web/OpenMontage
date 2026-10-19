"""Final render: one FFmpeg filtergraph per clip.

source --(mask burned text)--> split per keep-segment --(trim, tracked crop)-->
concat --(speed)--> layout to 1080x1920 --> libass captions + hook --> H.264/AAC
with loudness normalisation (-14 LUFS, YouTube's reference level).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

from ..config import settings
from ..jobs.queue import JobContext
from . import captions as cap
from . import reframe
from .media import run_ffmpeg

OUT_W, OUT_H = 1080, 1920


def _even(x: float) -> int:
    v = int(round(x))
    return v - (v % 2)


def resolve_framing(edit: dict[str, Any], stats: dict[str, Any], src_w: int, src_h: int) -> dict[str, Any]:
    framing = dict(edit.get("framing") or {})
    layout = framing.get("layout") or "auto"
    reason = "Chosen manually"
    if layout == "auto":
        layout, reason = reframe.choose_layout(stats, src_w, src_h)
    if layout in ("fill", "split") and src_h >= src_w:
        layout, reason = "fit", "Source is already vertical"
    if layout == "split" and len(stats.get("clusters") or []) != 2:
        layout, reason = "fill", "Split-screen needs two separated speakers; using tracked crop"
    return {**framing, "layout": layout, "reason": reason, "zoom": float(framing.get("zoom") or 1.0)}


def burned_text_plan(edit: dict[str, Any], burned: dict[str, Any], layout: str) -> dict[str, Any]:
    strategy = (edit.get("burned_text") or {}).get("strategy", "auto")
    if not burned or not burned.get("detected"):
        return {"strategy": "none", "applied": "none", "detected": False,
                "note": "No burned-in captions were detected in the source frames."}
    box = burned["box"]
    kind = burned.get("kind")
    if strategy == "auto":
        if kind == "static_overlay":
            strategy = "reposition"
        elif layout in ("blur", "fit") and box[1] > 0.72:
            strategy = "crop"
        else:
            strategy = "mask"
    notes = {
        "mask": "Original on-screen text is blurred out (masked). It is obscured, not removed - inpainting is not available.",
        "crop": "The band containing the original text is cropped out of the frame.",
        "reposition": "Original text is still visible; new captions are positioned away from it.",
        "none": "Original on-screen text is left untouched and remains visible.",
    }
    return {"strategy": strategy, "applied": strategy, "detected": True, "kind": kind, "box": box, "note": notes[strategy]}


def caption_position(style: dict[str, Any], layout: str, stats: dict[str, Any], btext: dict[str, Any]) -> float:
    """Keep captions off faces, out of platform UI zones, and away from leftover text."""
    y = style["position"]
    if layout == "split":
        y = 0.5  # sits on the seam between the two speakers
    if btext.get("applied") == "reposition" and btext.get("box"):
        box = btext["box"]
        old_center = box[1] + box[3] / 2
        if abs(old_center - y) < 0.12 or (old_center > 0.6 and y > 0.6):
            y = 0.42 if old_center > 0.5 else 0.7
    return max(0.3, min(0.8, y))


def build_graph(*, plan: dict[str, Any], edit: dict[str, Any], framing: dict[str, Any], keys: list[list[tuple[float, float]]],
                src: dict[str, Any], seek_base: float, btext: dict[str, Any], ass_name: str | None, fonts_rel: str | None,
                stats: dict[str, Any], fps: float) -> str:
    sw, sh = src["width"], src["height"]
    segs = plan["segments"]
    n = len(segs)
    speed = plan["speed"]
    layout = framing["layout"]
    zoom = max(1.0, min(2.5, framing.get("zoom", 1.0)))
    chains: list[str] = []

    # 1) normalise + optional burned-text mask/crop in source coordinates
    pre = [f"fps={fps}", "setsar=1"]
    v_in = "[0:v]"
    if btext.get("applied") == "mask" and btext.get("box"):
        bx, by, bw, bh = btext["box"]
        x, y, w, h = _even(bx * sw), _even(by * sh), max(16, _even(bw * sw)), max(16, _even(bh * sh))
        chains.append(f"{v_in}{','.join(pre)},split=2[pm0][pm1]")
        chains.append(f"[pm1]crop={w}:{h}:{x}:{y},boxblur=luma_radius=min(h\\,w)/4:luma_power=3[pmb]")
        chains.append(f"[pm0][pmb]overlay={x}:{y}[vsrc]")
    elif btext.get("applied") == "crop" and btext.get("box"):
        keep_h = _even(btext["box"][1] * sh)
        chains.append(f"{v_in}{','.join(pre)},crop={sw}:{keep_h}:0:0[vsrc]")
        sh = keep_h
    else:
        chains.append(f"{v_in}{','.join(pre)}[vsrc]")

    chains.append(f"[vsrc]split={n}" + "".join(f"[vs{i}]" for i in range(n)))
    chains.append(f"[0:a]aresample=48000,asplit={n}" + "".join(f"[as{i}]" for i in range(n)))

    crop_h = _even(sh / zoom)
    crop_w = _even(crop_h * 9 / 16)
    if crop_w > sw:
        crop_w = _even(sw)
        crop_h = _even(crop_w * 16 / 9)
    face_y = stats.get("face_y", 0.4)
    crop_y = int(min(sh - crop_h, max(0, face_y * sh - crop_h * 0.38)))

    for i, s in enumerate(segs):
        a, b = round(s["start"] - seek_base, 3), round(s["end"] - seek_base, 3)
        v = f"[vs{i}]trim=start={a}:end={b},setpts=PTS-STARTPTS"
        if layout == "fill":
            xexpr = reframe.x_expression(keys[i], "iw", crop_w, sw)
            v += f",crop=w={crop_w}:h={crop_h}:x='{xexpr}':y={crop_y}"
        chains.append(v + f"[v{i}]")
        dur = b - a
        fade = min(0.012, dur / 4)
        chains.append(f"[as{i}]atrim=start={a}:end={b},asetpts=PTS-STARTPTS,afade=t=in:d={fade},afade=t=out:st={max(0, dur - fade):.3f}:d={fade}[a{i}]")

    chains.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[vc][ac]")

    vchain = "[vc]"
    if abs(speed - 1.0) > 1e-3:
        chains.append(f"[vc]setpts=PTS/{speed}[vsp]")
        vchain = "[vsp]"

    # 2) layout to 1080x1920
    if layout == "fill":
        chains.append(f"{vchain}scale={OUT_W}:{OUT_H}:flags=lanczos,setsar=1[vl]")
    elif layout == "split":
        c1, c2 = stats["clusters"]
        half_h = _even(sh * 0.92 / max(1.0, zoom))
        half_w = _even(half_h * OUT_W / (OUT_H / 2))
        if half_w > sw / 2 + sw * 0.1:
            half_w = _even(sw * 0.55)
            half_h = _even(half_w * (OUT_H / 2) / OUT_W)
        top_y = int(max(0, min(sh - half_h, face_y * sh - half_h * 0.4)))
        x1 = int(min(sw - half_w, max(0, c1 * sw - half_w / 2)))
        x2 = int(min(sw - half_w, max(0, c2 * sw - half_w / 2)))
        chains.append(f"{vchain}split=2[sp0][sp1]")
        chains.append(f"[sp0]crop={half_w}:{half_h}:{x1}:{top_y},scale={OUT_W}:{OUT_H // 2}:flags=lanczos[spt]")
        chains.append(f"[sp1]crop={half_w}:{half_h}:{x2}:{top_y},scale={OUT_W}:{OUT_H // 2}:flags=lanczos[spb]")
        chains.append("[spt][spb]vstack=inputs=2,drawbox=x=0:y=957:w=1080:h=6:color=black@0.85:t=fill,setsar=1[vl]")
    else:  # blur / fit
        fit_scale = min(OUT_W / sw, OUT_H / sh) * zoom
        fg_w, fg_h = _even(sw * fit_scale), _even(sh * fit_scale)
        chains.append(f"{vchain}split=2[bg0][fg0]")
        chains.append(f"[bg0]scale={OUT_W // 4}:{OUT_H // 4}:force_original_aspect_ratio=increase,crop={OUT_W // 4}:{OUT_H // 4},boxblur=12:3,eq=brightness=-0.06:saturation=1.1,scale={OUT_W}:{OUT_H}[bg1]")
        fg = f"[fg0]scale={fg_w}:{fg_h}:flags=lanczos"
        if fg_w > OUT_W:
            subj = framing.get("subject_x")
            subj = 0.5 if subj is None else float(subj)
            cx = int(min(fg_w - OUT_W, max(0, subj * fg_w - OUT_W / 2)))
            fg += f",crop={OUT_W}:{min(fg_h, OUT_H)}:{cx}:0"
            fg_h = min(fg_h, OUT_H)
        chains.append(fg + "[fg1]")
        y = int(max(0, min(OUT_H - fg_h, OUT_H * 0.44 - fg_h / 2))) if layout == "blur" else (OUT_H - fg_h) // 2
        chains.append(f"[bg1][fg1]overlay=(W-w)/2:{y},setsar=1[vl]")

    # 3) captions + hook
    if ass_name:
        fonts = f":fontsdir='{fonts_rel}'" if fonts_rel else ""
        chains.append(f"[vl]ass='{ass_name}'{fonts},format=yuv420p[vout]")
    else:
        chains.append("[vl]format=yuv420p[vout]")

    # 4) audio: speed, gain, cleanup, loudness
    af = ["highpass=f=70"]
    if abs(speed - 1.0) > 1e-3:
        af.append(f"atempo={speed}")
    vol = float(edit.get("volume_db") or 0.0)
    if abs(vol) > 0.01:
        af.append(f"volume={vol}dB")
    if edit.get("denoise", True):
        af.append("afftdn=nr=10:nf=-40:tn=1")
    af.append("loudnorm=I=-14:TP=-1.5:LRA=11")
    af.append("aresample=48000")
    chains.append(f"[ac]{','.join(af)}[aout]")
    return ";\n".join(chains)


def render_clip(*, work: Path, out_path: Path, plan: dict[str, Any], edit: dict[str, Any], src: dict[str, Any],
                frames: list[dict[str, Any]], scenes: list[float], burned: dict[str, Any], emphasis: set[int],
                ctx: JobContext, on_progress: Callable[[float], None]) -> dict[str, Any]:
    work.mkdir(parents=True, exist_ok=True)
    segs = plan["segments"]
    stats = reframe.analyse_range(frames, segs[0]["start"], segs[-1]["end"])
    framing = resolve_framing(edit, stats, src["width"], src["height"])
    btext = burned_text_plan(edit, burned, framing["layout"])
    style = cap.resolve_style(edit.get("caption"))
    y = caption_position(style, framing["layout"], stats, btext)

    eff_sw, eff_sh = src["width"], src["height"]
    if btext.get("applied") == "crop":
        eff_sh = _even(btext["box"][1] * eff_sh)
    zoom = max(1.0, min(2.5, framing.get("zoom", 1.0)))
    crop_h = _even(eff_sh / zoom)
    crop_w = min(_even(crop_h * 9 / 16), _even(eff_sw))
    keys = reframe.track_keyframes(frames, segs, scenes, crop_w / max(1, eff_sw), framing.get("subject_x"))

    ass_text = cap.build_ass(plan, style, hook=edit.get("hook"), emphasis=emphasis, caption_y=y)
    ass_path = cap.write(work / "captions.ass", ass_text)
    srt_path = cap.write(work / "captions.srt", cap.build_srt(plan, style))

    fonts_rel = None
    if settings.fonts_dir.is_dir() and any(settings.fonts_dir.iterdir()):
        try:
            fonts_rel = os.path.relpath(settings.fonts_dir, work).replace("\\", "/")
        except ValueError:
            fonts_rel = None

    fps = src.get("fps") or 30.0
    fps = 30.0 if fps <= 0 or fps > 61 else fps
    fps_out = "30000/1001" if abs(fps - 29.97) < 0.02 else "24000/1001" if abs(fps - 23.976) < 0.02 else str(round(fps, 3))
    seek_base = max(0.0, segs[0]["start"] - 1.0)
    to = segs[-1]["end"] + 0.5
    graph = build_graph(plan=plan, edit=edit, framing=framing, keys=keys, src={**src, "width": src["width"], "height": src["height"]},
                        seek_base=seek_base, btext=btext, ass_name="captions.ass", fonts_rel=fonts_rel, stats=stats, fps=fps_out)
    graph_path = work / "graph.txt"
    graph_path.write_text(graph, encoding="utf-8")
    tmp_out = out_path.with_suffix(".tmp.mp4")
    args = [
        "-ss", f"{seek_base:.3f}", "-to", f"{to:.3f}", "-i", str(src["path"]),
        "-/filter_complex", "graph.txt",
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", settings.render_preset, "-crf", str(settings.render_crf),
        "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p", "-r", fps_out,
        "-g", str(int(round(float(eval(fps_out)) * 2))),  # noqa: S307 - fps_out is our own numeric string
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-sn", "-dn", "-map_metadata", "-1", "-movflags", "+faststart",
        "-metadata", "comment=Made with CapClip",
        str(tmp_out),
    ]
    run_ffmpeg(args, ctx=ctx, duration=plan["duration"], on_progress=on_progress, cwd=work)
    os.replace(tmp_out, out_path)
    return {
        "framing": {k: v for k, v in framing.items()},
        "framing_stats": stats,
        "burned_text": btext,
        "caption_style": style,
        "caption_y": y,
        "ass_path": str(ass_path),
        "srt_path": str(srt_path),
        "keyframes": keys,
    }
