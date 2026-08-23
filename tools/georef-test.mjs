/**
 * ── THE GEOREFERENCE, IN ISOLATION ────────────────────────────────────────
 *
 * The parallax test proves the world does not move when the camera does. This
 * one proves it is in the *right place* — which is a different question, and the
 * one with a sign error waiting in it.
 *
 * XR8 puts its world origin wherever the camera was when the session started and
 * aligns -Z with wherever it happened to be pointing. Everything geodetic
 * therefore passes through one rotation, and if that rotation is backwards the
 * symptom on site is an aircraft in exactly the wrong quadrant of the sky — with
 * nothing on screen to say so, because there is no reference to line it up
 * against a kilometre away over water. It has to be checked here instead.
 *
 * No browser: georef.js only needs three's maths.
 */
import * as THREE from 'three';
import { createGeoReference } from '../src/xr/georef.js';
import { bearingBetween, destination, distanceBetween } from '../src/geo.js';

const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const close = (a, b, tol) => Math.abs(a - b) <= tol;

/** London, for no reason other than that it is where the installation is. */
const HERE = { lat: 51.5104797, lon: -0.0900796 };

/**
 * Lock a georeference with a stated world yaw. `cameraBearing` is what SLAM
 * says the camera is facing within its own frame, `headingDeg` what the compass
 * says it is facing in the world; the difference is the yaw, so passing
 * (yaw + 0, 0) is the direct way to ask for a particular one.
 */
function locked(yaw, at = HERE, cameraWorld = new THREE.Vector3(0, 1.6, 0)) {
  const georef = createGeoReference({ geoLock: 'once' });
  georef.lock({ geo: at, cameraWorld, headingDeg: yaw, cameraBearing: 0 });
  return georef;
}

console.log('\n──── the yaw convention ────');
{
  // World frame aligned with north: the classic three.js arrangement, north on
  // -Z and east on +X. Anything else here means the whole port is mirrored.
  const georef = locked(0);
  const to = destination(HERE, 0, 100);
  const north = georef.worldFromGeo(to.lat, to.lon, 0);
  check('yaw 0: 100 m north lands on -Z',
    close(north.x, 0, 0.05) && close(north.z, -100, 0.2),
    `(${north.x.toFixed(2)}, ${north.z.toFixed(2)})`);

  const east = georef.worldFromGeo(destination(HERE, 90, 100).lat, destination(HERE, 90, 100).lon, 0);
  check('yaw 0: 100 m east lands on +X',
    close(east.x, 100, 0.2) && close(east.z, 0, 0.05),
    `(${east.x.toFixed(2)}, ${east.z.toFixed(2)})`);
}
{
  /*
   * The case that actually catches a sign error. Yaw 90 means the world's -Z
   * axis points due east — you started the session facing east — so something
   * due north of you is off to your LEFT, which is -X. Get the sign backwards
   * and it appears to the right instead: 180° wrong, and invisible on site.
   */
  const georef = locked(90);
  const to = destination(HERE, 0, 100);
  const north = georef.worldFromGeo(to.lat, to.lon, 0);
  check('yaw 90: 100 m north lands on -X (to your left)',
    close(north.x, -100, 0.2) && close(north.z, 0, 0.05),
    `(${north.x.toFixed(2)}, ${north.z.toFixed(2)})`);

  const ahead = destination(HERE, 90, 100);
  const eastward = georef.worldFromGeo(ahead.lat, ahead.lon, 0);
  check('yaw 90: 100 m east lands on -Z (straight ahead)',
    close(eastward.x, 0, 0.05) && close(eastward.z, -100, 0.2),
    `(${eastward.x.toFixed(2)}, ${eastward.z.toFixed(2)})`);
}

console.log('\n──── round trips ────');
{
  // Every yaw, every bearing: worldFromGeo and geoFromWorld must be inverses,
  // or the HUD's reported position drifts away from where the content is.
  let worstPosition = 0;
  let worstBearing = 0;
  for (const yaw of [0, 37, 90, 114.5, 180, 271, 359]) {
    const georef = locked(yaw);
    for (const bearing of [0, 45, 114.5, 200, 315]) {
      for (const range of [5, 200, 2500]) {
        const target = destination(HERE, bearing, range);
        const world = georef.worldFromGeo(target.lat, target.lon, 0);
        const back = georef.geoFromWorld(world);
        worstPosition = Math.max(worstPosition, distanceBetween(target, back));

        // And the bearing of that world offset, read back through georef, has to
        // be the bearing we asked for.
        const offset = world.clone().sub(georef.worldOrigin);
        const measured = georef.bearingOfWorld(offset);
        const error = Math.abs(((measured - bearing + 540) % 360) - 180);
        worstBearing = Math.max(worstBearing, error);
        /*
         * These cannot agree exactly, and the residue is not an error to chase.
         * `destination` walks a great circle and `bearingOfWorld` reads a flat
         * plane, and the meridians converge between them: the gap is about
         * (dlon * sin(lat)) / 2, which at 2.5 km and 51.5N is 0.014 degrees.
         * That is 0.65 m of lateral position at 2.5 km — an order of magnitude
         * inside GPS, and two inside what anyone can see against open water.
         */
      }
    }
  }
  check('geo -> world -> geo is lossless', worstPosition < 0.02,
    `worst ${(worstPosition * 1000).toFixed(2)} mm across 105 combinations`);
  check('world offsets read back as the right bearing', worstBearing < 0.05,
    `worst ${worstBearing.toFixed(4)}° (meridian convergence, not error)`);
}

console.log('\n──── elevation is not rotated ────');
{
  const georef = locked(114.5);
  const target = destination(HERE, 200, 800);
  const world = georef.worldFromGeo(target.lat, target.lon, 50);
  check('50 m of elevation is 50 m of +Y, whatever the yaw', close(world.y, 50, 1e-9),
    `y = ${world.y}`);
  // And the ground offset is unchanged by it, so altitude cannot shorten range.
  const flat = georef.worldFromGeo(target.lat, target.lon, 0);
  check('elevation does not disturb the ground position',
    close(Math.hypot(world.x - flat.x, world.z - flat.z), 0, 1e-9));
}

console.log('\n──── the origin sits on the ground, not at the eye ────');
{
  // XR8's absolute scale puts y = 0 at the detected ground plane and the camera
  // about 1.6 m above it, while `elevation` in this project means metres above
  // your feet. Taking the camera's y would sink the world by your own height.
  const georef = locked(0, HERE, new THREE.Vector3(3, 1.65, -4));
  check('origin takes the camera x/z', close(georef.worldOrigin.x, 3, 1e-9)
    && close(georef.worldOrigin.z, -4, 1e-9));
  check('origin drops the camera height', close(georef.worldOrigin.y, 0, 1e-9),
    `y = ${georef.worldOrigin.y}`);
}

console.log('\n──── lock() derives yaw from the two bearings ────');
{
  /*
   * The one measurement the port cannot derive. If SLAM says the camera faces
   * 30° within its own frame and the compass says it faces 200° in the world,
   * then the world frame's -Z points at 170°.
   */
  const georef = createGeoReference({ geoLock: 'once' });
  georef.lock({
    geo: HERE,
    cameraWorld: new THREE.Vector3(),
    headingDeg: 200,
    cameraBearing: 30,
  });
  check('yaw = compass heading - world bearing', close(georef.yaw, 170, 1e-9),
    `${georef.yaw}°`);

  // And it has to wrap rather than go negative, or every downstream rotation is
  // off by a turn in a way that only shows up at some headings.
  const wrapped = createGeoReference({ geoLock: 'once' });
  wrapped.lock({ geo: HERE, cameraWorld: new THREE.Vector3(), headingDeg: 10, cameraBearing: 350 });
  check('yaw wraps into 0-360', close(wrapped.yaw, 20, 1e-9), `${wrapped.yaw}°`);
}

console.log('\n──── geoLock modes ────');
{
  const camera = new THREE.Vector3(0, 1.6, 0);
  // 'once': a fix 12 m away must be reported and then ignored.
  const once = locked(0);
  const anchorBefore = once.worldFromGeo(HERE.lat, HERE.lon, 0).clone();
  once.submitFix({ geo: destination(HERE, 45, 12), cameraWorld: camera });
  const anchorAfter = once.worldFromGeo(HERE.lat, HERE.lon, 0);
  check("'once' reports the residual", close(once.residual, 12, 0.05),
    `${once.residual.toFixed(2)} m`);
  check("'once' does not move the world", anchorBefore.distanceTo(anchorAfter) < 1e-9);

  // 'follow': the same fix must move it, and by the amount of the residual.
  const follow = createGeoReference({ geoLock: 'follow' });
  follow.lock({ geo: HERE, cameraWorld: camera, headingDeg: 0, cameraBearing: 0 });
  const before = follow.worldFromGeo(HERE.lat, HERE.lon, 0).clone();
  follow.submitFix({ geo: destination(HERE, 45, 12), cameraWorld: camera });
  const moved = before.distanceTo(follow.worldFromGeo(HERE.lat, HERE.lon, 0));
  check("'follow' moves the world by the residual", close(moved, 12, 0.05),
    `${moved.toFixed(2)} m`);

  /*
   * And the direction has to be right. GPS saying you are north-east of where
   * SLAM put you means the world has to shift south-west relative to you — the
   * opposite sign is the classic way to make content run away as you walk.
   */
  const shifted = follow.worldFromGeo(HERE.lat, HERE.lon, 0);
  const bearingOfShift = follow.bearingOfWorld(shifted.clone().sub(before));
  check("'follow' corrects in the opposite direction to the residual",
    close(Math.abs(((bearingOfShift - 225 + 540) % 360) - 180), 0, 0.5),
    `shifted towards ${bearingOfShift.toFixed(1)}°, expected 225°`);

  // 'slow' must rate-limit rather than snap, and must eventually arrive.
  const slow = createGeoReference({ geoLock: 'slow', correctionRate: 0.5 });
  slow.lock({ geo: HERE, cameraWorld: camera, headingDeg: 0, cameraBearing: 0 });
  const slowBefore = slow.worldFromGeo(HERE.lat, HERE.lon, 0).clone();
  slow.submitFix({ geo: destination(HERE, 45, 12), cameraWorld: camera });
  slow.update(1);
  const afterOneSecond = slowBefore.distanceTo(slow.worldFromGeo(HERE.lat, HERE.lon, 0));
  check("'slow' moves at the configured rate", close(afterOneSecond, 0.5, 1e-6),
    `${afterOneSecond.toFixed(3)} m in the first second`);
  for (let i = 0; i < 60; i += 1) slow.update(1);
  // A millimetre, not zero: `update` has a 0.1 mm deadband so it stops rather
  // than chasing float noise forever, and it can stop anywhere inside it.
  check("'slow' eventually arrives", slow.pending < 1e-3,
    `${(slow.pending * 1000).toFixed(3)} mm left`);
}

console.log('\n──── walk alignment recovers a wrong compass ────');
{
  /*
   * The scenario this exists for: an Android magnetometer 40° out, so the world
   * is locked 40° wrong and the aircraft is in the wrong part of the sky. Walk a
   * line and the pairing of GPS bearing against SLAM displacement should find
   * the error without the compass being consulted again.
   */
  const truth = 114.5;
  const georef = createGeoReference({
    geoLock: 'once', alignWalk: true, walkBaseline: 8, yawBlend: 0.6,
  });
  georef.lock({ geo: HERE, cameraWorld: new THREE.Vector3(), headingDeg: truth - 40, cameraBearing: 0 });
  check('starts 40 degrees wrong', close(georef.yaw, truth - 40, 1e-9), `${georef.yaw.toFixed(1)}°`);

  /*
   * Walk 60 m due east in the real world. In a world frame whose -Z points at
   * `truth`, that displacement is Ry(truth) applied to (east, 0, -north) — so
   * the SLAM positions are generated from the correct yaw, and the solver has to
   * find it from the mismatch with its own wrong one.
   */
  const oracle = locked(truth);
  for (let step = 1; step <= 30; step += 1) {
    const geo = destination(HERE, 90, step * 2);
    const world = oracle.worldFromGeo(geo.lat, geo.lon, 0);
    georef.submitFix({ geo, cameraWorld: world });
  }
  const error = Math.abs(((georef.yaw - truth + 540) % 360) - 180);
  check('walking recovers the true yaw', error < 1.5,
    `settled at ${georef.yaw.toFixed(1)}°, truth ${truth}°, error ${error.toFixed(2)}°`);
}

console.log('\n──── geodesy still agrees with itself ────');
{
  // georef has its own tangent-plane projection; it must not disagree with the
  // great-circle helpers the flight path is built from.
  const georef = locked(0);
  let worst = 0;
  for (const bearing of [0, 60, 150, 240, 330]) {
    const target = destination(HERE, bearing, 1500);
    const world = georef.worldFromGeo(target.lat, target.lon, 0);
    const flat = Math.hypot(world.x - georef.worldOrigin.x, world.z - georef.worldOrigin.z);
    worst = Math.max(worst, Math.abs(flat - 1500));
    const measured = bearingBetween(HERE, target);
    worst = Math.max(worst, Math.abs(((measured - bearing + 540) % 360) - 180) * 26);
  }
  // 1500 m is well inside where a tangent plane and a sphere part company.
  check('tangent plane agrees with great-circle distance at 1.5 km', worst < 0.5,
    `worst ${worst.toFixed(3)} m`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll georeference checks passed.');
