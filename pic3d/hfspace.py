"""Minimal, dependency-free client for Gradio apps hosted on Hugging Face Spaces.

Covers what Relief needs: upload a file, call a named endpoint, follow its
server-sent events, and keep one session so stateful apps (gr.State) work across
calls. Works with Gradio 4 (routes at /call, /upload) and Gradio 5+ (/gradio_api/...).
"""

from __future__ import annotations

import json
import os
import random
import string
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


# Space configs barely change; caching them saves a round trip (1-2 s) per generation.
_CONFIGS: dict[str, tuple[float, dict]] = {}


class SpaceError(RuntimeError):
    pass


class QuotaError(SpaceError):
    """The free ZeroGPU allowance for this user/IP is used up."""


def _friendly(message: str) -> SpaceError:
    low = message.lower()
    if "quota" in low or ("zerogpu" in low and "exceeded" in low) or "larger than the maximum" in low or "gpu duration" in low:
        return QuotaError(message)
    return SpaceError(message)


class Space:
    def __init__(self, subdomain: str, token: str | None = None, timeout: int = 60):
        self.base = f"https://{subdomain}.hf.space"
        self.token = token
        self.timeout = timeout
        self.session_hash = "".join(random.choices(string.ascii_lowercase + string.digits, k=11))
        cached = _CONFIGS.get(self.base)
        if cached and time.time() - cached[0] < 600:
            config = cached[1]
        else:
            config = self._json("GET", "/config")
            _CONFIGS[self.base] = (time.time(), config)
        prefix = config.get("api_prefix")
        if prefix is None:
            major = int(str(config.get("version", "4")).split(".")[0] or 4)
            prefix = "/gradio_api" if major >= 5 else ""
        self.prefix = prefix.rstrip("/")
        # api_name -> fn_index (Gradio 5 uses the dependency's "id", Gradio 4 its position)
        # and which of its inputs are gr.State (the queue wants a placeholder for those,
        # while the documented API, and our callers, leave them out).
        self.fns, self.state_slots = {}, {}
        kinds = {c["id"]: c.get("type") for c in config.get("components", [])}
        for i, dep in enumerate(config.get("dependencies", [])):
            if dep.get("api_name"):
                name = dep["api_name"].lstrip("/")
                self.fns[name] = dep.get("id", i)
                self.state_slots[name] = [j for j, cid in enumerate(dep.get("inputs", [])) if kinds.get(cid) == "state"]

    # ------------------------------------------------------------------ http

    def _request(self, method: str, path: str, data: bytes | None = None, headers: dict | None = None):
        url = path if path.startswith("http") else self.base + path
        req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        req.add_header("User-Agent", "relief-local/1.0")
        host = urllib.parse.urlsplit(url).hostname or ""
        if self.token and (host.endswith(".hf.space") or host in ("huggingface.co", "hf.co")):
            # Unredirected: urllib must not forward the token if a URL redirects elsewhere.
            req.add_unredirected_header("Authorization", f"Bearer {self.token}")
        return urllib.request.urlopen(req, timeout=self.timeout)

    def _json(self, method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if data else {}
        try:
            with self._request(method, path, data, headers) as res:
                return json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:400]
            if e.code in (503, 502):
                raise SpaceError("The free Space is starting up or busy. Try again in a minute.") from None
            raise _friendly(f"{e.code}: {detail}") from None

    # ------------------------------------------------------------------ api

    def upload(self, data: bytes, filename: str, content_type: str) -> dict:
        boundary = uuid.uuid4().hex
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
        headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
        try:
            with self._request("POST", f"{self.prefix}/upload", body, headers) as res:
                paths = json.loads(res.read())
        except urllib.error.HTTPError as e:
            raise SpaceError(f"Upload to the Space failed ({e.code}).") from None
        return {
            "path": paths[0],
            "orig_name": filename,
            "mime_type": content_type,
            "size": len(data),
            "meta": {"_type": "gradio.FileData"},
        }

    def call(self, api_name: str, data: list, on_event=None) -> list:
        """Run an endpoint through the queue (keeps this client's session) and block
        until it finishes. Returns its output list.

        on_event(kind, info) receives ("queue", {"rank", "size", "eta"}),
        ("start", {}), ("progress", {"desc", "progress"}) and ("log", {"message"}).
        """
        api = api_name.lstrip("/")
        if api not in self.fns:
            raise SpaceError(f"The Space has no '{api}' endpoint any more; it may have been updated.")
        data = list(data)
        for slot in self.state_slots.get(api, []):
            data.insert(slot, None)
        joined = self._json(
            "POST",
            f"{self.prefix}/queue/join",
            {"data": data, "event_data": None, "fn_index": self.fns[api], "trigger_id": None, "session_hash": self.session_hash},
        )
        event_id = joined.get("event_id")
        if not event_id:
            raise SpaceError(f"The Space did not accept the request: {joined}")
        try:
            res = self._request("GET", f"{self.prefix}/queue/data?session_hash={self.session_hash}")
        except urllib.error.HTTPError as e:
            raise SpaceError(f"Couldn't follow the job ({e.code}).") from None
        # Spaces send a heartbeat every ~15 s, so the 60 s socket timeout only trips
        # on a truly dead connection.
        with res:
            for raw in res:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    msg = json.loads(line[5:])
                except ValueError:
                    continue
                if msg.get("event_id") not in (None, event_id):
                    continue
                kind = msg.get("msg")
                if kind == "process_completed":
                    out = msg.get("output") or {}
                    if msg.get("success") and "data" in out:
                        return out["data"]
                    err = out.get("error") or msg.get("title") or "The Space reported an error."
                    raise _friendly(str(err))
                if kind == "unexpected_error":
                    raise _friendly(msg.get("message") or "The Space failed unexpectedly.")
                if kind == "close_stream":
                    break
                if not on_event:
                    continue
                if kind == "estimation":
                    on_event("queue", {"rank": msg.get("rank"), "size": msg.get("queue_size"), "eta": msg.get("rank_eta")})
                elif kind == "process_starts":
                    on_event("start", {})
                elif kind == "progress":
                    for p in msg.get("progress_data") or []:
                        on_event("progress", {"desc": p.get("desc"), "progress": p.get("progress"), "index": p.get("index"), "length": p.get("length")})
                elif kind == "log":
                    on_event("log", {"message": msg.get("log")})
        raise SpaceError("The Space closed the connection before finishing.")

    def has(self, api_name: str) -> bool:
        return api_name.lstrip("/") in self.fns

    def file_url(self, value) -> str | None:
        """Extract a downloadable URL from a Gradio FileData-like output."""
        if isinstance(value, dict):
            if value.get("url"):
                return value["url"]
            if value.get("path"):
                return f"{self.base}{self.prefix}/file={value['path']}"
            if "value" in value:
                return self.file_url(value["value"])
        if isinstance(value, str) and value:
            return value if value.startswith("http") else f"{self.base}{self.prefix}/file={value}"
        return None

    def download(self, url: str, dest):
        tmp = f"{dest}.part"
        with self._request("GET", url) as res, open(tmp, "wb") as f:
            while chunk := res.read(1 << 16):
                f.write(chunk)
        os.replace(tmp, dest)
