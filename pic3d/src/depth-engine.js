// Main-thread client for the depth worker. One worker for the page's lifetime so the
// loaded model stays warm between images.

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./depth.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    const job = pending.get(msg.id);
    if (!job) return;
    if (msg.type === 'progress') job.onProgress?.(msg);
    else if (msg.type === 'result') {
      pending.delete(msg.id);
      job.resolve(msg);
    } else if (msg.type === 'error') {
      pending.delete(msg.id);
      job.reject(new Error(msg.message));
    }
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'The depth worker failed to start. Check your connection and reload.');
    for (const job of pending.values()) job.reject(err);
    pending.clear();
    worker = null;
  };
  return worker;
}

/**
 * Estimate depth for an image.
 * @param {ImageData} input
 * @param {'fast' | 'detail'} quality
 * @param {'gpu' | 'cpu'} accel preferred accelerator; 'gpu' falls back to CPU if WebGPU is missing or fails
 * @param {(p: object) => void} onProgress
 * @returns {Promise<{ data: Float32Array, width: number, height: number, device: string, dtype: string, ms: number, fellBack?: boolean }>}
 */
export function estimateDepth(input, quality, accel, onProgress) {
  const w = getWorker();
  const id = nextId++;
  // Drop progress from any older request still running; only the latest one matters.
  for (const job of pending.values()) job.onProgress = null;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    const pixels = new Uint8ClampedArray(input.data);
    w.postMessage({ id, type: 'estimate', quality, accel, width: input.width, height: input.height, pixels }, [pixels.buffer]);
  });
}

/** Best-effort detection so the UI can show where inference will run. */
export async function detectDevice() {
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) return 'webgpu';
  } catch {
    /* ignore */
  }
  return 'wasm';
}
