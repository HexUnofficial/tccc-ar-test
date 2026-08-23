import * as THREE from 'three';
import * as LocAR from 'locar';
import { config } from './config.js';
import { createFeedLagMeter } from './feedlag.js';
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
      // 1 disables LocAR's own per-event easing. We ease per rendered frame
      // instead — see `followAim` — so its factor would only compound with ours
      // on the wrong clock.
      smoothingFactor: 1,
    },
  });

  const { scene, camera, renderer } = app;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  /**
   * Match the render's field of view to the lens, and keep it matched.
   *
   * Everything here except the lens itself is measurable. The feed is drawn with
   * `object-fit: cover`, so given the video's real dimensions and the viewport's
   * the crop is determined; and because that crop preserves the container's
   * aspect exactly, a single vertical fov describes the view. So the only input
   * that has to be assumed is the camera's own angle of view — see
   * `config.lensFov` — and the orientation of the feed, which decides whether
   * the answer is nearer 42° or 68°, is read rather than guessed.
   *
   * Re-applied every frame rather than once, because LocAR recomputes
   * `fov = hFov / aspect` on each resize. Measured: a 414x896 to 414x700 change
   * took its fov from 173.1° to 60.0°, so on a phone the world's scale shifted
   * whenever the browser toolbar appeared. Comparing a float per frame is
   * cheaper than that bug.
   */
  const video = () => document.querySelector('video');

  function lensVerticalFov() {
    if (config.verticalFov > 0) return config.verticalFov;
    if (config.lensFov <= 0) return 0;

    const feed = video();
    const vw = feed?.videoWidth ?? 0;
    const vh = feed?.videoHeight ?? 0;
    const cw = renderer.domElement.clientWidth;
    const ch = renderer.domElement.clientHeight;
    // Before the first frame arrives there is nothing to match; leave it alone
    // rather than guess and then visibly change our mind.
    if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0) return 0;

    // The lens angle is quoted across the frame's long axis.
    const half = Math.tan(THREE.MathUtils.degToRad(config.lensFov) / 2);
    const [tanH, tanV] = vw >= vh ? [half, (half * vh) / vw] : [(half * vw) / vh, half];

    // cover scales to fill, so the smaller axis is the one left fully visible.
    const scale = Math.max(cw / vw, ch / vh);
    const visibleV = Math.min(1, ch / (vh * scale));
    void tanH;
    return 2 * THREE.MathUtils.radToDeg(Math.atan(tanV * visibleV));
  }

  function holdFieldOfView() {
    const wanted = lensVerticalFov();
    if (wanted <= 0 || Math.abs(camera.fov - wanted) < 0.01) return;
    camera.fov = wanted;
    camera.updateProjectionMatrix();
  }
  holdFieldOfView();
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
      /** Measured age of the displayed camera frame, ms, or null if unreported. */
      get feedLatencyMs() { return measuredFeedLatency; },
      get renderDelaySeconds() { return renderDelay(); },
      get activeRotationFilter() { return activeFilter; },
      /** Feed age measured from the pixels, seconds, or null before it locks. */
      get flowLatencySeconds() { return flowMeter?.latencySeconds ?? null; },
      get flowCorrelation() { return flowMeter?.correlation ?? 0; },
      /** Exposed so the estimator can be driven against a synthetic camera. */
      createFeedLagMeter,
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

  /*
   * Let the display, not the compass, decide when the view moves.
   *
   * LocAR rotates the camera inside its deviceorientation handler and its
   * update() does nothing, so between sensor events the view is frozen. We
   * render at 60fps; iOS delivers orientation more slowly and at uneven
   * intervals. The result is that panning advances in steps timed by the sensor
   * rather than by the display, and that stepping is the jitter — which is why
   * no value of smoothingFactor fixed it. Smoothing only changes how big each
   * step is, never that the motion is quantised to when readings land.
   *
   * So the sensor now drives a detached object and the camera eases towards it
   * once per rendered frame. Motion becomes continuous at the display's rate,
   * and what used to be a per-event fraction becomes an honest time constant:
   * `?smoothrot=` in seconds. It doubles as latency matching — the camera feed
   * is itself delayed by some tens of milliseconds, so easing the overlay
   * slightly keeps the two closer together than snapping it to the sensor does.
   */
  const aim = new THREE.Object3D();
  aim.rotation.reorder('YXZ');
  aim.quaternion.copy(camera.quaternion);
  if (app.deviceOrientationControls) {
    app.deviceOrientationControls.object = aim;
    // Its own easing would compound with ours, and per event is the wrong clock.
    app.deviceOrientationControls.smoothingFactor = 1;
  }

  /**
   * The fraction of the remaining error a first-order low-pass removes this
   * frame, for a given cutoff. Straight from the 1€ filter's definition:
   * tau = 1/(2*pi*fc), alpha = 1/(1 + tau/dt).
   */
  const cutoffAlpha = (hz, dt) => 1 / (1 + 1 / (2 * Math.PI * hz * dt));

  /** Cutoff for the speed estimate itself, in Hz — the paper's dcutoff. */
  const SPEED_CUTOFF = 1;
  const previousAim = new THREE.Quaternion().copy(aim.quaternion);
  /** Filtered angular speed of the readings, radians per second. */
  let aimSpeed = 0;

  /*
   * ── MATCHING THE CAMERA FEED ──────────────────────────────────────────────
   *
   * The complaint this addresses is "the model follows the camera for a bit"
   * while panning, and it survived every attempt to tune the rotation filter
   * because the filter was never the whole cause.
   *
   * The aircraft is drawn from the orientation sensor, which is essentially
   * live. The background it is drawn over came through the camera pipeline and
   * is tens of milliseconds old. Panning at 60 deg/s, an 80 ms feed puts the
   * background 4.8 degrees behind where the phone is actually pointing — so a
   * perfectly tracked model LEADS the scenery it is supposed to be standing in.
   * Removing smoothing makes that worse, not better, which is why the AR.js
   * #278 workaround measured well against true heading and badly against a real
   * feed.
   *
   * SLAM-based WebAR does not have this problem because it derives its pose
   * from the same frame it draws over. We cannot do that with a raw <video>,
   * but we can ask how old the frame being shown is:
   * requestVideoFrameCallback reports `captureTime` for camera frames, so
   * expectedDisplayTime - captureTime is the latency, measured on the actual
   * device rather than guessed at from a desk.
   *
   * Off unless asked for with ?feedmatch=1, and it only ever reports a delay
   * for `renderDelay` to consume — a phone that does not populate captureTime
   * leaves it null and everything behaves exactly as before.
   */
  let measuredFeedLatency = null;
  let feedWatchArmed = false;
  /** Which filter the last rendered frame actually used. Exposed for tests. */
  let activeFilter = null;
  function trackFeedLatency() {
    const feed = video();
    if (!feed?.requestVideoFrameCallback) return;
    let smoothed = null;
    const step = (_now, metadata) => {
      const { captureTime, expectedDisplayTime } = metadata ?? {};
      // Both are on the same clock as performance.now(). A phone that reports
      // no capture time gives NaN here, which must not become a delay.
      const latency = expectedDisplayTime - captureTime;
      if (Number.isFinite(latency) && latency >= 0 && latency < 500) {
        // Heavily smoothed: this is a property of the device, and a single
        // frame that arrived late is not a reason to move the whole world.
        smoothed = smoothed === null ? latency : smoothed + 0.05 * (latency - smoothed);
        measuredFeedLatency = smoothed;
      }
      feed.requestVideoFrameCallback(step);
    };
    feed.requestVideoFrameCallback(step);
  }

  /*
   * Measuring the feed's age from the pixels, as well as asking for it.
   *
   * `captureTime` above is free when a browser reports it, but nothing requires
   * one to, and a fix that silently does nothing on the single handset that
   * matters is not a fix. This second route needs no cooperation: it correlates
   * how far the image slides against how fast the sensor says the phone is
   * turning, and the lag between those two signals IS the feed's age. It also
   * measures the whole chain end to end, including whatever the display adds,
   * where captureTime only covers the capture pipeline.
   *
   * Preferred over captureTime when it has locked on, for that reason.
   */
  let flowMeter = null;
  const yawOf = (() => {
    const forward = new THREE.Vector3();
    return (quaternion) => {
      forward.set(0, 0, -1).applyQuaternion(quaternion);
      return Math.atan2(forward.x, -forward.z) * 180 / Math.PI;
    };
  })();
  let previousYaw = null;

  function updateFlowMeter(dt) {
    if (!config.feedMatch) return;
    const feed = video();
    if (!feed) return;
    if (!flowMeter) flowMeter = createFeedLagMeter({ video: feed });
    const yaw = yawOf(aim.quaternion);
    if (previousYaw !== null && dt > 0) {
      let delta = yaw - previousYaw;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      flowMeter.update(dt, delta / dt);
    }
    previousYaw = yaw;
  }

  /**
   * How far behind the sensor the camera should be rendered, in seconds.
   *
   * ?feedlag= states it outright and wins, for pinning a known figure or
   * checking a suspected one by hand. Otherwise the measurements are preferred
   * in order of how much they actually cover — pixels over metadata — and the
   * fallback is used only when neither is available at all.
   */
  function renderDelay() {
    if (config.feedLag > 0) return config.feedLag;
    if (!config.feedMatch) return 0;
    const fromPixels = flowMeter?.latencySeconds;
    if (fromPixels !== null && fromPixels !== undefined) return fromPixels;
    if (measuredFeedLatency !== null) return measuredFeedLatency / 1000;
    return config.feedFallback;
  }

  /*
   * A short history of sensor orientations, so the camera can be pointed where
   * the phone was pointing when the visible frame was captured. A ring long
   * enough for any plausible feed latency and no longer.
   */
  const aimHistory = [];
  function aimAsOf(delay) {
    if (delay <= 0 || aimHistory.length === 0) return aim.quaternion;
    const at = performance.now() - delay * 1000;
    let chosen = aimHistory[0].q;
    for (let i = aimHistory.length - 1; i >= 0; i -= 1) {
      if (aimHistory[i].t <= at) { chosen = aimHistory[i].q; break; }
    }
    return chosen;
  }

  function followAim(dt) {
    if (!app.deviceOrientationControls || dt <= 0) return;

    /*
     * Record first, then aim at the past. With no delay configured this is the
     * newest entry, so the behaviour is bit-for-bit what it was.
     */
    const now = performance.now();
    aimHistory.push({ t: now, q: aim.quaternion.clone() });
    while (aimHistory.length > 2 && aimHistory[1].t < now - 600) aimHistory.shift();
    const delay = renderDelay();
    const target = aimAsOf(delay);

    /*
     * 'auto' resolves per frame rather than at startup: the feed's age is
     * measured from the frames themselves, so whether a delay is being applied
     * is not known until some have arrived. Falling back to the plain filter
     * when it is not keeps a browser that reports no capture time on exactly
     * the behaviour that shipped before feed matching existed.
     */
    const filter = config.rotationFilter === 'auto'
      ? (delay > 0 ? 'euro' : 'fixed')
      : config.rotationFilter;
    activeFilter = filter;

    if (filter === 'euro') {
      /*
       * How fast the readings are actually turning. A magnitude only — the axis
       * is never used and nothing is projected forward, so unlike the reverted
       * prediction this cannot turn noise into movement. It can only decide how
       * hard to smooth.
       */
      const turning = previousAim.angleTo(target) / dt;
      previousAim.copy(target);
      aimSpeed += cutoffAlpha(SPEED_CUTOFF, dt) * (turning - aimSpeed);

      const cutoff = config.euroMinCutoff + config.euroBeta * aimSpeed;
      camera.quaternion.slerp(target, cutoffAlpha(cutoff, dt));
      return;
    }

    const tau = config.orientationSmoothing;
    // Exponential approach expressed per second, so the feel does not change
    // with frame rate. tau <= 0 means track the sensor exactly.
    camera.quaternion.slerp(target, tau > 0 ? 1 - Math.exp(-dt / tau) : 1);
  }

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);

    holdFieldOfView();

    // The <video> is injected by LocAR after the session starts, so the watch
    // is armed on the first frame it exists rather than at setup.
    if (!feedWatchArmed && video()) { feedWatchArmed = true; trackFeedLatency(); }
    if (!config.simulate) updateFlowMeter(delta);

    if (config.simulate) simulator?.update(delta);
    else {
      app.deviceOrientationControls?.update();
      followAim(delta);
    }

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
