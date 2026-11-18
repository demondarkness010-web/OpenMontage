// Client for serve.py's /api routes. The fal.ai key stays on the server.

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Lost contact with the Relief server. Is serve.py still running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Server error (${res.status}).`), { status: res.status });
  return data;
}

export async function getConfig() {
  try {
    return await api('GET', '/api/config');
  } catch {
    // Opened from a plain static server: the relief mode still works.
    return { fal: false, mock: false, offline: true };
  }
}

export const startJob = (body) => api('POST', '/api/generate', body);
/** Keep a model built in the browser (Flat object) in History. */
export const saveLocalJob = (body) => api('POST', '/api/local-jobs', body);
export const getJob = (id) => api('GET', `/api/jobs/${id}`);
export const listJobs = () => api('GET', '/api/jobs');
export const cancelJob = (id) => api('POST', `/api/jobs/${id}/cancel`);
/** Clean and fix a finished model with Blender on the server; resolves with the new job. */
export const cleanJob = (id) => api('POST', `/api/jobs/${id}/clean`);
export const deleteJob = (id) => api('DELETE', `/api/jobs/${id}`);

/**
 * Poll a job until it finishes. Calls onUpdate with every snapshot.
 * Resolves with the final job; rejects only on network trouble.
 */
export async function waitForJob(id, onUpdate, signal) {
  let delay = 800; // the server is local, so polling is cheap; start fast for quick engines
  let misses = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Stopped watching', 'AbortError');
    let job;
    try {
      job = await getJob(id);
      misses = 0;
    } catch (err) {
      // A blip (server busy, provider hiccup, laptop waking up) shouldn't lose a running job:
      // keep trying for about half a minute. A 4xx means the job is really gone.
      if ((err.status >= 400 && err.status < 500) || ++misses > 6) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** Math.min(misses, 4)));
      continue;
    }
    onUpdate(job);
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(2500, delay + 200);
  }
}

/**
 * Text to image through the server's free image AI. Resolves with a JPEG Blob of one
 * object on a plain background, with the provider's corner watermark cropped away.
 * Rejects with an Error whose `retryAfter` (seconds) is set when rate limited.
 */
export async function imagine(prompt, seed) {
  let res;
  try {
    res = await fetch('/api/imagine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, seed }),
    });
  } catch {
    throw new Error('Lost contact with the Relief server. Is serve.py still running?');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Image AI error (${res.status}).`);
    err.retryAfter = data.retryAfter;
    throw err;
  }
  const bmp = await createImageBitmap(await res.blob());
  // The free tier stamps a logo in the bottom-right corner; trim the bottom strip and
  // the same amount off the sides so the picture stays square and centered.
  const cut = Math.round(bmp.height * 0.06);
  const w = bmp.width - cut, h = bmp.height - cut;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, cut / 2, 0, w, h, 0, 0, w, h);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the picture.'))), 'image/jpeg', 0.92),
  );
}

/**
 * Ask the server's vision AI what the photo shows and how its hidden sides most likely look.
 * Sends a 768 px copy: plenty for the AI, and quick to upload.
 */
/**
 * Ask the server to tidy the photo toward what every engine wants: the object centered,
 * padded, on a plain background. `force: false` (the default) only does the free, instant
 * pixel-math path and does nothing when the background isn't already plain; `force: true`
 * also tries a small local AI model for a busy background, which is slow on a weak CPU.
 * Resolves to null when nothing changed.
 */
export async function cleanupPhoto(canvas, force = false) {
  const { image, cut_off: cutOff } = await api('POST', '/api/cleanup', { image: canvas.toDataURL('image/jpeg', 0.92), force });
  if (!image) return null;
  const bmp = await createImageBitmap(await (await fetch(image)).blob());
  const out = document.createElement('canvas');
  out.width = bmp.width;
  out.height = bmp.height;
  out.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  out.cutOff = cutOff || []; // picture edges the object runs into
  return out;
}

export function analyzePhoto(canvas) {
  const scale = Math.min(1, 768 / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return api('POST', '/api/analyze', { image: c.toDataURL('image/jpeg', 0.88) });
}

/** Encode the source image for upload: JPEG, longest side ≤ 2048, under fal's 8 MB cap. */
export function encodeForUpload(canvas) {
  let quality = 0.92;
  let url = canvas.toDataURL('image/jpeg', quality);
  while (url.length > 10_500_000 && quality > 0.5) {
    quality -= 0.1;
    url = canvas.toDataURL('image/jpeg', quality);
  }
  return url;
}
