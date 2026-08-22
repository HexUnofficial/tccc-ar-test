import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { config } from './config.js';

/**
 * A soft contact shadow, drawn to a canvas rather than shipped as a texture.
 * Without it the model reads as floating above the ground in the camera feed.
 */
function createGroundShadow(radius) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.45)');
  gradient.addColorStop(0.6, 'rgba(0,0,0,0.15)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  shadow.renderOrder = -1;
  return shadow;
}

/**
 * Does this geometry enclose a volume, or is it a one-sided sheet?
 *
 * Summing the vertex normals of a closed shell very nearly cancels, because
 * every outward face is opposed by one pointing the other way. On an open sheet
 * they all agree instead, so the sum keeps close to its full length. Measured
 * on this aircraft: the banner comes out at 0.13, and the three genuinely
 * one-sided parts at 0.98 to 1.00 — so 0.6 sits in open space between them.
 */
function enclosesVolume(geometry) {
  const normal = geometry?.getAttribute('normal');
  if (!normal || normal.count === 0) return false;

  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < normal.count; i += 1) {
    x += normal.getX(i);
    y += normal.getY(i);
    z += normal.getZ(i);
  }
  return Math.hypot(x, y, z) / normal.count < 0.6;
}

/**
 * Turn off double-sided rendering wherever the geometry is solid.
 *
 * The export marks every material doubleSided, so interior faces are drawn as
 * well as exterior ones. On the banner that is not merely wasteful but visibly
 * wrong: it is a two-layer sheet whose two faces carry separate UVs — the
 * texture holds one copy of the lettering per side — with the layers about 34
 * units apart in a banner 1099 long, a few millimetres once scaled to metres.
 * The inside of the far layer therefore draws over the outside of the near one
 * and its reversed lettering bleeds through, so the banner reads forwards and
 * backwards at once and neither is legible.
 *
 * Deliberately decided from the geometry rather than from material or mesh
 * names: the model is redelivered by the 3D team as the design changes, and a
 * rename would silently switch a name-matched fix back off with the only
 * symptom being unreadable lettering. A closed shell never needs its inside
 * drawn, so this is safe wherever it fires, and genuinely one-sided parts keep
 * both faces.
 *
 * A material shared between a solid and a sheet stays double-sided — culling it
 * would make the sheet vanish from one side, which is the one way this could
 * make things worse.
 */
function cullBackfacesOnSolids(model) {
  const sheetMaterials = new Set();
  const solidMaterials = new Set();

  model.traverse((child) => {
    if (!child.isMesh) return;
    const solid = enclosesVolume(child.geometry);
    for (const material of [].concat(child.material)) {
      if (material) (solid ? solidMaterials : sheetMaterials).add(material);
    }
  });

  for (const material of solidMaterials) {
    if (!sheetMaterials.has(material)) material.side = THREE.FrontSide;
  }
}

/**
 * Load the GLB and normalise it into something we can drop onto a GPS anchor:
 * scaled to a real-world height in metres, with its feet at y = 0.
 *
 * @returns {Promise<{root: THREE.Group, mixer: THREE.AnimationMixer|null, clipName: string|null}>}
 */
export async function loadModel(onProgress) {
  const preset = config.model;

  /*
   * Draco takes the aircraft from 27 MB to 0.6 MB, which is the difference
   * between usable and not on mobile data.
   *
   * No setDecoderPath: three's DRACOLoader declares its decoder with
   * `new URL(..., import.meta.url)`, so the bundler emits and fingerprints it
   * automatically and serves it from our own origin. Pointing it at a hand-
   * copied directory only risks getting the fallback files wrong.
   */
  const draco = new DRACOLoader();
  const loader = new GLTFLoader().setDRACOLoader(draco);

  const gltf = await loader.loadAsync(preset.url, (event) => {
    if (event.lengthComputable) onProgress?.(event.loaded / event.total);
  });
  draco.dispose();

  const model = gltf.scene;

  // Normalise to a real-world size. Aircraft are measured along their longest
  // axis; anything standing on the ground is measured by height.
  const bounds = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  bounds.getSize(size);
  const reference = preset.scaleBy === 'size' ? Math.max(size.x, size.y, size.z) : size.y;
  model.scale.setScalar(reference > 0 ? preset.size / reference : 1);

  bounds.setFromObject(model);
  const centre = new THREE.Vector3();
  bounds.getCenter(centre);
  model.position.x -= centre.x;
  model.position.z -= centre.z;
  // Ground models stand on the anchor; flying ones are centred on their path.
  model.position.y -= preset.behaviour === 'flight' ? centre.y : bounds.min.y;

  model.traverse((child) => {
    if (child.isMesh) child.frustumCulled = false;
  });
  cullBackfacesOnSolids(model);

  /*
   * Three nested groups, each owning exactly one concern:
   *   root    positioned by LocAR at the GPS anchor, never touched by us
   *   motion  flown along the circuit, or spun to face the viewer
   *   yaw     fixed correction for a model that doesn't face -Z as authored
   * Without the separation, the flight path and the nose correction fight.
   */
  const yaw = new THREE.Group();
  yaw.rotation.y = THREE.MathUtils.degToRad(preset.noseOffset + config.model.yawOffset);
  yaw.add(model);

  const motion = new THREE.Group();
  motion.add(yaw);

  const root = new THREE.Group();
  root.add(motion);

  if (preset.groundShadow) {
    bounds.setFromObject(model);
    const footprint = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);
    root.add(createGroundShadow(footprint * 0.6));
  }

  /*
   * The local bounds of everything under `motion`, measured once. The HUD needs
   * the model's whole extent, not just its origin: this aircraft tows a banner,
   * so its centre sits in the empty gap on the tow line and leaves the frame
   * long before the aircraft or the banner do.
   */
  const localBounds = new THREE.Box3().setFromObject(motion);

  /*
   * Play every clip, not just the first. The aircraft's propeller lives in one
   * clip among what was originally 223 (one per object, all but one static —
   * see tools/optimize-geometry.mjs), and which one survives pruning is not
   * something to hard-code an index for.
   */
  let mixer = null;
  let clipName = null;
  if (gltf.animations.length > 0) {
    mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
    }
    clipName = gltf.animations.length === 1
      ? gltf.animations[0].name
      : `${gltf.animations.length} clips`;
  }

  return { root, motion, yaw, mixer, clipName, preset, localBounds };
}
