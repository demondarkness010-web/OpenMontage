"""Full-video understanding and clip selection.

Inputs: word-level transcript, loudness envelope, scene cuts, per-frame visual
signals. Output: a ranked list of non-overlapping clip proposals, each fitted
to the 30-60 s window *after* silence/redundancy removal, with publishing
metadata.

Two analyzers share the same post-processing (fitting, de-duplication,
validation):
  * Claude (multimodal) when ANTHROPIC_API_KEY is set
  * a local heuristic analyzer that combines transcript structure, prosody
    (loudness dynamics), visual activity and face presence. It is labelled as
    such in the UI and never presented as AI-written.
"""

from __future__ import annotations

import logging
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..config import settings
from . import llm
from .edit import compute_plan, is_filler, normalize_token

log = logging.getLogger("capclip.analysis")

PARAGRAPH_GAP = 1.8  # seconds of silence that usually marks a topic/paragraph break
SENT_END = re.compile(r"[.!?…]['\")\]]*$")

STOPWORDS = set("""a about above after again against all am an and any are aren't as at be because been before being below between both
but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't
have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it
it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same
shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these
they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what
what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours
yourself yourselves just like really yeah okay ok well gonna wanna kind sort thing things get got go going know mean actually also lot
um uh right say said one two""".split())

HOOK_PATTERNS = [
    r"\b(here'?s (the|what|why|how)|the (secret|truth|problem|reason|key|trick|mistake)|nobody (tells|talks)|most people|what if|"
    r"the (biggest|best|worst|number one)|i (never|finally|realized|learned|discovered)|stop\b|you (need|have) to|don'?t ever|"
    r"this is (why|how|the)|why (do|does|is|are|did)|how (to|do|i|we)|let me (tell|show|explain)|the one thing|imagine|"
    r"did you know|turns out|what (nobody|people don'?t)|i was (wrong|shocked)|wait|honestly|unpopular opinion|believe it or not)"
]
PAYOFF_PATTERNS = r"\b(that'?s (why|how|the|what)|so the (answer|lesson|point)|which means|the point is|in the end|bottom line|" \
                  r"the lesson|that'?s it|and that'?s|it worked|the result|the answer is|so remember|so next time|that changed)"
CONTRAST = r"\b(but|however|actually|instead|turns out|the truth|surprisingly|in fact|except)\b"
STORY = r"\b(when i was|i remember|one day|years ago|last (year|week|month)|the first time|so i|and then)\b"
TUTORIAL = r"\b(step|first,|second|third|tip|how to|you can|try this|make sure|the trick|here'?s how|use (a|the))\b"
INSPIRE = r"\b(dream|believe|never give up|keep going|success|failure|fear|courage|you can do|change your life|discipline|purpose)\b"
HUMOR = r"\b(haha|lol|funny|joke|laugh|hilarious|ridiculous|crazy|insane)\b"
EMOTION = r"\b(love|hate|scared|afraid|cried|amazing|incredible|devastat|heartbreak|angry|shocked|proud|terrified)\w*"
PROMO = r"\b(subscribe|like (and|&) subscribe|link in the (description|bio)|sponsor|brought to you|patreon|merch|discount code|" \
        r"welcome back|hey (guys|everyone)|in today'?s video|before we (start|begin|get started)|don'?t forget to|see you (next|in the))\b"
DANGLING = {"and", "but", "so", "because", "which", "or", "then", "also", "plus", "anyway"}
PRONOUN_START = {"it", "this", "that", "they", "he", "she", "those", "these", "him", "her", "them"}


# ---------------------------------------------------------------------------
# Sentences

def build_sentences(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sentences: list[dict[str, Any]] = []
    cur: list[dict[str, Any]] = []

    def flush() -> None:
        if cur:
            sentences.append({
                "id": len(sentences), "a": cur[0]["i"], "b": cur[-1]["i"], "start": cur[0]["s"], "end": cur[-1]["e"],
                "text": " ".join(w["w"] for w in cur), "n": len(cur),
            })
            cur.clear()

    for w in words:
        # A long pause splits an unpunctuated run, but never strands a short
        # fragment ("Why ... do we"): ASR word timings drift around pauses.
        if cur and w["s"] - cur[-1]["e"] > 1.4 and len(cur) >= 8:
            flush()
        cur.append(w)
        if SENT_END.search(w["w"]) and len(cur) >= 2:
            flush()
        elif len(cur) >= 40 and re.search(r"[,;:]$", w["w"]):
            flush()
        elif len(cur) >= 70:
            flush()
    flush()
    return sentences


def paragraph_gap(sentences: list[dict[str, Any]]) -> float:
    """Silence that marks a topic break *for this speaker*: deliberate speakers
    pause longer between sentences, so a fixed threshold splits their topics."""
    gaps = [b["start"] - a["end"] for a, b in zip(sentences, sentences[1:]) if b["start"] > a["end"]]
    if len(gaps) < 5:
        return PARAGRAPH_GAP
    return float(min(3.0, max(PARAGRAPH_GAP, np.percentile(gaps, 85) * 1.25)))


def est_duration(words: list[dict[str, Any]], a: int, b: int, max_pause: float = 0.38) -> float:
    total = 0.0
    prev = None
    for w in words[a:b + 1]:
        if is_filler(w["w"]):
            continue
        total += w["e"] - w["s"]
        if prev is not None:
            total += min(w["s"] - prev["e"], max_pause)
        prev = w
    return total + 0.5


# ---------------------------------------------------------------------------
# Heuristic scoring

class Signals:
    def __init__(self, words, envelope, frames, scenes):
        self.words = words
        self.env = np.array(envelope.get("db", []), dtype=np.float32)
        self.win = envelope.get("window", 0.25)
        speech = self.env[self.env > np.percentile(self.env, 40)] if len(self.env) else self.env
        self.env_mu = float(np.mean(speech)) if len(speech) else -30.0
        self.env_sd = float(np.std(speech)) + 1e-3 if len(speech) else 6.0
        self.frames = frames
        self.frame_t = np.array([f["t"] for f in frames]) if frames else np.array([])
        self.scenes = np.array(scenes or [])
        tokens = [normalize_token(w["w"]) for w in words]
        self.df = Counter(t for t in tokens if t and t not in STOPWORDS)
        self.total_tokens = max(1, sum(self.df.values()))

    def loudness(self, s: float, e: float) -> tuple[float, float]:
        if not len(self.env):
            return 0.0, 0.0
        seg = self.env[int(s / self.win): max(int(s / self.win) + 1, int(e / self.win))]
        seg = seg[seg > self.env_mu - 2 * self.env_sd]
        if not len(seg):
            return 0.0, 0.0
        z = (seg - self.env_mu) / self.env_sd
        return float(np.mean(z)), float(np.percentile(z, 95))

    def visual(self, s: float, e: float) -> dict[str, float]:
        if not len(self.frame_t):
            return {"face": 0.0, "motion": 0.0, "cuts": 0.0}
        i, j = np.searchsorted(self.frame_t, s), np.searchsorted(self.frame_t, e)
        sel = self.frames[i:j]
        if not sel:
            return {"face": 0.0, "motion": 0.0, "cuts": 0.0}
        cuts = float(((self.scenes > s) & (self.scenes < e)).sum()) if len(self.scenes) else 0.0
        return {"face": sum(1 for f in sel if f["faces"]) / len(sel), "motion": float(np.mean([f["motion"] for f in sel])), "cuts": cuts}


def _rx(pattern: str, text: str) -> int:
    return len(re.findall(pattern, text, re.I))


def score_window(sig: Signals, sentences: list[dict[str, Any]], i: int, j: int, dur: float) -> dict[str, Any]:
    first, last = sentences[i], sentences[j]
    text = " ".join(s["text"] for s in sentences[i:j + 1])
    low = text.lower()
    tokens = [normalize_token(w["w"]) for w in sig.words[first["a"]:last["b"] + 1]]
    content = [t for t in tokens if t and t not in STOPWORDS]
    f_low = first["text"].lower()
    first_tok = next((normalize_token(t) for t in first["text"].split() if not is_filler(t)), "")

    hook = 0.0
    hook += 0.35 if first["text"].rstrip().endswith("?") else 0
    hook += 0.35 if any(re.search(p, f_low) for p in HOOK_PATTERNS) else 0
    hook += 0.1 if re.search(r"\byou\b", f_low) else 0
    hook += 0.1 if re.search(r"\d", f_low) else 0
    hook += 0.1 if first["n"] <= 14 else 0
    if first_tok in DANGLING:
        hook -= 0.45
    elif first_tok in PRONOUN_START:
        hook -= 0.2
    hook = max(0.0, min(1.0, hook))

    tail = " ".join(s["text"] for s in sentences[max(i, j - 1):j + 1]).lower()
    payoff = 0.4 if SENT_END.search(last["text"]) and not last["text"].rstrip().endswith("?") else 0.0
    payoff += 0.35 if re.search(PAYOFF_PATTERNS, tail) else 0
    payoff += 0.15 if re.search(r"!$", last["text"].strip()) else 0
    payoff += 0.1 if 5 <= last["n"] <= 30 else 0
    payoff = min(1.0, payoff)

    mean_z, peak_z = sig.loudness(first["start"], last["end"])
    energy = 1 / (1 + math.exp(-(0.9 * mean_z + 0.6 * (peak_z - 1.5))))

    wps = len(tokens) / max(1.0, dur)
    pace = math.exp(-((wps - 2.8) ** 2) / 1.2)
    uniq = len(set(content)) / max(1, len(content))
    rarity = 0.0
    if content:
        idf = [math.log(sig.total_tokens / (1 + sig.df.get(t, 0))) for t in set(content)]
        rarity = min(1.0, float(np.mean(idf)) / 8.0)
    density = 0.4 * pace + 0.3 * uniq + 0.3 * rarity

    qa = 1.0 if "?" in " ".join(s["text"] for s in sentences[i:i + max(1, (j - i) // 3 + 1)]) and not last["text"].rstrip().endswith("?") else 0.0
    structure = min(1.0, 0.3 * qa + 0.15 * min(2, _rx(CONTRAST, low)) + 0.15 * min(1, _rx(STORY, low)) + 0.12 * min(2, _rx(EMOTION, low))
                    + 0.1 * min(2, _rx(TUTORIAL, low)) + 0.1 * min(1, _rx(HUMOR, low)) + 0.08 * min(2, low.count("!")))

    vis = sig.visual(first["start"], last["end"])
    cut_rate = vis["cuts"] / max(1.0, dur / 10)
    visual = 0.45 * vis["face"] + 0.3 * min(1.0, vis["motion"] * 12) + 0.25 * math.exp(-((cut_rate - 1.0) ** 2) / 2)

    conf = float(np.mean([w.get("p", 1.0) for w in sig.words[first["a"]:last["b"] + 1]])) if tokens else 0.5

    promo = min(1.0, _rx(PROMO, low) * 0.5)
    score = (0.22 * hook + 0.15 * payoff + 0.14 * energy + 0.16 * density + 0.13 * structure + 0.12 * visual + 0.08 * conf) - 0.35 * promo
    if not SENT_END.search(last["text"]):
        score -= 0.08
    category = _category(low, f_low, qa)
    return {"score": round(max(0.0, min(1.0, score)) * 100, 1), "category": category, "features": {
        "hook": round(hook, 2), "payoff": round(payoff, 2), "energy": round(energy, 2), "density": round(density, 2),
        "structure": round(structure, 2), "visual": round(visual, 2), "confidence": round(conf, 2), "promo": round(promo, 2)}}


def _category(low: str, first_low: str, qa: float) -> str:
    scores = {
        "q_and_a": 1.2 * qa,
        "tutorial": _rx(TUTORIAL, low) * 0.5,
        "story": _rx(STORY, low) * 0.7,
        "humor": _rx(HUMOR, low) * 0.8 + low.count("haha"),
        "inspiration": _rx(INSPIRE, low) * 0.6,
        "emotional": _rx(EMOTION, low) * 0.5,
        "opinion": _rx(r"\b(i think|i believe|in my opinion|honestly|unpopular|i disagree|overrated|underrated)\b", low) * 0.7,
        "fact": _rx(r"\b\d+(\.\d+)?\s?(%|percent|million|billion|thousand|years|times)\b", low) * 0.6 + _rx(r"\b(study|research|data|scientists)\b", low) * 0.5,
    }
    best = max(scores.items(), key=lambda kv: kv[1])
    return best[0] if best[1] >= 0.6 else "explanation"


def _reason(features: dict[str, float], category: str) -> str:
    parts = []
    f = features
    if f["hook"] >= 0.5:
        parts.append("opens on a strong hook")
    elif f["hook"] >= 0.3:
        parts.append("starts cleanly at a sentence boundary")
    if f["payoff"] >= 0.6:
        parts.append("ends on a clear payoff")
    if f["energy"] >= 0.6:
        parts.append("delivery is noticeably more animated than the rest of the video")
    if f["structure"] >= 0.4:
        parts.append({"q_and_a": "poses a question and answers it", "story": "has a self-contained story arc",
                      "tutorial": "gives actionable steps", "humor": "has a comedic beat"}.get(category, "has contrast and narrative tension"))
    if f["density"] >= 0.65:
        parts.append("information-dense with little filler")
    if f["visual"] >= 0.6:
        parts.append("the speaker is on camera throughout")
    if not parts:
        parts.append("one of the more self-contained, well-paced passages in the video")
    text = "Heuristic pick: " + ", ".join(parts[:4]) + "."
    return text[0:1].upper() + text[1:]


# ---------------------------------------------------------------------------
# Fitting to the 30-60 s window (after cuts)

def fit_range(words, sentences, i, j, base_edit, lo, hi, para_gap: float = PARAGRAPH_GAP) -> tuple[int, int, dict[str, Any], dict[str, Any]] | None:
    def plan_for(a, b, end_override=None):
        e = {**base_edit, "start": sentences[a]["start"], "end": end_override or sentences[b]["end"]}
        return e, compute_plan(words, e)

    i, j = max(0, i), min(len(sentences) - 1, j)
    if j < i:
        return None
    edit, plan = plan_for(i, j)
    # Shrink from the end while too long (keep the hook).
    while plan["duration"] > hi and j > i:
        j -= 1
        edit, plan = plan_for(i, j)
    if plan["duration"] > hi:
        # A single very long sentence: end at the last clause boundary that fits.
        target = hi - 1.5
        best = None
        for w in plan["words"]:
            if w["e"] > target:
                break
            if re.search(r"[,;:]$", w["w"]) or best is None:
                best = w
        if best is None:
            return None
        edit, plan = plan_for(i, j, end_override=best["src_e"])
    def grow(max_gap: float) -> bool:
        nonlocal i, j, edit, plan, grow_back
        if j + 1 < len(sentences) and sentences[j + 1]["start"] - sentences[j]["end"] < max_gap:
            e2, p2 = plan_for(i, j + 1)
            if p2["duration"] <= hi:
                j, edit, plan = j + 1, e2, p2
                return True
        if i > 0 and grow_back < 2 and sentences[i]["start"] - sentences[i - 1]["end"] < max_gap:
            e2, p2 = plan_for(i - 1, j)
            if p2["duration"] <= hi:
                i, edit, plan = i - 1, e2, p2
                grow_back += 1
                return True
        return False

    grow_back = 0
    # 1) extend within the same passage (sentence gaps under PARAGRAPH_GAP)
    while plan["duration"] < lo and grow(para_gap):
        pass
    # 2) keep more natural pauses rather than borrow from the next topic
    for relaxed in (0.55, 0.75, 1.0):
        if plan["duration"] >= lo:
            break
        e2 = {**edit, "max_pause": max(relaxed, float(edit.get("max_pause") or 0.38))}
        p2 = compute_plan(words, e2)
        if p2["duration"] <= hi:
            edit, plan = e2, p2
    # 3) last resort: cross a longer pause
    while plan["duration"] < lo:
        if not grow(3.0):
            return None
    return i, j, edit, plan


def _content_set(words, a, b) -> set[str]:
    return {t for t in (normalize_token(w["w"]) for w in words[a:b + 1]) if t and t not in STOPWORDS}


def dedupe(cands: list[dict[str, Any]], words) -> list[dict[str, Any]]:
    accepted: list[dict[str, Any]] = []
    for c in sorted(cands, key=lambda c: -c["score"]):
        ok = True
        for a in accepted:
            ov = max(0.0, min(c["end"], a["end"]) - max(c["start"], a["start"]))
            if ov > 0.08 * min(c["end"] - c["start"], a["end"] - a["start"]):
                ok = False
                break
            sa, sb = c["_content"], a["_content"]
            if sa and sb and len(sa & sb) / len(sa | sb) > 0.45:
                ok = False
                break
        if ok:
            accepted.append(c)
    return accepted


# ---------------------------------------------------------------------------
# Heuristic metadata (template-based, clearly labelled)

def heuristic_metadata(clip_words: list[dict[str, Any]], sig: Signals, category: str, source_title: str) -> dict[str, Any]:
    text = " ".join(w["w"] for w in clip_words)
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    first = sents[0] if sents else text
    toks = [normalize_token(w["w"]) for w in clip_words]
    content = [t for t in toks if t and t not in STOPWORDS and len(t) > 2]
    tf = Counter(content)
    scored = sorted(tf.items(), key=lambda kv: -(kv[1] * math.log(sig.total_tokens / (1 + sig.df.get(kv[0], 0)))))
    keywords = [k for k, _ in scored[:6]]
    bigrams = Counter(f"{a} {b}" for a, b in zip(toks, toks[1:]) if a in tf and b in tf and a != b)
    phrases = [p for p, n in bigrams.most_common(4) if n >= 1]

    def trim(s: str, n: int) -> str:
        s = s.strip().strip('"')
        s = s[:1].upper() + s[1:]
        if len(s) <= n:
            return s
        cut = s[:n].rsplit(" ", 1)[0]
        return cut.rstrip(",;:") + "…"

    hook = trim(first, 58)
    title_core = trim(first.rstrip(".!"), 66)
    titles = [title_core]
    if keywords:
        titles.append(trim(f"{keywords[0].capitalize()}: {first.rstrip('.!?')}", 70))
    if len(sents) > 1:
        titles.append(trim(sents[-1].rstrip(".!"), 66))
    hashtags = ["#Shorts"] + [f"#{k.replace(chr(39), '')}" for k in keywords[:4]]
    description = trim(" ".join(sents[:2]), 220)
    if source_title:
        description += f"\n\nFrom: {source_title}"
    return {
        "title": titles[0], "hook": hook, "titles": titles, "description": description, "hashtags": hashtags,
        "keywords": (phrases + keywords)[:8],
        "pinned_comment": f"What's your take on {keywords[0]}?" if keywords else "What did you think of this?",
        "thumbnail_text": " ".join(w.upper() for w in keywords[:2]),
        "generator": "template",
    }


# ---------------------------------------------------------------------------
# Orchestration

def _fmt(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:04.1f}"


def visual_timeline(frames: list[dict[str, Any]], scenes: list[float], duration: float, bucket: float = 10.0) -> str:
    rows = []
    prev = None
    n = int(math.ceil(duration / bucket))
    ft = np.array([f["t"] for f in frames]) if frames else np.array([])
    for k in range(n):
        s, e = k * bucket, (k + 1) * bucket
        i, j = (np.searchsorted(ft, s), np.searchsorted(ft, e)) if len(ft) else (0, 0)
        sel = frames[i:j]
        if not sel:
            continue
        faces = float(np.mean([len(f["faces"]) for f in sel]))
        motion = float(np.mean([f["motion"] for f in sel]))
        text = sum(1 for f in sel if f["text"]) / len(sel)
        cuts = sum(1 for c in scenes if s <= c < e)
        desc = (f"{'no face' if faces < 0.3 else '1 face' if faces < 1.4 else f'{faces:.0f} faces'}, "
                f"{'static' if motion < 0.015 else 'moving' if motion < 0.05 else 'high motion'}"
                f"{', on-screen text' if text > 0.5 else ''}{f', {cuts} cut(s)' if cuts else ''}")
        if desc != prev or cuts:
            rows.append(f"{_fmt(s)}: {desc}")
            prev = desc
    return "\n".join(rows) or "No visual data."


def pick_llm_frames(frames_dir: Path, duration: float, n: int) -> list[float]:
    if n <= 0:
        return []
    return [duration * (k + 0.5) / n for k in range(n)]


def analyze(*, words, envelope, frames, scenes, duration, source_title, frame_grabber: Callable[[list[float]], list[tuple[float, Path]]],
            base_edit: dict[str, Any], on_progress: Callable[[float, str], None]) -> dict[str, Any]:
    lo, hi = settings.min_clip_seconds, settings.max_clip_seconds
    sentences = build_sentences(words)
    para = paragraph_gap(sentences)
    sig = Signals(words, envelope, frames, scenes)
    warnings: list[str] = []
    speech_total = sum(w["e"] - w["s"] for w in words)
    if speech_total < lo:
        return {"clips": [], "analyzer": "none", "sentences": len(sentences), "warnings": [
            f"The source only contains about {speech_total:.0f} seconds of speech. A Short needs at least {lo:.0f} seconds of worthwhile "
            "material, so no clips were created rather than padding with filler."]}

    analyzer = settings.llm_active
    raw: list[dict[str, Any]] = []
    if analyzer == "anthropic":
        try:
            on_progress(0.1, "Claude is reviewing the full transcript and sampled frames")
            transcript_block = "\n".join(
                f"S{s['id']} [{_fmt(s['start'])}-{_fmt(s['end'])}] ({est_duration(words, s['a'], s['b']):.1f}s) {s['text']}" for s in sentences)
            n_frames = min(40, max(8, int(duration / 60) * settings.vision_frames_per_clip))
            frame_paths = frame_grabber(pick_llm_frames(Path("."), duration, n_frames))
            result = llm.select_clips(transcript_block, visual_timeline(frames, scenes, duration), frame_paths, source_title, duration)
            if result.get("notes"):
                warnings.append(f"AI note: {result['notes']}")
            for c in result.get("clips", []):
                raw.append({**c, "_source": "anthropic"})
        except Exception as exc:  # noqa: BLE001 - provider errors must not kill the job
            log.exception("LLM selection failed")
            warnings.append(f"AI clip selection failed ({exc.__class__.__name__}: {str(exc)[:160]}); used the local heuristic analyzer instead.")
            analyzer = "heuristic"

    on_progress(0.5, "Scoring candidate moments")
    proposals: list[dict[str, Any]] = []
    rejected = 0
    if analyzer == "anthropic":
        for c in raw:
            i, j = int(c["start_sentence"]), int(c["end_sentence"])
            if not (0 <= i < len(sentences)) or not (0 <= j < len(sentences)) or j < i:
                rejected += 1
                continue
            fitted = fit_range(words, sentences, i, j, base_edit, lo, hi, para)
            if not fitted:
                rejected += 1
                continue
            fi, fj, edit, plan = fitted
            drop = [d for d in c.get("drop_sentences", []) if fi < d < fj]
            if drop:
                removed = [w for d in drop for w in range(sentences[d]["a"], sentences[d]["b"] + 1)]
                e2 = {**edit, "removed_words": removed}
                p2 = compute_plan(words, e2)
                if p2["duration"] >= lo:
                    edit, plan = e2, p2
            emph_tokens = {normalize_token(x) for x in c.get("emphasis_words", [])}
            emphasis = [w["i"] for w in plan["words"] if normalize_token(w["orig"]) in emph_tokens]
            thumb_s = sentences[min(max(fi, int(c.get("thumbnail_sentence", fi))), fj)]["start"]
            proposals.append({
                "start": edit["start"], "end": edit["end"], "i": fi, "j": fj, "edit": edit, "duration": plan["duration"],
                "score": float(max(0, min(100, c.get("engagement_score", 50)))), "category": c.get("category", "explanation"),
                "reason": c.get("reason", ""), "emphasis": emphasis, "thumbnail_time": thumb_s,
                "publish": {k: c.get(k) for k in llm.METADATA_PROPS} | {"generator": "ai"},
                "_content": _content_set(words, sentences[fi]["a"], sentences[fj]["b"]),
            })
    else:
        cands: list[dict[str, Any]] = []
        total = len(sentences)
        for i in range(total):
            if i % 25 == 0:
                on_progress(0.5 + 0.35 * i / max(1, total), f"Scoring candidate moments · {i}/{total} sentences")
            j = i
            est = est_duration(words, sentences[i]["a"], sentences[j]["b"])
            while est < lo + 2 and j + 1 < total and sentences[j + 1]["start"] - sentences[j]["end"] < para:
                j += 1
                est = est_duration(words, sentences[i]["a"], sentences[j]["b"])
            best = None
            for jj in range(j, min(total, j + 5)):
                est = est_duration(words, sentences[i]["a"], sentences[jj]["b"])
                if est > hi - 1:
                    break
                if est_duration(words, sentences[i]["a"], sentences[jj]["b"], max_pause=1.0) < lo:
                    continue
                if jj > j and sentences[jj]["start"] - sentences[jj - 1]["end"] >= para:
                    break
                sc = score_window(sig, sentences, i, jj, est)
                if best is None or sc["score"] > best[2]["score"]:
                    best = (i, jj, sc)
            if best:
                cands.append({"i": best[0], "j": best[1], **best[2], "start": sentences[best[0]]["start"], "end": sentences[best[1]]["end"],
                              "_content": _content_set(words, sentences[best[0]]["a"], sentences[best[1]]["b"])})
        if cands:
            top = max(c["score"] for c in cands)
            floor = max(42.0, 0.78 * top)
            good = [c for c in cands if c["score"] >= floor]
            for c in dedupe(good, words):
                fitted = fit_range(words, sentences, c["i"], c["j"], base_edit, lo, hi, para)
                if not fitted:
                    rejected += 1
                    continue
                fi, fj, edit, plan = fitted
                kept_idx = {w["i"] for w in plan["words"]}
                clip_words = [w for w in words[sentences[fi]["a"]:sentences[fj]["b"] + 1] if w["i"] in kept_idx]
                mean_z, _ = sig.loudness(edit["start"], edit["end"])
                emphasis = []
                for w in plan["words"]:
                    z, _ = sig.loudness(w["src_s"], w["src_e"])
                    tok = normalize_token(w["w"])
                    if (z - mean_z > 1.1 and tok not in STOPWORDS and len(tok) > 3) or re.search(r"\d", w["w"]):
                        emphasis.append(w["i"])
                vis = sig.visual(edit["start"], edit["end"])
                thumb_t = edit["start"] + min(4.0, (edit["end"] - edit["start"]) / 3) if vis["face"] else edit["start"] + 1.0
                proposals.append({
                    "start": edit["start"], "end": edit["end"], "i": fi, "j": fj, "edit": edit, "duration": plan["duration"],
                    "score": c["score"], "category": c["category"], "reason": _reason(c["features"], c["category"]),
                    "features": c["features"], "emphasis": emphasis[:12], "thumbnail_time": thumb_t,
                    "publish": heuristic_metadata(clip_words, sig, c["category"], source_title),
                    "_content": c["_content"],
                })
        if not cands:
            warnings.append("No continuous 30-60 second passage of speech was found (long gaps split the content).")

    proposals = dedupe(proposals, words)
    if settings.max_clips_per_project > 0 and len(proposals) > settings.max_clips_per_project:
        warnings.append(f"Server limit: kept the top {settings.max_clips_per_project} of {len(proposals)} qualifying clips.")
        proposals = proposals[: settings.max_clips_per_project]
    if rejected:
        warnings.append(f"{rejected} candidate moment(s) were discarded because they couldn't be fitted to 30-60 s without cutting mid-thought.")
    if analyzer == "heuristic":
        warnings.append("Clips were selected by the local heuristic analyzer and titles are template-based. Add ANTHROPIC_API_KEY for multimodal AI selection and AI-written metadata.")
    proposals.sort(key=lambda p: p["start"])
    for p in proposals:
        p.pop("_content", None)
    on_progress(1.0, f"Selected {len(proposals)} clip(s)")
    return {"clips": proposals, "analyzer": analyzer, "sentences": len(sentences), "warnings": warnings}
