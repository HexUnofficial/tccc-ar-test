import * as THREE from 'three';
import * as LocAR from 'locar';
import { config } from './config.js';
import { loadModel } from './model.js';
import { createFlightPath } from './flight.js';
import { createHud, formatDistance } from './hud.js';
import { attachSimulator } from './simulate.js';
import { LocalMetresProjection } from './projection.js';
import { INSTALLATION } from './location.js';
import { bearingBetween, destination, distanceBetween } from './geo.js';

const canvas = document.getElementById('scene');
const gate = document.getElementById('gate');
const gateButton = document.getElementById('gate-start');
const gateMessage = document.getElementById('gate-message');

const hud = createHud();
hud.setChromeVisible(config.ui === 'debug');

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
/**
 * Drop the browser chrome where we're allowed to.
 *
 * Android Chrome honours this. iPhone Safari has no Fullscreen API at all, so
 * there the only frameless route is Add to Home Screen, which launches via the
 * manifest with no chrome. Deliberately not awaited: on iOS an await here would
 * spend the user gesture that the motion-permission prompt needs next.
 */
function requestFullscreen() {
  if (!config.fullscreen) return;
  const el = document.documentElement;
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (!request) return; // iPhone Safari
  Promise.resolve(request.call(el, { navigationUI: 'hide' })).catch(() => {
    // Refused (iframe policy, user setting) — the experience still works.
  });
}

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
  requestFullscreen();

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
    deviceOrientationOptions: {
      enabled: !config.simulate,
      enablePermissionDialog: false,
      smoothingFactor: config.orientationSmoothing,
    },
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

  /*
   * The banner is derived from state every frame rather than written at the
   * moment something happens. Imperatively setting it meant a transient GPS
   * error - routine among tall buildings - would overwrite the "you are 3 km
   * away" warning and nothing would ever put it back.
   */
  let gpsError = null;
  let welcomeUntil = 0;

  let flightPath = null;
  let flightTime = 0;

  /**
   * The circuit can't be built until the first fix, because both of its
   * viewer-relative options need to know where you're standing.
   *
   * `heading` decides which way the aircraft beats back and forth: a fixed
   * compass bearing on site (point it down the river), or resolved against your
   * line of sight for testing. `length: 'fit'` sizes the straight leg to the
   * camera's view at the anchor's distance, so the aircraft stays in frame
   * instead of vanishing off the side for most of the circuit.
   */
  function buildFlightPath(from, to) {
    const sightline = bearingBetween(from, to);
    const requested = config.flight.heading;
    let heading;
    if (requested === 'across') heading = (sightline + 90) % 360;
    else if (requested === 'along') heading = sightline;
    else heading = Number(requested) || 0;

    const range = distanceBetween(from, to);
    const length = config.flight.length === 'fit'
      // Roughly two thirds of the frame width at that range, clamped so a
      // faraway anchor doesn't ask for a kilometre-long racetrack.
      ? THREE.MathUtils.clamp(1.1 * range, 25, 400)
      : Number(config.flight.length);

    return createFlightPath({
      ...config.flight,
      heading,
      length,
      maxBank: THREE.MathUtils.degToRad(config.flight.maxBank),
    });
  }

  /** Resolve where the model goes, then hand it to LocAR to hold in place. */
  function placeModel(position) {
    if (!model || anchor) return;

    anchor = config.anchor.mode === 'fixed'
      ? { lat: config.anchor.lat, lon: config.anchor.lon }
      : destination(position, config.anchor.bearing, config.anchor.distance);

    if (model.preset.behaviour === 'flight') {
      flightPath = buildFlightPath(position, anchor);
    }

    locar.add(model.root, anchor.lon, anchor.lat, config.anchor.elevation);

    // Exposed for the smoke test and for poking at state from a remote inspector
    // while you're standing in a field wondering why nothing is showing up.
    window.__ar = {
      THREE, app, locar, scene, camera, renderer, model,
      get anchor() { return anchor; },
      flightPath,
      flightConfig: config.flight,
      /** Scrub the circuit to a fixed time, for screenshots and tests. */
      setFlightTime(t) { flightTime = t; },
    };
    welcomeUntil = performance.now() + 6000;
  }

  /*
   * LocAR teleports the camera to each accepted fix. We let it write the
   * authoritative position, then render a followed position that chases it at a
   * constant speed.
   *
   * Easing exponentially towards the target looked smooth on paper but still
   * read as stepping: it surges the instant a fix lands, then coasts to a halt
   * before the next one arrives. Instead we latch a speed when each fix comes
   * in, sized so the camera arrives exactly as the following fix is due. At a
   * steady walking pace that works out to a constant speed — continuous growth
   * rather than a series of lurches — and it naturally winds down to nothing
   * when you stand still.
   */
  const MAX_FOLLOW_SPEED = 20; // m/s, a guard against wild GPS spikes
  const gpsTarget = new THREE.Vector3();
  const followed = new THREE.Vector3();
  let tracking = false;
  let followSpeed = 0;
  let lastFixAt = null;
  let fixInterval = 1; // seconds between fixes, smoothed
  const recentFixes = [];

  // Note: GPS events are emitted by the LocAR engine, not the App wrapper.
  locar.on('gpsupdate', (event) => {
    const { latitude, longitude, accuracy } = event.position.coords;
    viewer = { lat: latitude, lon: longitude, accuracy };
    gpsError = null; // a good fix supersedes any earlier failure

    /*
     * LocAR has already written the raw fix to the camera. Average the last few
     * rather than following each one: see config.gps.averageFixes for why a
     * deadband was the wrong tool here.
     */
    recentFixes.push(camera.position.clone());
    while (recentFixes.length > config.gps.averageFixes) recentFixes.shift();

    gpsTarget.set(0, 0, 0);
    for (const fix of recentFixes) gpsTarget.add(fix);
    gpsTarget.divideScalar(recentFixes.length);
    gpsTarget.y = camera.position.y;

    const now = performance.now() / 1000;
    if (lastFixAt !== null) {
      const elapsed = now - lastFixAt;
      // Ignore absurd gaps (backgrounded tab, first fix after a stall).
      if (elapsed > 0.05 && elapsed < 10) fixInterval += (elapsed - fixInterval) * 0.3;
    }
    lastFixAt = now;

    if (!tracking) {
      followed.copy(gpsTarget); // first fix: just be there
      tracking = true;
    } else if (config.gps.smoothing > 0) {
      const travelTime = config.gps.smoothing * fixInterval;
      followSpeed = Math.min(followed.distanceTo(gpsTarget) / travelTime, MAX_FOLLOW_SPEED);
    } else {
      followed.copy(gpsTarget);
    }

    placeModel(viewer);
  });

  locar.on('gpserror', (error) => {
    gpsError = error.code === 1
      ? 'Location permission denied — allow it and reload.'
      : `Lost GPS${error.message ? `: ${error.message}` : ''}. Waiting for a fix…`;
  });

  if (config.simulate) {
    // Stand off the anchor on the configured bearing, so the simulated view
    // matches where a real spectator would be.
    const start = config.anchor.mode === 'fixed' && config.anchor.lat
      ? destination(
          { lat: config.anchor.lat, lon: config.anchor.lon },
          config.viewFrom,
          config.anchor.distance,
        )
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
  const subjectPosition = new THREE.Vector3();
  const toSubject = new THREE.Vector3();
  const viewDirection = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const viewFrustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const worldBounds = new THREE.Box3();
  let smoothedFps = 60;

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);

    if (config.simulate) simulator?.update(delta);
    else app.deviceOrientationControls?.update();

    if (tracking) {
      const remaining = followed.distanceTo(gpsTarget);
      if (remaining > 1e-4 && followSpeed > 0) {
        const step = Math.min(remaining, followSpeed * delta);
        followed.lerp(gpsTarget, step / remaining);
      }
      // Height is LocAR's business (setElevation); we only follow on the ground.
      camera.position.x = followed.x;
      camera.position.z = followed.z;
    }

    model?.mixer?.update(delta);

    if (model && anchor) {
      if (flightPath) {
        // Anchored models sit still; this one flies a circuit around the anchor.
        flightTime += delta;
        flightPath.apply(model.motion, flightTime);
      } else if (config.model.faceUser) {
        // Yaw-only billboard: turning to face the camera, never tipping over.
        const target = model.root.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
        model.motion.rotation.y = Math.atan2(target.x, target.z);
      }
    }

    renderer.render(scene, camera);

    if (delta > 0) smoothedFps += (1 / delta - smoothedFps) * 0.1;

    const distance = viewer && anchor ? distanceBetween(viewer, anchor) : null;

    /*
     * Being in the wrong place looks identical to the AR being broken: a big
     * number that barely moves, and no model anywhere. Say which it is. Walking
     * 20 m towards something 3 km away is a real 20 m of progress and utterly
     * imperceptible, so the distance readout alone doesn't give the game away.
     */
    const tooFar = distance !== null
      && config.anchor.mode === 'fixed'
      && distance > config.anchor.farWarning;

    let text = '';
    let tone = 'neutral';
    if (gpsError) {
      [text, tone] = [gpsError, 'error'];
    } else if (tooFar) {
      [text, tone] = [
        `${formatDistance(distance)} from ${INSTALLATION.label}. ` +
        'Add ?mode=relative to the URL to place it in front of you instead.',
        'warn',
      ];
    } else if (performance.now() < welcomeUntil) {
      [text, tone] = [`${model?.clipName ? `Playing "${model.clipName}" — ` : ''}look around to find it`, 'ok'];
    } else if (!viewer) {
      [text, tone] = [config.simulate ? 'Simulated GPS — drag to look, WASD to walk' : 'Waiting for GPS…', 'warn'];
    }

    // In minimal mode the overlay earns its place only when something is wrong;
    // in none mode it never does.
    const worthInterrupting = tone === 'warn' || tone === 'error';
    const showBanner = config.ui === 'debug' || (config.ui === 'minimal' && worthInterrupting);
    hud.setStatus(showBanner ? text : '', tone);

    // What the model looks like from here, which for a distant flypast is the
    // number that decides whether the whole thing reads or not.
    let subject = null;
    let pointer = null;
    if (model && anchor) {
      model.motion.getWorldPosition(subjectPosition);
      const range = subjectPosition.distanceTo(camera.position);
      const angular = 2 * Math.atan(config.model.size / 2 / Math.max(range, 0.1));
      const pixelsPerRadian = renderer.domElement.clientHeight
        / THREE.MathUtils.degToRad(camera.fov);
      subject = { range, pixels: angular * pixelsPerRadian };

      /*
       * Where to point the "it's over there" arrow. Projecting into screen
       * space handles both axes at once and, unlike comparing compass
       * bearings, copes with the model being above or below the frame.
       */
      toSubject.subVectors(subjectPosition, camera.position);
      camera.getWorldDirection(viewDirection);
      const behind = toSubject.dot(viewDirection) < 0;

      ndc.copy(subjectPosition).project(camera);
      // project() mirrors anything behind the camera, so un-mirror it.
      const x = behind ? -ndc.x : ndc.x;
      const y = behind ? -ndc.y : ndc.y;

      /*
       * Whether the model is on screen is decided by its bounding box, not by
       * its centre. Testing the centre made the arrow appear while the aircraft
       * was still plainly in view, because the centre of a banner-towing
       * aeroplane is the empty middle of the tow line.
       *
       * Corners that project in front of the camera give a 2D rect; if that
       * rect overlaps the viewport at all, some part of the model is visible.
       * A box straddling the camera plane always counts as visible.
       */
      /*
       * Whether the model is on screen is a frustum test against its bounding
       * box, not a check on its centre.
       *
       * Testing the centre made the arrow appear while the aircraft was still
       * plainly in view, because the centre of a banner-towing aeroplane is the
       * empty middle of the tow line. Hand-rolling the box test then got the
       * far-off-axis case wrong — a box can straddle the camera plane while
       * lying entirely off to one side. Three's Frustum handles every case.
       */
      viewFrustum.setFromProjectionMatrix(
        viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      const onScreen = model.localBounds
        ? viewFrustum.intersectsBox(
            worldBounds.copy(model.localBounds).applyMatrix4(model.motion.matrixWorld),
          )
        : !behind && Math.abs(x) < 1 && Math.abs(y) < 1;

      pointer = {
        angle: (Math.atan2(x, y) * 180) / Math.PI, // 0 = straight up
        range,
        onScreen,
      };
    }

    hud.update({
      position: viewer,
      heading: headingOf(camera),
      distance,
      subject,
      pointer,
      bearing: viewer && anchor ? bearingBetween(viewer, anchor) : null,
      anchor,
      fps: smoothedFps,
    });
  });
}

gateButton.addEventListener('click', startAR);
document.getElementById('panel-toggle').addEventListener('click', () => {
  config.ui = config.ui === 'debug' ? 'minimal' : 'debug';
  hud.setChromeVisible(config.ui === 'debug');
});
