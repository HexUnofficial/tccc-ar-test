import * as THREE from 'three';

/**
 * ── DESKTOP STAND-IN ──────────────────────────────────────────────────────
 *
 * XR8 will not run without an app key and an authorised domain, and it will not
 * run on a laptop with any fidelity even then. So `?sim=1` replaces it with a
 * plain three.js scene and a free camera, and — this is the part that matters —
 * it models the thing 8th Wall actually provides: six degrees of freedom in a
 * world frame that stays put.
 *
 * The LocAR build's simulator could not do that. It moved the viewer by feeding
 * fake GPS in, because GPS was the only position input the engine had, so the
 * one behaviour you most needed to check — walking past something and watching
 * it hold still — was the behaviour the simulator could not reproduce. Here the
 * camera is translated directly in metres and GPS is synthesised *from* that,
 * which is the same direction of causation as the real thing.
 *
 * It is what tools/parallax-test.mjs drives, so the claim that the world and the
 * camera are now separable is checked on every run rather than asserted.
 */

/** Free-look controls: drag to aim, WASD to walk, QE for height. */
export function attachFlyControls({ camera, canvas, walkSpeed = 4 }) {
  let yaw = 0;
  let pitch = 0;
  let dragging = false;
  let last = { x: 0, y: 0 };
  const keys = new Set();
  const step = new THREE.Vector3();

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - last.x) * 0.005;
    pitch = THREE.MathUtils.clamp(pitch - (e.clientY - last.y) * 0.005, -Math.PI / 2, Math.PI / 2);
    last = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  return {
    update(dt) {
      camera.rotation.order = 'YXZ';
      camera.rotation.set(pitch, yaw, 0);

      const forward = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
      const strafe = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
      const rise = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0);
      if (!forward && !strafe && !rise) return;

      // Walking is horizontal whatever the pitch, so the forward axis is taken
      // from yaw alone rather than from where the camera is looking.
      const metres = walkSpeed * dt * (keys.has('shift') ? 6 : 1);
      step.set(
        strafe * Math.cos(yaw) - forward * Math.sin(yaw),
        rise,
        -strafe * Math.sin(yaw) - forward * Math.cos(yaw),
      );
      camera.position.addScaledVector(step, metres);
    },

    /** Where the camera looks, in world-frame degrees — georef turns it north. */
    get worldBearing() {
      return ((-yaw * 180) / Math.PI + 360) % 360;
    },
  };
}

/**
 * A stand-in for `startSession` with the same shape, so main.js does not branch
 * any further than choosing which one to await.
 */
export function startSimulatedSession({ canvas, onUpdate, near = 0.01, far = 5000, eyeHeight = 1.6 }) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  /*
   * 55° vertical is roughly a phone's main camera through a portrait cover-crop.
   * On the real device this number is not ours to choose — XR8 supplies the true
   * intrinsics — so it is a plausible stand-in rather than a setting to tune.
   */
  const camera = new THREE.PerspectiveCamera(55, 1, near, far);
  camera.position.set(0, eyeHeight, 0);
  scene.add(camera);

  const resize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  // A faint ground grid: without it there is no way to see whether the camera is
  // moving through the world or the world is moving past the camera, which is
  // the single distinction this whole branch is about.
  const grid = new THREE.GridHelper(400, 80, 0x335577, 0x223344);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    onUpdate?.(Math.min(clock.getDelta(), 0.1));
    renderer.render(scene, camera);
  });

  return { XR8: null, scene, camera, renderer, simulated: true };
}

/**
 * The laptop webcam behind the canvas, so the framing reads like the real thing.
 * Entirely cosmetic and entirely optional — a refused permission is fine.
 */
export async function attachWebcamBackdrop() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.id = 'sim-feed';
    document.body.prepend(video);
    return video;
  } catch {
    return null;
  }
}
