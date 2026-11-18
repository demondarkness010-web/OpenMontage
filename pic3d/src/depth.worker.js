// Depth estimation worker: Depth Anything V2 via Transformers.js.
// Runs on WebGPU when the browser has it, otherwise on WASM. Weights are fetched
// from the Hugging Face Hub once, then served from the browser cache.
import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm';

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODELS = {
  fast: 'onnx-community/depth-anything-v2-small',
  detail: 'onnx-community/depth-anything-v2-base',
};

let activeId = 0;
let backend = null;
const pipes = new Map();

async function detectBackend(accel) {
  if (accel === 'cpu') return { device: 'wasm', dtype: 'q8' };
  if (backend) return backend;
  try {
    const adapter = self.navigator.gpu ? await self.navigator.gpu.requestAdapter() : null;
    if (adapter) backend = { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32' };
  } catch {
    /* fall through to wasm */
  }
  return (backend ??= { device: 'wasm', dtype: 'q8' });
}

function post(msg, transfer) {
  self.postMessage(msg, transfer ?? []);
}

// Aggregate per-file download progress into one number.
const files = new Map();
function onProgress(p) {
  if (p.status === 'progress' && p.total) {
    files.set(p.file, { loaded: p.loaded, total: p.total });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    post({ id: activeId, type: 'progress', phase: 'download', loaded, total });
  } else if (p.status === 'ready') {
    post({ id: activeId, type: 'progress', phase: 'warmup' });
  }
}

function getPipe(quality, device, dtype) {
  const key = `${quality}|${device}|${dtype}`;
  if (!pipes.has(key)) {
    files.clear();
    const p = pipeline('depth-estimation', MODELS[quality], { device, dtype, progress_callback: onProgress });
    p.catch(() => pipes.delete(key));
    pipes.set(key, p);
  }
  return pipes.get(key);
}

// Robust normalization: clip to the 0.5–99.5 percentile so a few outlier pixels
// do not flatten the whole relief.
function normalize(raw) {
  const n = raw.length;
  const step = Math.max(1, Math.floor(n / 40000));
  const s = [];
  for (let i = 0; i < n; i += step) if (Number.isFinite(raw[i])) s.push(raw[i]);
  if (s.length < 16) throw new Error('Depth output was empty or invalid.');
  s.sort((a, b) => a - b);
  const lo = s[Math.floor(s.length * 0.005)];
  const hi = s[Math.ceil(s.length * 0.995) - 1];
  const range = hi - lo || 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (raw[i] - lo) / range;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

async function run(quality, image, accel) {
  const { device, dtype } = await detectBackend(accel);
  post({ id: activeId, type: 'progress', phase: 'load', device, dtype });
  const pipe = await getPipe(quality, device, dtype);
  post({ id: activeId, type: 'progress', phase: 'infer', device, dtype });
  const t0 = performance.now();
  const out = await pipe(image);
  const res = Array.isArray(out) ? out[0] : out;
  const tensor = res.predicted_depth;
  const [height, width] = tensor.dims.slice(-2);
  const data = normalize(tensor.data);
  return { data, width, height, device, dtype, ms: Math.round(performance.now() - t0) };
}

self.onmessage = async (e) => {
  const { id, type, quality, accel, width, height, pixels } = e.data;
  if (type !== 'estimate') return;
  activeId = id;
  try {
    const image = new RawImage(pixels, width, height, 4).rgb();
    let result;
    try {
      result = await run(quality, image, accel);
    } catch (err) {
      // WebGPU can fail on some drivers or produce NaNs in fp16. Retry on WASM.
      if (accel === 'cpu' || backend?.device !== 'webgpu') throw err;
      console.warn('[relief] WebGPU path failed, retrying on WASM:', err);
      backend = { device: 'wasm', dtype: 'q8' };
      result = await run(quality, image, 'cpu');
      result.fellBack = true;
    }
    post({ id, type: 'result', ...result }, [result.data.buffer]);
  } catch (err) {
    post({ id, type: 'error', message: err?.message ?? String(err) });
  }
};
