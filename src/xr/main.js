import * as THREE from 'three';
import { config } from '../config.js';
import { loadModel } from '../model.js';
import { createFlightPath } from '../flight.js';
import { createHud, formatDistance } from '../hud.js';
import { INSTALLATION } from '../location.js';
import { bearingBetween, destination, distanceBetween } from '../geo.js';
import { createGeoReference } from './georef.js';
import { createHeadingReader, requestOrientationPermission } from './heading.js';
import { watchGps } from './gps.js';
import { loadEngine, startSession, waitForXR8, worldBearingOf } from './session.js';
import { attachFlyControls, attachWebcamBackdrop, startSimulatedSession } from './simulate.js';

/**
 * ── THE 8TH WALL BUILD ────────────────────────────────────────────────────
 *
 * Same experience, different engine, and one structural change that is the
 * reason for the port: the camera and the world are now separate objects.
 *
 * XR8 owns the camera. It computes a 6DoF pose from the camera frames and
 * writes it onto the three.js camera every frame, and nothing in this file ever
 * writes `camera.position` or `camera.quaternion`. georef.js owns the world: it
 * holds the rigid transform between XR8's local frame and the real one, and the
 * aircraft's position is a number in that frame.
 *
 * What follows from that is the answer to the showstopper. The aircraft can fly
 * past you, overhead and away, because its path is expressed in a frame you are
 * not part of — so turning to follow it moves the camera and nothing else, and
 * walking towards it produces parallax rather than dragging it along. In the
 * LocAR build both of those arrived as world motion, because there was only ever
 * one frame and both sensors wrote into it.
 *
 * A good deal of the old main.js is simply gone rather than ported, and it is
 * worth knowing why, so that nobody re-adds it:
 *
 *   the rotation filters (fixed, 1€), `?smoothrot=`, `?beta=`, `?fcmin=`
 *       These smoothed a compass that the render no longer reads. SLAM's
 *       rotation is derived from the frame it is drawn over, so there is nothing
 *       to filter and nothing for a filter to lag behind.
 *
 *   feed latency matching, `?feedmatch=`, `?feedlag=`, the aim history ring
 *       All of it existed to line up a live sensor with a delayed video frame.
 *       XR8 derives the pose from that same frame, so they cannot disagree.
 *
 *   field-of-view matching, `?lens=`, `?vfov=`, `holdFieldOfView`
 *       XR8 supplies the real camera intrinsics as a projection matrix. The
 *       angles-to-pixels scale is now measured, not nulled by eye. Only the
 *       depth range is ours — see `setDepthRange`.
 *
 *   GPS averaging and follow-speed easing, `?avg=`, `?smooth=`, `?mindist=`
 *       These hid the fact that GPS was steering the camera. It no longer is.
 */

const canvas = document.getElementById('scene');
const gate = document.getElementById('gate');
const gateButton = document.getElementById('gate-start');
const gateMessage = document.getElementById('gate-message');

const hud = createHud();
hud.setChromeVisible(config.ui === 'debug');

/*
 * Start fetching the engine now, before anything else happens in this module.
 *
 * It is the largest thing the page downloads — 2.1 MB gzipped with the tracker —
 * and it is wanted only on this path, which is why the tags are not in
 * index.html. Kicking it off here rather than at the tap means it downloads
 * alongside the aircraft instead of after someone has already pressed Start.
 * Skipped under ?sim=1, which has no XR8 in it at all.
 */
if (!config.simulate) loadEngine();

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
 * Drop the browser chrome where we are allowed to. Android Chrome honours this;
 * iPhone Safari has no Fullscreen API, so there the only frameless route is Add
 * to Home Screen. Deliberately not awaited — on iOS an await here would spend
 * the user gesture that the motion prompt needs next.
 */
function requestFullscreen() {
  if (!config.fullscreen) return;
  const el = document.documentElement;
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (!request) return;
  Promise.resolve(request.call(el, { navigationUI: 'hide' })).catch(() => {});
}

/** Vertical field of view in radians, read off whatever projection XR8 gave us. */
const verticalFov = (camera) => 2 * Math.atan(1 / camera.projectionMatrix.elements[5]);

async function startAR() {
  gateButton.disabled = true;
  requestFullscreen();

  /*
   * The compass is needed for exactly one reading — which way XR8's world frame
   * is pointing — but that reading has to be taken while you are holding the
   * phone up at the scene, so the listener starts now and the value is consumed
   * when the first GPS fix lands. iOS requires the grant inside this gesture.
   */
  const heading = createHeadingReader();
  if (!config.simulate) {
    if (!(await requestOrientationPermission())) {
      gateMessage.textContent =
        'Motion & Orientation access was denied. Enable it in Settings → Safari, then reload.';
      gateButton.disabled = false;
      return;
    }
    heading.start();
  }

  const georef = createGeoReference({
    geoLock: config.xr.geoLock,
    correctionRate: config.xr.correctionRate,
    alignWalk: config.xr.alignWalk,
    walkBaseline: config.xr.walkBaseline,
  });

  /*
   * Every piece of mutable frame state is declared before the session is
   * created, because creating it starts the render loop: XR8 calls `onUpdate`
   * from its own pipeline and the simulator schedules a frame immediately, so
   * `frame` can run before this function has finished setting itself up.
   * `booting` is what keeps that first frame harmless.
   */
  let booting = true;
  let model = null;
  /** Where the world is tied to the map. Null until the first good fix. */
  let anchor = null;
  /** Last GPS fix, kept for its accuracy figure and the far-away warning. */
  let lastFix = null;
  let gpsError = null;
  let engineError = null;
  let tracking = { status: config.simulate ? 'NORMAL' : 'LIMITED', reason: 'INITIALIZING' };
  let welcomeUntil = 0;
  let flightPath = null;
  let flightTime = 0;
  /*
   * Scrubbing the circuit has to stop it advancing, or a test that pins the
   * aircraft to one instant still measures it moving 60 m/s between the two
   * frames it takes to read a position back.
   */
  let flightPaused = false;
  let smoothedFps = 60;

  let session;
  let controls = null;
  try {
    if (config.simulate) {
      attachWebcamBackdrop();
      session = startSimulatedSession({ canvas, onUpdate: (dt) => frame(dt), far: config.xr.far });
      controls = attachFlyControls({ camera: session.camera, canvas });
    } else {
      gateMessage.textContent = 'Starting 8th Wall…';
      await waitForXR8();
      session = await startSession({
        canvas,
        worldTracking: config.xr.worldTracking,
        scale: config.xr.scale,
        near: config.xr.near,
        far: config.xr.far,
        onUpdate: (dt) => frame(dt),
        onTracking: (state) => { tracking = state; },
        onError: (error) => { engineError = error.message; },
      });
    }
  } catch (error) {
    gateMessage.textContent = error.message;
    gateButton.disabled = false;
    return;
  }

  const { scene, camera, renderer } = session;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1, 2, 1);
  scene.add(key);

  gate.hidden = true;

  model = await modelPromise;
  if (model) {
    /*
     * The model joins the graph now and is placed later. Its `root` is the frame
     * georef owns: positioned at the anchor and yawed so that, inside it, north
     * is -Z — which is the convention flight.js is authored against, so the
     * circuit needs no knowledge of XR8's arbitrary starting direction.
     */
    model.root.visible = false;
    scene.add(model.root);
  }

  /**
   * The circuit cannot be built until the world is placed, because both of its
   * viewer-relative options need to know where you are standing. Unchanged from
   * the LocAR build — it is geodetic maths, and geodesy did not move.
   */
  function buildFlightPath(from, to) {
    const sightline = bearingBetween(from, to);
    const requested = config.flight.heading;
    let bearing;
    if (requested === 'across') bearing = (sightline + 90) % 360;
    else if (requested === 'along') bearing = sightline;
    else bearing = Number(requested) || 0;

    const range = distanceBetween(from, to);
    const length = config.flight.length === 'fit'
      ? THREE.MathUtils.clamp(1.1 * range, 25, 400)
      : Number(config.flight.length);

    return createFlightPath({
      ...config.flight,
      heading: bearing,
      length,
      maxBank: THREE.MathUtils.degToRad(config.flight.maxBank),
    });
  }

  /**
   * Tie the world frame to the map, and put the aircraft in it.
   *
   * This runs once. Everything it computes is a constant thereafter: where the
   * anchor is in world metres, which way north is, what circuit is being flown.
   * Nothing in the render loop revisits any of it.
   */
  function placeWorld(fix) {
    if (!model || georef.locked) return false;

    const cameraBearing = worldBearingOf(camera);
    let trueHeading;
    if (config.simulate) {
      // The simulated world is north-aligned unless a test asks otherwise, so
      // the two bearings agree and the yaw comes out as `simYaw`.
      trueHeading = cameraBearing + config.xr.simYaw;
    } else if (config.xr.yaw !== null) {
      // Stated outright: the setup ritual fixed where you stand and which way
      // you point, so the compass is not consulted at all.
      trueHeading = config.xr.yaw + cameraBearing;
    } else {
      if (heading.heading === null) return false; // no absolute reading yet
      if (heading.samples < config.xr.headingSamples) return false;
      trueHeading = heading.heading;
    }

    georef.lock({
      geo: fix,
      cameraWorld: camera.position,
      headingDeg: trueHeading,
      cameraBearing,
    });
    if (!config.simulate && config.xr.yaw === null) heading.stop();

    anchor = config.anchor.mode === 'fixed'
      ? { lat: config.anchor.lat, lon: config.anchor.lon }
      : destination(fix, config.anchor.bearing, config.anchor.distance);

    if (model.preset.behaviour === 'flight') flightPath = buildFlightPath(fix, anchor);

    model.root.visible = true;
    welcomeUntil = performance.now() + 6000;
    return true;
  }

  if (config.simulate) {
    /*
     * A closed loop rather than a script: the camera is moved by the controls,
     * and the fixes are computed back out of where it ended up. That is the same
     * direction of causation as the device, so the correction logic in georef is
     * exercised honestly rather than fed the answer.
     */
    const start = config.anchor.mode === 'fixed'
      ? destination(
          { lat: config.anchor.lat, lon: config.anchor.lon },
          config.viewFrom,
          config.xr.standoff,
        )
      : { lat: INSTALLATION.lat, lon: INSTALLATION.lon };

    lastFix = { ...start, accuracy: 5, at: Date.now() };
    placeWorld(start);

    setInterval(() => {
      const here = georef.geoFromWorld(camera.position);
      if (!here) return;
      // Metres of noise, converted through the same tangent plane the fix would
      // have come in on. Zero by default: noise is a thing to switch on when
      // testing the correction path, not a thing to fight by accident.
      const jitter = config.xr.simGpsNoise;
      const bearing = Math.random() * 360;
      const drifted = jitter > 0 ? destination(here, bearing, Math.random() * jitter) : here;
      lastFix = { ...drifted, accuracy: Math.max(jitter, 5), at: Date.now() };
      georef.submitFix({ geo: drifted, cameraWorld: camera.position });
    }, 1000);
  } else {
    watchGps({
      minAccuracy: config.gps.minAccuracy,
      onFix: (fix) => {
        lastFix = fix;
        gpsError = null;
        if (!georef.locked) placeWorld(fix);
        else georef.submitFix({ geo: fix, cameraWorld: camera.position });
      },
      onError: (message) => { gpsError = message; },
    });
  }

  // Scratch objects, hoisted out of the loop.
  const subjectPosition = new THREE.Vector3();
  const toSubject = new THREE.Vector3();
  const viewDirection = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const viewFrustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const worldBounds = new THREE.Box3();

  /** One frame. Called by XR8's pipeline, or by the simulator's own loop. */
  function frame(delta) {
    // The camera feed is already being drawn by the time the model finishes
    // decoding; there is simply nothing to update until it has.
    if (booting) return;

    /*
     * The depth range is not touched here. XR8 rewrites the projection matrix
     * from the camera intrinsics every frame, its own near and far planes
     * included, so the widening has to happen after that and before anything
     * draws — which is why startSession hooks the render call instead of relying
     * on where in the pipeline this function runs.
     */
    controls?.update(delta);
    georef.update(delta);

    /*
     * Retry the placement, rather than only attempting it as each fix lands.
     * The lock needs a GPS fix AND enough compass samples, and those arrive on
     * unrelated schedules — so a phone that delivers one fix and then goes quiet
     * (a doorway, a lull between satellites) could hold a good compass reading
     * and never be asked for it. Placing is a no-op once locked.
     */
    if (!georef.locked && lastFix) placeWorld(lastFix);

    /*
     * Re-derive the anchor's placement from georef every frame rather than
     * writing it once. It is three cheap assignments, and it means a slow
     * correction or a walk-refined yaw arrives without a second code path — the
     * transform is the single source of truth for where the world is.
     */
    if (model && anchor) {
      georef.worldFromGeo(anchor.lat, anchor.lon, config.anchor.elevation, model.root.position);
      model.root.rotation.y = georef.worldYawRadians;
    }

    model?.mixer?.update(delta);

    if (model && anchor) {
      if (flightPath) {
        if (!flightPaused) flightTime += delta;
        flightPath.apply(model.motion, flightTime);
      } else if (config.model.faceUser) {
        // Yaw-only billboard: turning to face the camera, never tipping over.
        const target = model.root.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
        model.motion.rotation.y = Math.atan2(target.x, target.z);
      }
    }

    if (delta > 0) smoothedFps += (1 / delta - smoothedFps) * 0.1;

    /*
     * The viewer's position is now SLAM's answer expressed as a lat/lon, not
     * GPS's. It is far steadier — it does not wander while you stand still — and
     * it is what the rest of the HUD should be measured against, because it is
     * the position the render actually used.
     */
    const viewer = georef.locked
      ? { ...georef.geoFromWorld(camera.position), accuracy: lastFix?.accuracy ?? Number.NaN }
      : null;
    const distance = viewer && anchor ? distanceBetween(viewer, anchor) : null;

    const tooFar = distance !== null
      && config.anchor.mode === 'fixed'
      && distance > config.anchor.farWarning;
    const lostTracking = tracking.status !== 'NORMAL';

    let text = '';
    let tone = 'neutral';
    if (engineError) {
      [text, tone] = [engineError, 'error'];
    } else if (gpsError) {
      [text, tone] = [gpsError, 'error'];
    } else if (!georef.locked) {
      [text, tone] = [
        heading.absolute === false && heading.samples === 0 && !config.simulate
          ? 'Waiting for GPS and compass…'
          : 'Waiting for GPS…',
        'warn',
      ];
    } else if (lostTracking) {
      /*
       * The specific failure this installation invites. An aircraft over a river
       * means a phone aimed at sky and water, and SLAM needs texture to hold a
       * pose — so tell people what to do about it rather than letting the world
       * quietly slide.
       */
      [text, tone] = [
        tracking.reason === 'INITIALIZING'
          ? 'Finding your surroundings — move the phone slowly.'
          : 'Tracking lost. Point at the skyline or the ground for a moment.',
        'warn',
      ];
    } else if (tooFar) {
      [text, tone] = [
        `${formatDistance(distance)} from ${INSTALLATION.label}. `
        + 'Add ?mode=relative to the URL to place it in front of you instead.',
        'warn',
      ];
    } else if (performance.now() < welcomeUntil) {
      [text, tone] = [
        `${model?.clipName ? `Playing "${model.clipName}" — ` : ''}look around to find it`,
        'ok',
      ];
    }

    const worthInterrupting = tone === 'warn' || tone === 'error';
    const showBanner = config.ui === 'debug' || (config.ui === 'minimal' && worthInterrupting);
    hud.setStatus(showBanner ? text : '', tone);

    let subject = null;
    let pointer = null;
    if (model && anchor) {
      model.motion.getWorldPosition(subjectPosition);
      const range = subjectPosition.distanceTo(camera.position);
      const angular = 2 * Math.atan(config.model.size / 2 / Math.max(range, 0.1));
      // Off the projection matrix rather than camera.fov: XR8 writes the matrix
      // from the real intrinsics and never touches the convenience property.
      const pixelsPerRadian = renderer.domElement.clientHeight / verticalFov(camera);
      subject = { range, pixels: angular * pixelsPerRadian };

      toSubject.subVectors(subjectPosition, camera.position);
      camera.getWorldDirection(viewDirection);
      const behind = toSubject.dot(viewDirection) < 0;

      ndc.copy(subjectPosition).project(camera);
      const x = behind ? -ndc.x : ndc.x;
      const y = behind ? -ndc.y : ndc.y;

      /*
       * On-screen is a frustum test against the model's bounding box, not a
       * check on its centre: the centre of a banner-towing aeroplane is the
       * empty middle of the tow line, so testing it made the arrow appear while
       * the aircraft was plainly in view.
       */
      viewFrustum.setFromProjectionMatrix(
        viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      const onScreen = model.localBounds
        ? viewFrustum.intersectsBox(
            worldBounds.copy(model.localBounds).applyMatrix4(model.motion.matrixWorld),
          )
        : !behind && Math.abs(x) < 1 && Math.abs(y) < 1;

      pointer = { angle: (Math.atan2(x, y) * 180) / Math.PI, range, onScreen };
    }

    hud.update({
      position: viewer,
      // True heading, derived from SLAM through georef rather than read off the
      // compass. Steady enough to be worth showing, which it never was before.
      heading: georef.locked ? (georef.yaw + worldBearingOf(camera)) % 360 : null,
      distance,
      subject,
      pointer,
      bearing: viewer && anchor ? bearingBetween(viewer, anchor) : null,
      anchor,
      fps: smoothedFps,
      tracking: config.simulate ? 'simulated' : `${tracking.status}${tracking.reason ? ` (${tracking.reason})` : ''}`,
      georef: georef.locked
        ? `${georef.yaw.toFixed(1)}° · ${georef.residual === null ? '—' : `${georef.residual.toFixed(1)} m`}`
        : 'not locked',
    });
  }

  /*
   * Exposed for the test tools and for poking at state from a remote inspector
   * while standing in a field wondering why nothing is showing up. `georef` is
   * the addition that matters: it is what tools/parallax-test.mjs interrogates.
   */
  window.__ar = {
    THREE,
    session,
    scene,
    camera,
    renderer,
    model,
    georef,
    controls,
    get anchor() { return anchor; },
    get flightPath() { return flightPath; },
    flightConfig: config.flight,
    get tracking() { return tracking; },
    get viewerFix() { return lastFix; },
    /** Scrub the circuit to a fixed time and hold it there. */
    setFlightTime(t) { flightTime = t; flightPaused = true; },
    /** Let it fly again. */
    resumeFlight() { flightPaused = false; },
    /** Move the camera as if you had walked, for the parallax test. */
    teleportCamera(x, y, z) { camera.position.set(x, y, z); },
  };

  booting = false;
}

gateButton.addEventListener('click', startAR);
document.getElementById('panel-toggle').addEventListener('click', () => {
  config.ui = config.ui === 'debug' ? 'minimal' : 'debug';
  hud.setChromeVisible(config.ui === 'debug');
});
