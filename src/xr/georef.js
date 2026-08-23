import * as THREE from 'three';

/**
 * ── WHERE THE WORLD IS, AS DISTINCT FROM WHERE THE CAMERA IS ───────────────
 *
 * This is the module the port exists for.
 *
 * The LocAR build had one frame of reference and wrote both things into it. The
 * camera's rotation came from the compass, its position came from GPS, and the
 * anchor was a lat/lon converted into that same space. Every error in either
 * sensor therefore arrived as *world* motion: compass lag dragged the scene
 * along with a pan, a GPS fix landing 8 m away shoved the ground sideways, and
 * an aircraft flying past you was indistinguishable from an aircraft being
 * pushed off course by your own hands. No filter fixes that, because the
 * information needed to tell the two apart was never in the signals.
 *
 * 8th Wall changes what is available. XR8's world tracking derives a 6DoF pose
 * from the camera frames themselves, in a local world frame that stays put.
 * That gives two genuinely independent quantities for the first time:
 *
 *   camera pose   owned by SLAM, updated every frame, never written by us
 *   world anchor  owned by this module, in metres, in that same frame
 *
 * So the aircraft's position is computed once from its lat/lon and then lives
 * in the world frame as a plain number. Panning cannot move it, because panning
 * only changes the camera. Walking cannot move it either — walking moves the
 * camera through a world that is standing still, which is what parallax is.
 * The aircraft can fly past you because its path is expressed in a frame you
 * are not part of.
 *
 * All this module holds is the rigid transform between that world frame and the
 * real one: a translation (which world point a given lat/lon is) and a yaw
 * (which way is north). Resolved at the start of the session, then left alone.
 *
 * ── CONVENTIONS ───────────────────────────────────────────────────────────
 *
 * ENU is the geodetic frame: metres east, metres north, metres up, on a tangent
 * plane at `origin`. Three.js wants north on -Z and east on +X, so a
 * north-aligned three vector is (east, up, -north).
 *
 * `yaw` is the true compass bearing that the XR8 world's -Z axis points along.
 * XR8 puts its origin wherever the camera was when the session started and
 * aligns -Z with wherever it happened to be pointing, so this is the one
 * unknown that has to be measured rather than derived. Rotating a north-aligned
 * vector by Ry(yaw) lands it in the world frame; Ry(-yaw) brings it back.
 */

const R = 6371008.8;
const UP = new THREE.Vector3(0, 1, 0);
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * Metres east and north of `origin`, on a tangent plane anchored there.
 *
 * Not Mercator, deliberately — see the note in src/projection.js, which is what
 * the LocAR build needed to undo LocAR's own choice. Mercator's "metres" are
 * inflated by sec(latitude), so at 51°N an object 20 m away renders 32 m away.
 * Over the few hundred metres an AR session covers, a tangent plane's error is
 * millimetres.
 */
function enuFromGeo(origin, geo) {
  const cosLat = Math.cos(rad(origin.lat));
  return [rad(geo.lon - origin.lon) * R * cosLat, rad(geo.lat - origin.lat) * R];
}

function geoFromEnu(origin, east, north) {
  const cosLat = Math.cos(rad(origin.lat));
  return {
    lat: origin.lat + deg(north / R),
    lon: origin.lon + deg(east / (R * cosLat)),
  };
}

/** Shortest signed difference between two bearings, in degrees. */
const bearingDelta = (to, from) => ((to - from + 540) % 360) - 180;

/**
 * @param {object} [options]
 * @param {'once'|'slow'|'follow'} [options.geoLock]  what later GPS fixes do
 * @param {number} [options.correctionRate]  m/s cap on 'slow' corrections
 * @param {boolean} [options.alignWalk]  refine yaw from GPS-vs-SLAM displacement
 * @param {number} [options.walkBaseline]  metres of travel before that engages
 * @param {number} [options.yawBlend]  fraction of a yaw correction taken per fix
 */
export function createGeoReference({
  geoLock = 'once',
  correctionRate = 0.5,
  alignWalk = false,
  walkBaseline = 8,
  yawBlend = 0.25,
} = {}) {
  /** Geo position of `originWorld`. The tangent plane is anchored here. */
  let origin = null;
  /** World point that `origin` maps to. Ground level, so y is 0 by intent. */
  const originWorld = new THREE.Vector3();
  /** Where `originWorld` is heading, while a correction is being paid off. */
  const originTarget = new THREE.Vector3();
  /** True bearing of the world frame's -Z axis, in degrees. */
  let yaw = 0;

  /** Metres between the last GPS fix and where SLAM thought we were. */
  let residual = null;

  /** Samples for the walk-based yaw solve: world (x, z) paired with ENU (e, n). */
  const walk = [];
  let walkSumRe = 0;
  let walkSumIm = 0;

  const scratch = new THREE.Vector3();
  const offset = new THREE.Vector3();

  /** North-aligned (east, up, -north) rotated into the world frame. */
  function toWorldVector(east, up, north, out) {
    return out.set(east, up, -north).applyAxisAngle(UP, rad(yaw));
  }

  /** A world-frame offset expressed back as [east, north] metres. */
  function toEnuVector(direction) {
    offset.copy(direction).applyAxisAngle(UP, -rad(yaw));
    return [offset.x, -offset.z];
  }

  function geoFromWorld(point) {
    if (origin === null) return null;
    const [east, north] = toEnuVector(scratch.subVectors(point, originWorld));
    return geoFromEnu(origin, east, north);
  }

  /**
   * ── WALK ALIGNMENT ───────────────────────────────────────────────────────
   *
   * The compass is the weakest input in the whole system: iOS gives true north,
   * Android can be tens of degrees out until it has been waved in a figure of
   * eight, and getting it wrong swings a distant subject clean out of the sky.
   *
   * A better instrument is available, made of the two sensors we already have.
   * Walk twenty metres: GPS says which way you went in true bearings, SLAM says
   * which way you went in world axes, and one number relates them — the yaw. It
   * is a least-squares fit rather than a single reading, so it sharpens as you
   * walk instead of drifting as a compass does.
   *
   * Off by default: a spectator watching an aircraft over a river does not walk,
   * and a stationary phone contributes nothing but GPS noise. Turn it on with
   * ?alignwalk=1 during setup, walk a straight line, read the yaw off the HUD,
   * and hard-code it with ?yaw0= if you want it fixed.
   */
  function sampleWalk(geo, cameraWorld) {
    const [east, north] = enuFromGeo(origin, geo);
    const entry = { e: east, n: north, x: cameraWorld.x, z: cameraWorld.z };
    const from = walk.find((s) => Math.hypot(entry.e - s.e, entry.n - s.n) >= walkBaseline);
    walk.push(entry);
    if (walk.length > 240) walk.shift();
    if (!from) return;

    /*
     * Ry(yaw) acting on (x, z) is multiplication by exp(-i·yaw), so the yaw that
     * best maps every geodetic displacement onto its SLAM counterpart is the
     * argument of a single complex sum. Longer walks contribute larger terms,
     * which weights the fit by baseline without a weight ever being written.
     */
    const de = entry.e - from.e;
    const dn = entry.n - from.n;
    const dx = entry.x - from.x;
    const dz = entry.z - from.z;
    walkSumRe += dx * de - dz * dn;
    walkSumIm += dx * dn + dz * de;
    if (Math.hypot(walkSumRe, walkSumIm) < 1e-6) return;

    const solved = (deg(-Math.atan2(walkSumIm, walkSumRe)) + 360) % 360;
    yaw = ((yaw + yawBlend * bearingDelta(solved, yaw)) % 360 + 360) % 360;
  }

  return {
    get locked() { return origin !== null; },
    get origin() { return origin; },
    get yaw() { return yaw; },
    /** Metres of disagreement between GPS and SLAM at the last fix. */
    get residual() { return residual; },
    /** Metres of correction still owed, when geoLock is 'slow'. */
    get pending() { return origin === null ? 0 : originWorld.distanceTo(originTarget); },
    get worldOrigin() { return originWorld; },
    get walkSamples() { return walk.length; },

    /**
     * Tie the world frame to the real one. Called once, on the first fix good
     * enough to trust, with the camera pose that was current at that instant.
     *
     * @param {{lat:number, lon:number}} geo  where you are standing
     * @param {THREE.Vector3} cameraWorld     XR8's camera position right now
     * @param {number} headingDeg             true bearing the camera faces
     * @param {number} cameraBearing          that same facing, in world terms
     */
    lock({ geo, cameraWorld, headingDeg, cameraBearing }) {
      origin = { lat: geo.lat, lon: geo.lon };
      /*
       * The camera's x and z, but on the ground. XR8's absolute scale puts y = 0
       * at the ground plane and the camera about 1.6 m above it, while
       * `elevation` in this project means metres above your feet — so taking the
       * camera's y here would sink the whole world by your own height.
       */
      originWorld.set(cameraWorld.x, 0, cameraWorld.z);
      originTarget.copy(originWorld);
      /*
       * The same physical direction, named twice: once by the compass in true
       * bearings, once by SLAM in world axes. Their difference is the frame
       * offset, and it is the only thing about the world frame we cannot derive.
       */
      yaw = (((headingDeg - cameraBearing) % 360) + 360) % 360;
      residual = 0;
      return { origin, yaw };
    },

    /** Force the yaw, for a site where the setup ritual fixes where you stand. */
    setYaw(bearing) {
      yaw = ((bearing % 360) + 360) % 360;
    },

    /**
     * A new GPS fix.
     *
     * Note what does not happen here: the camera is never touched. LocAR
     * teleported the camera to every fix and then spent a great deal of effort
     * easing the teleport into something watchable. Here the camera belongs to
     * SLAM, and a fix can only ever adjust our belief about where the *world*
     * is. With `geoLock: 'once'` — the default — it does not even do that; it
     * only reports the disagreement so the HUD can show it.
     */
    submitFix({ geo, cameraWorld }) {
      if (origin === null) return;

      const here = geoFromWorld(cameraWorld);
      const [east, north] = enuFromGeo(here, geo);
      residual = Math.hypot(east, north);

      if (alignWalk) sampleWalk(geo, cameraWorld);
      if (geoLock === 'once') return;

      /*
       * Move the origin so the camera's SLAM position maps to the fix. Shifting
       * the origin *against* the residual is what leaves the camera alone: the
       * same world point simply now reads as a different lat/lon.
       */
      toWorldVector(east, 0, north, scratch);
      originTarget.copy(originWorld).sub(scratch);
      if (geoLock === 'follow') originWorld.copy(originTarget);
    },

    /**
     * Pay off a pending correction at a rate slow enough to go unnoticed.
     *
     * A correction is a real change to where the content is, so it can only be
     * spent in a way nobody sees. 0.5 m/s against a subject a kilometre away is
     * 0.03 degrees per second; against something 20 m away in relative mode it
     * is 1.4, which is why the default is not to correct at all.
     */
    update(dt) {
      if (origin === null || geoLock !== 'slow' || dt <= 0) return;
      const remaining = originWorld.distanceTo(originTarget);
      if (remaining < 1e-4) return;
      const step = Math.min(remaining, correctionRate * dt);
      originWorld.lerp(originTarget, step / remaining);
    },

    /** Where a lat/lon sits in the world frame, `elevation` metres up. */
    worldFromGeo(lat, lon, elevation = 0, out = new THREE.Vector3()) {
      if (origin === null) return out.set(0, elevation, 0);
      const [east, north] = enuFromGeo(origin, { lat, lon });
      toWorldVector(east, elevation, north, out);
      return out.add(originWorld);
    },

    /** What lat/lon a world point is — for the camera, the fused viewer fix. */
    geoFromWorld,

    /** A world-frame direction as a true compass bearing. */
    bearingOfWorld(direction) {
      const [east, north] = toEnuVector(direction);
      return (deg(Math.atan2(east, north)) + 360) % 360;
    },

    /** Yaw in radians, for putting a north-authored object into world space. */
    get worldYawRadians() { return rad(yaw); },
  };
}
