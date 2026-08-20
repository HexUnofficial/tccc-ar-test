import * as THREE from 'three';
import { destination } from './geo.js';

/**
 * Desktop stand-in for the phone's sensors: drag to look, WASD to walk.
 * Lets you verify placement, scale and animation without leaving your chair —
 * the laptop webcam still provides the passthrough feed.
 */
export function attachSimulator({ camera, canvas, locar, start, onMove }) {
  let position = { ...start };
  let yaw = 0;
  let pitch = 0;
  let dragging = false;
  let last = { x: 0, y: 0 };
  const keys = new Set();

  const push = () => {
    locar.fakeGps(position.lon, position.lat, null, 5);
    onMove?.(position);
  };

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

  push();

  return {
    /** Called once per frame from the render loop. */
    update(delta) {
      camera.rotation.order = 'YXZ';
      camera.rotation.set(pitch, yaw, 0);

      const forward = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
      const strafe = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
      if (forward === 0 && strafe === 0) return;

      const metres = 4 * delta; // a brisk walk
      // Camera yaw is anticlockwise from -Z; compass bearing is clockwise from north.
      const headingDeg = ((-yaw * 180) / Math.PI + 360) % 360;
      if (forward) position = destination(position, headingDeg, metres * forward);
      if (strafe) position = destination(position, (headingDeg + 90) % 360, metres * strafe);
      push();
    },

    /** Simulated compass heading, so the HUD arrow works on desktop too. */
    get heading() {
      return ((-yaw * 180) / Math.PI + 360) % 360;
    },
  };
}
