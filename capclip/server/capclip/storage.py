"""Private file storage with HMAC-signed, expiring URLs.

Every media file lives under ``settings.data_dir``. Nothing is served by a
predictable path: the API hands out ``/media/<relpath>?exp=..&sig=..`` URLs
whose signature covers the path, expiry and download name. Swap this module
for an S3/GCS implementation (presigned URLs) without touching callers.
"""

from __future__ import annotations

import hashlib
import hmac
import shutil
import time
from pathlib import Path
from urllib.parse import quote, urlencode

from .config import settings

DATA = settings.data_dir


def project_dir(project_id: str, area: str) -> Path:
    path = DATA / area / project_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def rel(path: str | Path) -> str:
    return Path(path).resolve().relative_to(DATA).as_posix()


def resolve(relpath: str) -> Path:
    """Resolve a stored relative path, refusing anything outside the data dir."""
    candidate = (DATA / relpath).resolve()
    if DATA not in candidate.parents and candidate != DATA:
        raise ValueError("path escapes storage root")
    return candidate


def _sig(relpath: str, exp: int, dl: str) -> str:
    msg = f"{relpath}|{exp}|{dl}".encode()
    return hmac.new(settings.secret_key.encode(), msg, hashlib.sha256).hexdigest()[:40]


def signed_url(path: str | Path | None, download_name: str = "", ttl: int | None = None) -> str | None:
    if not path:
        return None
    p = Path(path)
    if not p.is_absolute():
        p = DATA / p
    if not p.exists():
        return None
    relpath = rel(p)
    # Bucket expiry to the hour so URLs stay stable across polls (lets the
    # browser cache video and avoids re-buffering previews every refresh).
    ttl = ttl or settings.signed_url_ttl_seconds
    exp = (int(time.time()) // 3600 + 1) * 3600 + ttl
    query = {"exp": exp, "sig": _sig(relpath, exp, download_name)}
    if download_name:
        query["dl"] = download_name
    version = int(p.stat().st_mtime)
    query["v"] = version
    return f"{settings.public_base_url}/media/{quote(relpath)}?{urlencode(query)}"


def verify(relpath: str, exp: int, sig: str, dl: str = "") -> bool:
    if exp < time.time():
        return False
    return hmac.compare_digest(_sig(relpath, exp, dl), sig)


def remove_tree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def purge_project_files(project_id: str) -> None:
    for area in ("sources", "work", "renders", "exports", "uploads", "thumbs"):
        remove_tree(DATA / area / project_id)


def dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
