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
 * Load the GLB and normalise it into something we can drop onto a GPS anchor:
 * scaled to a real-world height in metres, with its feet at y = 0.
 *
 * @returns {Promise<{root: THREE.Group, mixer: THREE.AnimationMixer|null, clipName: string|null}>}
 */
export async function loadModel(onProgress) {
  const preset = config.model;

  /*
   * Draco takes the aircraft from 27 MB to 0.6 MB, which is the difference
   * between usable and not on mobile data. The decoder is served from our own
   * origin rather than a CDN: it is ~250 KB of wasm, fetched only for models
   * that actually need it, and one less third party to be down at the riverbank.
   */
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
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

  let mixer = null;
  let clipName = null;
  if (gltf.animations.length > 0) {
    mixer = new THREE.AnimationMixer(model);
    const clip = gltf.animations[0];
    mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
    clipName = clip.name;
  }

  return { root, motion, yaw, mixer, clipName, preset };
}
