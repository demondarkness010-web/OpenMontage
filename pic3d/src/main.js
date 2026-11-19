// App controller: wires the DOM to the viewer, the on-device depth engine and the
// cloud image-to-3D API.
import { ReliefViewer } from './viewer.js';
import { estimateDepth, detectDevice } from './depth-engine.js';
import { loadImage, downloadBlob, baseName } from './image.js';
import { ENGINES, isVisible, money } from './models.js';
import { getConfig, startJob, saveLocalJob, waitForJob, listJobs, cancelJob, cleanJob, deleteJob, getJob, encodeForUpload, imagine, analyzePhoto, cleanupPhoto,
  blenderStatus, blenderCheck, inspectJob, exportJob, cancelTask, waitForTask, getJSON } from './cloud.js';
import { buildFlat, openness } from './flat.js';
import { exportModel } from './exporters.js';
import { checkPhoto } from './photocheck.js';
import { FACTS, facts, makePlan, realSize } from './planner.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ settings

const DEFAULTS = {
  v: 2, // settings version; 2 = free engines exist
  tab: 'model',
  // relief view (no rebuild)
  mode: 'mesh', shading: 'photo', camera: 'parallax', autoRotate: false, backdrop: 'ink',
  depthScale: 0.55, pointSize: 1.2, motion: 0.5,
  // relief geometry (rebuild)
  segments: 384, smoothing: 1.5, curve: 1, edgeCut: 0, invert: false, solid: false, thickness: 0.15,
  // depth model (re-run depth)
  quality: 'fast', accel: 'gpu',
  // cloud 3D
  engine: 'sf3d',
  engineOpts: Object.fromEntries(Object.entries(ENGINES).map(([id, e]) => [id, { ...e.defaults }])),
  mMaterial: 'textured', mAutoRotate: true, mGround: true,
};
const VIEW_KEYS = new Set(['mode', 'shading', 'camera', 'autoRotate', 'backdrop', 'depthScale', 'pointSize', 'motion']);
const GEO_KEYS = new Set(['segments', 'smoothing', 'curve', 'edgeCut', 'invert', 'solid', 'thickness']);
const MODEL_KEYS = { material: 'mMaterial', autoRotate: 'mAutoRotate', ground: 'mGround' };
const STORE_KEY = 'relief.settings.v1';
const GPU_PENDING = 'relief.gpuPending';

const FORMAT = {
  depthScale: (v) => v.toFixed(2),
  curve: (v) => (Math.abs(v - 1) < 0.005 ? 'linear' : v.toFixed(2)),
  smoothing: (v) => (v === 0 ? 'off' : `${v.toFixed(1)} px`),
  edgeCut: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`),
  motion: (v) => `${Math.round(v * 100)}%`,
  pointSize: (v) => `${v.toFixed(2)}×`,
  segments: (v) => `${v} px`,
  thickness: (v) => `${Math.round(v * 100)}%`,
};

const settings = readSettings();

function readSettings() {
  const s = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    for (const [k, v] of Object.entries(saved)) {
      if (!(k in DEFAULTS) || typeof v !== typeof DEFAULTS[k]) continue;
      if (k === 'engineOpts') {
        for (const id of Object.keys(ENGINES)) Object.assign(s.engineOpts[id], v[id] ?? {});
      } else s[k] = v;
    }
    // Settings saved before the free engines existed point at a paid one; start on free.
    if (!ENGINES[s.engine] || (saved.v ?? 1) < 2) s.engine = DEFAULTS.engine;
    s.v = DEFAULTS.v;
  } catch {
    /* corrupt or unavailable storage: defaults */
  }
  return s;
}
function writeStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}
function storeFlag(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
function readFlag(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ app state

const app = $('.app');
const viewer = new ReliefViewer($('#viewport'));
const fileInput = $('#fileInput');

let source = null;            // the loaded photo
let reliefState = 'empty';    // empty | pending | processing | error | ready
let reliefError = '';
let runToken = 0;
let config = { fal: false };
let jobs = [];                // history, newest first
let shownJob = null;          // job whose model is on screen
let gen = { state: 'idle', jobId: null, error: '', started: 0 }; // idle | generating | error
const watching = new Set();
let home = false;             // showing the start screen on top of a loaded photo
let drawing = { busy: false, prompt: '', waitUntil: 0 }; // text-to-image
let sourcePrompt = null;      // the description the current photo was drawn from
// AI 3D plan for the current photo: the vision AI's notes, the user's corrections, the plan.
let plan = {
  url: null, status: 'idle', analysis: null, error: '', overrides: {}, userPicked: false, result: null, promise: null,
  cleaned: null,      // { canvas, model, use } set when the photo was centered/cropped toward a plain background
  cleaning: false,    // the slow, explicit background-removal pass is running
};
let planToken = 0;

viewer.setView(pick(VIEW_KEYS));
viewer.setGeometry(pick(GEO_KEYS));
viewer.setModelView({ material: settings.mMaterial, autoRotate: settings.mAutoRotate, ground: settings.mGround });
viewer.onStats = ({ vertices, triangles, ms }) => {
  $('#stats').textContent = `${vertices.toLocaleString()} verts · ${triangles.toLocaleString()} tris · ${ms} ms`;
};

function pick(keys) {
  return Object.fromEntries([...keys].map((k) => [k, settings[k]]));
}

/** Decide what the stage shows from the active tab and each mode's state. */
function refreshStage() {
  let state;
  if (drawing.busy) state = 'imagining';
  else if (home) state = 'empty';
  else if (settings.tab === 'relief') {
    if (reliefState === 'pending' && source) {
      runDepth(); // the photo arrived while the AI tab was open; build its relief now
      return;
    }
    viewer.setKind('relief');
    state = reliefState;
    if (state === 'error') showError("That didn't work", reliefError);
  } else {
    viewer.setKind('model');
    if (gen.state === 'generating') state = 'm-generating';
    else if (gen.state === 'error') {
      state = 'error';
      showError('Generation failed', gen.error);
      const quota = /GPU time/i.test(gen.error);
      const f = plan.status === 'done' && plan.url === source?.url ? facts(plan.analysis, plan.overrides) : {};
      const standee = quota && plan.result?.alt?.engine && settings.engine !== 'flat';
      const lighter = f.flat && settings.engine !== 'flat'
        ? 'flat'
        : standee ? 'flat'
          : quota && !f.thin_parts && !f.character && settings.engine !== 'sf3d' && ENGINES[settings.engine].free ? 'sf3d' : null;
      $('#lighterBtn').hidden = !lighter || !source;
      if (lighter) {
        $('#lighterBtn').textContent = standee ? 'Make a standee instead' : `Try ${ENGINES[lighter].name}`;
        $('#lighterBtn').dataset.engine = lighter;
        $('#lighterBtn').dataset.standee = standee ? '1' : '';
      }
    } else if (shownJob) state = 'm-done';
    else if (source) state = 'm-ready';
    else state = 'empty';
  }
  app.dataset.state = state;
  if (state === 'm-ready' && source && plan.url !== source.url) studyPhoto();
  viewer.paused = ['empty', 'imagining', 'm-generating', 'm-ready', 'error'].includes(state);
  const loaded = !!source || !!shownJob;
  $('#newBtn').hidden = !loaded || state === 'empty' || state === 'imagining';
  const back = $('#backBtn');
  back.hidden = !(home && loaded);
  if (!back.hidden) back.textContent = `← Back to ${prettyName(shownJob && settings.tab === 'model' ? shownJob.name : source?.name ?? 'your model')}`;
  $('#fileChip').hidden = !source;
  if (shownJob) app.dataset.hasModel = '';
  else delete app.dataset.hasModel;
  for (const t of $$('.tabs [data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === settings.tab));
  app.dataset.tab = settings.tab;
  syncHint();
}

function showError(title, msg) {
  $('#errorTitle').textContent = title;
  $('#errorMsg').textContent = msg;
}

function syncHint() {
  $('#hint').textContent =
    settings.tab === 'model'
      ? 'Drag to orbit · right-drag to pan · scroll to zoom · double-click to reframe'
      : settings.camera === 'parallax'
        ? 'Move the pointer to look around · scroll to zoom · double-click to recenter'
        : 'Drag to orbit · right-drag to pan · scroll to zoom · double-click to recenter';
}

// ------------------------------------------------------------------ relief controls

function update(key, value, { persist = true } = {}) {
  settings[key] = value;
  if (VIEW_KEYS.has(key)) viewer.setView({ [key]: value });
  else if (GEO_KEYS.has(key)) viewer.setGeometry({ [key]: value });
  else if ((key === 'quality' || key === 'accel') && source && reliefState !== 'empty') {
    if (settings.tab === 'relief') runDepth();
    else reliefState = 'pending';
  }
  syncUI();
  if (persist) writeStore();
}

function syncUI() {
  for (const seg of $$('.seg[data-key]')) {
    for (const b of $$('button', seg)) {
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(b.dataset.value === settings[seg.dataset.key]));
    }
  }
  for (const sw of $$('.switch[data-key]')) sw.setAttribute('aria-checked', String(!!settings[sw.dataset.key]));
  for (const field of $$('.field[data-key]')) {
    const key = field.dataset.key;
    const input = $('input', field);
    if (document.activeElement !== input) input.value = settings[key];
    paintRange(input);
    $('output', field).textContent = FORMAT[key]?.(settings[key]) ?? settings[key];
  }
  for (const el of $$('[data-when]')) {
    const [k, v] = el.dataset.when.split('=');
    el.hidden = String(settings[k]) !== v;
  }
  for (const seg of $$('.seg[data-mkey]')) {
    let value = settings[MODEL_KEYS[seg.dataset.mkey]];
    if ($(`[data-value="${value}"]`, seg)?.disabled) value = 'clay'; // e.g. "Textured" on a shape-only model
    for (const b of $$('button', seg)) {
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(b.dataset.value === value));
    }
  }
  for (const sw of $$('.switch[data-mkey]')) sw.setAttribute('aria-checked', String(!!settings[MODEL_KEYS[sw.dataset.mkey]]));
  app.dataset.backdrop = settings.backdrop;
  syncHint();
}

function paintRange(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', `${p}%`);
}

function bindSeg(seg, get, set) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !b.disabled) set(b.dataset.value);
  });
  seg.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const buttons = $$('button:not(:disabled)', seg);
    const i = buttons.findIndex((b) => b.dataset.value === String(get()));
    const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    set(next.dataset.value);
    next.focus();
  });
}

for (const seg of $$('.seg[data-key]')) bindSeg(seg, () => settings[seg.dataset.key], (v) => update(seg.dataset.key, v));
for (const sw of $$('.switch[data-key]')) sw.addEventListener('click', () => update(sw.dataset.key, !settings[sw.dataset.key]));
for (const field of $$('.field[data-key]')) {
  const key = field.dataset.key;
  const input = $('input', field);
  input.addEventListener('input', () => update(key, Number(input.value), { persist: false }));
  input.addEventListener('change', writeStore);
  field.addEventListener('dblclick', (e) => {
    e.preventDefault();
    update(key, DEFAULTS[key]);
  });
}

// Model view controls
function updateModelView(mkey, value) {
  settings[MODEL_KEYS[mkey]] = value;
  viewer.setModelView({ [mkey]: value });
  syncUI();
  writeStore();
}
for (const seg of $$('.seg[data-mkey]')) bindSeg(seg, () => settings[MODEL_KEYS[seg.dataset.mkey]], (v) => updateModelView(seg.dataset.mkey, v));
for (const sw of $$('.switch[data-mkey]')) sw.addEventListener('click', () => updateModelView(sw.dataset.mkey, !settings[MODEL_KEYS[sw.dataset.mkey]]));

// Tabs
for (const t of $$('.tabs [data-tab]')) {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
}
function switchTab(tab) {
  if (viewer.isRecording) return toast('Wait for the recording to finish.', 'error');
  settings.tab = tab;
  writeStore();
  refreshStage();
}

$('#resetBtn').addEventListener('click', () => {
  const qualityChanged = settings.quality !== DEFAULTS.quality;
  const { tab, accel } = settings;
  Object.assign(settings, structuredClone(DEFAULTS), { tab, accel });
  viewer.setView(pick(VIEW_KEYS));
  viewer.setGeometry(pick(GEO_KEYS));
  viewer.setModelView({ material: settings.mMaterial, autoRotate: settings.mAutoRotate, ground: settings.mGround });
  viewer.resetView();
  syncUI();
  renderEngines();
  writeStore();
  if (qualityChanged && source && reliefState !== 'empty') {
    if (tab === 'relief') runDepth();
    else reliefState = 'pending';
  }
  toast('Settings reset');
});

// ------------------------------------------------------------------ loading

async function openBlob(blob, name, { tab, prompt = null } = {}) {
  if (viewer.isRecording) return toast('Wait for the recording to finish.', 'error');
  let img;
  try {
    img = await loadImage(blob, name);
  } catch (err) {
    return toast(err.message, 'error');
  }
  if (source) URL.revokeObjectURL(source.url);
  source = img;
  sourcePrompt = prompt;
  home = false;
  if (tab) {
    settings.tab = tab;
    writeStore();
  }
  renderPhotoCheck();
  $('#fileName').textContent = img.name;
  $('#fileMeta').textContent = `${img.width}×${img.height}`;
  for (const id of ['#procImg', '#mreadyImg']) $(id).src = img.url;
  document.title = `${img.name} · Relief`;

  // A new photo replaces whatever model was on screen; history keeps the old one.
  shownJob = null;
  viewer.clearModel();
  if (gen.state === 'error') gen = { ...gen, state: 'idle' };
  renderHistory();

  if (settings.tab === 'relief') await runDepth();
  else {
    reliefState = 'pending'; // depth runs when the user opens the relief tab
    refreshStage();
  }
}

function setStep(step, status, meta) {
  const li = $(`.steps [data-step="${step}"]`);
  li.className = status;
  if (meta !== undefined) $('.step-meta', li).textContent = meta;
}
const setBar = (f) => ($('#bar').style.width = `${Math.round(f * 100)}%`);
const mb = (b) => (b / 1048576).toFixed(1);
const DEVICE_LABEL = { webgpu: 'WebGPU', wasm: 'WASM' };

async function runDepth() {
  const token = ++runToken;
  reliefState = 'processing';
  refreshStage();
  setStep('load', 'active', '');
  setStep('infer', '', '');
  setStep('build', '', '');
  setBar(0.04);

  const onProgress = (p) => {
    if (token !== runToken) return;
    if (p.phase === 'load') setStep('load', 'active', `${DEVICE_LABEL[p.device]} · ${p.dtype}`);
    else if (p.phase === 'download') {
      setStep('load', 'active', `${mb(p.loaded)} / ${mb(p.total)} MB`);
      setBar(0.04 + 0.66 * (p.loaded / p.total));
    } else if (p.phase === 'warmup') {
      setStep('load', 'active', 'initializing');
      setBar(0.72);
    } else if (p.phase === 'infer') {
      setStep('load', 'done', `${DEVICE_LABEL[p.device]} · ${p.dtype}`);
      setStep('infer', 'active', '');
      setBar(0.78);
    }
  };

  // A GPU driver crash takes the whole tab down, so leave a marker that the next
  // load can see and switch to CPU.
  const guard = settings.accel === 'gpu';
  if (guard) storeFlag(GPU_PENDING, '1');
  try {
    const result = await estimateDepth(source.depthInput, settings.quality, settings.accel, onProgress);
    if (guard) storeFlag(GPU_PENDING, null);
    if (token !== runToken) return;
    if (result.fellBack) toast('WebGPU failed on this device, so depth ran on the CPU.');
    setStep('load', 'done');
    setStep('infer', 'done', `${result.ms} ms`);
    setStep('build', 'active');
    setBar(0.94);
    await new Promise((r) => setTimeout(r, 30)); // let the step list paint first
    if (token !== runToken) return;

    viewer.setImage(source.texture, source.aspect);
    viewer.setDepth(result);
    if (settings.tab === 'relief') viewer.resetView();
    setStep('build', 'done');
    setBar(1);
    const modelName = settings.quality === 'detail' ? 'Base' : 'Small';
    $('#engine').textContent = `Depth Anything V2 ${modelName} · ${DEVICE_LABEL[result.device]} ${result.dtype} · ${result.width}×${result.height} · ${result.ms} ms`;
    reliefState = 'ready';
  } catch (err) {
    if (guard) storeFlag(GPU_PENDING, null);
    if (token !== runToken) return;
    console.error(err);
    reliefError = friendlyError(err);
    reliefState = 'error';
  }
  refreshStage();
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/fetch|network|Failed to load|load model/i.test(msg)) {
    return `The depth model couldn't be downloaded (${msg}). Check your connection; the first run needs to reach huggingface.co and cdn.jsdelivr.net.`;
  }
  if (/memory|allocation|OOM/i.test(msg)) {
    return 'Your device ran out of memory. Try the Fast model or a smaller image.';
  }
  return msg;
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) openBlob(file, file.name);
  fileInput.value = '';
});
$('#drop').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
$('#newBtn').addEventListener('click', goHome);
$('#backBtn').addEventListener('click', () => {
  home = false;
  refreshStage();
});

function goHome() {
  if (viewer.isRecording) return toast('Wait for the recording to finish.', 'error');
  home = true;
  refreshStage();
  setTimeout(() => $('#promptInput').focus({ preventScroll: true }), 50);
}
$('#errorNewBtn').addEventListener('click', () => fileInput.click());
$('#lighterBtn').addEventListener('click', () => {
  const id = $('#lighterBtn').dataset.engine;
  if (!ENGINES[id] || !source) return;
  if ($('#lighterBtn').dataset.standee && plan.result?.alt) Object.assign(settings.engineOpts[id], plan.result.alt.opts);
  settings.engine = id;
  if (plan.url === source.url && plan.status === 'done') plan.userPicked = plan.result?.engine !== id;
  writeStore();
  renderEngines();
  gen = { ...gen, state: 'idle', jobId: null };
  generate();
});
$('#retryBtn').addEventListener('click', () => {
  if (settings.tab === 'model') {
    const live = jobs.find((j) => j.id === gen.jobId && ['queued', 'running', 'downloading'].includes(j.status));
    if (live) return track(live);
    gen = { ...gen, state: 'idle' };
    refreshStage();
    if (source) generate();
  } else if (source) runDepth();
  else {
    reliefState = 'empty';
    refreshStage();
  }
});

for (const btn of $$('.sample')) {
  btn.addEventListener('click', async () => {
    try {
      const res = await fetch(btn.dataset.src);
      if (!res.ok) throw new Error(`Sample failed to load (${res.status}).`);
      await openBlob(await res.blob(), btn.dataset.name, { tab: btn.dataset.tab });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// Paste an image from the clipboard.
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  openBlob(item.getAsFile(), `pasted.${item.type.split('/')[1] || 'png'}`);
});

// Drag and drop anywhere on the page.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  app.classList.add('dragging');
});
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) app.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  app.classList.remove('dragging');
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/')) ?? e.dataTransfer.files[0];
  if (file) openBlob(file, file.name);
});

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'r' || e.key === 'R') viewer.resetView();
  if (e.key === '/' && app.dataset.state === 'empty') {
    e.preventDefault();
    $('#promptInput').focus();
  }
});

// ------------------------------------------------------------------ describe it (text to image)

const SURPRISES = [
  'a carved wooden fox figurine', 'a retro robot toy with antenna', 'a ceramic teapot shaped like a pumpkin',
  'a cute cactus in a terracotta pot', 'a medieval iron lantern', 'a small bronze dragon statue',
  'a red vintage rotary telephone', 'a stylised crystal on a stone base', 'a plush teddy bear',
  'an astronaut helmet', 'a stack of three colourful macarons', 'a sci-fi blaster prop',
];

$('#promptForm').addEventListener('submit', (e) => {
  e.preventDefault();
  runImagine($('#promptInput').value);
});
for (const b of $$('#ideas [data-idea]')) {
  b.addEventListener('click', () => {
    const idea = b.dataset.idea === 'surprise' ? SURPRISES[Math.floor(Math.random() * SURPRISES.length)] : b.dataset.idea;
    $('#promptInput').value = idea;
    runImagine(idea);
  });
}
$('#redrawBtn').addEventListener('click', () => {
  const prompt = sourcePrompt || (plan.status === 'done' && plan.url === source?.url ? plan.analysis.description : '');
  if (prompt) runImagine(prompt);
});
$('#useReliefBtn').addEventListener('click', () => switchTab('relief'));

async function runImagine(prompt) {
  prompt = prompt.trim();
  if (drawing.busy) return;
  if (prompt.length < 3) {
    $('#promptInput').focus();
    return toast('Describe the object in a few words, like "a ceramic owl".', 'error');
  }
  if (config.offline) return toast('Describing needs the Relief server: run python pic3d/serve.py', 'error');
  const wait = Math.ceil((drawing.waitUntil - Date.now()) / 1000);
  if (wait > 0) return toast(`The free image AI needs a short break. Try again in ${wait} s.`, 'error');
  drawing = { ...drawing, busy: true, prompt };
  $('#imaginePrompt').textContent = `\u201c${prompt}\u201d`;
  refreshStage();
  syncCooldown();
  try {
    const blob = await imagine(prompt, Math.floor(Math.random() * 1e9));
    drawing = { ...drawing, busy: false, waitUntil: Date.now() + 45_000 };
    const name = `${baseName(prompt).toLowerCase().slice(0, 40)}.jpg`;
    await openBlob(blob, name, { tab: 'model', prompt });
  } catch (err) {
    drawing = { ...drawing, busy: false };
    if (err.retryAfter) drawing.waitUntil = Date.now() + err.retryAfter * 1000;
    refreshStage();
    toast(err.message, 'error');
  }
  syncCooldown();
}

// Count down on the Create / Redraw buttons while the free image AI is cooling down.
function syncCooldown() {
  const left = Math.ceil((drawing.waitUntil - Date.now()) / 1000);
  const cooling = left > 0;
  $('#promptBtn').textContent = cooling ? `Ready in ${left} s` : 'Create';
  $('#promptBtn').disabled = cooling || drawing.busy;
  $('#redrawLabel').textContent = cooling ? `Redraw in ${left} s` : sourcePrompt ? 'Redraw' : 'Clean redraw with AI';
  $('#redrawBtn').disabled = cooling;
}
setInterval(syncCooldown, 1000);

// ------------------------------------------------------------------ photo check

function renderPhotoCheck() {
  const { checks, verdict, sceneLike } = checkPhoto(source.depthInput, source);
  $('#checks').replaceChildren(
    ...checks.map((c) => {
      const li = el(`<li class="${c.level}"><span class="ic"></span><span><span class="ct"></span><small></small></span></li>`);
      $('.ic', li).textContent = c.level === 'ok' ? '\u2713' : '!';
      $('.ct', li).textContent = c.title;
      $('small', li).textContent = c.detail;
      return li;
    }),
  );
  $('#verdict').innerHTML = verdict.html;
  $('#useReliefBtn').hidden = !sceneLike;
  renderPlan();
}

// ------------------------------------------------------------------ AI 3D plan

/** The photo the AI should study and the one that gets uploaded: cleaned up, when that worked. */
function workingCanvas() {
  return plan.status === 'done' && plan.url === source?.url && plan.cleaned?.use ? plan.cleaned.canvas : source?.texture;
}

/** Have the vision AI study the current photo, then plan the 3D run from its notes. */
function studyPhoto() {
  if (!source || config.offline) return null;
  const token = ++planToken;
  const url = source.url;
  plan = {
    url, status: 'busy', analysis: null, error: '', overrides: {}, userPicked: false, result: null, promise: null,
    cleaned: null, cleaning: false,
  };
  plan.promise = (async () => {
    // Free, instant pixel-math pass: only does anything when the background is already plain
    // (centers and pads the object toward how every engine and the vision AI want it). A busy
    // background needs the slower, explicit "Clean up the background" step the plan offers below.
    try {
      const cleaned = await cleanupPhoto(source.texture, false);
      if (token !== planToken) return;
      if (cleaned) plan.cleaned = { canvas: cleaned, model: 'plain-background', use: true };
    } catch (err) {
      console.warn('photo cleanup (fast path) failed', err);
    }
    if (token !== planToken) return;
    renderPlan();
    try {
      const analysis = await analyzePhoto(workingCanvas());
      if (token !== planToken) return;
      plan.status = 'done';
      // Second opinion from the pixels: lots of background showing through = wire / open frame.
      let seeThrough = false;
      try {
        seeThrough = !!openness(workingCanvas())?.open;
      } catch (err) {
        console.warn('openness check failed', err);
      }
      // Does the photo itself look like a scene (busy, no single object)? The vision AI sometimes
      // names one small thing in a whole garden, so the planner weighs this pixel evidence too.
      let photoScene = false;
      try {
        photoScene = !!checkPhoto(source.depthInput, source).sceneLike;
      } catch (err) {
        console.warn('scene check failed', err);
      }
      plan.analysis = { ...analysis, see_through: seeThrough, photo_scene: photoScene, cut_off: plan.cleaned?.canvas.cutOff ?? [] };
      applyPlan();
    } catch (err) {
      if (token !== planToken) return;
      plan.status = 'error';
      plan.error = err.message;
      renderPlan();
    }
  })();
  renderPlan();
  return plan.promise;
}

/** The slow path: ask the server to segment the object out of a busy background. */
function cleanupBackground() {
  if (!source || plan.cleaning) return;
  const token = planToken; // cleanupBackground only runs for the photo studyPhoto() set up
  plan.cleaning = true;
  renderPlan();
  (async () => {
    try {
      const canvas = await cleanupPhoto(source.texture, true);
      if (token !== planToken) return; // a different photo is current now
      if (!canvas) {
        toast('Could not find a clean outline for the background. Try "Clean redraw with AI" instead.', 'error');
        return;
      }
      plan.cleaned = { canvas, model: 'local AI', use: true };
      plan.cleaning = false; // hand off to the normal "Studying your photo" message
      // Study the cleaned photo instead: a plain background reads better for the vision AI too.
      plan.status = 'busy';
      renderPlan();
      const analysis = await analyzePhoto(canvas);
      if (token !== planToken) return;
      plan.status = 'done';
      let seeThrough = false;
      try {
        seeThrough = !!openness(canvas)?.open;
      } catch (err) {
        console.warn('openness check failed', err);
      }
      plan.analysis = { ...analysis, see_through: seeThrough, cut_off: canvas.cutOff ?? [] };
      applyPlan();
    } catch (err) {
      if (token !== planToken) return;
      plan.status = 'error';
      plan.error = err.message;
      toast(err.message, 'error');
    } finally {
      if (token === planToken) plan.cleaning = false;
      renderPlan();
    }
  })();
}

function computePlan() {
  const q = config.hfQuota;
  const quotaLow = !config.mock && !!(q?.resetAt && q.resetAt * 1000 > Date.now());
  return makePlan(plan.analysis, facts(plan.analysis, plan.overrides), {
    hfToken: config.hfToken,
    userPicked: plan.userPicked,
    quotaLow,
    quotaLeft: quotaLow ? q.left : null,
    quotaAt: quotaLow ? new Date(q.resetAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null,
    currentEngine: settings.engine,
  });
}

/** Recompute the plan and, unless the user picked an engine themselves, switch to it. */
function applyPlan() {
  plan.result = computePlan();
  if (!plan.userPicked) {
    settings.engine = plan.result.engine;
    Object.assign(settings.engineOpts[plan.result.engine], plan.result.opts);
    writeStore();
    renderEngines();
  }
  renderPlan();
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Switch to the plan's alternative (the standee) with its settings. */
function useAlt(alt) {
  if (alt.tab) return switchTab(alt.tab);
  settings.engine = alt.engine;
  Object.assign(settings.engineOpts[alt.engine], alt.opts);
  plan.userPicked = true;
  writeStore();
  renderEngines();
  renderPlan();
}

function renderPlan() {
  const box = $('#plan');
  const mine = plan.url === source?.url;
  $('#planScan').hidden = !(mine && plan.status === 'busy');
  const drawnTitle = sourcePrompt ? 'Your object is drawn' : 'Ready to build a 3D model';
  const done = mine && plan.status === 'done';
  $('#redrawBtn').hidden = !sourcePrompt && !(done && plan.result.warnings.length);
  syncCooldown();
  if (!source || config.offline || !mine || plan.status === 'idle') {
    box.replaceChildren();
    $('#mreadyTitle').textContent = drawnTitle;
    return;
  }
  if (plan.cleaning) {
    $('#mreadyTitle').textContent = 'Cleaning up your photo';
    box.innerHTML =
      '<p class="plan-status"><span class="spinner"></span><span>Finding the object and clearing the background.' +
      '<br><small>On this PC \u00b7 about 20\u201340 s</small></span></p>';
    return;
  }
  if (plan.status === 'busy') {
    $('#mreadyTitle').textContent = 'Studying your photo';
    box.innerHTML =
      '<p class="plan-status"><span class="spinner"></span><span>Working out what it is, what it\u2019s made of and how the hidden sides should look.' +
      '<br><small>Free vision AI \u00b7 about 10 s</small></span></p>';
    return;
  }
  if (plan.status === 'error') {
    $('#mreadyTitle').textContent = drawnTitle;
    const p = el('<p class="plan-status bad"><span></span> <button class="link">Try again</button></p>');
    p.firstChild.textContent = plan.error;
    $('button', p).addEventListener('click', () => studyPhoto());
    box.replaceChildren(p);
    return;
  }
  const a = plan.analysis;
  const p = plan.result;
  const f = facts(a, plan.overrides);
  $('#mreadyTitle').textContent = capitalize(a.object);

  const dl = el('<dl class="assume"></dl>');
  for (const [k, v] of p.assumptions) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.append(dt, dd);
  }

  const chips = el('<div class="facts"><p class="facts-label">Wrong guess? Tap to fix it; the plan updates.</p></div>');
  const base = facts(a);
  for (const fc of FACTS) {
    const on = !!f[fc.key];
    const b = el('<button class="fact"></button>');
    b.textContent = on ? fc.on : fc.off;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('changed', fc.key in plan.overrides);
    b.title = fc.key in plan.overrides ? 'You changed this' : 'The AI\u2019s guess';
    b.addEventListener('click', () => {
      if (base[fc.key] === !on) delete plan.overrides[fc.key];
      else plan.overrides[fc.key] = !on;
      applyPlan();
    });
    chips.append(b);
  }

  const engine = ENGINES[p.engine];
  const pick = el('<div class="pick"></div>');
  if (plan.userPicked && settings.engine !== p.engine) {
    pick.append(`You picked ${ENGINES[settings.engine].name}. The AI would use `, el('<b></b>'), '.');
    pick.querySelector('b').textContent = engine.name;
    const why = el('<p></p>');
    why.textContent = p.why.join(' ');
    const use = el('<button class="link">Use the AI pick</button>');
    use.addEventListener('click', () => {
      plan.userPicked = false;
      settings.engine = p.engine; // so the plan is computed for the free pick, not the user's
      applyPlan();
    });
    pick.append(why, use);
  } else {
    pick.append('AI pick: ', el('<b></b>'), el('<span class="opts"></span>'), el('<p></p>'));
    pick.querySelector('b').textContent = engine.name;
    pick.querySelector('.opts').textContent = describeOptions(engine, settings.engineOpts[p.engine]) || 'Default settings';
    pick.querySelector('p').textContent = p.why.join(' ');
  }

  if (p.alt && (p.alt.tab || settings.engine !== p.alt.engine)) {
    const alt = el('<p class="plan-alt"></p>');
    const btn = el('<button class="link"></button>');
    btn.textContent = p.alt.label;
    btn.addEventListener('click', () => useAlt(p.alt));
    alt.append('Or: ', btn, ` \u2014 ${p.alt.note}.`);
    pick.append(alt);
  }
  const parts = [dl, chips, pick];
  if (p.warnings.length) {
    const ul = el('<ul class="plan-warn"></ul>');
    for (const w of p.warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.append(li);
    }
    parts.push(ul);
  }
  if (plan.cleaned) {
    const note = el('<p class="plan-status"></p>');
    const label = plan.cleaned.model === 'local AI' ? 'Cleaned up the background' : 'Centered and cropped your photo';
    const link = el('<button class="link"></button>');
    link.textContent = plan.cleaned.use ? 'Use original photo' : 'Use the cleaned photo';
    link.addEventListener('click', () => {
      plan.cleaned.use = !plan.cleaned.use;
      renderPlan();
    });
    note.append(`${label}, so the engine and the AI's notes work from a clearer picture. `, link);
    parts.push(note);
  } else if (/busy background|multiple|several/i.test(a.problems.join(' ')) && !plan.cleaning && !f.scene) {
    const btn = el('<button class="link">Clean up the background (about 20–40 s on this PC)</button>');
    btn.addEventListener('click', cleanupBackground);
    const note = el('<p class="plan-status"></p>');
    note.append('The background looks busy. ', btn);
    parts.push(note);
  }
  const src = el('<p class="plan-source"></p>');
  src.textContent = `Studied by ${a.source}`;
  parts.push(src);
  box.replaceChildren(...parts);
}

// ------------------------------------------------------------------ engines (cloud 3D)

const engineOpts = () => settings.engineOpts[settings.engine];
const currentCost = () => ENGINES[settings.engine].cost(engineOpts());

let paidOpen = null; // remembers the paid-engines disclosure across re-renders

function renderEngines() {
  const list = $('#engines');
  const button = ([id, e]) => {
      const b = document.createElement('button');
      b.className = `engine${e.free ? ' free' : ''}`;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(id === settings.engine));
      b.dataset.engine = id;
      const price = e.free ? 'Free' : id === settings.engine ? money(e.cost(settings.engineOpts[id])) : `from ${money(e.cost(e.defaults))}`;
      b.innerHTML = `<b></b><span class="price"></span><span></span>`;
      b.children[0].textContent = e.name;
      if (e.badge) b.children[0].append(el(`<em class="badge">${e.badge}</em>`));
      b.children[1].textContent = price;
      b.children[2].textContent = `${e.vendor} · ${e.blurb}`;
      if (e.gpu) {
        const g = el(`<i class="gpu gpu-${e.gpu}" title="How much of the free daily GPU time a run reserves"><span></span><span></span><span></span></i>`);
        b.children[2].prepend(g);
      }
      b.addEventListener('click', () => {
        settings.engine = id;
        writeStore();
        renderEngines();
        if (plan.status === 'done' && plan.url === source?.url) {
          plan.userPicked = true; // the user's choice wins for this photo
          plan.result = computePlan();
          renderPlan();
        }
      });
      return b;
  };
  const entries = Object.entries(ENGINES);
  const free = entries.filter(([, e]) => e.free && !e.local);
  const local = entries.filter(([, e]) => e.local);
  const paid = entries.filter(([, e]) => !e.free);
  const head = el('<p class="engine-group">Free · Hugging Face</p>');
  const localHead = el('<p class="engine-group">Free · On your device</p>');
  const details = el('<details class="paid"><summary></summary><div class="engines"></div></details>');
  $('summary', details).textContent = `Paid engines · fal.ai (${paid.length})`;
  $('.engines', details).append(...paid.map(button));
  if (paidOpen === null) paidOpen = !ENGINES[settings.engine].free;
  details.open = paidOpen || !ENGINES[settings.engine].free;
  details.addEventListener('toggle', () => (paidOpen = details.open));
  list.replaceChildren(head, ...free.map(button), localHead, ...local.map(button), details);
  renderEngineOptions();
}

function syncNotice() {
  const notice = $('#keyNotice');
  const engine = ENGINES[settings.engine];
  let html = '';
  let info = true;
  if (config.offline) {
    html = 'AI 3D needs the Relief server. Start it with <code>python pic3d/serve.py</code>.';
    info = false;
  } else if (config.mock) {
    html = 'Mock mode: generations are simulated and nothing is charged.';
  } else if (engine.free && !engine.local && config.hfQuota?.resetAt && config.hfQuota.resetAt * 1000 > Date.now()) {
    const mins = Math.round((config.hfQuota.resetAt * 1000 - Date.now()) / 60000);
    const at = new Date(config.hfQuota.resetAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const wait = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
    html =
      `<b>Free GPU time is ${config.hfQuota.left ? `down to about ${config.hfQuota.left} s` : 'used up'} for today.</b> ` +
      `It refills in about ${wait} (around ${at}); runs will likely fail until then. ` +
      (config.hfToken ? '' : 'A free <code>HF_TOKEN</code> in <code>.env</code> gives you more right away.');
  } else if (!engine.free && !config.fal) {
    html = 'Add your fal.ai key as <code>FAL_KEY</code> in <code>OpenMontage/.env</code>, then restart <code>serve.py</code>.';
    info = false;
  }
  notice.innerHTML = html;
  notice.hidden = !html;
  notice.classList.toggle('info', info);
}

function renderEngineOptions() {
  const engine = ENGINES[settings.engine];
  const opts = engineOpts();
  const box = $('#engineOptions');
  box.replaceChildren();
  for (const c of engine.controls) {
    if (!isVisible(c, opts)) continue;
    const set = (v) => {
      opts[c.key] = v;
      writeStore();
      renderEngines();
    };
    const extra = c.extra ? `<span class="extra">+${money(c.extra)}</span>` : '';
    if (c.type === 'seg') {
      const row = el(`<div class="row"><span class="row-label"></span><div class="seg" role="radiogroup"></div></div>`);
      row.firstChild.textContent = c.label;
      const seg = row.lastChild;
      seg.setAttribute('aria-label', c.label);
      for (const [value, label] of c.choices) {
        const b = document.createElement('button');
        b.dataset.value = value;
        b.textContent = label;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(opts[c.key] === value));
        seg.append(b);
      }
      bindSeg(seg, () => opts[c.key], set);
      box.append(row);
    } else if (c.type === 'toggle') {
      const row = el(`<div class="row"><span class="row-label"></span><button class="switch" role="switch"><span></span></button></div>`);
      row.firstChild.innerHTML = extra;
      row.firstChild.prepend(c.label);
      const sw = row.lastChild;
      sw.setAttribute('aria-label', c.label);
      sw.setAttribute('aria-checked', String(!!opts[c.key]));
      sw.addEventListener('click', () => set(!opts[c.key]));
      box.append(row);
    } else if (c.type === 'range') {
      const field = el(`<label class="field"><span class="field-label"></span><output></output><input type="range" /></label>`);
      field.firstChild.textContent = c.label;
      const out = field.children[1];
      const input = field.lastChild;
      Object.assign(input, { min: c.min, max: c.max, step: c.step, value: opts[c.key] });
      const paint = () => {
        out.textContent = c.format(Number(input.value));
        paintRange(input);
      };
      input.addEventListener('input', () => {
        opts[c.key] = Number(input.value);
        paint();
      });
      input.addEventListener('change', () => set(Number(input.value)));
      paint();
      box.append(field);
    }
  }
  const cost = money(currentCost());
  $('#quote').textContent = cost;
  $('#quoteRow').hidden = !!engine.free;
  $('#generateLabel').textContent = `Generate 3D model · ${cost}`;
  $('#mreadyLabel').textContent = `Generate with ${engine.name} · ${cost}`;
  $('#mreadyNote').textContent = engine.local
    ? `${engine.name} is built right here in your browser in ${engine.eta}: nothing is uploaded and no GPU time is used.`
    : `${engine.name} usually takes ${engine.eta}${engine.free ? ' on a free GPU' : ''}. Switch engines in the panel.`;
  $('#paidNote').hidden = !!engine.free;
  $('#freeNote').hidden = !engine.free;
  $('#freeNote').textContent = engine.local
    ? 'Built in your browser from the photo itself: instant, private and unlimited.'
    : config.hfToken
    ? "Runs on Hugging Face's free shared GPUs with your account's daily quota."
    : "Runs on Hugging Face's free shared GPUs. Without an account that's about one model a day; a free HF_TOKEN in .env gives you more.";
  syncNotice();
  syncGenerateButtons();
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function syncGenerateButtons() {
  const busy = gen.state === 'generating';
  const usable = !config.offline && (ENGINES[settings.engine].free || config.fal);
  for (const id of ['#generateBtn', '#mreadyBtn']) $(id).disabled = !usable || busy;
  syncBlenderButtons();
}

function describeOptions(engine, opts) {
  return engine.controls
    .filter((c) => isVisible(c, opts))
    .map((c) => {
      const v = opts[c.key];
      if (c.type === 'toggle') return v ? c.label : null;
      if (c.type === 'seg') return `${c.label}: ${c.choices.find(([x]) => x === v)?.[1] ?? v}`;
      return `${c.label}: ${c.format(v)}`;
    })
    .filter(Boolean)
    .join(' · ');
}

function confirmGenerate(engine, opts, cost) {
  const dlg = $('#confirm');
  $('#confirmImage').textContent = `${source.name} (${source.width}×${source.height})`;
  $('#confirmEngine').textContent = `${engine.name} by ${engine.vendor}`;
  $('#confirmOptions').textContent = describeOptions(engine, opts) || 'Defaults';
  $('#confirmCost').textContent = config.mock ? `${money(cost)} (mock mode: not charged)` : money(cost);
  $('#confirmOk').textContent = `Generate · ${money(cost)}`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

async function generate() {
  if (!source) return fileInput.click();
  if (gen.state === 'generating') return;
  if (plan.status === 'busy' && plan.url === source.url) {
    // First let the AI define the object; its plan picks the engine and settings.
    settings.tab = 'model';
    home = false;
    gen = { state: 'generating', jobId: null, error: '', started: Date.now() };
    $('#mgenImg').src = source.url;
    stepLabels(false);
    setGenStatus('AI 3D plan', 'Studying your photo first', 'Working out the hidden sides and the best engine', 0);
    $('#mgenEta').textContent = 'about 10 s';
    refreshStage();
    syncGenerateButtons();
    await Promise.race([plan.promise, new Promise((r) => setTimeout(r, 60_000))]);
    gen = { ...gen, state: 'idle' };
    refreshStage();
  }
  const engine = ENGINES[settings.engine];
  if (!engine.free && !config.fal) return toast('Add your fal.ai key first (see the note in the panel).', 'error');
  const opts = { ...engineOpts() };
  const cost = engine.cost(opts);
  // Paid engines always ask first; free ones just go.
  if (!engine.free && !(await confirmGenerate(engine, opts, cost))) return;
  // Name the model after what the AI saw ("Red toy robot") rather than the file name.
  const planned = plan.status === 'done' && plan.url === source.url && !sourcePrompt;
  const name = planned ? `${baseName(plan.analysis.object).toLowerCase().slice(0, 40)}.jpg` : source.name;
  // A standee is desk-sized, whatever the size of the character it shows.
  const sizeCm = engine.local && opts.stand === 'base' ? (plan.result?.alt?.size_cm ?? 15) : planned ? realSize(plan.analysis).size_cm : null;
  if (engine.local) return runLocal(engine, opts, name, sizeCm);

  settings.tab = 'model';
  home = false;
  gen = { state: 'generating', jobId: null, error: '', started: Date.now() };
  $('#mgenImg').src = source.url;
  setGenStatus(engine.name, 'Sending your photo', '', 0);
  $('#mgenEta').textContent = `usually ${engine.eta}`;
  $('#queueLabel').textContent = engine.free ? 'Wait for a free GPU' : 'Wait in the queue';
  refreshStage();
  syncGenerateButtons();
  try {
    const job = await startJob({
      model: settings.engine,
      options: engine.payload(opts),
      image: encodeForUpload(workingCanvas() ?? source.texture),
      name,
      size_cm: sizeCm,
      cost,
    });
    jobs.unshift(job);
    renderHistory();
    await track(job);
  } catch (err) {
    failGeneration(err.message);
  }
}

/** Build a model in the browser (Flat object) and keep it in History like any other. */
async function runLocal(engine, opts, name, sizeCm) {
  settings.tab = 'model';
  home = false;
  const started = Date.now();
  gen = { state: 'generating', jobId: null, error: '', started };
  $('#mgenImg').src = source.url;
  stepLabels(false);
  setGenStatus(engine.name, 'Cutting out the object', 'On your device · nothing is uploaded', 2);
  $('#mgenEta').textContent = `usually ${engine.eta}`;
  refreshStage();
  syncGenerateButtons();
  try {
    await new Promise((r) => setTimeout(r, 60)); // let the overlay paint before the heavy work
    const finish = plan.status === 'done' && plan.url === source.url ? plan.analysis.finish : undefined;
    const { glb } = await buildFlat(workingCanvas() ?? source.texture, { ...opts, finish });
    setGenStatus(engine.name, 'Saving your model', '', 3);
    const glbB64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('Couldn’t read the built model.'));
      r.readAsDataURL(glb);
    });
    const job = await saveLocalJob({
      model: settings.engine,
      name,
      image: encodeForUpload(source.texture),
      glb: glbB64,
      options: engine.payload(opts),
      size_cm: sizeCm,
      seconds: (Date.now() - started) / 1000,
    });
    jobs.unshift(job);
    gen = { ...gen, jobId: job.id };
    await showJob(job);
    toast(`${engine.name} ready`);
  } catch (err) {
    console.error(err);
    failGeneration(err.message);
  } finally {
    syncGenerateButtons();
    refreshStage();
  }
}

function setGenStatus(engineName, title, log, step) {
  $('#mgenEngine').textContent = engineName;
  $('#mgenTitle').textContent = title;
  $('#mgenLog').textContent = log || ' ';
  if (step === undefined) return;
  $$('#mgenSteps li').forEach((li, i) => (li.className = i < step ? 'done' : i === step ? 'active' : ''));
}

/** The four step names: a cloud build, or a Blender fix of a model that already exists. */
function stepLabels(blender) {
  const names = blender
    ? ['Hand the model to Blender', 'Start Blender', 'Clean and fix the mesh', 'Open the fixed model']
    : ['Send the photo', 'Wait for a free GPU', 'Build the 3D model', 'Download and open'];
  $$('#mgenSteps .step-label').forEach((l, i) => (l.textContent = names[i]));
}

/** Which of the four steps a job is on, and a headline for it. */
function jobStep(j) {
  if (j.status === 'downloading') return [3, 'Downloading your model'];
  if (j.status === 'running') return [2, j.provider === 'blender' ? 'Fixing the mesh in Blender' : 'Building your 3D model'];
  if (j.provider === 'blender') return [1, 'Starting Blender'];
  const waiting = j.queue_position != null || /^Waiting/.test(j.log || '') || (!j.log && j.provider !== 'hf');
  if (waiting) return [1, j.queue_position ? `In line · ${j.queue_position} ahead of you` : 'Waiting for a GPU'];
  return [0, 'Sending your photo'];
}

/** Follow a job to completion, keeping the overlay and history in sync. */
async function track(job) {
  if (watching.has(job.id)) return;
  watching.add(job.id);
  home = false;
  gen = { ...gen, state: 'generating', jobId: job.id, started: job.created * 1000 };
  $('#mgenImg').src = job.source;
  const engine = ENGINES[job.model];
  stepLabels(job.provider === 'blender');
  if (job.provider === 'blender') {
    $('#mgenEta').textContent = 'usually 1 to 3 min on this PC';
    $('#queueLabel').textContent = 'Start Blender';
  } else if (engine) {
    $('#mgenEta').textContent = `usually ${engine.eta}`;
    $('#queueLabel').textContent = engine.free ? 'Wait for a free GPU' : 'Wait in the queue';
  }
  const [step, title] = jobStep(job);
  setGenStatus(job.label, title, job.log, step);
  syncGenerateButtons();
  refreshStage();
  try {
    const final = await waitForJob(job.id, (j) => {
      replaceJob(j);
      if (gen.jobId !== j.id) return;
      const [step, title] = jobStep(j);
      setGenStatus(j.label, title, j.log, step);
      $('#queueMeta').textContent = j.queue_position ? `#${j.queue_position + 1}` : '';
    });
    if (gen.jobId !== final.id) return;
    if (final.status === 'done') {
      setGenStatus(final.label, 'Opening your model', '', 3);
      await showJob(final);
      toast(`${final.label} model ready`);
    } else if (final.status === 'cancelled') {
      gen = { ...gen, state: 'idle', jobId: null };
      toast('Generation cancelled');
    } else failGeneration(final.error || 'The provider reported a failure.');
  } catch (err) {
    failGeneration(err.message);
  } finally {
    watching.delete(job.id);
    // A free run tells the server how much GPU time is left; pick that up for the notice.
    if (ENGINES[job.model]?.free) {
      getConfig().then((c) => {
        if (c.offline) return;
        config = c;
        syncNotice();
        // The GPU time left changed: the best engine for this photo may have too.
        if (plan.status === 'done' && plan.url === source?.url && !plan.userPicked) applyPlan();
      });
    }
    syncGenerateButtons();
    refreshStage();
  }
}

/** "a-small-bronze-dragon-statue.jpg" → "Small bronze dragon statue". */
function prettyName(name) {
  const s = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/^(a|an|the)\s+/i, '').trim() || name;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function failGeneration(message) {
  gen = { ...gen, state: 'error', error: message };
  syncGenerateButtons();
  refreshStage();
}

function replaceJob(job) {
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = job;
  else jobs.unshift(job);
  renderHistory();
}

async function showJob(job) {
  try {
    const stats = await viewer.showModel(job.glb);
    shownJob = job;
    gen = { ...gen, state: 'idle', jobId: null };
    $('#modelStats').textContent =
      `${stats.triangles.toLocaleString()} tris · ${stats.vertices.toLocaleString()} verts · ` +
      `${stats.textures || !viewer.modelTextured ? `${stats.textures} texture${stats.textures === 1 ? '' : 's'}` : 'vertex colours'}` +
      `${job.cost != null ? ` · ${money(job.cost)}` : ''}`;
    const took = job.finished ? Math.round(job.finished - job.created) : null;
    $('#resultTitle').textContent = prettyName(job.name);
    $('#resultMeta').textContent = [
      job.label,
      `${stats.triangles >= 1e5 ? `${Math.round(stats.triangles / 1000)}k` : stats.triangles.toLocaleString()} tris`,
      viewer.modelTextured ? 'textured' : 'shape only',
      took ? `made in ${took < 120 ? `${took} s` : `${Math.round(took / 60)} min`}` : null,
    ].filter(Boolean).join(' · ');
    // A shape-only model has nothing to show in "Textured"; the viewer falls back to clay.
    const texturedBtn = $('.seg[data-mkey="material"] [data-value="textured"]');
    texturedBtn.disabled = !viewer.modelTextured;
    texturedBtn.title = texturedBtn.disabled ? 'This model has no texture' : '';
    syncUI();
    renderBlender(job);
    const links = $('#formatLinks');
    links.replaceChildren(
      ...Object.entries(job.formats ?? {}).map(([fmt, url]) => {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = `.${fmt}`;
        a.title = `Open the ${fmt.toUpperCase()} file hosted by fal.ai`;
        return a;
      }),
    );
  } catch (err) {
    if (err.name === 'AbortError') return; // superseded by a newer pick; that call renders
    console.error(err);
    gen = { ...gen, state: 'error', error: `The model downloaded but couldn't be displayed: ${err.message}` };
  }
  renderHistory();
  refreshStage();
}

// ------------------------------------------------------------------ Blender panel
// Everything shown here comes from Blender's own measurements (blender/inspector.py). Nothing
// is estimated in the browser: if a number wasn't measured, it says so.

var blender = null; // last /api/blender/status (var: read by syncGenerateButtons before this line runs)
var blTask = null; // the inspect/export Blender is running now
let blProfile = 'print'; // whose checks the inspection card lists
const reportCache = new Map();
const PROFILE_NAMES = { web: 'Web', game: 'Game', print: '3D print' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v) => (v == null ? '–' : typeof v !== 'number' ? String(v) : Math.abs(v) >= 1e5 ? `${Math.round(v / 1000)}k` : v.toLocaleString());
const kb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const ICON = { pass: '✓', warn: '!', fail: '✗', unknown: '?' };

async function loadBlenderStatus(run = false) {
  try {
    blender = run ? await blenderCheck() : await blenderStatus();
  } catch {
    blender = null;
  }
  syncBlenderStatus();
  if (blender?.checking) setTimeout(() => loadBlenderStatus(), 3000);
  else if (blender?.found && !blender.checked && !run) loadBlenderStatus(true); // never checked: check once
}

function syncBlenderStatus() {
  const s = $('#blStatus');
  const lines = [];
  if (!blender?.found) {
    s.textContent = 'not installed';
    s.className = 'bl-status bad';
    lines.push('Blender wasn\'t found. Unzip Blender 4.5 LTS into OpenMontage/.runtime/blender/,', 'or set BLENDER_PATH in .env to blender.exe, then restart serve.py.');
  } else if (blender.checking) {
    s.textContent = 'checking…';
    s.className = 'bl-status';
    lines.push('Running Blender\'s self-check (about 20–40 s on this PC).');
  } else {
    s.textContent = blender.working ? `${(blender.version || '').replace(' LTS', '')} · working` : blender.checked ? 'check failed' : 'not checked';
    s.className = `bl-status ${blender.working ? 'ok' : 'bad'}`;
    lines.push(`Blender ${blender.version || '?'} · Python ${blender.python || '?'}`, blender.path || '');
    for (const [name, c] of Object.entries(blender.checks || {}))
      lines.push(`${c.ok ? '✓' : '✗'} ${name.replace(/_/g, ' ')}${c.ok ? '' : `: ${c.error}`} (${c.seconds} s)`);
    if (blender.error) lines.push(`Problem: ${blender.error}`);
    if (blender.render_device) lines.push(`Cycles renders on: ${blender.render_device}`);
    if (blender.startup_seconds != null) lines.push(`Start-up: ${blender.startup_seconds} s`);
    if (blender.disk_free_gb != null) lines.push(`Free disk: ${blender.disk_free_gb} GB`);
    if (blender.checked) lines.push(`Checked ${new Date(blender.checked * 1000).toLocaleString()}. Click to check again.`);
  }
  s.title = lines.filter(Boolean).join('\n');
  syncBlenderButtons();
}

function syncBlenderButtons() {
  const usable = !!blender?.found && !blender.checking;
  const busy = !!blTask || gen.state === 'generating';
  $('#blInspectBtn').disabled = !usable || busy;
  $('#blExportBtn').disabled = !usable || busy;
  $('#blExportGo').disabled = !usable || busy;
  const fixed = !!shownJob?.cleaned_from;
  $('#blenderBtn').disabled = !usable || busy || fixed;
  $('#blenderBtn').title = fixed ? 'This is already the repaired copy' : 'Repair a copy: every change is checked and undone if it makes things worse';
  const p = $('#blProgress');
  p.hidden = !blTask;
  if (blTask) {
    const other = shownJob && blTask.job_id !== shownJob.id ? ' (another model)' : '';
    $('#blProgressText').textContent = `${blTask.kind === 'export' ? 'Exporting' : 'Inspecting'}${other}: ${blTask.progress || 'working'}`;
  }
}

async function loadReport(url) {
  if (!url) return null;
  if (!reportCache.has(url)) reportCache.set(url, getJSON(url).catch(() => null));
  return reportCache.get(url);
}

function scoreButton(key, s, onPick) {
  const verdict = (s.verdict || '').replace(' ', '-');
  const b = el(`<button type="button" class="bl-score v-${verdict}" aria-pressed="${key === blProfile}">
    <b>${s.score ?? '–'}</b><span>${PROFILE_NAMES[key] || key}</span><i>${esc(s.verdict)}</i></button>`);
  b.title = `${s.failed} failed, ${s.warnings} warning${s.warnings === 1 ? '' : 's'}. Score = (checks passed + ½ × warnings) ÷ checks measured.`;
  b.addEventListener('click', () => onPick(key));
  return b;
}

function shots(urls) {
  const d = el('<div class="bl-shots"></div>');
  for (const u of urls || []) {
    if (!u) continue;
    const a = el(`<a href="${esc(u)}" target="_blank" rel="noopener" title="Rendered by Blender (Workbench)"><img alt="Blender check picture" loading="lazy"></a>`);
    a.firstChild.src = u;
    d.append(a);
  }
  return d;
}

function dims(m) {
  const d = m?.dimensions_m;
  return d ? d.map((x) => (x >= 10 ? x.toFixed(1) : x.toFixed(3))).join(' × ') : '–';
}

/** The inspection card: three scores, the checks behind the chosen one, measured facts, pictures. */
async function inspectionCard(job) {
  const ins = job.inspection;
  if (!ins?.summary) return null;
  const card = el(`<div class="bl-card"><h4>Inspection <small>${new Date(ins.checked * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></h4>
    <div class="bl-scores"></div><ul class="bl-checks"><li class="bl-muted">Loading the measurements…</li></ul><dl class="bl-facts"></dl></div>`);
  const pick = (key) => {
    blProfile = key;
    renderBlender(job);
  };
  for (const [key, s] of Object.entries(ins.summary)) $('.bl-scores', card).append(scoreButton(key, s, pick));
  card.append(shots(ins.renders));
  const rep = await loadReport(ins.report_url);
  const m = rep?.inspections?.model || rep?.inspections?.after;
  const list = $('.bl-checks', card);
  if (!m) {
    list.replaceChildren(el('<li class="bl-muted">The detailed report is missing (it may have been cleaned up).</li>'));
    return card;
  }
  list.replaceChildren(
    ...m.profiles[blProfile].checks.map((c) => {
      const v = c.value === true ? 'yes' : c.value === false ? 'no' : c.value == null ? 'not measured' : `${num(c.value)}${c.unit ? ` ${c.unit}` : ''}`;
      return el(`<li><span class="r-${c.result}">${ICON[c.result]}</span><span>${esc(c.label)}</span><span class="val">${esc(v)}</span><small>wanted: ${esc(c.want)}</small></li>`);
    }),
  );
  const facts = [
    ['Size (model units, m)', dims(m)],
    ['Triangles', num(m.triangles)],
    ['Pieces', `${num(m.islands)}${m.specks ? ` (${m.specks} specks)` : ''}`],
    ['Closed (watertight)', m.watertight ? 'yes' : `no · ${num(m.holes)} hole${m.holes === 1 ? '' : 's'}, ${num(m.boundary_edges)} open edges`],
    ['Flipped faces', `${num(m.flipped_edges)} edges${m.inside_out ? ' · inside out' : ''}`],
    ['Self-intersections', m.self_intersecting_triangles == null ? 'not measured' : `${num(m.self_intersecting_triangles)} triangles`],
    ['UV map', m.has_uvs ? `yes${m.zero_area_uv_triangles ? ` · ${num(m.zero_area_uv_triangles)} squashed` : ''}` : 'no'],
    ['Textures', m.textures ? `${m.textures} · up to ${m.texture_max_px} px${m.missing_texture_count ? ` · ${m.missing_texture_count} missing` : ''}` : 'none'],
  ];
  $('.bl-facts', card).append(...facts.flatMap(([k, v]) => [el(`<dt>${esc(k)}</dt>`), el(`<dd>${esc(v)}</dd>`)]));
  card.append(el(`<p class="bl-muted">Not measured: ${esc((m.not_measured || []).join(', ') || 'nothing')}. Measured in ${m.seconds} s.</p>`));
  return card;
}

/** The repair card of a "+ Blender fix" model: what each step did, what was undone, and the re-check. */
function fixCard(job) {
  const r = job.report;
  if (!r?.before) return legacyFix(r);
  const card = el(`<div class="bl-card"><h4>What the fix changed <small>${r.seconds ? `${Math.round(r.seconds)} s` : ''}</small></h4></div>`);
  if (r.profiles_before && r.profiles_after) {
    card.append(el(`<p class="bl-muted">${Object.keys(r.profiles_after).map((k) =>
      `${PROFILE_NAMES[k] || k} ${r.profiles_before[k]?.score ?? '–'} → <b style="color:var(--text)">${r.profiles_after[k].score}</b>`).join(' · ')}</p>`));
  }
  const rows = [
    ['triangles', 'Triangles'], ['islands', 'Pieces'], ['specks', 'Specks'], ['holes', 'Holes'],
    ['boundary_edges', 'Open edges'], ['flipped_edges', 'Flipped edges'], ['non_manifold_edges', 'Non-manifold edges'],
    ['degenerate_triangles', 'Zero-area faces'], ['duplicate_vertices', 'Doubled points'], ['self_intersecting_triangles', 'Self-intersections'],
    ['watertight', 'Watertight'],
  ];
  const dl = el('<dl class="bl-facts"></dl>');
  for (const [k, label] of rows) {
    const b = r.before[k], a = r.after[k];
    const show = (v) => (v === true ? 'yes' : v === false ? 'no' : v == null ? '–' : num(v));
    dl.append(el(`<dt>${label}</dt>`), el(`<dd class="${b !== a ? 'changed' : ''}">${show(b)} → ${show(a)}</dd>`));
  }
  card.append(dl);
  const steps = el('<ul class="bl-steps"></ul>');
  for (const s of r.repair || []) {
    const extra = s.status === 'rolled_back' ? ` <span class="r-warn">undone: ${esc(s.reason)}</span>`
      : s.status === 'failed' ? ` <span class="r-fail">failed: ${esc(s.reason)}</span>`
      : s.status === 'skipped' ? ` · skipped, ${esc(s.reason)}`
      : s.skipped ? ` · ${esc(s.skipped)}` : '';
    const [cls, icon] = { ok: ['r-pass', '✓'], skipped: ['r-unknown', '–'], failed: ['r-fail', '✗'] }[s.status] || ['r-warn', '↺'];
    steps.append(el(`<li><span class="${cls}">${icon}</span> <b>${esc(s.step)}</b>${extra}</li>`));
  }
  card.append(steps);
  const v = r.validated;
  card.append(el(v?.ok
    ? '<p class="bl-muted"><span class="r-pass">✓</span> The repaired GLB was imported again in a clean scene: same triangles and size.</p>'
    : `<p class="bl-muted"><span class="r-fail">✗</span> Re-import check: ${esc((v?.problems || ['not run']).join('; '))}</p>`));
  card.append(shots([r.renders?.before, r.renders?.after]));
  return card;
}

/** Reports from the first, single-script Blender fix (before the inspector existed). */
function legacyFix(r) {
  if (!r) return null;
  const did = [
    r.islands_removed && `removed ${r.islands_removed} floating bit${r.islands_removed === 1 ? '' : 's'}`,
    r.holes_filled && `filled ${r.holes_filled} hole${r.holes_filled === 1 ? '' : 's'}`,
    r.merged_vertices && `joined ${num(r.merged_vertices)} doubled points`,
    r.decimated_from && `trimmed ${num(r.decimated_from)} → ${num(r.after?.triangles)} triangles`,
  ].filter(Boolean);
  return el(`<div class="bl-card"><h4>Fixed with Blender</h4><p class="bl-muted">${esc(did.join(', ') || 'the mesh was already clean')}.
    This fix ran before Relief measured results, so press Inspect to check it.</p></div>`);
}

function exportsCard(job) {
  const ex = job.exports;
  if (!ex || !Object.keys(ex).length) return null;
  const card = el('<div class="bl-card"><h4>Blender exports <small>each file re-imported to check it</small></h4><ul class="bl-files"></ul></div>');
  const base = prettyName(job.name).replace(/[^\w-]+/g, '-').toLowerCase() || 'model';
  for (const [fmt, e] of Object.entries(ex)) {
    const file = e.url.split('/').pop();
    const name = file.endsWith('.zip') ? `${base}-${fmt}.zip` : `${base}.${file.split('.').pop()}`;
    const li = el(`<li><span class="${e.ok ? 'r-pass' : 'r-fail'}">${e.ok ? '✓' : '✗'}</span><a download></a><span class="val">${kb(e.bytes)}</span>
      <small>${e.ok ? 'opens again with the same shape, size and materials' : `problem: ${esc(e.problems.join('; '))}`}</small></li>`);
    const a = $('a', li);
    a.href = e.url;
    a.download = name;
    a.textContent = name;
    $('.bl-files', card).append(li);
  }
  return card;
}

let blRender = 0;
async function renderBlender(job) {
  const group = $('#blenderGroup');
  group.hidden = !!config.offline;
  if (!job || config.offline) return;
  syncBlenderButtons();
  const size = $('#blSize');
  if (size.dataset.job !== job.id) {
    size.dataset.job = job.id;
    size.value = job.size_cm || '';
  }
  const note = $('#blenderNote');
  note.textContent = job.cleaned_from ? '' : job.inspection ? '' :
    'Inspect measures the mesh for holes, flipped faces, specks and more, and scores it for web, games and 3D printing. Fix repairs a copy and undoes any step that makes it worse.';
  const mine = ++blRender;
  const cards = [fixCard(job), await inspectionCard(job), exportsCard(job)].filter(Boolean);
  if (mine !== blRender) return; // a newer model was picked meanwhile
  $('#blResults').replaceChildren(...cards);
}

async function runBlenderTask(start) {
  const job = shownJob;
  if (!job || blTask) return;
  try {
    blTask = await start(job.id);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  syncBlenderButtons();
  try {
    const final = await waitForTask(blTask.id, (t) => {
      blTask = t;
      syncBlenderButtons();
    });
    if (final.status === 'failed') toast(final.error || 'Blender stopped with an error.', 'error');
    else if (final.status === 'done' && final.report?.status === 'done_with_problems' && final.kind === 'export')
      toast('Some files didn\'t pass the re-import check; see the list.', 'error');
    const fresh = await getJob(final.job_id);
    replaceJob(fresh);
    if (shownJob?.id === fresh.id) shownJob = fresh;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    blTask = null;
    syncBlenderButtons();
    if (shownJob) renderBlender(shownJob);
  }
}

$('#blStatus').addEventListener('click', () => {
  if (blender?.found && !blender.checking) loadBlenderStatus(true);
});
$('#blInspectBtn').addEventListener('click', () => runBlenderTask(inspectJob));
$('#blExportBtn').addEventListener('click', () => {
  const box = $('#blExport');
  box.hidden = !box.hidden;
  $('#blExportBtn').setAttribute('aria-expanded', String(!box.hidden));
});
$('#blExportGo').addEventListener('click', () => {
  const formats = $$('#blFormats input:checked').map((i) => i.value);
  if (!formats.length) return toast('Pick at least one format', 'error');
  const size = parseFloat($('#blSize').value);
  $('#blExport').hidden = true;
  $('#blExportBtn').setAttribute('aria-expanded', 'false');
  runBlenderTask((id) => exportJob(id, formats, Number.isFinite(size) && size > 0 ? size : null));
});
$('#blCancel').addEventListener('click', async () => {
  if (!blTask) return;
  try {
    await cancelTask(blTask.id);
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#blenderBtn').addEventListener('click', async () => {
  if (!shownJob || gen.state === 'generating') return;
  const btn = $('#blenderBtn');
  btn.disabled = true;
  try {
    const job = await cleanJob(shownJob.id);
    jobs.unshift(job);
    renderHistory();
    await track(job);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    syncBlenderButtons();
  }
});

$('#generateBtn').addEventListener('click', generate);
$('#mreadyBtn').addEventListener('click', generate);
$('#mgenCancel').addEventListener('click', async () => {
  if (!gen.jobId) return;
  try {
    await cancelJob(gen.jobId);
  } catch (err) {
    toast(err.message, 'error');
  }
});

// Elapsed time on the generating overlay.
setInterval(() => {
  if (gen.state !== 'generating') return;
  const s = Math.max(0, Math.round((Date.now() - gen.started) / 1000));
  $('#mgenTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}, 1000);

// ------------------------------------------------------------------ history

const STATUS_TEXT = { queued: 'Queued', running: 'Generating', downloading: 'Downloading', failed: 'Failed', cancelled: 'Cancelled' };

function renderHistory() {
  const list = $('#history');
  if (!jobs.length) {
    list.innerHTML = '<li class="history-empty">Your generated models appear here.</li>';
    return;
  }
  list.replaceChildren(
    ...jobs.map((job) => {
      const li = el(`<li class="history-item" tabindex="0"><img alt="" /><div class="t"><b></b><small></small></div>
        <button class="del" aria-label="Delete"><svg viewBox="0 0 16 16"><path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.6 9h5.8l.6-9" /></svg></button></li>`);
      const img = $('img', li);
      img.src = job.thumbnail || job.source;
      li.classList.toggle('active', shownJob?.id === job.id);
      $('b', li).textContent = job.name;
      const when = new Date(job.created * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const small = $('small', li);
      small.textContent = [job.label, STATUS_TEXT[job.status], job.cost != null ? money(job.cost) : null, when].filter(Boolean).join(' · ');
      small.classList.toggle('bad', job.status === 'failed');
      const open = () => openJob(job);
      li.addEventListener('click', (e) => !e.target.closest('.del') && open());
      li.addEventListener('keydown', (e) => e.key === 'Enter' && open());
      $('.del', li).addEventListener('click', () => removeJob(job));
      return li;
    }),
  );
}

async function openJob(job) {
  settings.tab = 'model';
  home = false;
  writeStore();
  if (job.status === 'done') {
    if (gen.state === 'generating') return toast('Wait for the current generation to finish.', 'error');
    gen = { ...gen, state: 'idle' };
    await showJob(job);
  } else if (job.status === 'failed') {
    toast(job.error || 'This generation failed.', 'error');
  } else if (job.status === 'cancelled') {
    toast('This generation was cancelled.');
  } else track(job);
}

async function removeJob(job) {
  if (['queued', 'running', 'downloading'].includes(job.status)) return toast('Cancel it before deleting.', 'error');
  if (!confirm(`Delete "${job.name}" (${job.label}) from history and from this computer?`)) return;
  try {
    await deleteJob(job.id);
    jobs = jobs.filter((j) => j.id !== job.id);
    if (shownJob?.id === job.id) {
      shownJob = null;
      viewer.clearModel();
    }
    renderHistory();
    refreshStage();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ------------------------------------------------------------------ export

$('#resultGlb').addEventListener('click', () => $('[data-mexport="glb"]').click());

const size = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

async function withBusy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast(err.message || 'Export failed.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function recordClip(btn, base, defaultLabel) {
  const label = $('.label', btn);
  $('#recBadge').hidden = false;
  try {
    const { blob, ext } = await viewer.record(6, (f) => {
      $('#recPct').textContent = `${Math.round(f * 100)}%`;
      label.textContent = `Recording ${Math.round(f * 100)}%`;
    });
    save(blob, `${base}.${ext}`);
  } finally {
    $('#recBadge').hidden = true;
    label.textContent = defaultLabel;
  }
}

for (const btn of $$('[data-export]')) {
  btn.addEventListener('click', () =>
    withBusy(btn, async () => {
      if (!source || reliefState !== 'ready') throw new Error('Build a relief first.');
      const base = baseName(source.name);
      const kind = btn.dataset.export;
      if (kind === 'glb') save(await viewer.exportGLB(), `${base}-relief.glb`);
      else if (kind === 'png') save(await viewer.snapshot(), `${base}-view.png`);
      else if (kind === 'depth') save(await viewer.depthPNG(), `${base}-depth.png`);
      else if (kind === 'video') await recordClip(btn, `${base}-loop`, 'Loop clip');
    }),
  );
}

// Depth relief -> History -> Blender: keeps the relief as a model, then cleans and lightens it
// like any AI model. The result opens in the AI 3D model tab with the rest of History.
$('#reliefBlenderBtn').addEventListener('click', () =>
  withBusy($('#reliefBlenderBtn'), async () => {
    if (!source || reliefState !== 'ready') throw new Error('Build a relief first.');
    if (gen.state === 'generating') throw new Error('Wait for the current model to finish.');
    const glb = await viewer.exportGLB();
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('Couldn\u2019t read the relief.'));
      r.readAsDataURL(glb);
    });
    const saved = await saveLocalJob({
      model: 'relief',
      name: `${baseName(source.name)} relief.jpg`,
      image: encodeForUpload(source.texture),
      glb: b64,
      options: { quality: settings.quality },
      seconds: 0,
    });
    jobs.unshift(saved);
    const job = await cleanJob(saved.id);
    jobs.unshift(job);
    renderHistory();
    switchTab('model');
    track(job);
  }),
);

for (const btn of $$('[data-mexport]')) {
  btn.addEventListener('click', () =>
    withBusy(btn, async () => {
      if (!shownJob) throw new Error('Generate or open a model first.');
      const base = `${baseName(shownJob.name)}-${shownJob.model}`;
      const kind = btn.dataset.mexport;
      if (kind === 'glb') {
        const res = await fetch(shownJob.glb);
        if (!res.ok) throw new Error('The model file is missing from the generated folder.');
        save(await res.blob(), `${base}.glb`);
      } else if (kind === 'png') save(await viewer.snapshot(), `${base}.png`);
      else if (kind === 'video') await recordClip(btn, `${base}-turntable`, 'Turntable');
    }),
  );
}

for (const btn of $$('[data-format]')) {
  btn.addEventListener('click', () =>
    withBusy(btn, async () => {
      if (!shownJob || !viewer.model) throw new Error('Generate or open a model first.');
      const fmt = btn.dataset.format;
      const sizeMm = shownJob.size_cm ? shownJob.size_cm * 10 : 100;
      save(await exportModel(viewer.model, fmt, { sizeMm }), `${baseName(shownJob.name)}-${shownJob.model}.${fmt}`);
      if (fmt === 'stl') toast(`STL scaled to ${Math.round(sizeMm)} mm on its longest side${shownJob.size_cm ? ' (the AI’s size estimate)' : ''}.`);
    }),
  );
}

function save(blob, filename) {
  if (!blob) throw new Error('Export produced no data.');
  downloadBlob(blob, filename);
  toast(`Saved ${filename} · ${size(blob.size)}`);
}

function toast(message, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  $('#toasts').append(t);
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, kind === 'error' ? 5200 : 2600);
}

// ------------------------------------------------------------------ boot

// Low-memory / dual-core machines tend to crash on WebGPU model loads; start them on
// CPU unless the user has picked an accelerator themselves.
const lowEnd = (navigator.deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 2;
if (lowEnd && !/"accel"/.test(readFlag(STORE_KEY) ?? '')) settings.accel = 'cpu';

if (readFlag(GPU_PENDING)) {
  storeFlag(GPU_PENDING, null);
  settings.accel = 'cpu';
  writeStore();
  setTimeout(() => toast('The last run crashed on WebGPU, so Relief switched to CPU. You can change this under Depth model.', 'error'), 400);
}
syncUI();
renderEngines();
refreshStage();

detectDevice().then((device) => {
  const gpu = device === 'webgpu';
  if (!gpu) {
    const btn = $('.seg[data-key="accel"] [data-value="gpu"]');
    btn.disabled = true;
    btn.title = 'WebGPU is not available in this browser';
    if (settings.accel === 'gpu') update('accel', 'cpu', { persist: false });
  }
  $('#fastSize').textContent = gpu ? 'Small · ~50 MB' : 'Small · ~27 MB';
  $('#detailSize').textContent = gpu ? 'Base · ~195 MB' : 'Base · ~100 MB';
  $('#engine').textContent = `Depth Anything V2 · runs on ${DEVICE_LABEL[device]}`;
});

getConfig().then(async (cfg) => {
  config = cfg;
  $('#reliefBlenderBtn').hidden = !cfg.blender;
  $('#blenderGroup').hidden = !!cfg.offline;
  if (!cfg.offline) loadBlenderStatus();
  syncNotice();
  syncGenerateButtons();
  if (cfg.offline) return;
  try {
    jobs = await listJobs();
    renderHistory();
    // Pick up a generation that was still running when the page was closed.
    const live = jobs.find((j) => ['queued', 'running', 'downloading'].includes(j.status));
    if (live) track(live);
  } catch (err) {
    console.warn(err);
  }
});
