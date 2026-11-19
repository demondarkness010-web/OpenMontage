// Quick on-device check of how well a photo suits image-to-3D models, which work best on
// one whole object, on a plain background, filling most of the frame. Pure pixel
// statistics on a small thumbnail: runs in a few milliseconds.

const GRID = 128; // analyse at most 128 px on the long side

/**
 * @param {ImageData} img
 * @param {{width:number,height:number}} original size of the original photo
 * @returns {{ checks: {level:'ok'|'warn'|'bad', title:string, detail:string}[], verdict: {level:string, html:string}, sceneLike: boolean }}
 */
export function checkPhoto(img, original) {
  const s = Math.min(1, GRID / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * s));
  const h = Math.max(8, Math.round(img.height * s));
  const px = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) / s));
      const sy = Math.min(img.height - 1, Math.floor((y + 0.5) / s));
      const i = (sy * img.width + sx) * 4, o = (y * w + x) * 3;
      px[o] = img.data[i];
      px[o + 1] = img.data[i + 1];
      px[o + 2] = img.data[i + 2];
    }
  }
  const at = (x, y, c) => px[(y * w + x) * 3 + c];

  // Border band: its colour and how textured it is.
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.07));
  const inBand = (x, y) => x < band || y < band || x >= w - band || y >= h - band;
  let n = 0;
  const mean = [0, 0, 0];
  let grad = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      if (!inBand(x, y)) continue;
      n++;
      for (let c = 0; c < 3; c++) {
        mean[c] += at(x, y, c);
        grad += Math.abs(at(x + 1, y, c) - at(x, y, c)) + Math.abs(at(x, y + 1, c) - at(x, y, c));
      }
    }
  }
  for (let c = 0; c < 3; c++) mean[c] /= n;
  grad /= n * 6;
  let varSum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inBand(x, y)) continue;
      for (let c = 0; c < 3; c++) varSum += (at(x, y, c) - mean[c]) ** 2;
    }
  }
  const std = Math.sqrt(varSum / (n * 3));
  // Smooth falloff and vignettes are still "plain": judge by local texture, not spread.
  const plain = grad < 5.5 && std < 60;
  const busy = grad > 9;

  // Background model: blend the border band's colour along each row and column, so
  // gradients and vignettes are predicted rather than mistaken for the subject.
  const edgeAvg = (x0, x1, y0, y1) => {
    const m = [0, 0, 0];
    let k = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, k++) for (let c = 0; c < 3; c++) m[c] += at(x, y, c);
    return m.map((v) => v / Math.max(1, k));
  };
  const L = [], R = [], T = [], B = [];
  for (let y = 0; y < h; y++) {
    L.push(edgeAvg(0, band, y, y + 1));
    R.push(edgeAvg(w - band, w, y, y + 1));
  }
  for (let x = 0; x < w; x++) {
    T.push(edgeAvg(x, x + 1, 0, band));
    B.push(edgeAvg(x, x + 1, h - band, h));
  }
  const bg = (x, y, c) => {
    const fx = x / (w - 1), fy = y / (h - 1);
    return 0.5 * (L[y][c] * (1 - fx) + R[y][c] * fx) + 0.5 * (T[x][c] * (1 - fy) + B[x][c] * fy);
  };

  // Subject: pixels that differ clearly from the predicted background.
  const thresh = Math.max(28, grad * 4);
  const rows = new Uint32Array(h), cols = new Uint32Array(w);
  let fg = 0, lum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(at(x, y, 0) - bg(x, y, 0), at(x, y, 1) - bg(x, y, 1), at(x, y, 2) - bg(x, y, 2));
      lum += 0.2126 * at(x, y, 0) + 0.7152 * at(x, y, 1) + 0.0722 * at(x, y, 2);
      if (d > thresh) {
        fg++;
        rows[y]++;
        cols[x]++;
      }
    }
  }
  lum /= w * h;
  const span = (arr, len, min) => {
    let a = 0, b = len - 1;
    while (a < len && arr[a] < min) a++;
    while (b > a && arr[b] < min) b--;
    return [a, b];
  };
  const [x0, x1] = span(cols, w, Math.max(1, h * 0.03));
  const [y0, y1] = span(rows, h, Math.max(1, w * 0.03));
  const found = fg > w * h * 0.02 && x1 > x0 && y1 > y0;
  const fill = found ? ((x1 - x0 + 1) * (y1 - y0 + 1)) / (w * h) : 0;
  // Does the object cross the left, right or top edge? Walk 2 px inside each edge and
  // look for sharp departures from a smoothed version of that line (gradients are smooth).
  const luma = (x, y) => 0.2126 * at(x, y, 0) + 0.7152 * at(x, y, 1) + 0.0722 * at(x, y, 2);
  const jumpy = (get, len) => {
    const v = Array.from({ length: len }, (_, i) => get(i));
    const r = Math.max(3, Math.round(len * 0.08));
    let hits = 0;
    for (let i = 0; i < len; i++) {
      let sum = 0, k = 0;
      for (let j = Math.max(0, i - r); j <= Math.min(len - 1, i + r); j++, k++) sum += v[j];
      if (Math.abs(v[i] - sum / k) > 22) hits++;
    }
    return hits / len > 0.04;
  };
  const touches = [jumpy((y) => luma(1, y), h), jumpy((y) => luma(w - 2, y), h), jumpy((x) => luma(x, 1), w)].filter(Boolean).length;

  const checks = [];
  if (plain) checks.push({ level: 'ok', title: 'Plain background', detail: 'Easy for the AI to cut out the object.' });
  else if (busy) checks.push({ level: 'bad', title: 'Busy background', detail: 'Looks like a scene. The AI keeps only the main object.' });
  else checks.push({ level: 'warn', title: 'Some background detail', detail: 'The AI removes it automatically; a plainer one is safer.' });

  if (!found || busy) {
    checks.push({ level: 'warn', title: 'No single clear object', detail: 'One object, seen whole, gives the best model.' });
  } else if (touches >= 1) {
    checks.push({ level: 'warn', title: 'Object touches the edge', detail: 'Parts outside the photo will be guessed or missing.' });
  } else if (fill < 0.12) {
    checks.push({ level: 'warn', title: 'Object is small', detail: 'Crop closer so it fills more of the frame.' });
  } else {
    checks.push({ level: 'ok', title: 'Object fully in frame', detail: 'Seen whole and a good size in the picture.' });
  }

  const minSide = Math.min(original.width, original.height);
  if (minSide >= 512) checks.push({ level: 'ok', title: 'Sharp enough', detail: `${original.width}×${original.height} pixels.` });
  else if (minSide >= 256) checks.push({ level: 'warn', title: 'Low resolution', detail: `${original.width}×${original.height}; fine detail may be lost.` });
  else checks.push({ level: 'bad', title: 'Very small image', detail: `${original.width}×${original.height}; use a larger photo.` });

  if (lum < 45) checks.push({ level: 'warn', title: 'Very dark', detail: 'Brighter, even lighting gives cleaner textures.' });

  const sceneLike = busy && (!found || fill > 0.85);
  const bad = checks.some((c) => c.level === 'bad');
  const warn = checks.some((c) => c.level === 'warn');
  let verdict;
  if (sceneLike) {
    verdict = { level: 'bad', html: '<b>This looks like a scene, not an object.</b> You can still try, but a depth relief usually suits scenes better.' };
  } else if (bad) {
    verdict = { level: 'bad', html: '<b>Might not turn out well.</b> See the notes above.' };
  } else if (warn) {
    verdict = { level: 'warn', html: '<b>Should work.</b> The notes above can make the model better.' };
  } else {
    verdict = { level: 'ok', html: '<b>Looks great for 3D.</b> One clear object on a plain background.' };
  }
  return { checks, verdict, sceneLike, stats: { busy, found, fill, touches, grad } };
}
