"""Runtime configuration for CapClip, read from environment variables.

Every knob has a safe default so the app runs locally with zero setup. Provider
keys are optional; when absent the matching capability reports itself as
unconfigured and the pipeline falls back to a clearly-labelled local path.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (no extra dependency). Existing env vars win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


_load_dotenv(SERVER_ROOT / ".env")
_load_dotenv(SERVER_ROOT.parent / ".env")


def _bool(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("CAPCLIP_DATA_DIR") or SERVER_ROOT / "data"))
    database_url: str = ""
    secret_key: str = ""
    public_base_url: str = os.environ.get("CAPCLIP_PUBLIC_BASE_URL", "")

    # --- Processing limits -------------------------------------------------
    max_upload_mb: int = _int("CAPCLIP_MAX_UPLOAD_MB", 4096)
    max_source_minutes: int = _int("CAPCLIP_MAX_SOURCE_MINUTES", 240)
    max_clips_per_project: int = _int("CAPCLIP_MAX_CLIPS_PER_PROJECT", 0)  # 0 = no cap
    min_clip_seconds: float = _float("CAPCLIP_MIN_CLIP_SECONDS", 30.0)
    max_clip_seconds: float = _float("CAPCLIP_MAX_CLIP_SECONDS", 60.0)
    worker_concurrency: int = _int("CAPCLIP_WORKER_CONCURRENCY", 1)
    job_max_attempts: int = _int("CAPCLIP_JOB_MAX_ATTEMPTS", 3)
    job_lease_seconds: int = _int("CAPCLIP_JOB_LEASE_SECONDS", 120)
    signed_url_ttl_seconds: int = _int("CAPCLIP_SIGNED_URL_TTL", 6 * 3600)
    retention_days: int = _int("CAPCLIP_RETENTION_DAYS", 30)
    embedded_worker: bool = _bool("CAPCLIP_EMBEDDED_WORKER", True)
    # Slower presets compress better; on 2-core machines "medium" takes minutes per clip.
    render_preset: str = os.environ.get("CAPCLIP_X264_PRESET") or ("veryfast" if (os.cpu_count() or 2) <= 2 else "medium")
    render_crf: int = _int("CAPCLIP_X264_CRF", 20)

    # --- Source retrieval ---------------------------------------------------
    # Downloading from YouTube is OFF by default. YouTube's Terms of Service
    # restrict downloading; operators must only enable this for content they
    # own or are licensed to process. When off, users upload the file instead.
    enable_youtube_download: bool = _bool("CAPCLIP_ENABLE_YOUTUBE_DOWNLOAD", False)
    ytdlp_binary: str = os.environ.get("CAPCLIP_YTDLP_BINARY", "yt-dlp")
    ffmpeg_binary: str = os.environ.get("CAPCLIP_FFMPEG", "ffmpeg")
    ffprobe_binary: str = os.environ.get("CAPCLIP_FFPROBE", "ffprobe")

    # --- AI providers -------------------------------------------------------
    anthropic_api_key: str = os.environ.get("ANTHROPIC_API_KEY", "")
    # Explicit so a stray ANTHROPIC_BASE_URL in the shell can't silently reroute.
    anthropic_base_url: str = os.environ.get("CAPCLIP_ANTHROPIC_BASE_URL", "https://api.anthropic.com")
    anthropic_model: str = os.environ.get("CAPCLIP_ANTHROPIC_MODEL", "claude-opus-5-5")
    anthropic_effort: str = os.environ.get("CAPCLIP_ANTHROPIC_EFFORT", "high")
    llm_provider: str = os.environ.get("CAPCLIP_LLM_PROVIDER", "auto")  # auto | anthropic | heuristic
    vision_frames_per_clip: int = _int("CAPCLIP_VISION_FRAMES_PER_CANDIDATE", 3)

    openai_api_key: str = os.environ.get("OPENAI_API_KEY", "")
    transcription_provider: str = os.environ.get("CAPCLIP_TRANSCRIBER", "auto")  # auto | local | openai
    whisper_model: str = os.environ.get("CAPCLIP_WHISPER_MODEL", "auto")  # auto picks by RAM/cores
    whisper_device: str = os.environ.get("CAPCLIP_WHISPER_DEVICE", "auto")
    whisper_compute_type: str = os.environ.get("CAPCLIP_WHISPER_COMPUTE", "auto")
    youtube_api_key: str = os.environ.get("YOUTUBE_API_KEY", "")

    fonts_dir: Path = field(default_factory=lambda: Path(os.environ.get("CAPCLIP_FONTS_DIR") or SERVER_ROOT / "fonts"))

    def __post_init__(self) -> None:
        self.data_dir = Path(self.data_dir).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        for sub in ("sources", "work", "renders", "exports", "uploads", "thumbs"):
            (self.data_dir / sub).mkdir(exist_ok=True)
        self.database_url = os.environ.get("CAPCLIP_DATABASE_URL") or f"sqlite:///{(self.data_dir / 'capclip.db').as_posix()}"
        self.secret_key = os.environ.get("CAPCLIP_SECRET_KEY") or self._persistent_secret()

    def _persistent_secret(self) -> str:
        path = self.data_dir / ".secret_key"
        if path.is_file():
            return path.read_text().strip()
        key = secrets.token_urlsafe(48)
        path.write_text(key)
        return key

    @property
    def llm_active(self) -> str:
        if self.llm_provider == "heuristic":
            return "heuristic"
        if self.anthropic_api_key:
            return "anthropic"
        return "heuristic"


settings = Settings()
