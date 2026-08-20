import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
  const gltf = await new GLTFLoader().loadAsync(config.model.url, (event) => {
    if (event.lengthComputable) onProgress?.(event.loaded / event.total);
  });

  const model = gltf.scene;

  // Scale to the configured real-world height, then sit it on the ground.
  const bounds = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  bounds.getSize(size);
  const scale = size.y > 0 ? config.model.heightMeters / size.y : 1;
  model.scale.setScalar(scale);

  bounds.setFromObject(model);
  const centre = new THREE.Vector3();
  bounds.getCenter(centre);
  model.position.x -= centre.x;
  model.position.z -= centre.z;
  model.position.y -= bounds.min.y;

  model.traverse((child) => {
    if (child.isMesh) child.frustumCulled = false;
  });

  // The yaw wrapper is what we spin to face the viewer; the anchor group is what
  // LocAR positions, so the two concerns never fight each other.
  const yaw = new THREE.Group();
  yaw.rotation.y = THREE.MathUtils.degToRad(config.model.yawOffset);
  yaw.add(model);

  const root = new THREE.Group();
  root.add(yaw);

  bounds.setFromObject(model);
  const footprint = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);
  root.add(createGroundShadow(footprint * 0.6));

  let mixer = null;
  let clipName = null;
  if (gltf.animations.length > 0) {
    mixer = new THREE.AnimationMixer(model);
    const clip = gltf.animations[0];
    mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
    clipName = clip.name;
  }

  return { root, yaw, mixer, clipName };
}
