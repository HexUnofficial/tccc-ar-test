import * as THREE from 'three';
import * as LocAR from 'locar';
import { config } from './config.js';
import { loadModel } from './model.js';
import { createHud } from './hud.js';
import { attachSimulator } from './simulate.js';
import { LocalMetresProjection } from './projection.js';
import { bearingBetween, destination, distanceBetween } from './geo.js';

const canvas = document.getElementById('scene');
const gate = document.getElementById('gate');
const gateButton = document.getElementById('gate-start');
const gateMessage = document.getElementById('gate-message');

const hud = createHud();
hud.setPanelVisible(config.debug);

/** Start fetching the model immediately; it should be ready before GPS is. */
const modelPromise = loadModel((progress) => {
  gateMessage.textContent = `Loading model… ${Math.round(progress * 100)}%`;
}).then((loaded) => {
  gateMessage.textContent = 'Ready';
  gateButton.disabled = false;
  return loaded;
}).catch((error) => {
  gateMessage.textContent = `Could not load the model: ${error.message}`;
  return null;
});

/**
 * iOS 13+ only delivers deviceorientation events after an explicit grant, and
 * the request must happen inside a user gesture. We do it ourselves rather than
 * letting LocAR pop its own dialog, so there's a single tap to get into AR.
 */
async function requestOrientationPermission() {
  const api = window.DeviceOrientationEvent;
  if (typeof api?.requestPermission !== 'function') return true; // Android and desktop
  try {
    return (await api.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

function headingOf(camera) {
  // LocAR's world is north = -Z, east = +X, so the camera's forward vector maps
  // straight onto a compass bearing.
  const forward = camera.getWorldDirection(new THREE.Vector3());
  return ((Math.atan2(forward.x, -forward.z) * 180) / Math.PI + 360) % 360;
}

async function startAR() {
  gateButton.disabled = true;

  const orientationGranted = config.simulate || (await requestOrientationPermission());
  if (!orientationGranted) {
    gateMessage.textContent =
      'Motion & Orientation access was denied. Enable it in Settings → Safari, then reload.';
    gateButton.disabled = false;
    return;
  }

  const app = new LocAR.App({
    canvas,
    cameraOptions: { hFov: 80, near: 0.01, far: 5000 },
    gpsOptions: {
      gpsMinAccuracy: config.gps.minAccuracy,
      gpsMinDistance: config.gps.minDistance,
    },
    videoConstraints: { video: { facingMode: 'environment' } },
    // Real metres, not Mercator metres — see projection.js.
    projection: new LocalMetresProjection(),
    // We already handled the iOS grant above; in simulate mode we drive the
    // camera with the mouse instead of the sensors.
    deviceOrientationOptions: { enabled: !config.simulate, enablePermissionDialog: false },
  });

  const { scene, camera, renderer } = app;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1, 2, 1);
  scene.add(key);

  let locar;
  try {
    locar = await app.start();
  } catch (error) {
    gateMessage.textContent = `${error.code ?? 'Error'}: ${error.message}`;
    gateButton.disabled = false;
    return;
  }

  gate.hidden = true;
  hud.setStatus(config.simulate ? 'Simulated GPS — drag to look, WASD to walk' : 'Waiting for GPS…', 'warn');

  const model = await modelPromise;
  let anchor = null;
  let viewer = null;
  let simulator = null;

  /** Resolve where the model goes, then hand it to LocAR to hold in place. */
  function placeModel(position) {
    if (!model || anchor) return;

    anchor = config.anchor.mode === 'fixed'
      ? { lat: config.anchor.lat, lon: config.anchor.lon }
      : destination(position, config.anchor.bearing, config.anchor.distance);

    locar.add(model.root, anchor.lon, anchor.lat, config.anchor.elevation);

    // Exposed for the smoke test and for poking at state from a remote inspector
    // while you're standing in a field wondering why nothing is showing up.
    window.__ar = { THREE, app, locar, scene, camera, renderer, model, get anchor() { return anchor; } };
    hud.setStatus(`${model.clipName ? `Playing "${model.clipName}" — ` : ''}look around to find it`, 'ok');
    setTimeout(() => hud.setStatus(''), 6000);
  }

  // Note: GPS events are emitted by the LocAR engine, not the App wrapper.
  locar.on('gpsupdate', (event) => {
    const { latitude, longitude, accuracy } = event.position.coords;
    viewer = { lat: latitude, lon: longitude, accuracy };
    placeModel(viewer);
  });

  locar.on('gpserror', (error) => {
    hud.setStatus(
      error.code === 1
        ? 'Location permission denied — allow it and reload.'
        : `GPS error: ${error.message ?? error.code}`,
      'error',
    );
  });

  if (config.simulate) {
    const start = config.anchor.mode === 'fixed' && config.anchor.lat
      ? destination({ lat: config.anchor.lat, lon: config.anchor.lon }, 180, config.anchor.distance)
      : { lat: 51.05043, lon: 3.72509 };
    simulator = attachSimulator({
      camera, canvas, locar, start,
      onMove: (position) => { viewer = { ...position, accuracy: 5 }; },
    });
  } else {
    await locar.startGps();
  }

  // We take over the animation loop from LocAR so the mixer, the billboarding
  // and the HUD all advance on the same clock as the render.
  const clock = new THREE.Clock();
  let smoothedFps = 60;

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);

    if (config.simulate) simulator?.update(delta);
    else app.deviceOrientationControls?.update();

    model?.mixer?.update(delta);

    if (model && anchor && config.model.faceUser) {
      // Yaw-only billboard: turning to face the camera, never tipping over.
      const target = model.root.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
      model.yaw.rotation.y =
        Math.atan2(target.x, target.z) + THREE.MathUtils.degToRad(config.model.yawOffset);
    }

    renderer.render(scene, camera);

    if (delta > 0) smoothedFps += (1 / delta - smoothedFps) * 0.1;
    hud.update({
      position: viewer,
      heading: headingOf(camera),
      distance: viewer && anchor ? distanceBetween(viewer, anchor) : null,
      bearing: viewer && anchor ? bearingBetween(viewer, anchor) : null,
      anchor,
      fps: smoothedFps,
    });
  });
}

gateButton.addEventListener('click', startAR);
document.getElementById('panel-toggle').addEventListener('click', () => {
  config.debug = !config.debug;
  hud.setPanelVisible(config.debug);
});
