"""Database models.

One SQLite (or any SQLAlchemy URL) database holds every record. Analysis,
render and export work all go through the single ``Job`` table so one worker
loop, one retry policy and one cancellation path cover every kind of job.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

from .config import settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def new_id() -> str:
    return uuid.uuid4().hex[:16]


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSON, list[Any]: JSON}


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    session_token: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120), default="Creator")
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    preferences: Mapped["UserPreference"] = relationship(back_populates="user", uselist=False, cascade="all, delete-orphan")


class UserPreference(Base):
    __tablename__ = "user_preferences"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    caption_preset: Mapped[str] = mapped_column(String(40), default="bold_viral")
    caption_overrides: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    burned_text_strategy: Mapped[str] = mapped_column(String(20), default="auto")
    auto_render: Mapped[bool] = mapped_column(Boolean, default=True)
    export_srt: Mapped[bool] = mapped_column(Boolean, default=True)
    remove_fillers: Mapped[bool] = mapped_column(Boolean, default=True)
    retention_days: Mapped[int] = mapped_column(Integer, default=30)

    user: Mapped[User] = relationship(back_populates="preferences")


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300), default="Untitled project")
    # draft | awaiting_source | queued | processing | rendering | completed | failed | cancelled
    status: Mapped[str] = mapped_column(String(32), default="draft", index=True)
    stage: Mapped[str] = mapped_column(String(48), default="created")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    eta_seconds: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    message: Mapped[str] = mapped_column(Text, default="")
    source_kind: Mapped[str] = mapped_column(String(16), default="youtube")  # youtube | upload
    youtube_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    youtube_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    options: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    warnings: Mapped[list[Any]] = mapped_column(JSON, default=list)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    source: Mapped[Optional["SourceVideo"]] = relationship(back_populates="project", uselist=False, cascade="all, delete-orphan")
    clips: Mapped[list["Clip"]] = relationship(back_populates="project", cascade="all, delete-orphan", order_by="Clip.index")
    segments: Mapped[list["TranscriptSegment"]] = relationship(back_populates="project", cascade="all, delete-orphan", order_by="TranscriptSegment.index")
    jobs: Mapped[list["Job"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class SourceVideo(Base):
    __tablename__ = "source_videos"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), unique=True)
    origin: Mapped[str] = mapped_column(String(16), default="upload")  # upload | youtube
    original_filename: Mapped[Optional[str]] = mapped_column(String(400), nullable=True)
    path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    proxy_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    audio_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    duration: Mapped[float] = mapped_column(Float, default=0.0)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    fps: Mapped[float] = mapped_column(Float, default=0.0)
    has_audio: Mapped[bool] = mapped_column(Boolean, default=True)
    subtitle_streams: Mapped[list[Any]] = mapped_column(JSON, default=list)
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    analysis: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    rights_attested: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    project: Mapped[Project] = relationship(back_populates="source")


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    index: Mapped[int] = mapped_column(Integer)
    start: Mapped[float] = mapped_column(Float)
    end: Mapped[float] = mapped_column(Float)
    text: Mapped[str] = mapped_column(Text)
    speaker: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    word_offset: Mapped[int] = mapped_column(Integer, default=0)
    # [{"w": "Hello", "s": 1.02, "e": 1.31, "p": 0.98}, ...]
    words: Mapped[list[Any]] = mapped_column(JSON, default=list)

    project: Mapped[Project] = relationship(back_populates="segments")


class Clip(Base):
    __tablename__ = "clips"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    index: Mapped[int] = mapped_column(Integer, default=0)
    # analyzing | queued | rendering | ready | failed
    status: Mapped[str] = mapped_column(String(24), default="queued")
    title: Mapped[str] = mapped_column(String(300), default="")
    hook: Mapped[str] = mapped_column(String(300), default="")
    reason: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(48), default="insight")
    score: Mapped[float] = mapped_column(Float, default=0.0)
    source_start: Mapped[float] = mapped_column(Float)
    source_end: Mapped[float] = mapped_column(Float)
    duration: Mapped[float] = mapped_column(Float, default=0.0)
    ai_edit: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    edit: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    publish: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    render_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    thumb_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    render_version: Mapped[int] = mapped_column(Integer, default=0)
    edit_version: Mapped[int] = mapped_column(Integer, default=0)
    qa: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    warnings: Mapped[list[Any]] = mapped_column(JSON, default=list)
    analyzer: Mapped[str] = mapped_column(String(32), default="heuristic")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    project: Mapped[Project] = relationship(back_populates="clips")
    caption_tracks: Mapped[list["CaptionTrack"]] = relationship(back_populates="clip", cascade="all, delete-orphan")


class CaptionTrack(Base):
    __tablename__ = "caption_tracks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    clip_id: Mapped[str] = mapped_column(ForeignKey("clips.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # ass (burned) | srt (sidecar)
    preset: Mapped[str] = mapped_column(String(40))
    style: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    path: Mapped[str] = mapped_column(Text)
    render_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    clip: Mapped[Clip] = relationship(back_populates="caption_tracks")


class Job(Base):
    """Background job. kind: analyze | render | export."""

    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    clip_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    export_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    # queued | running | succeeded | failed | cancelled
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    priority: Mapped[int] = mapped_column(Integer, default=100)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    stage: Mapped[str] = mapped_column(String(48), default="")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    lease_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    run_after: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    project: Mapped[Project] = relationship(back_populates="jobs")


class ExportFile(Base):
    __tablename__ = "export_files"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16), default="zip")  # zip
    clip_ids: Mapped[list[Any]] = mapped_column(JSON, default=list)
    include_srt: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued | building | ready | failed
    path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False, "timeout": 30} if settings.database_url.startswith("sqlite") else {},
)

if settings.database_url.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):  # pragma: no cover - driver hook
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(engine)
