// Depth-map processing and relief geometry. Pure functions, no DOM except the
// colormap canvas helper.
import * as THREE from 'three';

/** @typedef {{ data: Float32Array, width: number, height: number }} DepthMap */

/**
 * Separable box blur run twice (close to a Gaussian). Radius is in depth pixels.
 * @param {DepthMap} src
 * @param {number} radius
 * @returns {DepthMap}
 */
export function smoothDepth(src, radius) {
  const r = Math.round(radius);
  if (r < 1) return src;
  const { width: w, height: h } = src;
  let a = Float32Array.from(src.data);
  let b = new Float32Array(a.length);
  for (let pass = 0; pass < 2; pass++) {
    boxPass(a, b, w, h, r, 1, w); // horizontal
    boxPass(b, a, h, w, r, w, 1); // vertical
  }
  return { data: a, width: w, height: h };
}

// Blur `lines` lines of length `len`; `step` walks along a line, `stride` jumps between lines.
function boxPass(src, dst, len, lines, r, step, stride) {
  const norm = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * stride;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[base + clamp(k, 0, len - 1) * step];
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = acc * norm;
      acc += src[base + Math.min(i + r + 1, len - 1) * step] - src[base + Math.max(i - r, 0) * step];
    }
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Bilinear sample at normalized (u, v), v = 0 at the image top. */
function sample(map, u, v) {
  const x = u * (map.width - 1);
  const y = v * (map.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, map.width - 1), y1 = Math.min(y0 + 1, map.height - 1);
  const fx = x - x0, fy = y - y0;
  const d = map.data, w = map.width;
  const top = d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx;
  const bot = d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx;
  return top * (1 - fy) + bot * fy;
}

/**
 * Build a displaced grid from a depth map. Depth runs along z in [-0.5, 0.5] so the
 * caller controls strength with object scale.z (no rebuild needed).
 *
 * @param {DepthMap} depth normalized 0..1, 1 = nearest
 * @param {{ aspect: number, segments: number, curve: number, edgeCut: number,
 *           invert: boolean, solid: boolean, thickness: number }} o
 */
export function buildRelief(depth, o) {
  const W = o.aspect >= 1 ? 2 : 2 * o.aspect;
  const H = W / o.aspect;
  const nx = Math.max(2, o.aspect >= 1 ? o.segments : Math.round(o.segments * o.aspect));
  const ny = Math.max(2, Math.round(nx / o.aspect));
  const cols = nx + 1, rows = ny + 1;
  const count = cols * rows;

  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const z01 = new Float32Array(count);

  for (let iy = 0; iy < rows; iy++) {
    const v = iy / ny;
    for (let ix = 0; ix < cols; ix++) {
      const u = ix / nx;
      const i = iy * cols + ix;
      let d = sample(depth, u, v);
      if (o.invert) d = 1 - d;
      d = Math.pow(clamp(d, 0, 1), o.curve);
      z01[i] = d;
      pos[i * 3] = -W / 2 + u * W;
      pos[i * 3 + 1] = H / 2 - v * H;
      pos[i * 3 + 2] = d - 0.5;
      uv[i * 2] = u;
      uv[i * 2 + 1] = 1 - v;
    }
  }

  // Surface triangles. Quads that straddle a sharp depth step are dropped
  // ("edge tearing") so silhouettes separate instead of smearing.
  const cut = o.edgeCut > 0 ? 0.3 - 0.27 * o.edgeCut : Infinity;
  const surface = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iy * cols + ix, b = a + cols, c = b + 1, d = a + 1;
      if (cut !== Infinity) {
        const za = z01[a], zb = z01[b], zc = z01[c], zd = z01[d];
        if (Math.max(za, zb, zc, zd) - Math.min(za, zb, zc, zd) > cut) continue;
      }
      surface.push(a, b, d, b, c, d);
    }
  }

  let positions = pos, uvs = uv;
  const index = surface;
  const groups = [{ start: 0, count: surface.length, materialIndex: 0 }];

  if (o.solid) {
    // Side walls + back plate, on their own vertices so normals stay crisp.
    const back = -0.5 - Math.max(0.02, o.thickness);
    const ring = [];
    for (let ix = 0; ix < nx; ix++) ring.push(ny * cols + ix);              // bottom edge, left → right
    for (let iy = ny; iy > 0; iy--) ring.push(iy * cols + nx);              // right edge, bottom → top
    for (let ix = nx; ix > 0; ix--) ring.push(ix);                          // top edge, right → left
    for (let iy = 0; iy < ny; iy++) ring.push(iy * cols);                   // left edge, top → bottom
    // 4 per wall quad, then the back: one copy of each ring point plus a centre point.
    const extra = new Float32Array((ring.length * 5 + 1) * 3);
    const extraUv = new Float32Array((ring.length * 5 + 1) * 2);
    let k = count;
    const sideStart = index.length;
    for (let r = 0; r < ring.length; r++) {
      const p = ring[r], q = ring[(r + 1) % ring.length];
      const base = (k - count) * 3;
      const set = (slot, src, z) => {
        extra[base + slot * 3] = pos[src * 3];
        extra[base + slot * 3 + 1] = pos[src * 3 + 1];
        extra[base + slot * 3 + 2] = z;
      };
      set(0, p, pos[p * 3 + 2]);
      set(1, q, pos[q * 3 + 2]);
      set(2, q, back);
      set(3, p, back);
      index.push(k, k + 3, k + 1, k + 1, k + 3, k + 2);
      k += 4;
    }
    // Back plate as a fan through the same points the walls end on. A single big quad here
    // touched the walls' bottom edges without sharing them: the solid was not closed
    // (Blender measured 1,204 open edges and 400 "self-intersections" along that seam).
    const centre = k + ring.length;
    for (let r = 0; r < ring.length; r++) {
      const p = ring[r];
      extra.set([pos[p * 3], pos[p * 3 + 1], back], (k + r - count) * 3);
      index.push(centre, k + ((r + 1) % ring.length), k + r); // clockwise from the front = faces back
    }
    extra.set([0, 0, back], (centre - count) * 3);
    k = centre + 1;
    groups.push({ start: sideStart, count: index.length - sideStart, materialIndex: 1 });

    positions = new Float32Array(pos.length + extra.length);
    positions.set(pos);
    positions.set(extra, pos.length);
    uvs = new Float32Array(uv.length + extraUv.length);
    uvs.set(uv);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  for (const g of groups) geometry.addGroup(g.start, g.count, g.materialIndex);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return {
    geometry,
    size: { width: W, height: H },
    spacing: W / nx,
    surfaceVertices: count,
    triangles: index.length / 3,
  };
}

// Turbo colormap, polynomial fit (Mikhailov, Google 2019).
function turbo(x) {
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return [clamp(r, 0, 1) * 255, clamp(g, 0, 1) * 255, clamp(b, 0, 1) * 255];
}

/**
 * Render a depth map to a canvas, either as a Turbo heatmap or plain grayscale.
 * @param {DepthMap} depth
 * @param {'turbo' | 'gray'} palette
 */
export function depthToCanvas(depth, palette = 'turbo') {
  const canvas = document.createElement('canvas');
  canvas.width = depth.width;
  canvas.height = depth.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(depth.width, depth.height);
  const px = img.data;
  for (let i = 0; i < depth.data.length; i++) {
    const v = clamp(depth.data[i], 0, 1);
    if (palette === 'gray') {
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v * 255;
    } else {
      const [r, g, b] = turbo(v);
      px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b;
    }
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
