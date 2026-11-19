# Relief: audit, architecture and roadmap

Written 2026-11-19, against the "master development prompt" for an AI-powered 3D creation studio. This is the
first deliverable that prompt asks for: what exists, what works, what doesn't, and the order to build the rest.
It's kept current as stages land. See the checklist at the end.

## 1. Constraints that shape every decision

| Constraint | Effect |
| --- | --- |
| Laptop: Intel Celeron N4020 (2 cores, 1.1 GHz), 3.8 GB RAM, Intel UHD 600 | No local GPU AI. Blender Cycles renders take ~12 min each at 1100×760 / 24 samples. Heavy jobs must be one at a time. |
| C: drive: ~2.7 GB free | No Node toolchain, no PostgreSQL/Redis, no local AI models over a few hundred MB. |
| No money | Free engines only (Hugging Face ZeroGPU Spaces with a free token). fal.ai is wired up, but its balance is empty. |
| Free ZeroGPU quota | A daily cap on GPU minutes and a separate cap on the number of runs. When it's hit, every heavy HF engine refuses for the rest of the day. |

The master prompt suggests Next.js, FastAPI, PostgreSQL, Redis and S3. Its own Part 1 says to keep the existing
stack unless there's a strong reason not to, and on this machine there isn't room for it. Relief therefore stays
zero-install:
- a static ES-module front end, with Three.js loaded through an importmap;
- a standard-library Python server;
- a portable Blender.

Every new system is a separate module behind a JSON contract. That way one can be swapped for the suggested
stack later without rewriting the others.

## 2. What exists today

| Area | Files | State |
| --- | --- | --- |
| Static UI, two tabs (AI 3D model, Depth relief) | `index.html`, `styles.css`, `src/main.js` | Works |
| 3D viewer: orbit/parallax, Textured/Clay/Wire/Normals, PNG + 6 s turntable capture | `src/viewer.js` | Works |
| Depth relief (Depth Anything V2 in a worker, WebGPU or WASM) | `src/depth*.js`, `src/relief.js` | Works; ~90 s on this CPU |
| Photo check (on device) | `src/photocheck.js` | Works |
| Photo cleanup: plain-background crop and AI cut-out | `serve.py` → `tools/enhancement/cutout_engine.py` | Works; the cut-out engine isn't committed |
| Vision analysis → AI 3D plan | `serve.py /api/analyze` (LLaVA-OneVision Space), `src/planner.js` | Works; verified on 7 test images |
| Image-to-3D, free: SF3D, TRELLIS, TRELLIS.2, Hunyuan3D-2 / 2.1 / 2mini, TripoSG, InstantMesh | `serve.py run_hf_job`, `hfspace.py` | SF3D, TRELLIS.2, Hunyuan3D-2.1 and InstantMesh are verified end to end. The others are wired up but unverified: the quota ran out. |
| Image-to-3D, paid: Hunyuan 3.1, Tripo, Meshy (fal.ai) | `serve.py`, `src/models.js` | Wired up; unusable without credit |
| Text-to-3D | `/api/imagine` (Pollinations image) → image-to-3D | Works, as a two-step pipeline |
| Flat object / standee engine (on device) | `src/flat.js` | Works |
| Exports: GLB, OBJ, STL (real size), PLY, USDZ | `src/exporters.js` | Work. They're never re-imported to check them. |
| History of jobs, with files on disk | `serve.py` (`generated/jobs.json`) | Works |
| Blender | `blender_clean.py`, `/api/jobs/<id>/clean` | Works, but as one fixed script. It has no diagnostics, no inspection report, no rollback and no export validation. |

### Problems found

1. **The Blender integration is a single script.** It reports what it did, but nothing *checks* the result:
   - no before/after inspection;
   - no rollback if a repair makes things worse;
   - "it ran" is treated as "it worked". The prompt's Part 5.4 and Rule 4 forbid exactly this.
2. **Blender's presence is a yes/no.** There's no version, GPU, render-engine or write-permission check, and no
   live execution test. An install that was moved or broken only shows up when a job fails.
3. **No independent quality inspector.** Nothing measures non-manifold edges, holes, flipped faces,
   self-intersections, missing textures or UVs. So nothing can tell a model is *usable* for printing or games, as
   opposed to *looking* fine.
4. **Exports are never validated.** STL/OBJ/PLY/USDZ come from three.js exporters and are never re-read.
5. **There's no automated test suite.** The planner test and the API probes live in a scratch folder.
6. **The cut-out engine isn't committed** (`tools/enhancement/cutout_engine.py`), so a fresh clone loses photo
   cleanup. It degrades gracefully, but silently.

## 3. Architecture going forward

```
browser (src/*)  ──JSON──►  serve.py (HTTP, jobs, history)
                               │
                               ├─► hfspace.py ──► Hugging Face Spaces   (AI generation)
                               ├─► cutout_engine / LLaVA                (photo cleanup, vision)
                               └─► blender_runner.py ──subprocess──► Blender 4.5 LTS
                                     (diagnostics, job dirs,              └─ blender/ops.py
                                      timeouts, cancel, one at a time)       operation library:
                                                                             inspect · repair · export
                                                                             · validate · render views
```

- **Job contract:** the server never sends Python to Blender. It writes a `job.json` listing named operations
  with parameters. `blender/ops.py` checks every operation and parameter against its own registry before it runs
  anything, so the server never runs untrusted Python (prompt Parts 5.2, 5.7 and 18).
- **Each operation:**
  - checks its inputs;
  - acts through Blender's data API (bmesh, data-blocks), not context-dependent operators, wherever possible;
  - then runs a post-check and records status, timing and measurements in `report.json`.
- **Checkpoints:** before any operation that changes geometry, the scene is saved to a `.blend` checkpoint. If
  the post-check finds the result worse than before, the checkpoint is reloaded (prompt Part 5.6).
- **The inspector is independent of the repair code.** It only measures, and its scores come only from those
  measurements, using per-use profiles (web, game, print).
- **Isolation:** each job gets its own folder under `generated/blender-jobs/<id>/`, a timeout and cancellation.
  Only one Blender runs at a time, because of the 4 GB of RAM. Windows has no simple per-process memory limit, so
  the timeout and the single worker are the guard.

## 4. Roadmap (priority order)

| Stage | Scope | Status |
| --- | --- | --- |
| 1. Stabilize | Audit (this file); test suite; commit the cut-out engine dependency or report its absence | In progress |
| 2. Blender foundation | Connection manager + diagnostics; operation library; JSON jobs; checkpoints + rollback; independent inspector; export with re-import validation; regression tests | In progress |
| 3. Generation reliability | Inspect every AI result automatically; retry with another engine on refusal; per-region "inferred" markers from the plan | Next |
| 4. Professional editing | In-browser transform gizmos, a material editor wired to Blender, modifier stack, UV view | Later |
| 5. Website builder | Prompt → static 3D page (three.js) using a model from History, with an export | Later |
| 6. Advanced | Multi-image and video reconstruction, rigging, environments | Needs GPU services this machine and budget don't have. Adapters will be documented, not faked. |

### Honest limits (prompt Rule 15)

- **Multi-image and video reconstruction** need photogrammetry (COLMAP, Gaussian splatting) or multi-view
  models. None of these run on this laptop, and no free hosted API was found. They stay "unavailable" in the UI
  until a service is configured.
- **8K textures, sculpting, rigging, lip-sync and motion capture** aren't possible on a Celeron. Blender has the
  tools, but an interactive web front end for them is a stage-4+ project.
- **One photo can't reveal hidden surfaces.** The AI plan already lists what it *assumes* about the back and
  underside. Inferred-region markers are planned for stage 3.

## 5. Testing strategy

- `tests/blender_regression.py` builds known scenes inside Blender, each with a defect in it:
  - duplicate vertices;
  - a hole;
  - flipped faces;
  - floating specks;
  - self-intersecting boxes;
  - a thin wire frame;
  - a textured mesh.

  It asserts that the inspector finds each defect, that the repair fixes it without changing the object's size,
  and that every export format re-imports with the same geometry. It also runs on real models from History when
  they exist.
- `tests/planner.test.mjs` runs the AI-plan regression on its fixed set of analyses.
- `tests/README.md` explains how to run both. A change to `blender/ops.py` isn't done until the regression suite
  passes.

## 6. Checklist

- [x] Audit and roadmap
- [x] Blender connection manager: `GET /api/blender/status`, `POST /api/blender/check` (`blender_runner.py`, `blender/diagnose.py`)
- [x] Operation library + JSON job runner (`blender/relief_ops.py`, `blender/worker.py`)
- [x] Independent inspector with web/game/print profiles (`blender/inspector.py`)
- [x] Checkpointed repair with rollback (in-memory mesh copies per step; see "Checkpoints" below)
- [x] Blender exports (GLB, FBX, OBJ+MTL+textures, STL in mm, USDZ, PLY, .blend) with re-import validation
- [x] UI: status + self-check details, Inspect / Fix / Export, measured before → after, validated downloads
- [x] Regression suite passing (see `tests/README.md`): Blender 30/30 including the garden relief, planner 8/8

### Notes from building it

- **Checkpoints** are in-memory copies of the mesh data-block, not `.blend` files. With ~0.2–2.7 GB of free
  disk, writing a `.blend` (packed textures) before every step isn't affordable. Rollback is exact: the
  regression suite checks that every vertex returns to its old position, even after a step that crashes
  halfway.
- **Headless rendering:** Workbench works headless on the Intel UHD 600 (~4 s for a 480 px picture), and so
  does EEVEE (slow to start, because shaders compile on first use). Cycles has no GPU here (no CUDA, OptiX,
  HIP or oneAPI) and takes ~12 min per 1100×760 frame, so check pictures use Workbench.
- **The validators caught real bugs while this was built:**
  - OBJ exports silently dropped textures, because glTF textures are packed and had no file to copy.
  - The first inspector counted UV-seam splits as thousands of "open edges" on closed models.
  Both are fixed and covered by tests.
- **The garden photo end to end (Nov 2026) found three more real problems:**
  - *Scene read as an object.* The vision prompt said "study the main object", so for a greenhouse garden the AI
    named one pot ("stone planter", furniture) and the plan picked TRELLIS. The prompt now first asks whether
    the photo is one object, several, or a place (`subject`, which sets category "scene"), and the planner also
    counts the on-device photo check ("no single object" plus the AI's "busy background") as scene evidence.
    `tests/planner.test.mjs` has the garden case and a planter-on-busy-background case that must stay an object.
  - *"Solid base" reliefs weren't closed.* The back was one 4-corner quad touching 1,200 wall edges without
    sharing them: 1,204 open edges and ~400 "self-intersections" along that seam, print score 67. The back is now
    a fan through the same edge points (`src/relief.js`). The garden solid now measures watertight, 0 open
    edges, 0 self-intersections, print 100.
  - *A job crashed with "Access is denied" writing `report.json`.* On Windows a file the server is reading
    can't be replaced. `worker.py` and `diagnose.py` now retry the replace for up to 5 s.
- **Fix targets the web budget (150k triangles).** A fixed model can still score "not ready" for games (≤ 50k);
  that's reported honestly rather than reduced further without being asked.
- **Depth relief speed depends on free memory.** Normally ~40–50 s for depth on this PC; with C: at 0.23 GB
  and ~300 MB RAM free it took 5 to 44 minutes because Windows was swapping.
