/**
 * ── THE SAME EXPERIENCE, TRACKED BY SLAM INSTEAD OF THE COMPASS ────────────
 *
 * A second entry point, not a replacement. index.html is the approved build and
 * is untouched; this exists so the two can be compared on the same phone from
 * the same deploy.
 *
 * WHY IT EXISTS
 *
 * The complaint this addresses is the aircraft sliding against the scenery
 * while panning. In the LocAR build the cause is a timing mismatch: the model is
 * drawn from an orientation sensor that is essentially live, over a camera frame
 * tens of milliseconds old, so the model leads the background. That build now
 * measures the feed's age and cancels it, which removes most of it.
 *
 * SLAM removes the cause instead of correcting for it. 8th Wall's engine derives
 * the camera pose FROM the frame it is about to draw over, so the pose and the
 * background are the same instant by construction. There is no delay left to
 * cancel and nothing to tune.
 *
 * WHAT SLAM DOES NOT DO
 *
 * It has no idea where on Earth it is. Its world origin is wherever the session
 * started and its yaw is arbitrary. This experience is a GPS anchor with a
 * 2.5 km run on a true bearing, so the geography has to come from elsewhere:
 *
 *   rotation, short term   SLAM. Steady, synchronised with the picture, and
 *                          drifts slowly in yaw.
 *   rotation, long term    the compass. Absolutely referenced to true north,
 *                          accurate to about +/-10 degrees, and noisy.
 *   position               one GPS fix, taken as the origin. SLAM then tracks
 *                          movement from it far better than repeated fixes do.
 *
 * So the compass is used only to align the world once and then to correct SLAM's
 * yaw drift very slowly — a long time constant, because a fast one would just
 * feed compass noise back into a view SLAM is holding steady. This is the
 * complementary filter the LocAR build could not have: there, the compass WAS
 * the short-term signal, so its noise had nowhere to hide.
 */
import * as THREE from 'three';
import { XR8Promise } from '@8thwall/engine-binary';
import { config } from '../config.js';
import { loadModel } from '../model.js';
import { createFlightPath } from '../flight.js';
import { bearingBetween, distanceBetween } from '../geo.js';
import { INSTALLATION } from '../location.js';
import { bearingDelta, easeBearing, northYaw } from './north.js';

const status = (text) => {
  const el = document.getElementById('xr-status');
  if (el) el.textContent = text;
};

/** A compass bearing, in degrees, from a direction in the north-up frame. */
const bearingOf = (direction) => THREE.MathUtils.radToDeg(Math.atan2(direction.x, -direction.z));

async function start() {
  status('Waiting for a GPS fix…');

  // The origin. One fix, held: SLAM tracks movement from here far better than a
  // stream of fixes can, and each new fix would otherwise teleport the world.
  const origin = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (fix) => resolve({ lat: fix.coords.latitude, lon: fix.coords.longitude, accuracy: fix.coords.accuracy }),
      reject,
      { enableHighAccuracy: true, timeout: 30_000 },
    );
  });

  status('Loading the aircraft…');
  const model = await loadModel((fraction) => status(`Loading the aircraft… ${Math.round(fraction * 100)}%`));

  status('Starting tracking…');
  const XR8 = await XR8Promise;

  /*
   * The engine's ThreeJS module reads `window.THREE` rather than being handed a
   * module, because it predates bundlers being the norm and it builds the scene
   * itself. It must be the same instance we import, or `instanceof` fails
   * across the boundary and objects added here are silently ignored — the same
   * duplicate-three trap vite.config.js dedupes for locar.
   */
  window.THREE = THREE;

  /*
   * Everything geographic lives under `world`, in metres with north at -Z and
   * east at +X — the frame src/flight.js already authors its circuit in, so the
   * path and the heading need no reinterpretation here.
   *
   * `world.rotation.y` is the one number that ties that frame to SLAM's, and it
   * is the only thing the compass is allowed to touch.
   */
  const world = new THREE.Group();
  world.add(model.root);

  const anchor = config.anchor.mode === 'relative'
    ? null
    : { lat: config.anchor.lat, lon: config.anchor.lon, elevation: config.anchor.elevation };

  // Where the aircraft sits relative to the origin, in north-up metres.
  const place = () => {
    if (!anchor) {
      const { distance, bearing } = config.relative;
      const radians = THREE.MathUtils.degToRad(bearing);
      model.root.position.set(Math.sin(radians) * distance, config.anchor.elevation, -Math.cos(radians) * distance);
      return distance;
    }
    const range = distanceBetween(origin, anchor);
    const radians = THREE.MathUtils.degToRad(bearingBetween(origin, anchor));
    model.root.position.set(Math.sin(radians) * range, anchor.elevation, -Math.cos(radians) * range);
    return range;
  };
  const range = place();

  const flightPath = model.preset.behaviour === 'flight' ? createFlightPath(config.flight) : null;
  let flightTime = 0;

  /*
   * The compass, read straight rather than through LocAR. `webkitCompassHeading`
   * is already a true-north bearing on iOS; elsewhere `alpha` on an absolute
   * event is 360 - bearing.
   */
  let compassBearing = null;
  let compassAccuracy = null;
  const orientationEvent = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(orientationEvent, (event) => {
    if (typeof event.webkitCompassHeading === 'number' && event.webkitCompassHeading >= 0) {
      compassBearing = event.webkitCompassHeading;
      compassAccuracy = event.webkitCompassAccuracy ?? null;
    } else if (event.absolute && typeof event.alpha === 'number') {
      compassBearing = (360 - event.alpha) % 360;
    }
  });

  let aligned = false;
  const forward = new THREE.Vector3();

  /**
   * Ease `world.rotation.y` so the camera's SLAM heading agrees with the compass.
   *
   * The first fix snaps — there is nothing to preserve yet. After that the
   * correction is deliberately slow: SLAM's yaw drift is a matter of degrees per
   * minute, while the compass jitters by degrees per second, so anything quick
   * would import exactly the noise this build exists to avoid. A wildly
   * inaccurate compass reading is ignored outright.
   */
  function alignToNorth(camera, dt) {
    if (compassBearing === null) return;
    if (compassAccuracy !== null && compassAccuracy > 25) return;

    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const target = northYaw(bearingOf(forward), compassBearing);
    const current = THREE.MathUtils.radToDeg(world.rotation.y);
    // The first reading snaps: there is nothing worth preserving yet, and
    // easing in from an arbitrary yaw would swing the world across the sky.
    const next = aligned ? easeBearing(current, target, dt, config.xrNorthSmoothing) : target;
    world.rotation.y = THREE.MathUtils.degToRad(next);
    aligned = true;
  }

  const clock = new THREE.Clock();

  const experience = {
    name: 'tccc-flight',
    onStart: ({ canvas }) => {
      const { scene, camera, renderer } = XR8.Threejs.xrScene();
      scene.add(world);
      scene.add(new THREE.HemisphereLight(0xbfd6ff, 0x2a2a2a, 2.2));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(-60, 120, 40);
      scene.add(sun);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      void canvas;
      status('');
      window.__xr = {
        THREE, XR8, scene, camera, renderer, world, model, flightPath, origin, range,
        get compassBearing() { return compassBearing; },
        get worldYawDegrees() { return THREE.MathUtils.radToDeg(world.rotation.y); },
        get aligned() { return aligned; },
      };
    },
    onUpdate: () => {
      const { camera } = XR8.Threejs.xrScene();
      const dt = Math.min(clock.getDelta(), 0.1);
      alignToNorth(camera, dt);
      model.mixer?.update(dt);
      if (flightPath) {
        flightTime += dt;
        flightPath.apply(model.motion, flightTime);
      }
    },
  };

  XR8.XrController.configure({
    // Metres, matching GPS distances — 'responsive' would rescale the world as
    // tracking confidence changes, which would rescale a 400 m aircraft.
    scale: 'absolute',
    disableWorldTracking: false,
  });

  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(),
    XR8.Threejs.pipelineModule(),
    XR8.XrController.pipelineModule(),
    experience,
  ]);

  XR8.run({ canvas: document.getElementById('xr-canvas') });
}

document.getElementById('xr-start')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  document.getElementById('xr-gate')?.setAttribute('hidden', '');
  try {
    // iOS needs the motion permission asked for from inside a gesture.
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission();
    }
    await start();
  } catch (error) {
    document.getElementById('xr-gate')?.removeAttribute('hidden');
    button.disabled = false;
    status(`Could not start: ${error?.message ?? error}`);
  }
});
