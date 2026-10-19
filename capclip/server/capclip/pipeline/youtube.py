"""YouTube URL validation, public metadata lookup and (opt-in) source retrieval.

Policy: a public YouTube URL does not by itself grant permission to download
or process the video. CapClip therefore
  * always validates the link and fetches public metadata (oEmbed / Data API),
  * only downloads when the operator enabled it (CAPCLIP_ENABLE_YOUTUBE_DOWNLOAD)
    AND the user attests they own the video or are licensed to process it,
  * otherwise asks the user to upload the source file for that link.
It never bypasses access restrictions: private, age-gated, members-only, DRM
or region-locked videos fail with a clear message instead of being worked around.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

import httpx

from ..config import settings
from ..jobs.queue import JobCancelled, JobContext, PermanentJobError
from .media import CREATE_FLAGS

_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"}


class InvalidYouTubeURL(ValueError):
    pass


def parse_video_id(url: str) -> str:
    url = (url or "").strip()
    if not url:
        raise InvalidYouTubeURL("Paste a YouTube video link.")
    if _ID.match(url):
        return url
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host not in _HOSTS:
        raise InvalidYouTubeURL("That doesn't look like a YouTube link. Use a youtube.com or youtu.be URL.")
    vid: Optional[str] = None
    if host.endswith("youtu.be"):
        vid = parsed.path.lstrip("/").split("/")[0]
    else:
        qs = parse_qs(parsed.query)
        if "v" in qs:
            vid = qs["v"][0]
        else:
            m = re.match(r"^/(shorts|embed|live|v|e)/([^/?#]+)", parsed.path)
            if m:
                vid = m.group(2)
            elif parsed.path.startswith("/playlist"):
                raise InvalidYouTubeURL("Playlists aren't supported yet. Paste a link to a single video.")
            elif parsed.path.startswith(("/@", "/channel", "/c/", "/user")):
                raise InvalidYouTubeURL("That's a channel link. Paste a link to a single video.")
    if not vid or not _ID.match(vid):
        raise InvalidYouTubeURL("Couldn't find a video ID in that link.")
    return vid


def canonical_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def _iso8601_duration(value: str) -> float:
    m = re.match(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", value or "")
    if not m:
        return 0.0
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return float(d * 86400 + h * 3600 + mi * 60 + s)


def fetch_metadata(video_id: str) -> dict[str, Any]:
    """Public metadata. Never raises for network trouble; returns what it can."""
    meta: dict[str, Any] = {
        "video_id": video_id,
        "url": canonical_url(video_id),
        "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "available": None,
        "source": "none",
    }
    try:
        with httpx.Client(timeout=8.0, follow_redirects=True) as client:
            if settings.youtube_api_key:
                r = client.get(
                    "https://www.googleapis.com/youtube/v3/videos",
                    params={"id": video_id, "part": "snippet,contentDetails,status", "key": settings.youtube_api_key},
                )
                if r.status_code == 200:
                    items = r.json().get("items", [])
                    if not items:
                        meta.update(available=False, reason="Video not found, private, or removed.")
                        return meta
                    it = items[0]
                    sn, cd, st = it.get("snippet", {}), it.get("contentDetails", {}), it.get("status", {})
                    meta.update(
                        title=sn.get("title"),
                        channel=sn.get("channelTitle"),
                        duration=_iso8601_duration(cd.get("duration", "")),
                        license=st.get("license"),
                        privacy=st.get("privacyStatus"),
                        embeddable=st.get("embeddable"),
                        region_restricted=bool(cd.get("regionRestriction")),
                        age_restricted=cd.get("contentRating", {}).get("ytRating") == "ytAgeRestricted",
                        available=True,
                        source="youtube_data_api",
                    )
                    thumbs = sn.get("thumbnails", {})
                    best = thumbs.get("maxres") or thumbs.get("high") or thumbs.get("medium")
                    if best:
                        meta["thumbnail"] = best.get("url")
                    return meta
            r = client.get("https://www.youtube.com/oembed", params={"url": canonical_url(video_id), "format": "json"})
            if r.status_code == 200:
                d = r.json()
                meta.update(title=d.get("title"), channel=d.get("author_name"), available=True, source="oembed")
                if d.get("thumbnail_url"):
                    meta["thumbnail"] = d["thumbnail_url"]
            elif r.status_code in (401, 403):
                meta.update(available=False, reason="This video is private or restricted, so its details can't be read.")
            elif r.status_code in (400, 404):
                meta.update(available=False, reason="No public YouTube video exists at that link.")
    except httpx.HTTPError as exc:
        meta["lookup_error"] = f"Couldn't reach YouTube to verify the link ({exc.__class__.__name__})."
    return meta


def retrieval_status() -> dict[str, Any]:
    from .media import tool_available

    enabled = settings.enable_youtube_download
    has_bin = tool_available(settings.ytdlp_binary) if enabled else False
    return {
        "youtube_download_enabled": enabled and has_bin,
        "reason": (
            None
            if enabled and has_bin
            else "Direct YouTube retrieval is disabled on this server. Upload the video file for this link instead."
            if not enabled
            else "CAPCLIP_ENABLE_YOUTUBE_DOWNLOAD is on but yt-dlp is not installed."
        ),
    }


_RESTRICTED_PATTERNS = [
    (r"Private video", "This video is private."),
    (r"Sign in to confirm your age|age-restricted", "This video is age-restricted. CapClip does not bypass age gates."),
    (r"members-only|Join this channel", "This is a members-only video."),
    (r"not available in your country|geo", "This video is region-restricted."),
    (r"DRM", "This video is DRM-protected and cannot be processed."),
    (r"Video unavailable|This video has been removed", "This video is unavailable."),
    (r"live event will begin|is not live|Premieres in", "This live stream or premiere hasn't finished yet."),
]


def download(video_id: str, out_dir: Path, ctx: JobContext, max_height: int = 1080) -> Path:
    if not settings.enable_youtube_download:
        raise PermanentJobError("Direct YouTube retrieval is disabled on this server. Upload the video file instead.")
    out_dir.mkdir(parents=True, exist_ok=True)
    template = str(out_dir / "source.%(ext)s")
    cmd = [
        settings.ytdlp_binary,
        "--no-playlist",
        "--no-part",
        "--newline",
        "--no-write-subs",  # existing captions are replaced, not reused
        "-f", f"bv*[height<={max_height}]+ba/b[height<={max_height}]/b",
        "--merge-output-format", "mp4",
        "--max-filesize", f"{settings.max_upload_mb}M",
        "--match-filter", f"duration <= {settings.max_source_minutes * 60}",
        "-o", template,
        canonical_url(video_id),
    ]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", creationflags=CREATE_FLAGS)
    except FileNotFoundError as exc:
        raise PermanentJobError("yt-dlp is not installed on the server.") from exc
    log_lines: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        log_lines.append(line.rstrip())
        m = re.search(r"\[download\]\s+([\d.]+)%", line)
        if m:
            ctx.progress("retrieving", float(m.group(1)) / 100 * 0.08, "Retrieving source video",
                         project_update={"stage": "retrieving", "progress": float(m.group(1)) / 100 * 0.08})
        if ctx.cancelled():
            proc.kill()
            raise JobCancelled()
    proc.wait()
    if proc.returncode != 0:
        text = "\n".join(log_lines[-30:])
        for pat, msg in _RESTRICTED_PATTERNS:
            if re.search(pat, text, re.I):
                raise PermanentJobError(msg + " Upload a copy you have rights to instead.")
        if "does not pass filter" in text:
            raise PermanentJobError(f"This video is longer than the {settings.max_source_minutes}-minute limit.")
        raise RuntimeError("Video retrieval failed: " + (log_lines[-1] if log_lines else "unknown error"))
    files = sorted(p for p in out_dir.glob("source.*") if p.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"})
    if not files:
        raise RuntimeError("Retrieval finished but no video file was produced.")
    return files[0]
