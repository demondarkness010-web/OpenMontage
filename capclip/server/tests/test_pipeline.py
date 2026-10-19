"""Fast unit tests for the pure pipeline logic (no media, no network).

Run: .venv/Scripts/python -m pytest tests/test_pipeline.py   (or python tests/test_pipeline.py)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("CAPCLIP_EMBEDDED_WORKER", "false")

from capclip.pipeline import analysis, captions, reframe, youtube  # noqa: E402
from capclip.pipeline.edit import DEFAULT_EDIT, compute_plan, flatten_words, source_to_output  # noqa: E402

TEXT = ("Here's the truth nobody tells you about productivity. Working longer hours does not make you more productive. "
        "In fact, after about fifty hours a week, output per hour drops sharply. Um, so what actually works? Protecting your first two hours. "
        "I I think your brain is sharpest in the morning, and most people spend that window answering email. "
        "Move the email to the afternoon, and use the morning for the one task that really matters. "
        "That single change gave me back more focused time than any app I have ever tried.")


def make_words(text: str = TEXT, repeat: int = 3):
    t, words = 0.0, []
    for tok in (text + " ") .split() * repeat:
        d = 0.18 + 0.013 * len(tok)
        words.append({"w": tok, "s": round(t, 3), "e": round(t + d, 3), "p": 0.95})
        t += d + (0.9 if tok.endswith((".", "?")) else 0.06)
    return flatten_words([{"start": 0, "end": t, "text": text, "words": words}])


def test_youtube_parsing():
    vid = "dQw4w9WgXcQ"
    for url in [f"https://www.youtube.com/watch?v={vid}&t=10", f"youtu.be/{vid}", f"https://m.youtube.com/shorts/{vid}",
                f"https://www.youtube.com/embed/{vid}", f"https://www.youtube.com/live/{vid}?si=x", vid]:
        assert youtube.parse_video_id(url) == vid, url
    for bad in ["https://vimeo.com/123", "https://www.youtube.com/playlist?list=PL1", "https://www.youtube.com/@channel", ""]:
        try:
            youtube.parse_video_id(bad)
        except youtube.InvalidYouTubeURL:
            continue
        raise AssertionError(f"accepted {bad!r}")


def test_plan_removes_fillers_stutters_and_pauses():
    words = make_words()
    sents = analysis.build_sentences(words)
    plan = compute_plan(words, {**DEFAULT_EDIT, "start": sents[0]["start"], "end": sents[7]["end"]})
    removed = {words[i]["w"] for i in plan["removed"]}
    assert "Um," in removed and "I" in removed
    assert any(g["cut"] for g in plan["gaps"])
    # Output timeline is monotonic and never longer than the source span.
    ts = [w["s"] for w in plan["words"]]
    assert ts == sorted(ts)
    assert plan["duration"] < plan["source_duration"]
    # No kept word is clipped by a cut.
    for w in plan["words"]:
        assert any(s["start"] <= w["src_s"] and w["src_e"] <= s["end"] + 1e-6 for s in plan["segments"]), w


def test_restoring_gaps_and_speed():
    words = make_words()
    sents = analysis.build_sentences(words)
    base = {**DEFAULT_EDIT, "start": sents[0]["start"], "end": sents[7]["end"]}
    plan = compute_plan(words, base)
    restored = compute_plan(words, {**base, "restored_gaps": [g["id"] for g in plan["gaps"]], "remove_fillers": False})
    assert restored["duration"] > plan["duration"]
    fast = compute_plan(words, {**base, "speed": 1.25})
    assert abs(fast["duration"] - plan["duration"] / 1.25) < 0.05
    mid = plan["words"][10]
    assert abs(source_to_output(plan, mid["src_s"]) - mid["s"]) < 0.02


def test_heuristic_analysis_fits_duration_window():
    words = make_words(TEXT + " " + TEXT.replace("productivity", "focus").replace("email", "messages"), repeat=2)
    env = {"window": 0.25, "db": [-20.0] * 2000}
    res = analysis.analyze(words=words, envelope=env, frames=[], scenes=[], duration=words[-1]["e"], source_title="T",
                           frame_grabber=lambda ts: [], base_edit=dict(DEFAULT_EDIT), on_progress=lambda f, m: None)
    assert res["analyzer"] == "heuristic"
    assert res["clips"], res["warnings"]
    for c in res["clips"]:
        assert 29.5 <= c["duration"] <= 60.5
        assert not c["publish"]["title"].lower().startswith("um")
    spans = sorted((c["start"], c["end"]) for c in res["clips"])
    for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
        assert b0 >= a1 - 0.15 * min(a1 - a0, b1 - b0)


def test_short_source_reports_limitation():
    words = make_words("Hello there. This is short.", repeat=1)
    res = analysis.analyze(words=words, envelope={"window": 0.25, "db": [-20.0] * 40}, frames=[], scenes=[], duration=5,
                           source_title="", frame_grabber=lambda ts: [], base_edit=dict(DEFAULT_EDIT), on_progress=lambda f, m: None)
    assert res["clips"] == [] and "seconds of speech" in res["warnings"][0]


def test_captions_ass_and_srt():
    words = make_words()
    sents = analysis.build_sentences(words)
    plan = compute_plan(words, {**DEFAULT_EDIT, "start": sents[0]["start"], "end": sents[7]["end"]})
    for preset in captions.PRESETS:
        style = captions.resolve_style({"preset": preset})
        ass = captions.build_ass(plan, style, hook={"text": "Hook", "show": True, "duration": 3})
        assert "PlayResX: 1080" in ass and "Style: Cap," in ass and "Dialogue:" in ass
    srt = captions.build_srt(plan, captions.resolve_style({}))
    assert srt.startswith("1\n00:00:00")
    style = captions.resolve_style({"preset": "bold_viral", "words_per_caption": 3})
    assert all(len(p) <= 4 for p in captions.build_phrases(plan["words"], style))


def test_reframe_tracking_holds_and_moves():
    frames = [{"t": i * 0.5, "faces": [{"x": 0.3 if i < 40 else 0.7, "y": 0.4, "w": 0.1, "h": 0.15}], "motion": 0.01, "text": []} for i in range(120)]
    keys = reframe.track_keyframes(frames, [{"start": 0, "end": 60}], [], 0.316)
    xs = [k[1] for k in keys[0]]
    assert abs(xs[0] - 0.3) < 0.02 and abs(xs[-1] - 0.7) < 0.02
    assert len(keys[0]) <= 6  # one move, no jitter
    expr = reframe.x_expression(keys[0], "iw", 606, 1920)
    assert expr.startswith("if(")
    stats = reframe.analyse_range(frames, 0, 60)
    assert reframe.choose_layout(stats, 1920, 1080)[0] in ("fill", "split")
    assert reframe.choose_layout(stats, 1080, 1920)[0] == "fit"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
