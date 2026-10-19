"""End-to-end smoke test against a running API: upload -> analyze -> render -> export.

Usage: python tests/e2e_upload.py [video] [--base http://127.0.0.1:8000]
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8000"
args = [a for a in sys.argv[1:] if not a.startswith("--")]
if "--base" in sys.argv:
    BASE = sys.argv[sys.argv.index("--base") + 1]
video = Path(args[0] if args else Path(__file__).parent / "sample" / "talk.mp4")
CHUNK = 8 * 1024 * 1024

with httpx.Client(base_url=BASE, timeout=120) as c:
    p = c.post("/api/projects", json={"title": "E2E sample talk"}).json()
    pid = p["id"]
    print("project", pid, p["status"])
    data = video.read_bytes()
    off = 0
    while off < len(data):
        r = c.put(f"/api/projects/{pid}/upload", params={"offset": off, "total": len(data), "filename": video.name}, content=data[off:off + CHUNK])
        r.raise_for_status()
        off = r.json()["received"]
    print("uploaded", off, "bytes")
    t0 = time.time()
    last = None
    while True:
        p = c.get(f"/api/projects/{pid}").json()
        line = f"{p['status']:<10} {p['stage']:<13} {p['progress'] * 100:5.1f}%  {p['message'][:90]}"
        if line != last:
            print(f"[{time.time() - t0:6.1f}s] {line}")
            last = line
        if p["status"] in ("completed", "failed", "cancelled"):
            break
        time.sleep(2)
    print(json.dumps({k: p[k] for k in ("summary", "warnings", "error")}, indent=2))
    for clip in p.get("clips", []):
        print(f"- [{clip['status']}] {clip['source_start']:.1f}-{clip['source_end']:.1f}s -> {clip['duration']:.1f}s score={clip['score']} "
              f"{clip['category']} | {clip['title'][:70]}")
        for chk in clip["qa"].get("checks", []):
            if not chk["ok"]:
                print(f"     ! {chk['severity']}: {chk['label']} - {chk['detail']}")
        print(f"     framing={clip['qa'].get('framing', {}).get('layout')} burned={clip['qa'].get('burned_text', {}).get('applied')} warnings={clip['warnings']}")
    ready = [cl["id"] for cl in p.get("clips", []) if cl["status"] == "ready"]
    if ready:
        e = c.post("/api/exports", json={"project_id": pid, "clip_ids": ready, "include_srt": True}).json()
        while e["status"] in ("queued", "building"):
            time.sleep(1.5)
            e = c.get(f"/api/exports/{e['id']}").json()
        print("export", e["status"], e["size_bytes"], e.get("error"))
    print("PROJECT_ID", pid)
