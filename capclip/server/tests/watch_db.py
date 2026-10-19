"""Print a project's state transitions straight from the database until it finishes.

Usage: python tests/watch_db.py <project_id>
"""

import json
import sqlite3
import sys
import time
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "data" / "capclip.db"
pid = sys.argv[1]
prev = None
while True:
    c = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True, timeout=10)
    p = c.execute("select status, stage, progress, message, warnings, summary from projects where id=?", (pid,)).fetchone()
    jobs = c.execute("select kind, status, attempts from jobs where project_id=? order by created_at", (pid,)).fetchall()
    line = f"{p[0]:<10} {p[1]:<12} {p[2] * 100:5.1f}% {p[3][:80]} | jobs={[(k, s, a) for k, s, a in jobs][-6:]}"
    if line != prev:
        print(time.strftime("%H:%M:%S"), line, flush=True)
        prev = line
    if p[0] in ("completed", "failed", "cancelled"):
        print("warnings:", json.dumps(json.loads(p[4]), indent=1))
        print("summary:", p[5])
        for row in c.execute("select status, source_start, source_end, duration, score, category, title, qa, warnings from clips where project_id=? order by source_start", (pid,)):
            qa = json.loads(row[7] or "{}")
            bad = [f"{x['severity']}:{x['label']} ({x['detail']})" for x in qa.get("checks", []) if not x["ok"]]
            print(f"- [{row[0]}] {row[1]:.1f}-{row[2]:.1f}s -> {row[3]:.1f}s score={row[4]} {row[5]} | {row[6][:70]}")
            print(f"    framing={qa.get('framing', {}).get('layout')} burned={qa.get('burned_text', {}).get('applied')} issues={bad} warn={json.loads(row[8] or '[]')[:2]}")
        break
    c.close()
    time.sleep(3)
