// "Flat object" engine: records, coins, plates, cards, posters, stickers. Image-to-3D models
// guess depth and inflate flat things into blobs, so instead this cuts the object out of the
// photo, finds its outline (a true circle when it's round), and extrudes it to a realistic
// thickness. The front keeps every pixel of the photo. Runs in the browser in about a second.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const MASK_MAX = 512;

/**
 * Find the object in the photo.
 * @returns {{ mask: Uint8Array, w: number, h: number, cut: boolean, circle: object|null,
 *             edge: number[], body: number[], area: number }}
 */
export function cutout(canvas, { erodePx = 2 } = {}) {
  const s = Math.min(1, MASK_MAX / Math.max(canvas.width, canvas.height));
  const w = Math.max(8, Math.round(canvas.width * s));
  const h = Math.max(8, Math.round(canvas.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const at = (i) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // Background = the colour around the border, if the border is mostly one colour.
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const median = (idx) => [0, 1, 2].map((k) => {
    const v = idx.map((i) => px[i * 4 + k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  const bg = median(border);
  const TOL = 42;
  const plain = border.filter((i) => dist(at(i), bg) < TOL).length / border.length > 0.75;

  let mask = new Uint8Array(n).fill(1);
  if (plain) {
    // Flood the background in from the edges. Holes inside the object stay solid.
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    for (const i of border) {
      if (mask[i] && dist(at(i), bg) < TOL) {
        mask[i] = 0;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || !mask[j]) continue;
        if (dist(at(j), bg) < TOL) {
          mask[j] = 0;
          queue[tail++] = j;
        }
      }
    }
    mask = largestComponent(mask, w, h);
    mask = erode(mask, w, h, erodePx); // drop the light halo photos have around cut-out objects
  }
  let area = 0;
  for (let i = 0; i < n; i++) area += mask[i];
  const cut = plain && area > n * 0.03;
  if (!cut) mask.fill(1), (area = n); // busy background: treat the whole photo as a card

  // Round? Compare the outline's area with the circle that fits its bounding box.
  let minX = w, maxX = 0, minY = h, maxY = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sx += x;
    sy += y;
  }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const r = (bw + bh) / 4;
  const roundish = cut && Math.abs(bw - bh) / Math.max(bw, bh) < 0.05 && Math.abs(area / (Math.PI * r * r) - 1) < 0.06;
  // Trim a little off a round outline: photos of round things usually have a bright rim
  // highlight or outline that would show as a pale ring.
  const circle = roundish ? { cx: sx / area + 0.5, cy: sy / area + 0.5, r: r * 0.985 } : null;

  // Colours for the parts the photo can't show. The rim takes the colour a little way in from
  // the outline (the outline itself is often a highlight); the plain back takes the most common.
  const in4 = erode(mask, w, h, 4), in10 = erode(in4, w, h, 6);
  const ring = [], inside = [];
  for (let i = 0; i < n; i++) {
    if (in4[i] && !in10[i]) ring.push(i);
    else if (mask[i] && i % 3 === 0) inside.push(i);
  }
  const body = dominant(px, inside.length ? inside : ring);
  return { mask, w, h, cut, circle, edge: ring.length > 20 ? median(ring) : body, body, area, px, bg, TOL };
}

/**
 * How see-through the object is, from the photo alone. A wire cart, chair or cage shows the
 * background through many small gaps, each boxed in by bars; a solid object shows none (or one
 * big hole, like a ring or a record's centre). So: count background-coloured pockets inside the
 * object. Needs a plain background; returns null otherwise.
 */
export function openness(canvas) {
  const { mask, w, h, cut, area, px, bg, TOL } = cutout(canvas, { erodePx: 0 });
  if (!cut) return null;
  const n = w * h;
  const pocket = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const d = Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2]);
    if (d < TOL) pocket[i] = 1;
  }
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let holes = 0, holeArea = 0;
  for (let s = 0; s < n; s++) {
    if (!pocket[s] || seen[s]) continue;
    let head = 0, tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || !pocket[j] || seen[j]) continue;
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
    if (tail >= 6) {
      holes++;
      holeArea += tail;
    }
  }
  // Many pockets AND a real share of the area: white flowers painted on a record are many small
  // background-coloured patches too, but they cover ~2% of it; a wire cart's gaps cover ~30%.
  const holeShare = holeArea / area;
  return { holes, holeShare, open: holes >= 10 && holeShare >= 0.08 };
}

function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let best = 0, bestSize = 0, next = 0;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    next++;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = s;
    label[s] = next;
    while (head < tail) {
      const i = queue[head++];
      size++;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= mask.length || !mask[j] || label[j]) continue;
        label[j] = next;
        queue[tail++] = j;
      }
    }
    if (size > bestSize) (bestSize = size), (best = next);
  }
  return Uint8Array.from(label, (l) => (l === best ? 1 : 0));
}

function erode(mask, w, h, times) {
  let m = mask;
  for (let t = 0; t < times; t++) {
    const out = new Uint8Array(m.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        out[i] = m[i] & m[i - 1] & m[i + 1] & m[i - w] & m[i + w];
      }
    }
    m = out;
  }
  return m;
}

/** Most common colour (coarse 4-bit bins), for a plain back that matches the object. */
function dominant(px, idx) {
  const bins = new Map();
  for (const i of idx) {
    const key = ((px[i * 4] >> 4) << 8) | ((px[i * 4 + 1] >> 4) << 4) | (px[i * 4 + 2] >> 4);
    const b = bins.get(key) ?? [0, 0, 0, 0];
    b[0] += px[i * 4];
    b[1] += px[i * 4 + 1];
    b[2] += px[i * 4 + 2];
    b[3]++;
    bins.set(key, b);
  }
  let top = [128, 128, 128, 1];
  for (const b of bins.values()) if (b[3] > top[3]) top = b;
  return [top[0] / top[3], top[1] / top[3], top[2] / top[3]];
}

/** Outline of the mask as a closed polygon (Moore-neighbour tracing), in mask pixels. */
function trace(mask, w, h) {
  let start = mask.indexOf(1);
  if (start < 0) return [];
  const dirs = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const dirOf = (dx, dy) => dirs.findIndex(([a, b]) => a === dx && b === dy);
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const sx = start % w, sy = (start / w) | 0;
  const pts = [[sx, sy]];
  let x = sx, y = sy, back = 0; // the first pixel in raster order always has background to its west
  for (let guard = 0; guard < w * h * 4; guard++) {
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      const nx = x + dirs[d][0], ny = y + dirs[d][1];
      if (!inside(nx, ny)) continue;
      const p = (back + k - 1) % 8;
      back = dirOf(x + dirs[p][0] - nx, y + dirs[p][1] - ny);
      x = nx;
      y = ny;
      moved = true;
      break;
    }
    if (!moved || (x === sx && y === sy)) break;
    pts.push([x, y]);
  }
  return pts;
}

/** Douglas-Peucker on a closed outline, after a light smoothing pass to remove pixel steps. */
function simplify(pts, eps) {
  if (pts.length < 8) return pts;
  const sm = pts.map((_, i) => {
    let ax = 0, ay = 0;
    for (let k = -2; k <= 2; k++) {
      const q = pts[(i + k + pts.length) % pts.length];
      ax += q[0];
      ay += q[1];
    }
    return [ax / 5, ay / 5];
  });
  const dp = (a, b, out) => {
    let far = -1, best = eps;
    const [x1, y1] = sm[a], [x2, y2] = sm[b];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((x2 - x1) * (y1 - sm[i][1]) - (x1 - sm[i][0]) * (y2 - y1)) / len;
      if (d > best) (best = d), (far = i);
    }
    if (far < 0) return out.push(sm[a]);
    dp(a, far, out);
    dp(far, b, out);
  };
  const half = sm.length >> 1;
  const out = [];
  dp(0, half, out);
  dp(half, sm.length - 1, out);
  return out;
}

const css = (rgb) => new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255).convertSRGBToLinear();

/**
 * Build the flat object.
 * @param canvas  the photo (texture canvas)
 * @param opts    { shape: 'auto'|'round'|'cutout'|'card', thickness: fraction of the longest side,
 *                  back: 'plain'|'mirror', finish?: 'matte'|'glossy'|'metallic'|'mixed' }
 * @returns {Promise<{ glb: Blob, info: { shape: string, triangles: number } }>}
 */
export async function buildFlat(canvas, opts) {
  const cut = cutout(canvas);
  const { w, h } = cut;
  const M = Math.max(w, h);
  let shapeKind = opts.shape === 'auto' ? (cut.circle ? 'round' : cut.cut ? 'cutout' : 'card') : opts.shape;
  if (shapeKind === 'cutout' && !cut.cut) shapeKind = 'card';

  // Outline in "longest side = 1" units, y up.
  const P = (x, y) => new THREE.Vector2(x / M, (h - y) / M);
  let shape;
  if (shapeKind === 'round') {
    const c = cut.circle ?? { cx: w / 2, cy: h / 2, r: Math.min(w, h) / 2 };
    shape = new THREE.Shape().absarc(c.cx / M, (h - c.cy) / M, c.r / M, 0, Math.PI * 2, false);
  } else if (shapeKind === 'cutout') {
    const pts = simplify(trace(cut.mask, w, h), 0.7).map(([x, y]) => P(x + 0.5, y + 0.5));
    if (pts.length < 3) throw new Error('Couldn’t find the object’s outline. Try Card or Round.');
    shape = new THREE.Shape(pts);
  } else {
    shape = new THREE.Shape([P(0, 0), P(w, 0), P(w, h), P(0, h)]);
  }

  const depth = Math.min(0.3, Math.max(0.002, opts.thickness));
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 160, steps: 1 });
  // Caps come first (back lid, then front lid), then the side walls. Give each its own material
  // and map both lids straight onto the photo.
  const capCount = geo.groups.find((g) => g.materialIndex === 0).count;
  geo.clearGroups();
  geo.addGroup(0, capCount / 2, 1); // back (z = 0)
  geo.addGroup(capCount / 2, capCount / 2, 0); // front (z = depth)
  geo.addGroup(capCount, geo.attributes.position.count - capCount, 2); // rim
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < capCount; i++) uv.setXY(i, (pos.getX(i) * M) / w, (pos.getY(i) * M) / h);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const centre = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-centre.x, -centre.y, -centre.z);

  // Texture: the photo, with the background repainted in the rim colour so edges don't glow.
  const tex = document.createElement('canvas');
  const ts = Math.min(1, 2048 / Math.max(canvas.width, canvas.height));
  tex.width = Math.round(canvas.width * ts);
  tex.height = Math.round(canvas.height * ts);
  const tctx = tex.getContext('2d');
  tctx.drawImage(canvas, 0, 0, tex.width, tex.height);
  if (cut.cut) {
    const m = document.createElement('canvas');
    m.width = w;
    m.height = h;
    const mctx = m.getContext('2d');
    const img = mctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      if (cut.mask[i]) continue;
      img.data.set([...cut.edge.map(Math.round), 255], i * 4);
    }
    mctx.putImageData(img, 0, 0);
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(m, 0, 0, tex.width, tex.height);
  }
  const map = new THREE.CanvasTexture(tex);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  map.userData.mimeType = 'image/jpeg'; // keeps the GLB small

  const rough = { glossy: 0.32, metallic: 0.35, mixed: 0.5, matte: 0.8 }[opts.finish] ?? 0.55;
  const metal = opts.finish === 'metallic' ? 0.6 : 0;
  const front = new THREE.MeshStandardMaterial({ name: 'Front', map, roughness: rough, metalness: metal });
  const back = opts.back === 'mirror'
    ? new THREE.MeshStandardMaterial({ name: 'Back', map, roughness: rough, metalness: metal })
    : new THREE.MeshStandardMaterial({ name: 'Back', color: css(cut.body), roughness: rough, metalness: metal });
  const rim = new THREE.MeshStandardMaterial({ name: 'Rim', color: css(cut.edge), roughness: rough, metalness: metal });
  const mesh = new THREE.Mesh(geo, [front, back, rim]);
  mesh.name = 'FlatObject';
  const root = new THREE.Group();
  root.add(mesh);
  let triangles = geo.index ? geo.index.count / 3 : pos.count / 3;

  // Standee: an oval base under the feet, so a cut-out character stands up on a desk.
  let baseGeo = null, baseMat = null;
  if (opts.stand === 'base') {
    const bb = geo.boundingBox; // already moved with the geometry
    const height = bb.max.y - bb.min.y, width = bb.max.x - bb.min.x;
    // Centre it under what touches the ground: the bottom 6% of the outline.
    let lo = cut.h, sum = 0, cnt = 0, minX = cut.w, maxX = 0;
    for (let i = 0; i < cut.w * cut.h; i++) if (cut.mask[i]) lo = Math.min(lo, cut.h - 1 - ((i / cut.w) | 0));
    const band = lo + Math.max(2, Math.round((shapeKind === 'cutout' ? cut.h : 0) * 0.06));
    for (let i = 0; i < cut.w * cut.h; i++) {
      if (!cut.mask[i] || cut.h - 1 - ((i / cut.w) | 0) > band) continue;
      const x = i % cut.w;
      sum += x;
      cnt++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    const footX = cnt ? sum / cnt / M - centre.x : 0;
    const footW = cnt ? (maxX - minX + 1) / M : width;
    const rx = Math.min(width * 0.6, Math.max(footW * 0.65, width * 0.28, height * 0.12));
    const rz = Math.max(height * 0.11, depth * 3);
    const thick = height * 0.025;
    baseGeo = new THREE.CylinderGeometry(1, 1, thick, 96);
    baseGeo.scale(rx, 1, rz);
    // The figure's bottom sits a little way into the base, like a slot.
    baseGeo.translate(footX, bb.min.y + thick * 0.1, 0);
    baseMat = new THREE.MeshStandardMaterial({ name: 'Base', color: 0x26262b, roughness: 0.35 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.name = 'Base';
    root.add(base);
    triangles += baseGeo.index.count / 3;
  }

  const result = await new GLTFExporter().parseAsync(root, { binary: true, maxTextureSize: 2048 });
  geo.dispose();
  baseGeo?.dispose();
  map.dispose();
  [front, back, rim, baseMat].forEach((m) => m?.dispose());
  return {
    glb: new Blob([result], { type: 'model/gltf-binary' }),
    info: { shape: shapeKind, triangles },
  };
}
