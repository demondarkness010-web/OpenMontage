"""Multimodal clip selection and publishing metadata via Claude.

The provider is optional. ``describe()`` reports what is configured; the
analysis stage falls back to the local heuristic analyzer (and labels the
results accordingly) when no key is present.
"""

from __future__ import annotations

import base64
import json
import logging
from pathlib import Path
from typing import Any

from ..config import settings

log = logging.getLogger("capclip.llm")

FALLBACK_BETA = "server-side-fallback-2026-07-01"


def describe() -> dict[str, Any]:
    active = settings.llm_active
    return {
        "provider": active,
        "model": settings.anthropic_model if active == "anthropic" else None,
        "multimodal": active == "anthropic",
        "configured": active == "anthropic",
        "hint": None if active == "anthropic" else
        "Set ANTHROPIC_API_KEY to enable Claude multimodal clip selection and AI-written titles. "
        "Until then CapClip uses its local heuristic analyzer and template-based metadata.",
    }


class LLMUnavailable(RuntimeError):
    pass


def _client():
    if settings.llm_active != "anthropic":
        raise LLMUnavailable("No AI provider configured")
    import anthropic

    return anthropic.Anthropic(api_key=settings.anthropic_api_key, base_url=settings.anthropic_base_url, max_retries=3, timeout=900)


METADATA_PROPS: dict[str, Any] = {
    "title": {"type": "string", "description": "Primary YouTube Shorts title, <= 70 chars, specific and accurate."},
    "hook": {"type": "string", "description": "On-screen opening text for the first ~3 s, <= 60 chars. Must be paid off by the clip."},
    "titles": {"type": "array", "items": {"type": "string"}, "description": "3-5 alternative titles."},
    "description": {"type": "string", "description": "2-3 natural sentences of context. No invented facts."},
    "hashtags": {"type": "array", "items": {"type": "string"}, "description": "3-6 relevant hashtags incl. #Shorts."},
    "keywords": {"type": "array", "items": {"type": "string"}, "description": "4-8 search phrases."},
    "pinned_comment": {"type": "string", "description": "An authentic discussion question tied to the clip."},
    "thumbnail_text": {"type": "string", "description": "<= 4 words overlay suggestion, or empty."},
}

CLIP_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_sentence": {"type": "integer"},
                    "end_sentence": {"type": "integer"},
                    "drop_sentences": {"type": "array", "items": {"type": "integer"}, "description": "Redundant sentences strictly inside the range to cut."},
                    "category": {"type": "string", "enum": ["hook", "fact", "humor", "emotional", "opinion", "tutorial", "inspiration", "story", "relatable", "explanation", "q_and_a"]},
                    "engagement_score": {"type": "integer", "description": "0-100 relative ranking estimate; not a prediction of views."},
                    "reason": {"type": "string", "description": "1-2 sentences: why this moment works as a standalone Short."},
                    "emphasis_words": {"type": "array", "items": {"type": "string"}, "description": "A few spoken words worth emphasising in captions, verbatim."},
                    "thumbnail_sentence": {"type": "integer"},
                    **METADATA_PROPS,
                },
                "required": ["start_sentence", "end_sentence", "drop_sentences", "category", "engagement_score", "reason", "emphasis_words",
                             "thumbnail_sentence", *METADATA_PROPS.keys()],
                "additionalProperties": False,
            },
        },
        "notes": {"type": "string", "description": "Limitations worth telling the user (e.g. not enough material)."},
    },
    "required": ["clips", "notes"],
    "additionalProperties": False,
}

META_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": METADATA_PROPS,
    "required": list(METADATA_PROPS.keys()),
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You are CapClip's senior Shorts editor and content strategist. You receive the complete, timestamped transcript of a long video (split into numbered sentences), a visual timeline derived from frame analysis, and sampled frames. Your job is to find every moment in the video that genuinely works as a standalone YouTube Short.

What makes a good Short:
- It opens on something that earns attention within ~2 seconds: a strong claim, a surprising fact, a question, a funny or emotional beat, a useful promise. Start as close to that moment as possible while keeping the context a first-time viewer needs.
- It delivers a payoff: the answer, punchline, reaction, conclusion or practical takeaway. End right after it, not mid-thought.
- It makes sense with no knowledge of the rest of the video. Avoid clips that start with an unresolved "this", "he", "that thing" etc. unless the referent is in the clip.
- Consider what is visible as well as what is said: demonstrations, reactions, expressions, scene changes.

Hard constraints:
- The final clip must run 30-60 seconds AFTER silences and redundancy are removed (cutting usually shortens the raw range by 5-15%). Use the per-sentence durations to aim for 34-58 s of raw range.
- Ranges must follow sentence boundaries. Use drop_sentences only for clearly redundant or off-topic sentences strictly inside a range; never drop a sentence the meaning depends on.
- There is no fixed number of clips. Return every moment that meets the bar, and none that don't. Do not return overlapping or near-duplicate clips that make the same point. If the video has no worthwhile 30-second moment, return an empty list and explain in notes.
- Skip intros, sponsor reads, "like and subscribe" and housekeeping unless they are genuinely entertaining.

Metadata rules: every title, hook, description, hashtag and pinned comment must be accurate to what is said and shown in that clip. Never invent facts, quotes, numbers or outcomes, and never promise something the clip doesn't deliver. Do not claim virality. engagement_score is a relative ranking signal only."""


def _image_block(path: Path) -> dict[str, Any]:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(path.read_bytes()).decode()}}


def _call(system: str, content: list[dict[str, Any]], schema: dict[str, Any], max_tokens: int = 64000) -> dict[str, Any]:
    import anthropic

    client = _client()
    kwargs: dict[str, Any] = {
        "model": settings.anthropic_model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": content}],
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": settings.anthropic_effort, "format": {"type": "json_schema", "schema": schema}},
    }
    try:
        with client.beta.messages.stream(betas=[FALLBACK_BETA], fallbacks="default", **kwargs) as stream:
            message = stream.get_final_message()
    except anthropic.BadRequestError as exc:
        # Some models/platforms reject the fallback beta; retry without it.
        if "fallback" not in str(exc).lower():
            raise
        with client.messages.stream(**kwargs) as stream:
            message = stream.get_final_message()
    if message.stop_reason == "refusal":
        raise LLMUnavailable("The AI provider declined this request.")
    if message.stop_reason == "max_tokens":
        raise LLMUnavailable("AI response was truncated (max_tokens).")
    text = next((b.text for b in message.content if b.type == "text"), "")
    return json.loads(text)


def select_clips(transcript_block: str, visual_block: str, frames: list[tuple[float, Path]], source_title: str, duration: float) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    for t, path in frames:
        content.append({"type": "text", "text": f"Frame at {int(t // 60)}:{t % 60:04.1f}"})
        content.append(_image_block(path))
    content.append({"type": "text", "text": (
        f"Source video: {source_title or 'untitled'} ({duration / 60:.1f} minutes).\n\n"
        f"<visual_timeline>\n{visual_block}\n</visual_timeline>\n\n"
        f"<transcript>\n{transcript_block}\n</transcript>\n\n"
        "Return every clip that meets the bar, best first."
    )})
    return _call(SYSTEM_PROMPT, content, CLIP_SCHEMA)


def clip_metadata(clip_transcript: str, source_title: str, frame: Path | None) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    if frame and frame.exists():
        content.append(_image_block(frame))
    content.append({"type": "text", "text": (
        f"Source video: {source_title or 'untitled'}.\nWrite fresh YouTube Shorts publishing metadata for this finished clip. "
        f"Everything must be accurate to the clip.\n\n<clip_transcript>\n{clip_transcript}\n</clip_transcript>"
    )})
    system = "You write accurate, engaging YouTube Shorts metadata. Never invent facts, quotes or outcomes; never promise what the clip doesn't deliver; never claim virality."
    return _call(system, content, META_SCHEMA, max_tokens=16000)
