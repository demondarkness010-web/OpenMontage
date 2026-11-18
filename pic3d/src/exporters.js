// Extra download formats for a generated model, made in the browser from what's on screen:
//   OBJ  - geometry for any 3D app (no materials)
//   STL  - for 3D printing, Z up, scaled to the object's real size in millimetres
//   PLY  - geometry with vertex colours
//   USDZ - for AR Quick Look on iPhone and iPad
import * as THREE from 'three';

const LOADERS = {
  obj: () => import('three/addons/exporters/OBJExporter.js').then((m) => m.OBJExporter),
  stl: () => import('three/addons/exporters/STLExporter.js').then((m) => m.STLExporter),
  ply: () => import('three/addons/exporters/PLYExporter.js').then((m) => m.PLYExporter),
  usdz: () => import('three/addons/exporters/USDZExporter.js').then((m) => m.USDZExporter),
};
const TYPES = { obj: 'model/obj', stl: 'model/stl', ply: 'application/octet-stream', usdz: 'model/vnd.usdz+zip' };

/**
 * @param model   the viewer's loaded model (normalized to about 2 units, standing on y = 0)
 * @param format  'obj' | 'stl' | 'ply' | 'usdz'
 * @param sizeMm  real size of the longest side, for STL; defaults to 100 mm
 */
export async function exportModel(model, format, { sizeMm } = {}) {
  const Exporter = await LOADERS[format]();
  // Export the original materials, not the viewer's clay or wireframe stand-ins.
  const root = model.clone(true);
  root.traverse((o) => {
    if (o.isMesh && o.userData.original) o.material = o.userData.original;
  });
  const wrapper = new THREE.Group();
  wrapper.add(root);
  if (format === 'stl') {
    const box = new THREE.Box3().setFromObject(model);
    const longest = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1e-6);
    wrapper.scale.setScalar((sizeMm || 100) / longest);
    wrapper.rotation.x = Math.PI / 2; // slicers expect Z up
  }
  wrapper.updateMatrixWorld(true);

  let data;
  if (format === 'obj') data = new Exporter().parse(wrapper);
  else if (format === 'stl') data = new Exporter().parse(wrapper, { binary: true });
  else if (format === 'ply') data = await new Promise((resolve) => new Exporter().parse(wrapper, resolve, { binary: true }));
  else data = await new Exporter().parseAsync(wrapper, { quickLookCompatible: true });
  if (!data || (data.byteLength ?? data.length) === 0) throw new Error(`The ${format.toUpperCase()} export came out empty.`);
  return new Blob([data], { type: TYPES[format] });
}
