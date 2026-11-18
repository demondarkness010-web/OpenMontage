# Relief: photo or words to 3D

Relief turns a photo, or a short description, into 3D in one of two ways:

- **Depth relief** (free, on your device): Depth Anything V2 estimates depth in the browser, and Three.js shapes it into a relief you can move around, relight and export. Nothing is uploaded.
- **AI 3D model** (cloud): sends the photo to an image-to-3D model and gets back a full 3D object (a GLB you can orbit all the way round).
  - **Free**: eight open-source models on Hugging Face's free shared GPUs, with no key or payment needed: **Stable Fast 3D**, **TRELLIS.2**, **TRELLIS**, **Hunyuan3D-2**, **Hunyuan3D-2.1**, **TripoSG**, **Hunyuan3D-2mini Turbo** and **InstantMesh**.
  - **Paid**: **Hunyuan3D 3.1 Pro**, **Tripo H3.1** or **Meshy 7.1** on fal.ai.

## Run it

```bash
python pic3d/serve.py
```

Then open http://localhost:5190. There's nothing to install. Three.js and Transformers.js load from jsDelivr at pinned versions.

### Describe it (free text to 3D)

No photo? Type what you want ("a ceramic owl figurine") or pick an idea chip. A free image AI (Pollinations, no key) draws the object on a plain background in about 5 to 15 seconds. Relief crops off the provider's corner logo and opens the picture in the AI 3D model tab, ready to generate. **Redraw** asks for a new version of the same description.

The free image AI allows one picture every 45 seconds per IP address. The Create and Redraw buttons count down until the next one is allowed.

### Photo cleanup (free)

Before anything is sent to the vision AI or a 3D engine, the server tidies the photo toward what both want: the object centered, padded, on a plain background.

- **When the background is already plain** (most product-style photos), this is pure pixel math — a few seconds, no AI model, no GPU quota — and runs automatically every time.
- **When the background is busy** (a scene, clutter, several objects), the plan card offers **Clean up the background**. This runs a small AI model on your own computer (not Hugging Face), so it costs no GPU quota either, but takes about 20 to 40 seconds on a weak CPU. It re-studies the cleaned photo afterward, since the vision AI reads a clean photo far better: in testing, a photo of a person in front of a fiery explosion was read as "urban scene" before cleanup and correctly as "action figure" after.
- Either way, a note on the plan card says what changed, with a **Use original photo** link to go back.

### AI 3D plan (free)

Before anything is sent to a 3D engine, a free vision AI studies the photo (in the AI 3D model tab only; the depth relief stays on your device). It takes about 10 seconds and doesn't use the daily GPU quota. It writes down:

- what the object is, its style, materials and finish;
- what the hidden back and underside most likely look like, and whether it's symmetric;
- whether it needs colour, has fine printed detail, thin parts or hard edges;
- problems for 3D: several objects, cropping, blur, an odd angle, glass.

From that, the app picks the engine and its settings and says why. For example, fine detail gets TRELLIS with a 2K texture, and a shape-only hard-surface object gets TripoSG. If a guess is wrong, tap it on the plan card and the plan updates. Picking an engine yourself always wins; **Use the AI pick** switches back. For a poor photo, **Clean redraw with AI** draws a fresh reference picture from the AI's description. That picture is new, not an exact copy. Pressing Generate while the AI is still studying waits for the plan first.

The vision AI is LLaVA-OneVision-1.5 (Space `lmms-lab/LLaVA-OneVision-1.5`). If it's down, the server falls back to a Florence-2 caption (Space `prithivMLmods/Florence-2-Image-Caption`) read by a free text AI (Pollinations). If both fail, you can still generate with your own settings.

### More free engines

- **InstantMesh** (Tencent ARC): builds six consistent views of the object, then reconstructs a textured mesh from them in one fast pass — about 25 seconds total.
- **Hunyuan3D-2**: the original, most-used free 3D Space on Hugging Face (shape generation plus a full texture-painting pass). Heavier than Hunyuan3D-2.1 but produces a textured model, not shape-only.

Pick any free engine from the panel; the AI plan still tunes whichever one is selected.

### Wire and open-frame objects

Shopping carts, chairs, bikes, cages and baskets are built from thin bars with gaps between them. Stable Fast 3D fills those gaps and returns a solid block with the pattern painted on, so the plan never picks it for them. They go to TRELLIS (or TRELLIS.2 with an `HF_TOKEN`) with less mesh simplifying, and a failed run won't suggest Stable Fast 3D as the fallback. Three checks catch them, because the vision model alone misses them:
- the AI's `open_frame` / `thin_parts` answer;
- a list of object names (cart, chair, bike, cage, and so on);
- the pixels: many background-coloured pockets inside the object.

Even TRELLIS merges or thickens some bars on these; it's the hardest case for image-to-3D AI.

### Scenes

When the picture is a place rather than one object (courtyard, street, landscape, room, garden and so on), the AI plan says so. The AI's category is "scene", or the name matches a list of place words. In that case the plan:
- recommends **Make a depth relief instead**, which switches to the Depth relief tab;
- explains that AI 3D engines would only make a small diorama;
- doesn't offer the background cut-out, which would keep one random piece;
- skips the real-size guess.

A **Whole scene** chip lets you overrule it.

### Characters and drawings

When the AI sees a person or character (a photo, a figurine, or anime / manga / concept art), the plan:
- picks TRELLIS.2 (or TRELLIS without a token) with a 2K texture, and never Stable Fast 3D. Stable Fast 3D turns a figure into a ghost-like lump; this was tested on a full-body anime character;
- doesn't treat chains, straps or loose hair as a "wire frame";
- notes that the pose is kept as drawn;
- warns that hanging chains and thin cloth tips thicken or fuse, and that a full-body face comes out soft.

The vision AI also says whether the picture is a **photo, drawing or 3D render**. A drawing gets a note that the AI invents the volume, like turning the art into a figurine.

The photo cleanup reports which picture edges the object **runs off** (a cape cut by the frame, for example), so the plan can warn that part will end abruptly.

For any character or drawing, the plan also offers **Make it a standee instead**. This is the exact art cut out on an oval base, about 15 cm tall. It's built on your device in about a second and uses no GPU time. When the GPU limit stops a run, the same option appears on the error screen.

### Flat objects (free, on your device)

AI 3D engines guess depth, so flat things like vinyl records, coins, plates, cards, posters and stickers come out as lumpy blobs. When the AI plan sees a flat object, it picks **Flat object** instead. This engine:

- cuts the object out of the photo (it needs a plain background; otherwise the whole photo becomes a card);
- uses a true circle when the outline is round;
- gives it a real thickness, using standard sizes for records, CDs, coins, cards and plates, or the AI's estimate otherwise;
- keeps every pixel of the photo on the front, with a plain back in the object's main colour, or the same picture.

It takes about a second, uploads nothing and uses no GPU time. Change **Outline**, **Thickness**, **Back** and **Stand** (an oval base, for standees) in the panel. You can also tap the **Flat object** chip on the plan card to switch to it, or off it.

### Free AI 3D models (Hugging Face)

These work out of the box. They run on public Hugging Face Spaces (ZeroGPU), which give every visitor a small daily GPU quota:

- Without an account the quota is tiny (about one model a day, shared per IP).
- A free Hugging Face account gets more. Create one at https://huggingface.co/join, make a **Read** token at https://huggingface.co/settings/tokens, and add it to `OpenMontage/.env`:
  ```
  HF_TOKEN=hf_your-token-here
  ```
  Restart `serve.py`. Like the fal key, it stays on the server.

All Spaces share one quota, and each run reserves GPU time up front. The engine list shows how much each one needs (a green, amber or red meter):

| Engine | Output | GPU need | Usual time |
| --- | --- | --- | --- |
| Stable Fast 3D (Stability AI) | textured | light | about 15 s |
| TRELLIS.2 (Microsoft) | textured, most detail | heavy | 1 to 2 min |
| TRELLIS (Microsoft) | textured | medium | about 1 min |
| Hunyuan3D-2 (Tencent) | textured | heavy | 1 to 2 min |
| Hunyuan3D-2.1 (Tencent) | shape only | medium | about 30 s |
| TripoSG (VAST) | shape only | medium | about 1 min |
| Hunyuan3D-2mini Turbo (Tencent) | shape only | medium | about 20 s |
| InstantMesh (Tencent ARC) | textured | medium | about 25 s |

Stable Fast 3D is the default because it fits in the smallest quota. The AI plan reads how much GPU time is left and switches to Stable Fast 3D when it's low. When a run fails for lack of GPU time, the error screen offers a one-click retry with a lighter engine. After each run the server records what Hugging Face reports. If the quota is low or used up, a notice in the panel says how much is left and when it refills, and a failed run suggests lighter engines.

### Paid AI 3D models (fal.ai)

1. Create a key at https://fal.ai/dashboard/keys and add credit to the account.
2. Put it in `OpenMontage/.env` (or `pic3d/.env`):
   ```
   FAL_KEY=your-key-here
   ```
3. Restart `serve.py`. The key stays in the Python server and is never sent to the browser.

Try the AI flow for free with fake results:

```bash
python pic3d/serve.py 5192 --mock
```

## AI engines and prices

Prices are per generation, as listed on fal.ai on 2026-11-12. Check fal.ai before you rely on them. Before every paid run, the app shows the engine, the options and the exact cost, and waits for you to confirm.

| Engine | fal endpoint | Base | Add-ons |
| --- | --- | --- | --- |
| Hunyuan3D 3.1 Pro (Tencent) | `fal-ai/hunyuan-3d/v3.1/pro/image-to-3d` | $0.375 | PBR +$0.15, custom face count +$0.15 |
| Tripo H3.1 | `tripo3d/h3.1/image-to-3d` | $0.20 untextured / $0.30 textured / $0.40 HD | detailed geometry +$0.20, quad mesh +$0.05 |
| Meshy 7.1 | `fal-ai/meshy/v7.1/image-to-3d` | $0.80 untextured / $1.20 textured | |
| Stable Fast 3D (Stability AI) | HF Space `stabilityai/stable-fast-3d` | Free (daily quota) | |
| TRELLIS.2 (Microsoft) | HF Space `microsoft/TRELLIS.2` | Free (daily quota) | |
| TRELLIS (Microsoft) | HF Space `trellis-community/TRELLIS` | Free (daily quota) | |
| Hunyuan3D-2 (Tencent) | HF Space `tencent/Hunyuan3D-2` | Free (daily quota) | |
| Hunyuan3D-2.1 (Tencent) | HF Space `tencent/Hunyuan3D-2.1` | Free (daily quota) | shape only |
| TripoSG (VAST) | HF Space `VAST-AI/TripoSG` | Free (daily quota) | shape only |
| Hunyuan3D-2mini Turbo (Tencent) | HF Space `tencent/Hunyuan3D-2mini-Turbo` | Free (daily quota) | shape only |
| InstantMesh (Tencent ARC) | HF Space `TencentARC/InstantMesh` | Free (daily quota) | |

Meshy v7 is deprecated on fal.ai in favor of v7.1, so the app uses 7.1.

### Fix with Blender (free, on your PC)

AI engines leave the same problems in their models:
- specks floating around the model;
- vertices doubled along seams;
- small holes and flipped faces;
- far more triangles than a laptop needs. TRELLIS.2 makes about 450k.

**Fix with Blender**, under Download, runs Blender hidden in the background. It:
1. joins the parts;
2. merges doubled vertices;
3. deletes floating specks. Only bits that are small in both face count and size go, so a wire bar that broke off stays;
4. fills holes of up to 24 edges, giving the patch the colours around it;
5. points every face outward;
6. cuts the model to 150k triangles when it has more;
7. smooths the shading, keeping creases sharper than 40°.

Textures and colours are kept. The result is saved as a new History entry ("… + Blender fix") next to the original, with a summary of what changed. Only one Blender job runs at a time.

Tested on the TRELLIS.2 shopping cart: Blender removed 240 specks and cut 444k triangles to 150k (16 MB to 6.5 MB), and the result looks the same in clay and textured views. It takes about 2 minutes on a Celeron N4020 and about 15 s for a small Stable Fast 3D model.

**Depth reliefs too:** on the Depth relief tab, **Fix with Blender** (under Export) saves the relief to History, runs the same Blender fix, and opens the result in the AI 3D model tab. From there it can be downloaded as OBJ, STL, PLY or USDZ like any model. Export in Photo or Studio material, not Clay, so the picture stays on it. On the cloister test photo, the relief went from 209k to 150k triangles in about 3 minutes.

Setup: unzip the portable [Blender 4.5 LTS](https://download.blender.org/release/Blender4.5/) into `OpenMontage/.runtime/blender/`, the same place `tools/graphics/blender_world.py` looks. Or set `BLENDER_PATH` in `.env` to `blender.exe`. Without Blender, the button is hidden.

### Download formats

Besides `.glb`, a finished model downloads as:
- `.obj`, for any 3D app;
- `.stl`, for 3D printing: Z up and scaled to the object's real size in millimetres (100 mm when the size is unknown);
- `.ply`, which keeps vertex colours;
- `.usdz`, for AR Quick Look on iPhone and iPad.

These are made in the browser from the model on screen.

**Tips:** use one object on a plain background, filling most of the frame. Generation usually takes 1 to 3 minutes. Every finished model is downloaded to `pic3d/generated/`, so it stays available in **History** after fal's links expire. OBJ, FBX and USDZ links appear under Download when the engine provides them.

## Features

- **Input**: file picker, drag and drop anywhere on the page, paste (Ctrl+V), or the built-in samples. EXIF rotation is respected.
- **Depth relief**: Fast (Small) or Detail (Base) model. Runs on WebGPU or CPU (WASM). If WebGPU crashes the tab, Relief switches to CPU on the next load. Low-memory machines start on CPU. Views are Mesh / Points / Wire. Materials are Photo / Studio / Clay / Depth. The camera can follow the pointer (Parallax) or orbit. Shaping controls: strength, curve, smoothing, edge tearing, invert, resolution, solid base. Exports: GLB, PNG, depth map, and a 6-second loop clip.
- **Start screen**: upload a photo or describe an object. Object samples open in the AI 3D model tab; scene samples open as a depth relief.
- **Photo check**: before generating, Relief inspects the picture on your device (background, framing, resolution, lighting) and says whether it suits a 3D model. Scenes get a one-click switch to a depth relief instead.
- **AI 3D model**: free engines first, paid ones folded away. Per-engine options, live pricing and a confirmation step for paid runs, a four-step progress view (send, wait for a GPU, build, download) with the engine's usual time, cancel, and a ground shadow. When the model is ready, a bar at the bottom shows its size and build time with a one-click .glb download. Materials are Textured / Clay / Wire / Normals. Exports: GLB, PNG, and a 6-second turntable clip. History persists across restarts, and a generation that is still running resumes after a page reload.

## Files

| File | Role |
| --- | --- |
| `index.html` / `styles.css` | Layout, controls, design tokens |
| `src/main.js` | App controller: tabs, state, loading, generation, history, export |
| `src/viewer.js` | `ReliefViewer`: renderer, relief + GLB display, camera modes, PNG and video capture |
| `src/relief.js` | Depth smoothing, relief mesh builder, colormaps |
| `src/depth.worker.js` / `src/depth-engine.js` | Depth Anything V2 in a Web Worker |
| `src/flat.js` | Flat object engine: cut-out, outline/circle fit, extrusion, GLB |
| `src/exporters.js` | OBJ / STL / PLY / USDZ downloads |
| `src/planner.js` | Turns the vision AI's notes into an engine, settings, assumptions and warnings |
| `src/models.js` | AI engine catalog: options, payload mapping, prices, typical times |
| `src/photocheck.js` | On-device check of whether a photo suits image-to-3D |
| `src/cloud.js` | Client for the server's `/api` routes |
| `serve.py` | Server: static files, COOP/COEP headers, fal.ai queue proxy, free Hugging Face jobs, free text-to-image proxy, photo cleanup (`tools/enhancement/cutout_engine.py`), mock mode |
| `hfspace.py` | Minimal Gradio queue client for Hugging Face Spaces (stdlib only) |
| `blender_clean.py` | Blender script behind **Fix with Blender**: cleans, repairs and reduces a GLB, writes a JSON report |

## Security

`serve.py` only answers requests addressed to `localhost` / `127.0.0.1` on its own port, rejects cross-site writes and non-JSON bodies, and never serves dotfiles such as `.env`. Your Hugging Face token is only sent to Hugging Face hosts.
