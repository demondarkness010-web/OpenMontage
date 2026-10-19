# CapClip — One Video. Endless Shorts.

CapClip turns one long video into ready-to-publish YouTube Shorts. It analyses the **whole** video (word-level transcript, loudness, scene changes, and frames sampled across the full runtime), picks every moment that works on its own at 30–60 s, tightens the pacing, reframes to 9:16, rebuilds the captions, writes publishing metadata, and exports H.264 MP4s.

```
capclip/
├── server/   FastAPI API + background worker + media pipeline (Python 3.11+)
└── web/      Next.js 15 / React 19 / TypeScript / Tailwind v4 frontend
```

## Quick start

Requirements: **Python 3.11+**, **Node 20+**, **FFmpeg** with libass (any recent full build; `ffmpeg -filters | grep ass`), and about **3 GB of free disk** for dependencies plus the speech model.

```bash
# 1) Backend (API + embedded worker) on :8000
cd capclip/server
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt      # Windows (macOS/Linux: .venv/bin/python)
.venv/Scripts/python -m uvicorn capclip.api:app --port 8000
```

```bash
# 2) Frontend on :3000 (proxies /api and /media to :8000)
cd capclip/web
npm install
npm run dev
```

Open http://localhost:3000. The first transcription downloads the Whisper model once (`base` ~145 MB or `small` ~480 MB, see below).

### Low-end machines

CapClip adapts to the hardware it runs on:
- `CAPCLIP_WHISPER_MODEL=auto` (the default) uses `base` on machines with under 6 GB RAM or 2 or fewer cores, and `small` otherwise.
- On 2-core machines, x264 uses the `veryfast` preset.
- All FFmpeg work runs at below-normal priority so the UI stays responsive.

Even so, on something like a 2-core Celeron with 4 GB RAM, local transcription runs about **9× slower than real time** (a 10-minute video takes roughly 1.5 hours), and each clip render takes several minutes. For real use on such a machine, set `OPENAI_API_KEY` with `CAPCLIP_TRANSCRIBER=openai` to transcribe in the cloud, or run the worker on a stronger machine (`CAPCLIP_EMBEDDED_WORKER=false` plus `python -m capclip.jobs.worker` elsewhere, sharing the database and data directory).

For production, run the worker separately (`CAPCLIP_EMBEDDED_WORKER=false` on the API, then `python -m capclip.jobs.worker` on one or more worker hosts sharing the database and data directory), and `npm run build && npm start` for the web app.

## Configuration

Set these in the environment or in `capclip/server/.env`. Everything is optional. Missing providers are reported in **Settings → System status** and the pipeline uses a clearly labelled fallback.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Enables Claude multimodal clip selection (full transcript + visual timeline + sampled frames) and AI-written metadata. Without it, the local heuristic analyzer and template metadata are used and labelled that way. |
| `CAPCLIP_ANTHROPIC_MODEL` | `claude-opus-5-5` | Model used for selection and metadata. |
| `CAPCLIP_ANTHROPIC_EFFORT` | `high` | `low` / `medium` / `high` / `xhigh` / `max`. |
| `OPENAI_API_KEY` | – | Optional cloud transcription (`CAPCLIP_TRANSCRIBER=openai`). |
| `CAPCLIP_TRANSCRIBER` | `auto` | `auto` (local first), `local` (faster-whisper), `openai`. |
| `CAPCLIP_WHISPER_MODEL` | `auto` | faster-whisper model (`auto`, `tiny`, `base`, `small`, `medium`, `large-v3`). |
| `CAPCLIP_ENABLE_YOUTUBE_DOWNLOAD` | `false` | Allow direct retrieval with yt-dlp. **Only enable this for content you own or are licensed to process.** Users must also confirm their rights for every video. |
| `YOUTUBE_API_KEY` | – | Richer link validation (duration, license, restrictions) via the YouTube Data API. oEmbed is used otherwise. |
| `CAPCLIP_MAX_UPLOAD_MB` | `4096` | Upload size limit. |
| `CAPCLIP_MAX_SOURCE_MINUTES` | `240` | Source length limit. |
| `CAPCLIP_MAX_CLIPS_PER_PROJECT` | `0` | `0` = no cap (the default: as many clips as the video supports). |
| `CAPCLIP_WORKER_CONCURRENCY` | `1` | Parallel jobs per worker process. |
| `CAPCLIP_JOB_MAX_ATTEMPTS` | `3` | Retries with exponential backoff for transient failures. |
| `CAPCLIP_RETENTION_DAYS` | `30` | Default project retention (users can change theirs). |
| `CAPCLIP_SIGNED_URL_TTL` | `21600` | Lifetime of signed media links (seconds). |
| `CAPCLIP_DATA_DIR` | `server/data` | Media + SQLite location. |
| `CAPCLIP_DATABASE_URL` | SQLite in data dir | Any SQLAlchemy URL (e.g. Postgres). |
| `CAPCLIP_FONTS_DIR` | `server/fonts` | Extra `.ttf/.otf` caption fonts (passed to libass). |
| `CAPCLIP_X264_PRESET` / `CAPCLIP_X264_CRF` | `medium` (`veryfast` on ≤2 cores) / `20` | Export encoder settings. |

## YouTube and rights

A public YouTube URL doesn't grant permission to download or re-edit a video. CapClip always validates the link and fetches public metadata. It retrieves the video itself only when the operator has enabled it **and** the user confirms they own the video or are licensed to process it. Otherwise the project waits for the user to upload the file. Private, age-restricted, members-only, region-locked and DRM-protected videos fail with a clear message. CapClip never works around them.

## How the pipeline works

1. **Ingest.** Upload (resumable 8 MB chunks) or opt-in retrieval, then probe, a 720p preview proxy, and 16 kHz mono audio.
2. **Transcribe.** faster-whisper with VAD and word timestamps (or OpenAI Whisper), with progress and ETA.
3. **Signals.** A loudness envelope (250 ms windows), FFmpeg scene detection, and adaptive frame sampling over the *entire* video (2 fps for ≤10 min down to 0.25 fps for 90+ min): faces (OpenCV), motion, brightness, text bands. Burned-in caption detection runs on those frames.
4. **Select.** The transcript is split into sentences, and every sentence-aligned 30–60 s window is considered.
   - *Claude*: gets numbered sentences with timings, a visual timeline and ~8–40 frames, and returns clips with reasons, emphasis words, drop-sentences and metadata (JSON-schema structured output).
   - *Heuristic*: scores hook strength, payoff, prosodic energy, information density, narrative structure (question→answer, contrast, story), on-camera presence, ASR confidence and promo penalties.
   - Both are then **fitted** (shrink or grow at sentence boundaries until the *post-cut* duration is 30–60 s), **de-duplicated** (time overlap and content similarity), and kept only above a quality floor. There is no fixed count.
5. **Edit plan.** Fillers ("um", "uh") and stutters are removed, pauses longer than 0.38 s are tightened with lead/trail padding, and a 0.45 s tail keeps reactions. The same plan drives the preview, the captions and the render.
6. **Render.** One FFmpeg graph per clip: optional burned-text mask or crop, per-segment trim with 12 ms audio fades, a face-tracked crop (dead zone plus eased moves, snapping on scene cuts) or split-screen or blurred fill, then libass captions with word highlighting and a hook card, high-pass, light denoise and loudnorm to −14 LUFS. Output is 1080×1920 H.264 High / AAC 48 kHz with faststart.
7. **QA.** Duration, codecs, resolution, no leftover subtitle track, full decode, black frames, dead air, caption timing, clean sentence start and end, transcript confidence, and burned-text handling. A clip is only marked *ready* if it passes.
8. **Export.** Single MP4s, or a ZIP with MP4s, optional SRTs and `metadata.json`/`metadata.csv`.

### What it does *not* do (and says so in the UI)
- **Inpainting** of burned-in text. Detected text is blurred (masked), cropped, or avoided by moving the new captions, and each clip's QA panel says which.
- **Speaker diarization.** Captions aren't labelled per speaker.
- **Guaranteed views.** "AI-estimated potential" is a ranking signal only.

## Architecture

- **API** (`capclip/api.py`): projects, chunked upload, clips, live edit-plan preview, save and render, regenerate, exports, jobs, account, and HMAC-signed `/media` URLs with HTTP range support. A per-browser session cookie scopes data to a workspace user.
- **Queue** (`capclip/jobs/queue.py`): DB-backed jobs with atomic claim, leases and heartbeats (dead workers' jobs are re-queued), retries with exponential backoff, cooperative cancellation (running FFmpeg processes are killed), and priorities.
- **Pipeline** (`capclip/pipeline/`): swappable modules: `youtube`, `transcribe`, `signals`, `analysis`, `llm`, `edit`, `reframe`, `captions`, `render`, `qa`.
- **Data model** (`capclip/models.py`): User, UserPreference, Project, SourceVideo, TranscriptSegment, Clip (AI edit, current edit and publishing metadata), CaptionTrack, Job (analysis, render and export), ExportFile.
- **Retention**: a periodic sweep deletes projects past their retention period, exports after 7 days, and abandoned uploads.

## Testing

- `server/tests/test_pipeline.py`: fast unit tests for URL parsing, edit plans, selection, captions and reframing (`.venv/Scripts/python tests/test_pipeline.py`).
- `server/tests/e2e_upload.py`: uploads a video to a running API and follows it through analysis, rendering, QA and ZIP export. `tests/watch_db.py <project_id>` prints a project's progress straight from the database.
- `server/tests/make_sample.ps1` synthesises a 3.4-minute narrated talk with Windows' built-in speech synthesizer. Combine it with any background (the dev notes use an FFmpeg gradient with burned subtitles) to exercise the whole pipeline end to end without downloading media.
