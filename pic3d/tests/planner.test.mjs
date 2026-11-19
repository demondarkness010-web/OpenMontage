// Regression test for the AI 3D plan (src/planner.js):  node tests/planner.test.mjs
// Fixed analyses of objects that once went wrong; each must keep getting the right engine.
import { facts, makePlan } from '../src/planner.js';

const base = {
  style: 'stylized', medium: 'photo', materials: [], colors: ['red', 'black'], finish: 'matte', symmetry: 'left-right',
  view: 'three-quarter', back: 'plain', underside: 'flat', thin_parts: false, open_frame: false, transparent: false,
  fine_texture: false, hard_surface: false, complexity: 'medium', flat: false, size_cm: 20, depth_cm: 10, problems: [], cut_off: [],
};
const cases = [
  // The wire cart went to SF3D once and came out as a solid box: thin bars need TRELLIS.
  { name: 'wire cart', a: { ...base, object: 'pink shopping cart', category: 'other' }, engine: /^trellis/ },
  // A vinyl record is flat: the on-device extruder, not an AI blob.
  { name: 'vinyl record', a: { ...base, object: 'vinyl record', category: 'product', flat: true, symmetry: 'radial' }, engine: 'flat' },
  // "figurine" once made the owl a character.
  { name: 'owl figurine', a: { ...base, object: 'ceramic owl figurine', category: 'sculpture' }, engine: 'sf3d', notAlt: true },
  { name: 'toy robot', a: { ...base, object: 'red toy robot', category: 'toy' }, engine: 'sf3d' },
  {
    name: 'drawn character',
    a: { ...base, object: 'elven prince', category: 'character', medium: 'drawing', thin_parts: true, complexity: 'complex', fine_texture: true, problems: ['odd angle'], cut_off: ['right'] },
    engine: /^trellis/, alt: 'flat', warn: /edge/,
  },
  // The cloister courtyard is a scene: depth relief, not a 3D object.
  {
    name: 'courtyard scene',
    a: { ...base, object: 'cloister courtyard', category: 'scene', complexity: 'complex' },
    altTab: 'relief',
  },
  // The garden conservatory: the AI named one pot ("stone planter", furniture) but noted the busy
  // background, and the on-device check saw no single object. That is a scene.
  {
    name: 'garden (AI said planter)',
    a: { ...base, object: 'stone planter', category: 'furniture', problems: ['busy background'], photo_scene: true, description: 'A medium-sized stone planter with plants.' },
    altTab: 'relief',
  },
  // Same AI notes, but the pixels show one clear object: stays an object.
  {
    name: 'planter on busy bg',
    a: { ...base, object: 'stone planter', category: 'furniture', problems: ['busy background'], photo_scene: false },
    engine: /^(sf3d|trellis)/, notAlt: false, notScene: true,
  },
];

let failed = 0;
for (const c of cases) {
  const f = facts(c.a);
  const p = makePlan(c.a, f, { hfToken: true, currentEngine: 'sf3d' });
  const problems = [];
  if (c.altTab && !f.scene) problems.push('not seen as a scene');
  if (c.notScene && (f.scene || p.alt?.tab === 'relief')) problems.push('wrongly seen as a scene');
  if (c.engine && !(c.engine instanceof RegExp ? c.engine.test(p.engine) : p.engine === c.engine)) problems.push(`engine ${p.engine}`);
  if (c.alt && p.alt?.engine !== c.alt) problems.push(`alt ${JSON.stringify(p.alt)}`);
  if (c.altTab && p.alt?.tab !== c.altTab) problems.push(`alt ${JSON.stringify(p.alt)}`);
  if (c.notAlt && p.alt) problems.push(`unexpected alt ${JSON.stringify(p.alt)}`);
  if (c.warn && !p.warnings.some((w) => c.warn.test(w))) problems.push(`missing warning ${c.warn}`);
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${c.name.padEnd(16)} ${p.engine}${problems.length ? ` · ${problems.join(', ')}` : ''}`);
  failed += problems.length > 0;
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
