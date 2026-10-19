"""Caption styling, phrase layout and ASS/SRT generation.

Captions are built from the clip plan's output-time words, so they are
synchronised with the rendered audio by construction. Styling is expressed as
a preset plus user overrides; the same style object drives the browser preview
(see web/src/lib/captions.ts) and libass rendering here.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..config import settings

W, H = 1080, 1920
SAFE_X = 90  # left/right safe margin in px

PRESETS: dict[str, dict[str, Any]] = {
    "bold_viral": {
        "label": "Bold Viral",
        "description": "Heavy uppercase words, yellow active-word pop.",
        "font": "Arial Black", "size": 84, "bold": True, "uppercase": True,
        "color": "#FFFFFF", "highlight": "#FFE11A", "emphasis": "#C6FF3D",
        "outline": 7, "outline_color": "#000000", "shadow": 3, "shadow_color": "#000000",
        "box": False, "box_color": "#000000", "highlight_mode": "color",
        "words_per_caption": 3, "max_chars_per_line": 16, "max_lines": 2,
        "position": 0.68, "animation": "pop", "animation_speed": 1.0, "letter_spacing": 0,
    },
    "clean_minimal": {
        "label": "Clean Minimal",
        "description": "Sentence-case on a soft translucent plate.",
        "font": "Segoe UI", "size": 60, "bold": True, "uppercase": False,
        "color": "#FFFFFF", "highlight": "#FFFFFF", "emphasis": "#FFFFFF",
        "outline": 0, "outline_color": "#000000", "shadow": 0, "shadow_color": "#000000",
        "box": True, "box_color": "#000000B0", "highlight_mode": "none",
        "words_per_caption": 7, "max_chars_per_line": 28, "max_lines": 2,
        "position": 0.72, "animation": "fade", "animation_speed": 1.0, "letter_spacing": 0,
    },
    "modern_creator": {
        "label": "Modern Creator",
        "description": "Punchy lime pill behind the spoken word.",
        "font": "Trebuchet MS", "size": 76, "bold": True, "uppercase": False,
        "color": "#FFFFFF", "highlight": "#0B0B0F", "emphasis": "#C6FF3D",
        "outline": 5, "outline_color": "#0B0B0F", "shadow": 0, "shadow_color": "#000000",
        "box": False, "box_color": "#C6FF3D", "highlight_mode": "box",
        "words_per_caption": 4, "max_chars_per_line": 18, "max_lines": 2,
        "position": 0.66, "animation": "pop", "animation_speed": 1.2, "letter_spacing": 0,
    },
    "cinematic": {
        "label": "Cinematic",
        "description": "Elegant serif, wide tracking, slow fades.",
        "font": "Georgia", "size": 58, "bold": False, "uppercase": False,
        "color": "#F4EBDD", "highlight": "#FFFFFF", "emphasis": "#F2C98A",
        "outline": 0, "outline_color": "#000000", "shadow": 2, "shadow_color": "#000000",
        "box": False, "box_color": "#000000", "highlight_mode": "none",
        "words_per_caption": 7, "max_chars_per_line": 30, "max_lines": 2,
        "position": 0.78, "animation": "fade", "animation_speed": 0.7, "letter_spacing": 3,
    },
    "podcast_highlight": {
        "label": "Podcast Highlight",
        "description": "Full line visible, violet box tracks each word.",
        "font": "Arial", "size": 68, "bold": True, "uppercase": False,
        "color": "#FFFFFF", "highlight": "#FFFFFF", "emphasis": "#C4B5FD",
        "outline": 4, "outline_color": "#000000", "shadow": 0, "shadow_color": "#000000",
        "box": False, "box_color": "#7C3AED", "highlight_mode": "box",
        "words_per_caption": 6, "max_chars_per_line": 22, "max_lines": 2,
        "position": 0.70, "animation": "none", "animation_speed": 1.0, "letter_spacing": 0,
    },
}

SYSTEM_FONTS = ["Arial", "Arial Black", "Impact", "Segoe UI", "Trebuchet MS", "Verdana", "Tahoma", "Georgia", "Times New Roman", "Courier New"]


def available_fonts() -> list[str]:
    fonts = list(SYSTEM_FONTS)
    if settings.fonts_dir.is_dir():
        for f in sorted(settings.fonts_dir.glob("*.[ot]tf")):
            name = re.sub(r"[-_](Regular|Bold|Black|Medium|SemiBold|ExtraBold|Italic)$", "", f.stem, flags=re.I)
            name = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name)
            if name not in fonts:
                fonts.append(name)
    return fonts


def resolve_style(caption: dict[str, Any] | None) -> dict[str, Any]:
    caption = caption or {}
    base = PRESETS.get(caption.get("preset") or "bold_viral", PRESETS["bold_viral"])
    style = {**base, **{k: v for k, v in caption.items() if v is not None and k != "preset"}}
    style["preset"] = caption.get("preset") or "bold_viral"
    style["enabled"] = caption.get("enabled", True)
    style["size"] = int(max(28, min(140, float(style["size"]))))
    style["position"] = float(max(0.12, min(0.86, float(style["position"]))))
    style["animation_speed"] = float(max(0.25, min(3.0, float(style["animation_speed"]))))
    style["words_per_caption"] = int(max(1, min(12, int(style["words_per_caption"]))))
    return style


def _ass_color(hex_color: str) -> str:
    """#RRGGBB or #RRGGBBAA (AA = opacity) -> &HAABBGGRR (ASS alpha is transparency)."""
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = h[0:2], h[2:4], h[4:6]
    alpha = 255 - int(h[6:8], 16) if len(h) == 8 else 0
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _inline_color(hex_color: str) -> str:
    h = hex_color.lstrip("#")[:6]
    return f"&H{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


def _esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


def build_phrases(words: list[dict[str, Any]], style: dict[str, Any]) -> list[list[dict[str, Any]]]:
    max_words = style["words_per_caption"]
    max_chars = style["max_chars_per_line"] * style["max_lines"]
    phrases: list[list[dict[str, Any]]] = []
    cur: list[dict[str, Any]] = []
    for i, w in enumerate(words):
        text = w["w"]
        cur_len = sum(len(x["w"]) + 1 for x in cur)
        if cur and (len(cur) >= max_words or cur_len + len(text) > max_chars or w["s"] - cur[-1]["e"] > 0.6):
            phrases.append(cur)
            cur = []
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        ends_sentence = bool(re.search(r"[.!?]$", text))
        soft_break = bool(re.search(r"[,;:]$", text)) and len(cur) >= max(2, max_words // 2)
        if ends_sentence or soft_break or (nxt and nxt["s"] - w["e"] > 0.45):
            phrases.append(cur)
            cur = []
    if cur:
        phrases.append(cur)
    # Avoid orphan single words when the next phrase can absorb them.
    merged: list[list[dict[str, Any]]] = []
    for p in phrases:
        if merged and len(p) == 1 and len(merged[-1]) < max_words and p[0]["s"] - merged[-1][-1]["e"] < 0.25 \
                and not re.search(r"[.!?]$", merged[-1][-1]["w"]):
            merged[-1].append(p[0])
        else:
            merged.append(p)
    return merged


def _line_break(tokens: list[str], max_chars: int, max_lines: int) -> list[list[int]]:
    """Split token indices into balanced lines."""
    total = sum(len(t) for t in tokens) + len(tokens) - 1
    if total <= max_chars or max_lines < 2 or len(tokens) < 2:
        return [list(range(len(tokens)))]
    best, best_cost = 1, 1e9
    for k in range(1, len(tokens)):
        a = sum(len(t) for t in tokens[:k]) + k - 1
        b = sum(len(t) for t in tokens[k:]) + len(tokens) - k - 1
        cost = abs(a - b) + (100 if max(a, b) > max_chars else 0)
        if cost < best_cost:
            best, best_cost = k, cost
    return [list(range(best)), list(range(best, len(tokens)))]


def _display(text: str, style: dict[str, Any]) -> str:
    text = text.strip()
    if style.get("uppercase"):
        text = text.upper()
    if style["preset"] in ("bold_viral", "modern_creator"):
        text = re.sub(r"[,;]$", "", text)
    return text


def build_ass(plan: dict[str, Any], style: dict[str, Any], *, hook: dict[str, Any] | None = None,
              emphasis: set[int] | None = None, caption_y: float | None = None) -> str:
    emphasis = emphasis or set()
    y = int(H * (caption_y if caption_y is not None else style["position"]))
    bold = -1 if style.get("bold") else 0
    border_style = 3 if style.get("box") else 1
    outline_col = _ass_color(style["box_color"]) if style.get("box") else _ass_color(style["outline_color"])
    back_col = _ass_color(style["box_color"]) if style.get("box") else _ass_color(style.get("shadow_color", "#000000") + "A0")
    outline = 14 if style.get("box") else style["outline"]
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {W}",
        f"PlayResY: {H}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Cap,{style['font']},{style['size']},{_ass_color(style['color'])},{_ass_color(style['highlight'])},{outline_col},{back_col},{bold},0,0,0,100,100,{style.get('letter_spacing', 0)},0,{border_style},{outline},{style['shadow']},5,{SAFE_X},{SAFE_X},0,1",
        f"Style: Hook,{style['font']},{max(52, int(style['size'] * 0.82))},&H00FFFFFF,&H00FFFFFF,&H00101014,&H00101014,-1,0,0,0,100,100,0,0,3,22,0,5,{SAFE_X},{SAFE_X},0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    def ts(t: float) -> str:
        t = max(0.0, t)
        cs = int(round(t * 100))
        h, cs = divmod(cs, 360000)
        m, cs = divmod(cs, 6000)
        s, cs = divmod(cs, 100)
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

    if hook and hook.get("show", True) and (hook.get("text") or "").strip():
        hook_text = _esc(hook["text"].strip())
        dur = float(hook.get("duration") or 3.0)
        # Wrap hook text to ~22 chars a line.
        wrapped, line = [], ""
        for token in hook_text.split():
            if len(line) + len(token) + 1 > 22 and line:
                wrapped.append(line)
                line = token
            else:
                line = f"{line} {token}".strip()
        if line:
            wrapped.append(line)
        lines.append(f"Dialogue: 2,{ts(0)},{ts(dur)},Hook,,0,0,0,,{{\\pos({W // 2},{int(H * 0.2)})\\fad(180,220)\\fscx92\\fscy92\\t(0,220,\\fscx100\\fscy100)}}" + "\\N".join(wrapped))

    if not style.get("enabled", True):
        return "\n".join(lines) + "\n"

    speed = style["animation_speed"]
    pop_ms = int(110 / speed)
    fade_ms = int(160 / speed)
    hl = _inline_color(style["highlight"])
    em = _inline_color(style.get("emphasis") or style["highlight"])
    base = _inline_color(style["color"])
    box = _inline_color(style["box_color"][:7])
    mode = style.get("highlight_mode", "color")
    phrases = build_phrases(plan["words"], style)
    for pi, phrase in enumerate(phrases):
        tokens = [_esc(_display(w["w"], style)) for w in phrase]
        rows = _line_break(tokens, style["max_chars_per_line"], style["max_lines"])
        p_start = phrase[0]["s"]
        nxt_start = phrases[pi + 1][0]["s"] if pi + 1 < len(phrases) else None
        p_end = phrase[-1]["e"] + 0.25
        if nxt_start is not None:
            p_end = min(p_end, nxt_start)
        for wi, w in enumerate(phrase):
            ev_start = p_start if wi == 0 else w["s"]
            ev_end = phrase[wi + 1]["s"] if wi + 1 < len(phrase) else p_end
            if ev_end - ev_start < 0.02:
                continue
            parts = []
            for row in rows:
                row_txt = []
                for k in row:
                    tok = tokens[k]
                    is_active = k == wi
                    is_em = phrase[k]["i"] in emphasis
                    if is_active and mode == "color":
                        row_txt.append(f"{{\\c{hl}\\fscx108\\fscy108}}{tok}{{\\c{base}\\fscx100\\fscy100}}")
                    elif is_active and mode == "box":
                        row_txt.append(f"{{\\c{hl}\\3c{box}\\bord14}}{tok}{{\\c{base}\\3c{_inline_color(style['outline_color'])}\\bord{style['outline']}}}")
                    elif is_em and mode != "none":
                        row_txt.append(f"{{\\c{em}}}{tok}{{\\c{base}}}")
                    else:
                        row_txt.append(tok)
                parts.append(" ".join(row_txt))
            text = "\\N".join(parts)
            prefix = f"\\pos({W // 2},{y})"
            if style["animation"] == "pop" and wi == 0:
                prefix += f"\\fscx84\\fscy84\\t(0,{pop_ms},\\fscx100\\fscy100)"
            elif style["animation"] == "fade" and wi == 0:
                prefix += f"\\fad({fade_ms},0)"
            if style["animation"] == "fade" and wi == len(phrase) - 1 and nxt_start is None:
                prefix += f"\\fad(0,{fade_ms})"
            lines.append(f"Dialogue: 0,{ts(ev_start)},{ts(ev_end)},Cap,,0,0,0,,{{{prefix}}}{text}")
    return "\n".join(lines) + "\n"


def build_srt(plan: dict[str, Any], style: dict[str, Any]) -> str:
    srt_style = {**style, "words_per_caption": max(6, style["words_per_caption"]), "max_chars_per_line": 32, "max_lines": 2, "uppercase": False}
    out = []

    def ts(t: float) -> str:
        ms = int(round(max(0.0, t) * 1000))
        h, ms = divmod(ms, 3600000)
        m, ms = divmod(ms, 60000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    phrases = build_phrases(plan["words"], srt_style)
    for n, phrase in enumerate(phrases, 1):
        tokens = [w["w"] for w in phrase]
        rows = _line_break(tokens, 32, 2)
        text = "\n".join(" ".join(tokens[k] for k in row) for row in rows)
        end = phrase[-1]["e"] + 0.2
        if n < len(phrases):
            end = min(end, phrases[n][0]["s"])
        out.append(f"{n}\n{ts(phrase[0]['s'])} --> {ts(end)}\n{text}\n")
    return "\n".join(out)


def write(path: Path, content: str) -> Path:
    path.write_text(content, encoding="utf-8")
    return path
