// ReliefViewer: owns the Three.js renderer, scene, camera and the relief object.
// The UI talks to it through setImage / setDepth / setGeometry / setView and the
// export methods. Rendering runs on a single animation loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildRelief, smoothDepth, depthToCanvas } from './relief.js';

const BACKDROPS = { ink: 0x0d0d10, paper: 0xeceae5 };
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const POINTS_VERT = /* glsl */ `
  uniform float uSize;
  uniform float uScale;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(1.0, uSize * uScale / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const POINTS_FRAG = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    gl_FragColor = texture2D(map, vUv);
    #include <colorspace_fragment>
  }
`;

/**
 * Remove disconnected specks (generation noise) from an indexed mesh: keeps every
 * connected piece with at least 5% of the largest piece's triangles.
 */
function dropFloaters(geometry) {
  const index = geometry.index;
  // Past ~600k triangles the extra passes cost seconds on a slow laptop; big meshes are clean anyway.
  if (!index || index.count < 300 || index.count > 1_800_000) return;
  if (Object.values(geometry.attributes).some((a) => a.isInterleavedBufferAttribute)) return;
  if (Object.keys(geometry.morphAttributes).length) return;
  const idx = index.array;
  const parent = new Int32Array(geometry.attributes.position.count).map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let i = 0; i < idx.length; i += 3) {
    const a = find(idx[i]), b = find(idx[i + 1]), c = find(idx[i + 2]);
    parent[b] = a;
    parent[find(c)] = a;
  }
  const tris = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    const r = find(idx[i]);
    tris.set(r, (tris.get(r) || 0) + 1);
  }
  if (tris.size < 2) return;
  let biggest = 0;
  for (const t of tris.values()) if (t > biggest) biggest = t; // spread would overflow on noisy meshes
  const min = biggest * 0.05;
  const kept = [];
  for (let i = 0; i < idx.length; i += 3) {
    if (tris.get(find(idx[i])) >= min) kept.push(idx[i], idx[i + 1], idx[i + 2]);
  }
  if (kept.length === idx.length) return;
  // Compact: keep only referenced vertices so bounds and stats ignore the specks.
  const remap = new Int32Array(parent.length).fill(-1);
  let n = 0;
  for (const v of kept) if (remap[v] < 0) remap[v] = n++;
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const out = new attr.array.constructor(n * attr.itemSize);
    for (let v = 0; v < remap.length; v++) {
      if (remap[v] < 0) continue;
      for (let k = 0; k < attr.itemSize; k++) out[remap[v] * attr.itemSize + k] = attr.array[v * attr.itemSize + k];
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize, attr.normalized));
  }
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(kept, (v) => remap[v]), 1));
  // GLTFLoader caches bounds from the accessors' min/max; recompute for the trimmed mesh.
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

export class ReliefViewer {
  /** @param {HTMLElement} host */
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    // 4 GB machines (deviceMemory reports ≤ 4) can't afford retina-sized buffers or 2K shadows.
    const lowMemory = (navigator.deviceMemory ?? 8) <= 4;
    this.renderer.setPixelRatio(lowMemory ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'gl';
    host.append(this.canvas);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    this.camera.position.set(0, 0, 4);

    // Key light comes in at a low angle so relief detail reads in Studio and Clay.
    const key = new THREE.DirectionalLight(0xfff4e8, 2.2);
    key.position.set(4, 4, 1.4);
    const fill = new THREE.DirectionalLight(0xc8d8ff, 0.35);
    fill.position.set(-4, -1, 2);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x14141a, 0.12), key, fill);

    // Soft contact shadow for generated models (relief meshes don't cast).
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft was removed in r18x and falls back to this
    key.castShadow = true;
    key.shadow.mapSize.setScalar(lowMemory ? 1024 : 2048);
    Object.assign(key.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 0.1, far: 20 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.ShadowMaterial({ opacity: 0.3 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.scene.add(this.ground);

    this.modelGroup = new THREE.Group();
    this.modelGroup.visible = false;
    this.scene.add(this.modelGroup);
    this.kind = 'relief';
    this.model = null;
    this.modelView = { material: 'textured', autoRotate: true, ground: true };
    this.modelTarget = new THREE.Vector3(0, 0.8, 0);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 12;
    this.controls.autoRotateSpeed = 1.2;
    this.controls.rotateSpeed = 0.6;
    this.controls.enabled = false;

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.mats = {
      photo: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }),
      studio: new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.78, metalness: 0, envMapIntensity: 0.3 }),
      clay: new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, color: 0xa69f95, roughness: 0.55, metalness: 0, envMapIntensity: 0.12 }),
      depth: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }),
      side: new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, color: 0x1a1a1f, roughness: 0.6, metalness: 0.1 }),
      points: new THREE.ShaderMaterial({
        uniforms: { map: { value: null }, uSize: { value: 0.01 }, uScale: { value: 500 } },
        vertexShader: POINTS_VERT,
        fragmentShader: POINTS_FRAG,
        toneMapped: false,
      }),
    };

    this.view = {
      mode: 'mesh', shading: 'photo', camera: 'parallax', autoRotate: false,
      backdrop: 'ink', depthScale: 0.55, pointSize: 1.2, motion: 0.5,
    };
    this.geo = { segments: 384, smoothing: 1.5, curve: 1, edgeCut: 0, invert: false, solid: false, thickness: 0.15 };

    this.aspect = 1;
    this.planeSize = { width: 2, height: 2 };
    this.fitDistance = 4;
    this.zoom = 1;
    this.pointer = { x: 0, y: 0, last: -1e9 };
    this.sway = { x: 0, y: 0 };
    this.reveal = 1;
    this.revealStart = 0;
    this.recording = null;
    this.depth = null;
    this.smoothed = null;
    this.dirty = false;
    this.onStats = null;
    this.lastTime = performance.now();

    this.#bindInput();
    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(host);
    this.#resize();
    this.applyView();
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  // ---------------------------------------------------------------- inputs

  #bindInput() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      this.pointer.last = performance.now();
    });
    c.addEventListener('pointerleave', () => (this.pointer.last = -1e9));
    c.addEventListener(
      'wheel',
      (e) => {
        if (this.view.camera !== 'parallax') return;
        e.preventDefault();
        this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(e.deltaY * 0.001), 0.4, 2);
      },
      { passive: false },
    );
    c.addEventListener('dblclick', () => this.resetView());
  }

  #resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.mats.points.uniforms.uScale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.#fit();
  }

  #fit() {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const { width, height } = this.planeSize;
    const d = Math.max(height / 2 / Math.tan(vFov / 2), width / 2 / Math.tan(hFov / 2));
    this.fitDistance = d * 1.14 + this.view.depthScale * 0.5;
  }

  // ---------------------------------------------------------------- content

  /** @param {HTMLCanvasElement} canvas */
  setImage(canvas, aspect) {
    this.photoTex?.dispose();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.userData.mimeType = 'image/jpeg';
    this.photoTex = tex;
    this.aspect = aspect;
    this.mats.photo.map = tex;
    this.mats.studio.map = tex;
    this.mats.photo.needsUpdate = this.mats.studio.needsUpdate = true;
    this.applyView();
  }

  /** @param {{ data: Float32Array, width: number, height: number }} depth */
  setDepth(depth) {
    this.depth = depth;
    this.smoothed = null;
    this.depthTex?.dispose();
    this.depthTex = null;
    this.reveal = 0;
    this.revealStart = performance.now();
    this.#rebuild();
  }

  clear() {
    this.depth = null;
    this.#disposeObjects();
  }

  setGeometry(patch) {
    const prevSmoothing = this.geo.smoothing;
    Object.assign(this.geo, patch);
    if (this.geo.smoothing !== prevSmoothing) this.smoothed = null;
    this.dirty = true; // coalesced to one rebuild per frame
  }

  setView(patch) {
    const prevCam = this.view.camera;
    Object.assign(this.view, patch);
    if (patch.camera && patch.camera !== prevCam) {
      if (patch.camera === 'orbit') {
        this.controls.target.set(0, 0, 0);
        this.controls.update();
      }
    }
    if ('depthScale' in patch) this.#fit();
    this.applyView();
  }

  applyView() {
    const v = this.view;
    const isModel = this.kind === 'model';
    this.controls.enabled = (isModel || v.camera === 'orbit') && !this.recording;
    this.controls.autoRotate = isModel ? this.modelView.autoRotate : v.autoRotate;
    this.root.visible = !isModel;
    this.modelGroup.visible = isModel;
    this.ground.visible = isModel && !!this.model && this.modelView.ground;

    if (v.backdrop === 'none') this.renderer.setClearColor(0x000000, 0);
    else this.renderer.setClearColor(BACKDROPS[v.backdrop], 1);

    for (const k of ['photo', 'studio', 'clay', 'depth']) this.mats[k].wireframe = v.mode === 'wire';
    if (v.shading === 'depth') this.#ensureDepthTexture();
    this.mats.points.uniforms.map.value = v.shading === 'depth' ? this.depthTex : this.photoTex;

    if (this.mesh) {
      this.mesh.material = [this.mats[v.shading], this.mats.side];
      this.mesh.visible = v.mode !== 'points';
    }
    if (this.points) {
      this.points.visible = v.mode === 'points';
      this.mats.points.uniforms.uSize.value = this.spacing * v.pointSize;
    }
  }

  #ensureDepthTexture() {
    if (this.depthTex || !this.depth) return;
    const tex = new THREE.CanvasTexture(depthToCanvas(this.#smoothedDepth(), 'turbo'));
    tex.colorSpace = THREE.SRGBColorSpace;
    this.depthTex = tex;
    this.mats.depth.map = tex;
    this.mats.depth.needsUpdate = true;
  }

  #smoothedDepth() {
    if (!this.smoothed) this.smoothed = smoothDepth(this.depth, this.geo.smoothing);
    return this.smoothed;
  }

  #disposeObjects() {
    if (this.mesh) {
      this.root.remove(this.mesh, this.points);
      this.mesh.geometry.dispose();
      this.points.geometry.dispose();
      this.mesh = this.points = null;
    }
  }

  #rebuild() {
    this.dirty = false;
    if (!this.depth) return;
    const t0 = performance.now();
    const hadDepthTex = !!this.depthTex;
    const depth = this.#smoothedDepth();
    const built = buildRelief(depth, { aspect: this.aspect, ...this.geo });
    this.#disposeObjects();

    this.mesh = new THREE.Mesh(built.geometry, [this.mats[this.view.shading], this.mats.side]);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', built.geometry.getAttribute('position'));
    pg.setAttribute('uv', built.geometry.getAttribute('uv'));
    pg.setDrawRange(0, built.surfaceVertices);
    this.points = new THREE.Points(pg, this.mats.points);
    this.points.frustumCulled = false;
    this.root.add(this.mesh, this.points);

    this.planeSize = built.size;
    this.spacing = built.spacing;
    this.#fit();

    // The heatmap reflects smoothing, so refresh it if it was in use.
    if (hadDepthTex) {
      this.depthTex.dispose();
      this.depthTex = null;
    }
    this.applyView();
    this.onStats?.({
      vertices: built.geometry.getAttribute('position').count,
      triangles: built.triangles,
      ms: Math.round(performance.now() - t0),
    });
  }

  // ---------------------------------------------------------------- generated models

  /** Switch between the depth relief and a generated 3D model. */
  setKind(kind) {
    if (kind === this.kind) return;
    this.kind = kind;
    if (kind === 'model') this.#frameModel();
    else {
      this.controls.target.set(0, 0, 0);
      this.camera.position.set(0, 0, this.fitDistance);
      this.controls.update();
    }
    this.applyView();
  }

  /**
   * Load a GLB, normalize it to ~2 units tall-or-wide, stand it on the ground and frame it.
   * @returns {Promise<{ triangles: number, vertices: number, meshes: number, textures: number }>}
   */
  async showModel(url) {
    if (!this.loader) {
      const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/libs/draco/gltf/');
      this.loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
    }
    const token = (this.loadToken = (this.loadToken ?? 0) + 1);
    const gltf = await this.loader.loadAsync(url);
    if (token !== this.loadToken) throw new DOMException('A newer model was picked', 'AbortError');
    this.clearModel();
    const obj = gltf.scene;
    obj.traverse((o) => {
      // Untextured meshes have merged vertices, so connectivity is real (no UV seams).
      if (o.isMesh && !o.material?.map && !o.geometry.attributes.uv) dropFloaters(o.geometry);
    });

    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = 2 / Math.max(size.x, size.y, size.z, 1e-6);
    obj.scale.setScalar(s);
    obj.position.set(-center.x * s, -box.min.y * s, -center.z * s);
    this.modelHeight = size.y * s;
    this.modelRadius = (size.length() * s) / 2;
    this.modelTarget.set(0, this.modelHeight / 2, 0);

    let triangles = 0, vertices = 0, meshes = 0;
    const textures = new Set();
    obj.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      o.castShadow = o.receiveShadow = true;
      o.userData.original = o.material;
      const g = o.geometry;
      // Shape-only outputs (e.g. Hunyuan3D-2.1 free) ship without normals or materials.
      if (!g.attributes.normal) g.computeVertexNormals();
      if (g.attributes.color) textures.add(g.attributes.color);
      vertices += g.attributes.position.count;
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
      for (const m of [].concat(o.material)) {
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
          if (m[key]) {
            textures.add(m[key]);
            m[key].anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          }
        }
      }
    });
    this.modelGroup.add(obj);
    this.model = obj;
    this.modelTextured = textures.size > 0;
    textures.forEach((t) => t.isBufferAttribute && textures.delete(t));
    this.#applyModelMaterial();
    this.#frameModel();
    this.applyView();
    return { triangles: Math.round(triangles), vertices, meshes, textures: textures.size };
  }

  clearModel() {
    if (!this.model) return;
    this.modelGroup.remove(this.model);
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      for (const m of [].concat(o.userData.original ?? o.material)) {
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
        m.dispose();
      }
    });
    this.model = null;
    this.applyView();
  }

  setModelView(patch) {
    Object.assign(this.modelView, patch);
    if ('material' in patch) this.#applyModelMaterial();
    this.applyView();
  }

  #applyModelMaterial() {
    if (!this.model) return;
    // Without textures or vertex colours, "textured" would be flat white: show clay instead.
    const mode = this.modelView.material === 'textured' && !this.modelTextured ? 'clay' : this.modelView.material;
    this.modelMats ??= {
      clay: new THREE.MeshStandardMaterial({ color: 0xa69f95, roughness: 0.55, metalness: 0, envMapIntensity: 0.25 }),
      wire: new THREE.MeshBasicMaterial({ color: 0xffb547, wireframe: true, toneMapped: false }),
      normals: new THREE.MeshNormalMaterial(),
    };
    this.model.traverse((o) => {
      if (o.isMesh) o.material = mode === 'textured' ? o.userData.original : this.modelMats[mode];
    });
  }

  #frameModel() {
    if (!this.model) return;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const fitH = this.modelRadius / Math.sin(vFov / 2);
    const fitW = this.modelRadius / Math.sin(Math.atan(Math.tan(vFov / 2) * this.camera.aspect));
    const d = Math.max(fitH, fitW) * 1.08;
    const dir = new THREE.Vector3(0.55, 0.32, 1).normalize();
    this.controls.target.copy(this.modelTarget);
    this.camera.position.copy(this.modelTarget).addScaledVector(dir, d);
    this.controls.update();
  }

  // ---------------------------------------------------------------- camera

  resetView() {
    this.zoom = 1;
    if (this.kind === 'model') {
      this.#frameModel();
      return;
    }
    if (this.view.camera === 'orbit') {
      this.camera.position.set(0, 0, this.fitDistance);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  }

  #tick() {
    const now = performance.now();
    if (this.paused && !this.recording) {
      this.lastTime = now; // no time jump when drawing resumes
      return;
    }
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (this.dirty) this.#rebuild();

    if (this.reveal < 1) this.reveal = Math.min(1, (now - this.revealStart) / 1100);
    this.root.scale.z = Math.max(0.001, this.view.depthScale * easeOutCubic(this.reveal));

    const cam = this.camera;
    if (this.recording) {
      const r = this.recording;
      const t = Math.min(1, (now - r.start) / r.duration);
      if (this.kind === 'model') {
        // One full turn around the model at the current height and distance.
        r.orbit ??= (() => {
          const off = cam.position.clone().sub(this.controls.target);
          return { R: Math.hypot(off.x, off.z), y: off.y, a0: Math.atan2(off.x, off.z) };
        })();
        const a = r.orbit.a0 + t * Math.PI * 2;
        cam.position.set(Math.sin(a) * r.orbit.R, r.orbit.y, Math.cos(a) * r.orbit.R).add(this.controls.target);
        cam.lookAt(this.controls.target);
      } else {
        const a = easeInOut(t) * Math.PI * 2;
        this.#placeOnSphere(Math.sin(a) * 0.42, Math.sin(2 * a) * 0.16, this.fitDistance);
      }
      if (t >= 1) r.done();
    } else if (this.kind === 'relief' && this.view.camera === 'parallax') {
      const live = now - this.pointer.last < 2500;
      const tx = live ? this.pointer.x : Math.sin(now * 0.00042) * 0.6;
      const ty = live ? this.pointer.y : Math.sin(now * 0.00067) * 0.35;
      const k = 1 - Math.exp(-dt * (live ? 6 : 2));
      this.sway.x += (tx - this.sway.x) * k;
      this.sway.y += (ty - this.sway.y) * k;
      const m = 0.12 + this.view.motion * 0.5;
      const target = this.#spherePoint(this.sway.x * m, this.sway.y * m * 0.6, this.fitDistance * this.zoom);
      cam.position.lerp(target, 1 - Math.exp(-dt * 8));
      cam.lookAt(0, 0, 0);
    } else {
      this.controls.update(dt);
    }
    this.renderer.render(this.scene, cam);
  }

  #spherePoint(ax, ay, d) {
    return new THREE.Vector3(d * Math.sin(ax) * Math.cos(ay), d * Math.sin(ay), d * Math.cos(ax) * Math.cos(ay));
  }

  #placeOnSphere(ax, ay, d) {
    this.camera.position.copy(this.#spherePoint(ax, ay, d));
    this.camera.lookAt(0, 0, 0);
  }

  // ---------------------------------------------------------------- export

  /** PNG of the current view at the canvas's resolution. */
  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  /** Binary glTF of the relief mesh, with the photo baked in as a texture. */
  async exportGLB() {
    if (!this.mesh) throw new Error('Nothing to export yet.');
    const material = this.view.shading === 'clay' ? this.mats.clay : this.mats.studio;
    const mesh = new THREE.Mesh(this.mesh.geometry, [material, this.mats.side]);
    mesh.name = 'Relief';
    mesh.scale.z = this.view.depthScale;
    const wire = material.wireframe;
    material.wireframe = false;
    try {
      const result = await new GLTFExporter().parseAsync(mesh, { binary: true, maxTextureSize: 4096 });
      return new Blob([result], { type: 'model/gltf-binary' });
    } finally {
      material.wireframe = wire;
    }
  }

  /** Records a seamless figure-eight camera loop. */
  async record(seconds, onProgress) {
    if (this.recording) throw new Error('Already recording.');
    if (!(this.kind === 'model' ? this.model : this.mesh)) throw new Error('Nothing to record yet.');
    const types = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    const supported = types.filter((t) => window.MediaRecorder?.isTypeSupported(t));
    if (!supported.length) throw new Error('This browser cannot record video.');
    // A cold hardware encoder sometimes returns an empty file on its first use;
    // retry once, falling to the next format if there is one.
    for (let attempt = 0; attempt < 2; attempt++) {
      const mimeType = supported[Math.min(attempt, supported.length - 1)];
      const out = await this.#recordOnce(mimeType, seconds, onProgress);
      if (out.blob.size > 0) return out;
    }
    throw new Error('The recording came out empty. Try again.');
  }

  async #recordOnce(mimeType, seconds, onProgress) {
    const stream = this.canvas.captureStream(60);
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 14_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));

    const transparent = this.view.backdrop === 'none';
    if (transparent) this.renderer.setClearColor(BACKDROPS.ink, 1);
    this.reveal = 1;

    const ticker = setInterval(() => {
      if (this.recording) onProgress?.(Math.min(1, (performance.now() - this.recording.start) / this.recording.duration));
    }, 100);
    await new Promise((done) => {
      this.recording = { start: performance.now(), duration: seconds * 1000, done };
      this.applyView();
      rec.start(250);
    });
    clearInterval(ticker);
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    this.recording = null;
    this.applyView();
    const type = mimeType.split(';')[0];
    return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm' };
  }

  /** Grayscale depth map PNG (white = near). */
  depthPNG() {
    if (!this.depth) return Promise.resolve(null);
    const canvas = depthToCanvas(this.#smoothedDepth(), 'gray');
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  get isRecording() {
    return !!this.recording;
  }
}
