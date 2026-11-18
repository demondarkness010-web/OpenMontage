// Cloud image-to-3D engines: free ones on Hugging Face Spaces, paid ones on fal.ai. Each engine declares its option
// controls, how they map to the provider payload, and the price per run.
// Prices checked 2026-11-12 on fal.ai; confirm there before relying on them.

/**
 * Option control types:
 *   seg:    { key, label, choices: [[value, label, extraCost?]] }
 *   toggle: { key, label, extra? (cost when on) }
 *   range:  { key, label, min, max, step, format }
 * `when` hides a control unless another option has a given value.
 */
export const ENGINES = {
  // ---- Free: open-source models on Hugging Face Spaces (shared ZeroGPU daily quota).
  // `gpu` is how much of that quota a run reserves: light < medium < heavy.
  sf3d: {
    name: 'Stable Fast 3D',
    vendor: 'Stability AI',
    free: true,
    badge: 'Fastest',
    gpu: 'light',
    blurb: 'Textured in seconds · lightest on free GPU time',
    eta: 'about 15 s',
    defaults: { texture: '1024', remesh: 'None' },
    controls: [
      { type: 'seg', key: 'texture', label: 'Texture', choices: [['512', '512'], ['1024', '1K'], ['2048', '2K']] },
      { type: 'seg', key: 'remesh', label: 'Remesh', choices: [['None', 'Off'], ['Triangle', 'Tris'], ['Quad', 'Quads']] },
    ],
    payload: (o) => ({ texture_size: Number(o.texture), remesh: o.remesh }),
    cost: () => 0,
  },
  trellis2: {
    name: 'TRELLIS.2',
    vendor: 'Microsoft',
    free: true,
    badge: 'Best quality',
    gpu: 'heavy',
    blurb: 'Detailed textured model · uses the most GPU time',
    eta: 'about 1 to 2 min',
    defaults: { resolution: '512', texture: '2048', faces: 300000 },
    controls: [
      { type: 'seg', key: 'resolution', label: 'Detail', choices: [['512', 'Standard'], ['1024', 'High']] },
      { type: 'seg', key: 'texture', label: 'Texture', choices: [['1024', '1K'], ['2048', '2K']] },
      { type: 'range', key: 'faces', label: 'Faces', min: 50000, max: 500000, step: 10000, format: k },
    ],
    payload: (o) => ({ resolution: o.resolution, texture_size: Number(o.texture), faces: o.faces }),
    cost: () => 0,
  },
  trellis: {
    name: 'TRELLIS',
    vendor: 'Microsoft',
    free: true,
    gpu: 'medium',
    blurb: 'Textured · dependable all-rounder',
    eta: 'about 1 min',
    defaults: { steps: '12', texture: '1024', simplify: 0.95 },
    controls: [
      { type: 'seg', key: 'steps', label: 'Detail', choices: [['12', 'Standard'], ['25', 'High']] },
      { type: 'seg', key: 'texture', label: 'Texture', choices: [['512', '512'], ['1024', '1K'], ['2048', '2K']] },
      { type: 'range', key: 'simplify', label: 'Simplify', min: 0.9, max: 0.98, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
    ],
    payload: (o) => ({ steps: Number(o.steps), texture_size: Number(o.texture), simplify: o.simplify }),
    cost: () => 0,
  },
  hunyuan21: {
    name: 'Hunyuan3D-2.1',
    vendor: 'Tencent',
    free: true,
    gpu: 'medium',
    blurb: 'Shape only (no texture) · very detailed',
    eta: 'about 30 s',
    defaults: { octree: '256', rembg: true },
    controls: [
      { type: 'seg', key: 'octree', label: 'Detail', choices: [['256', 'Standard'], ['384', 'High']] },
      { type: 'toggle', key: 'rembg', label: 'Remove background' },
    ],
    payload: (o) => ({ octree: Number(o.octree), rembg: o.rembg }),
    cost: () => 0,
  },
  triposg: {
    name: 'TripoSG',
    vendor: 'VAST',
    free: true,
    gpu: 'medium',
    blurb: 'Shape only · sharp, clean geometry',
    eta: 'about 1 min',
    defaults: { faces: 100000 },
    controls: [{ type: 'range', key: 'faces', label: 'Faces', min: 20000, max: 200000, step: 10000, format: k }],
    payload: (o) => ({ faces: o.faces }),
    cost: () => 0,
  },
  hy2mini: {
    name: 'Hunyuan3D-2mini Turbo',
    vendor: 'Tencent',
    free: true,
    gpu: 'medium',
    blurb: 'Shape only · 5-step turbo',
    eta: 'about 20 s',
    defaults: { octree: '256', rembg: true },
    controls: [
      { type: 'seg', key: 'octree', label: 'Detail', choices: [['196', 'Fast'], ['256', 'Standard'], ['384', 'High']] },
      { type: 'toggle', key: 'rembg', label: 'Remove background' },
    ],
    payload: (o) => ({ octree: Number(o.octree), rembg: o.rembg }),
    cost: () => 0,
  },
  instantmesh: {
    name: 'InstantMesh',
    vendor: 'Tencent ARC',
    free: true,
    gpu: 'medium',
    blurb: 'Textured · builds from 6 generated views · very fast',
    eta: 'about 25 s',
    defaults: { steps: 75, rembg: true },
    controls: [
      { type: 'range', key: 'steps', label: 'View detail', min: 30, max: 100, step: 5, format: (v) => `${v} steps` },
      { type: 'toggle', key: 'rembg', label: 'Remove background' },
    ],
    payload: (o) => ({ steps: o.steps, rembg: o.rembg }),
    cost: () => 0,
  },
  hunyuan2: {
    name: 'Hunyuan3D-2',
    vendor: 'Tencent',
    free: true,
    gpu: 'heavy',
    blurb: 'Textured · shape + full texture pass · the most-used free engine',
    eta: 'about 1 to 2 min',
    defaults: { octree: '256', rembg: true },
    controls: [
      { type: 'seg', key: 'octree', label: 'Detail', choices: [['256', 'Standard'], ['384', 'High']] },
      { type: 'toggle', key: 'rembg', label: 'Remove background' },
    ],
    payload: (o) => ({ octree: Number(o.octree), rembg: o.rembg }),
    cost: () => 0,
  },
  // ---- On your device: no upload, no GPU quota.
  flat: {
    name: 'Flat object',
    vendor: 'On your device',
    free: true,
    local: true,
    badge: 'Instant',
    blurb: 'Records, coins, plates, cards, posters, standees · keeps every pixel',
    eta: 'about 2 s',
    defaults: { shape: 'auto', thickness: 0.02, back: 'plain', stand: 'none' },
    controls: [
      { type: 'seg', key: 'shape', label: 'Outline', choices: [['auto', 'Auto'], ['round', 'Round'], ['cutout', 'Cut out'], ['card', 'Card']] },
      { type: 'range', key: 'thickness', label: 'Thickness', min: 0.004, max: 0.15, step: 0.002, format: (v) => `${(v * 100).toFixed(1)}%` },
      { type: 'seg', key: 'back', label: 'Back', choices: [['plain', 'Plain'], ['mirror', 'Same picture']] },
      { type: 'seg', key: 'stand', label: 'Stand', choices: [['none', 'None'], ['base', 'Base']] },
    ],
    payload: (o) => ({ ...o }),
    cost: () => 0,
  },
  // ---- Paid: commercial models via fal.ai
  hunyuan: {
    name: 'Hunyuan3D 3.1 Pro',
    vendor: 'Tencent',
    blurb: 'Most faithful shape and fine detail',
    eta: '1 to 3 min',
    defaults: { texture: 'Normal', pbr: false, customFaces: false, faces: 500000 },
    controls: [
      { type: 'seg', key: 'texture', label: 'Output', choices: [['Normal', 'Textured'], ['Geometry', 'Shape only']] },
      { type: 'toggle', key: 'pbr', label: 'PBR materials', extra: 0.15, when: ['texture', 'Normal'] },
      { type: 'toggle', key: 'customFaces', label: 'Custom face count', extra: 0.15 },
      { type: 'range', key: 'faces', label: 'Faces', min: 40000, max: 1500000, step: 10000, format: k, when: ['customFaces', true] },
    ],
    payload: (o) => ({
      generate_type: o.texture,
      enable_pbr: o.texture === 'Normal' && o.pbr,
      ...(o.customFaces ? { face_count: o.faces } : {}),
    }),
    cost: (o) => 0.375 + (o.texture === 'Normal' && o.pbr ? 0.15 : 0) + (o.customFaces ? 0.15 : 0),
  },
  tripo: {
    name: 'Tripo H3.1',
    vendor: 'Tripo AI',
    blurb: 'Fast, clean topology, game-ready',
    eta: 'about 1 min',
    defaults: { texture: 'standard', pbr: true, geometry: 'standard', quad: false },
    controls: [
      { type: 'seg', key: 'texture', label: 'Texture', choices: [['none', 'None'], ['standard', 'Standard'], ['detailed', 'HD']] },
      { type: 'toggle', key: 'pbr', label: 'PBR materials', when: ['texture', '!none'] },
      { type: 'seg', key: 'geometry', label: 'Geometry', choices: [['standard', 'Standard'], ['detailed', 'Detailed']] },
      { type: 'toggle', key: 'quad', label: 'Quad mesh', extra: 0.05 },
    ],
    payload: (o) => ({
      texture: o.texture !== 'none',
      pbr: o.texture !== 'none' && o.pbr,
      ...(o.texture !== 'none' ? { texture_quality: o.texture } : {}),
      geometry_quality: o.geometry,
      quad: o.quad,
    }),
    cost: (o) =>
      ({ none: 0.2, standard: 0.3, detailed: 0.4 })[o.texture] + (o.geometry === 'detailed' ? 0.2 : 0) + (o.quad ? 0.05 : 0),
  },
  meshy: {
    name: 'Meshy 7.1',
    vendor: 'Meshy',
    blurb: 'Polished textures, controllable polycount',
    eta: '2 to 4 min',
    defaults: { texture: true, pbr: false, polycount: 30000, topology: 'triangle', symmetry: 'auto' },
    controls: [
      { type: 'toggle', key: 'texture', label: 'Texture', extra: 0.4 },
      { type: 'toggle', key: 'pbr', label: 'PBR materials', when: ['texture', true] },
      { type: 'range', key: 'polycount', label: 'Polycount', min: 1000, max: 300000, step: 1000, format: k },
      { type: 'seg', key: 'topology', label: 'Topology', choices: [['triangle', 'Triangles'], ['quad', 'Quads']] },
      { type: 'seg', key: 'symmetry', label: 'Symmetry', choices: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']] },
    ],
    payload: (o) => ({
      should_texture: o.texture,
      enable_pbr: o.texture && o.pbr,
      target_polycount: o.polycount,
      topology: o.topology,
      symmetry_mode: o.symmetry,
    }),
    cost: (o) => (o.texture ? 1.2 : 0.8),
  },
};

function k(v) {
  return v >= 1e6 ? `${(v / 1e6).toFixed(2).replace(/\.?0+$/, '')}M` : `${Math.round(v / 1000)}k`;
}

export function isVisible(control, opts) {
  if (!control.when) return true;
  const [key, want] = control.when;
  if (typeof want === 'string' && want.startsWith('!')) return opts[key] !== want.slice(1);
  return opts[key] === want;
}

export const money = (v) => (v === 0 ? 'Free' : `$${v.toFixed(Math.round(v * 1000) % 10 ? 3 : 2)}`);
