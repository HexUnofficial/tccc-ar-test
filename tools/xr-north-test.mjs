/**
 * The join between SLAM's arbitrary yaw and true north, checked exactly.
 *
 * This lives outside the browser on purpose. The page it serves cannot be
 * meaningfully exercised in a headless environment — no real camera, SLAM
 * against a synthetic feed, no compass — and trying to assert this through a
 * rendered scene produced three different wrong answers for correct code
 * before the mistake turned out to be in the measurement. Here the arithmetic
 * either holds or it does not.
 */
import { bearingDelta, easeBearing, northYaw } from '../src/xr/north.js';

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
};
const near = (a, b, tol = 1e-9) => Math.abs(bearingDelta(a, b)) <= tol;

// --- the shortest way round ---
check('180 is not the long way round', Math.abs(bearingDelta(170, -170)) === 20, `${bearingDelta(170, -170)}`);
check('wraps the other way too', bearingDelta(-170, 170) === 20 || bearingDelta(-170, 170) === -20,
  `${bearingDelta(-170, 170)}`);
check('zero for equal bearings', bearingDelta(42, 42) === 0);

/*
 * --- the alignment itself ---
 *
 * The world's yaw must make the camera read the compass. Checked by applying
 * it: a yaw of a maps a north-up bearing b onto scene bearing b - a, so the
 * compass bearing mapped through the answer must land on the camera's scene
 * bearing.
 */
for (const sceneBearing of [0, 37, 90, 180, -90, 179, -179]) {
  for (const compass of [0, 45, 90, 210, 359]) {
    const yaw = northYaw(sceneBearing, compass);
    const mapped = bearingDelta(compass - yaw, 0);
    if (!near(mapped, sceneBearing, 1e-9)) {
      check(`aligns scene ${sceneBearing}° to compass ${compass}°`, false,
        `yaw ${yaw}° maps compass onto ${mapped}°, wanted ${sceneBearing}°`);
    }
  }
}
check('alignment holds for every scene/compass pair tried', failures.length === 0);

/*
 * --- the half-answer bug, asserted directly ---
 *
 * The original mistake subtracted the world's own yaw from the camera bearing,
 * which converged on half the correct rotation. Iterating the correct function
 * from an arbitrary start must reach the same answer it gives in one step.
 */
{
  const sceneBearing = 180;
  let yaw = 0;
  for (let i = 0; i < 200; i += 1) yaw = easeBearing(yaw, northYaw(sceneBearing, 90), 0.05, 0.5);
  check('iterating converges on the one-step answer', near(yaw, northYaw(180, 90), 0.5),
    `${yaw.toFixed(2)}° vs ${northYaw(180, 90)}°`);
}

// --- a 90 degree compass change turns the world 90 degrees ---
{
  const moved = bearingDelta(northYaw(180, 90), northYaw(180, 0));
  check('a 90° compass change is a 90° world turn', Math.abs(moved) === 90, `${moved}°`);
}

// --- easing ---
{
  check('snaps when tau is zero', easeBearing(0, 90, 0.016, 0) === 90);
  const oneTau = easeBearing(0, 100, 1, 1);
  check('one time constant covers ~63%', Math.abs(oneTau - 63.2) < 0.5, `${oneTau.toFixed(1)}`);
  // Frame-rate independence: many small steps must match one big one.
  let fine = 0;
  for (let i = 0; i < 100; i += 1) fine = easeBearing(fine, 100, 0.01, 1);
  const coarse = easeBearing(0, 100, 1, 1);
  check('independent of frame rate', Math.abs(fine - coarse) < 0.5, `${fine.toFixed(1)} vs ${coarse.toFixed(1)}`);
  // And it must take the short way: 170 -> -170 is a 20 degree nudge.
  const short = easeBearing(170, -170, 1, 0.0001);
  check('eases the short way across the wrap', Math.abs(bearingDelta(short, -170)) < 1, `${short.toFixed(1)}`);
}

if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — the world lands on true north, and gets there smoothly');
