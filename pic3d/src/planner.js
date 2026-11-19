// Turns the vision AI's notes about a photo into a 3D plan: which engine to use, with which
// settings, what the model will assume about the sides the camera can't see, and what to
// watch out for. Pure functions, so the plan can be recomputed whenever the user corrects
// one of the AI's assumptions.
import { ENGINES } from './models.js';

/** The facts the user can flip on the plan card, with how each one reads. */
export const FACTS = [
  { key: 'flat', on: 'Flat object', off: 'Full 3D object' },
  { key: 'scene', on: 'Whole scene', off: 'One object' },
  { key: 'character', on: 'Character / figure', off: 'Not a figure' },
  { key: 'colour', on: 'Keep its colours', off: 'Shape only' },
  { key: 'fine_texture', on: 'Fine print / paint detail', off: 'Plain surfaces' },
  { key: 'thin_parts', on: 'Wire / thin bars / gaps', off: 'Solid body' },
  { key: 'hard_surface', on: 'Hard, sharp edges', off: 'Soft, organic shape' },
];

// Standard sizes (longest side, thickness, in cm) for common flat things. The small vision
// model is good at naming objects and poor at guessing their size, so these win when they match.
const KNOWN_SIZES = [
  [/\b(vinyl|lp|record)\b/i, 30, 0.15],
  [/\b(cd|dvd|blu-?ray|compact disc)\b/i, 12, 0.12],
  [/\bcoin\b|medal/i, 2.6, 0.2],
  [/\b(credit|bank|business|playing|trading|id) card\b/i, 8.6, 0.08],
  [/\bplate\b|saucer/i, 26, 1.5],
  [/coaster/i, 10, 0.4],
  [/poster|print|photo(graph)?\b/i, 60, 0.05],
  [/canvas|painting|picture frame/i, 50, 2],
  [/badge|\bpin\b|button/i, 4, 0.3],
  [/phone case/i, 15, 1],
  [/sticker|decal/i, 8, 0.02],
];

/** Real size for the object: a standard one when it's a known flat thing, else the AI's guess. */
export function realSize(a) {
  const known = a.flat ? KNOWN_SIZES.find(([re]) => re.test(a.object)) : null;
  return known ? { size_cm: known[1], depth_cm: known[2], standard: true } : { size_cm: a.size_cm, depth_cm: a.depth_cm, standard: false };
}

// Things that are built from bars, wire or tubes. The vision model often misses this (it called a
// wire shopping cart "no thin parts"), and getting it wrong is costly: Stable Fast 3D fills the
// gaps and turns them into solid blocks.
const OPEN_FRAME = /\b(cart|trolley|bicycle|bike|tricycle|scooter|chair|stool|bench|cage|basket|rack|shelf|stand|tripod|easel|ladder|fence|gate|railing|lamp|chandelier|birdcage|crib|stroller|pram|wheelchair|wire|mesh|grill|frame|skeleton|tower|crane|bridge|swing)s?\b/i;

// People and creature figures. A character with chains, straps or loose hair is not a wire
// frame: it needs the engine that invents a believable back and keeps the pose.
const CHARACTER = /\b(person|people|man|woman|girl|boy|child|kid|lady|guy|warrior|knight|hero|heroine|action figure|doll|anime|manga|elf|elven|dwarf|orc|prince|princess|king|queen|soldier|mage|wizard|witch|sorcerer|ninja|samurai|character|mascot|superhero|villain|god|goddess|angel|demon|fairy|pirate|monk|priest|archer|hunter|dancer|idol|chibi)s?\b/i;

// Places rather than things. The vision model usually says category "scene" for these, but not always.
const SCENE = /\b(landscape|scenery|courtyard|cloister|garden|street|cityscape|skyline|village|town|forest|woods|park|beach|interior|room|plaza|square|alley|harbou?r|valley|panorama|countryside|meadow|field|ruins|grounds)s?\b/i;

/**
 * A place rather than one thing. The AI's word alone is not enough: for a garden conservatory it
 * said "stone planter" (the one pot it could name) yet still noted the busy background. So the
 * on-device photo check counts too: when the pixels show no single object filling the frame
 * (photo_scene) and the AI also saw a busy background or several things, it is a scene.
 */
export function isScene(a) {
  if (a.category === 'scene' || SCENE.test(a.object)) return true;
  if (!a.photo_scene) return false;
  const notes = (a.problems || []).join(' ');
  return /busy|cluttered|several|multiple|many objects|background/i.test(notes) || SCENE.test(a.description || '');
}

export function isCharacter(a) {
  return a.category === 'character' || CHARACTER.test(a.object);
}

/** Is this made of bars, wire or mesh with see-through gaps? AI, object name or the pixels say so. */
export function isOpenFrame(a) {
  return !!(a.open_frame || a.thin_parts || a.see_through || OPEN_FRAME.test(a.object));
}

/** The AI's notes plus the user's corrections, in one object. */
export function facts(analysis, overrides = {}) {
  const a = analysis;
  const colourful = a.colors.length > 1 || a.fine_texture || !['sculpture'].includes(a.category);
  const character = 'character' in overrides ? overrides.character : isCharacter(a);
  return {
    scene: isScene(a), // overrides.scene (spread below) wins when the user taps the chip
    colour: colourful,
    character,
    drawing: a.medium === 'drawing',
    fine_texture: a.fine_texture,
    thin_parts: character ? !!a.open_frame : isOpenFrame(a),
    hard_surface: a.hard_surface,
    complexity: a.complexity,
    flat: !!a.flat,
    ...overrides,
  };
}

/**
 * @param analysis   normalized result of /api/analyze
 * @param f          facts(analysis, overrides)
 * @param ctx        { hfToken, quotaLow, quotaLeft, quotaAt, currentEngine }
 * @returns {{ engine: string, opts: object, why: string[], assumptions: string[][], warnings: string[] }}
 */
export function makePlan(analysis, f, ctx) {
  const a = analysis;
  const why = [];
  const complex = f.complexity === 'complex';
  const simple = f.complexity === 'simple';

  // ---- engine. Paid engines are only ever chosen by the user; the plan then tunes them.
  let engine;
  if (!ENGINES[ctx.currentEngine]?.free) {
    engine = ctx.currentEngine;
    why.push(`Keeping your pick, ${ENGINES[engine].name}, and tuning it for this object.`);
  } else if (f.scene) {
    // Only used if they generate anyway: TRELLIS makes the best small diorama of a scene.
    engine = ctx.hfToken ? 'trellis2' : 'trellis';
    why.push(`A whole scene (${a.object}), not one object. AI 3D engines build a single object, so the most this becomes is a small diorama, and most of the picture is lost. A depth relief keeps the whole picture and turns it into 3D on your device, with no GPU time. If you still want to try, ${ENGINES[engine].name} makes the best diorama.`);
  } else if (f.flat) {
    engine = 'flat';
    why.push(`A flat ${a.object}: AI 3D engines inflate flat things into lumpy blobs, so this one is cut out of the photo on your device and given a real thickness. The front keeps every pixel of the photo, and it costs no GPU time.`);
  } else if (!f.colour) {
    engine = f.hard_surface ? 'triposg' : 'hunyuan21';
    why.push(f.hard_surface
      ? 'Shape only with hard edges: TripoSG keeps geometry sharp and clean.'
      : 'Shape only with a soft, organic form: Hunyuan3D-2.1 gives the most surface detail.');
  } else if (f.character) {
    // Before the GPU-time shortcut too: Stable Fast 3D turns a figure into a lumpy doll.
    engine = ctx.hfToken ? 'trellis2' : 'trellis';
    why.push(`A ${f.drawing ? 'drawn ' : ''}character: the body, face, hair and clothes need an engine that keeps the pose and invents a believable back. ${ENGINES[engine].name} is the best free one at that${ctx.hfToken ? '' : ' within the anonymous quota'}.`);
    if (f.drawing) why.push('It\u2019s a drawing, so there\u2019s no real lighting to read depth from: the AI gives the flat art volume, like turning it into a figurine.');
  } else if (f.thin_parts) {
    // Checked before the GPU-time shortcut on purpose: a light engine that fills every gap
    // gives a useless block, which is worse than asking for a bit more GPU time.
    engine = ctx.hfToken ? 'trellis2' : 'trellis';
    why.push(`It's built from thin bars or wire with gaps between them. Stable Fast 3D fills those gaps and makes a solid block, so ${ENGINES[engine].name}, which keeps open structures best.`);
  } else if (ctx.quotaLow) {
    engine = 'sf3d';
    why.push('Free GPU time is low today, so the lightest textured engine, Stable Fast 3D.');
  } else if (complex || f.fine_texture || f.thin_parts) {
    // TRELLIS.2 is the best, but its runs rarely fit an anonymous quota.
    engine = ctx.hfToken ? 'trellis2' : 'trellis';
    const reason = [complex && 'a complex shape', f.fine_texture && 'fine surface detail', f.thin_parts && 'thin parts']
      .filter(Boolean).join(' and ');
    why.push(`It has ${reason}, which ${ENGINES[engine].name} handles best${ctx.hfToken ? '' : ' within the free quota'}.`);
  } else {
    engine = 'sf3d';
    why.push(`A ${simple ? 'simple' : 'fairly simple'} textured object: Stable Fast 3D does it well in seconds.`);
  }

  // ---- settings for that engine
  const opts = { ...ENGINES[engine].defaults };
  const faces = complex ? 'high' : simple ? 'low' : 'mid';
  switch (engine) {
    case 'flat': {
      const real = realSize(a);
      const ratio = real.size_cm && real.depth_cm ? real.depth_cm / real.size_cm : 0.02;
      opts.thickness = Math.round(Math.min(0.15, Math.max(0.006, ratio)) * 500) / 500;
      opts.shape = a.symmetry === 'radial' ? 'round' : 'auto';
      opts.back = /same|similar|mirror|identical|matching|both sides/i.test(a.back) ? 'mirror' : 'plain';
      break;
    }
    case 'sf3d':
      opts.texture = f.fine_texture ? '2048' : '1024';
      opts.remesh = 'None';
      break;
    case 'trellis2':
      opts.resolution = complex ? '1024' : '512';
      opts.texture = f.fine_texture || f.character ? '2048' : '1024';
      opts.faces = f.thin_parts ? 450000 : { low: 150000, mid: 300000, high: 450000 }[faces];
      break;
    case 'trellis':
      opts.steps = (complex || f.thin_parts) && !ctx.quotaLow ? '25' : '12';
      opts.texture = f.fine_texture || f.character ? '2048' : '1024';
      opts.simplify = complex || f.thin_parts ? 0.9 : 0.95;
      break;
    case 'hunyuan21':
    case 'hy2mini':
      opts.octree = complex ? '384' : '256';
      opts.rembg = true;
      break;
    case 'triposg':
      opts.faces = { low: 50000, mid: 100000, high: 200000 }[faces];
      break;
    case 'hunyuan':
      opts.texture = f.colour ? 'Normal' : 'Geometry';
      opts.pbr = f.colour && ['metallic', 'glossy', 'mixed'].includes(a.finish);
      break;
    case 'tripo':
      opts.texture = !f.colour ? 'none' : f.fine_texture ? 'detailed' : 'standard';
      opts.pbr = f.colour && ['metallic', 'glossy', 'mixed'].includes(a.finish);
      opts.geometry = complex ? 'detailed' : 'standard';
      opts.quad = f.hard_surface;
      break;
    case 'meshy':
      opts.texture = f.colour;
      opts.pbr = f.colour && ['metallic', 'glossy', 'mixed'].includes(a.finish);
      opts.polycount = { low: 15000, mid: 30000, high: 100000 }[faces];
      opts.topology = f.hard_surface ? 'quad' : 'triangle';
      opts.symmetry = a.symmetry === 'left-right' ? 'on' : a.symmetry === 'none' ? 'off' : 'auto';
      break;
  }
  if (engine === 'flat') {
    why.push(`${opts.shape === 'round' ? 'Round outline' : 'Outline traced from the photo'}, ${(opts.thickness * 100).toFixed(1)}% thick, ${opts.back === 'mirror' ? 'the same picture on the back' : 'a plain back'}.`);
  }
  if (engine === 'sf3d' && f.fine_texture) why.push('2K texture to keep the printed and painted detail.');
  if (engine === 'trellis' && (complex || f.thin_parts)) why.push('High detail and less simplifying so small parts survive.');
  if (['hunyuan21', 'hy2mini'].includes(engine) && complex) why.push('High detail to keep the complex shape.');
  if (engine === 'meshy' && a.symmetry !== 'none') why.push('Symmetry on, because the object is mirrored left to right.');
  if (['hunyuan', 'tripo', 'meshy'].includes(engine) && opts.pbr) why.push(`PBR materials for its ${a.finish} finish.`);

  // ---- what the model will have to invent
  const assumptions = [
    ['Object', `${a.object} (${a.style}, ${a.category})`],
    ['Materials', [...a.materials, a.finish].filter(Boolean).join(', ')],
    ['Back', a.back],
    ['Underside', a.underside],
    ['Symmetry', a.symmetry === 'left-right' ? 'mirrored left to right' : a.symmetry === 'radial' ? 'round (same all the way round)' : 'not symmetric'],
  ];
  const real = realSize(a);
  if (real.size_cm && !f.scene) {
    const cm = (v) => (v >= 100 ? `${(v / 100).toFixed(1)} m` : v < 1 ? `${Math.round(v * 100) / 10} mm` : `${Math.round(v * 10) / 10} cm`);
    assumptions.push(['Real size', `${real.standard ? 'standard' : 'about'} ${cm(real.size_cm)} ${f.character && !f.flat ? 'tall' : 'across'}${real.depth_cm ? `, ${cm(real.depth_cm)} thick` : ''}`]);
  }
  if (a.view !== 'front' && a.view !== 'three-quarter' && !f.flat) assumptions.push(['Seen from', `the ${a.view}; the other sides are guessed`]);
  if (f.character && !f.flat) {
    assumptions.push(['Pose', `kept exactly as ${f.drawing ? 'drawn' : 'photographed'}; hands and cloth resting on the body merge into it`]);
  }

  // ---- things worth knowing before spending GPU time
  const warnings = [];
  const problems = a.problems.map((p) => p.toLowerCase()).join(' ');
  if (!f.scene && /several|multiple/.test(problems)) warnings.push('There is more than one thing in the photo. Engines build one object; crop to it or use a depth relief.');
  const edges = a.cut_off || [];
  if (edges.length) {
    const list = edges.length > 1 ? `${edges.slice(0, -1).join(', ')} and ${edges.at(-1)} edges` : `${edges[0]} edge`;
    warnings.push(`It runs off the ${list} of the picture, so that part will end abruptly or be invented. A picture with space all round works best.`);
  } else if (/crop|cut off|partial/.test(problems)) warnings.push('Part of the object is out of frame; the missing part will be invented.');
  if (/blur|dark/.test(problems)) warnings.push('The photo is blurry or dark, so details will be soft.');
  // The small vision model often says "odd angle" about an ordinary front or three-quarter
  // view, so only trust it when the view agrees.
  const oddAngle = ['top', 'back', 'side'].includes(a.view) || (/angle|top|back/.test(problems) && !['front', 'three-quarter'].includes(a.view));
  if (!f.flat && oddAngle) warnings.push('An unusual angle: a three-quarter view from the front gives the best shape.');
  if (a.transparent) warnings.push('Glass or clear parts come out solid; engines can’t make see-through materials.');
  if (f.thin_parts) {
    if (engine === 'sf3d' || (ctx.userPicked && ctx.currentEngine === 'sf3d')) {
      warnings.push('Stable Fast 3D fills the gaps between bars, so this will come out as a solid block with the pattern painted on. Use TRELLIS.');
    }
    warnings.push('Wire and thin-bar objects are the hardest case for image-to-3D AI: expect some bars to merge or thicken. The overall frame usually comes out right.');
    if (ctx.quotaLow && !ctx.hfToken) {
      warnings.push(`${ENGINES[engine].name} reserves more GPU time than Stable Fast 3D, so with little left today it may not start. A free HF_TOKEN in .env fixes that.`);
    }
  }
  if (f.character && !f.flat && engine !== 'flat') {
    if (a.thin_parts) warnings.push('Hanging chains, loose strands of hair and thin cloth tips come out thicker, shorter or fused to the body. The figure, face and clothes come through.');
    warnings.push('In a full-body picture the face is small, so it comes out soft. For a sharper face, use a picture cropped to the upper body.');
  }
  if (!f.colour && ENGINES[engine].free && !ENGINES[engine].local) warnings.push('Shape only: the model comes out grey.');
  if (ctx.quotaLow && ENGINES[engine].free && !ENGINES[engine].local) {
    const left = ctx.quotaLeft ? `only about ${ctx.quotaLeft} s` : 'no';
    warnings.push(`There's ${left} free GPU time left today${ctx.quotaAt ? ` (it refills around ${ctx.quotaAt})` : ''}, so this run may fail. Flat object and Depth relief work without it.`);
  }
  // A drawn character can also become a standee: the exact art cut out, on a base. It costs no
  // GPU time and never fails, so it's always offered next to the AI pick.
  const alt = f.scene
    ? { tab: 'relief', label: 'Make a depth relief instead', note: 'the whole picture in 3D, on your device, no GPU time' }
    : (f.character || f.drawing) && !f.flat && engine !== 'flat'
    ? { engine: 'flat', opts: { shape: 'cutout', thickness: 0.02, back: 'mirror', stand: 'base' }, size_cm: 15,
        label: 'Make it a standee instead', note: 'the exact art, cut out on a base \u00b7 instant, no GPU time' }
    : null;
  return { engine, opts, why, assumptions, warnings, alt };
}
