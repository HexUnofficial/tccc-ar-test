/**
 * ── WHAT CAN BE CHECKED WITHOUT AN 8TH WALL KEY ───────────────────────────
 *
 * XR8 is a hosted script keyed to an account and locked to authorised domains,
 * so the tracking itself cannot be exercised from a test runner on localhost.
 * Two things around it can be, and both are things that would otherwise fail
 * silently on site:
 *
 *   1. the depth range. XR8 rewrites the projection matrix from the camera
 *      intrinsics every frame, near and far planes included, sized for content
 *      within reach. This installation's straight leg is 2475 m. If the widening
 *      in setDepthRange is wrong the aircraft is simply clipped away for most of
 *      its circuit, which reads on site as the model failing to load.
 *
 *   2. the missing-key path. A build deployed without VITE_XR8_APP_KEY must say
 *      so, on screen, and leave the gate usable — not white-screen and not sit
 *      on "Loading model…" forever while someone stands in a field.
 *
 * What is NOT covered here, and has to be checked on a device: that XR8's pose
 * is good, that absolute scale puts the ground where it should, and that
 * tracking holds when the phone is pointed at open sky. See the README.
 */
import * as THREE from 'three';
import { chromium } from 'playwright';
import { setDepthRange } from '../src/xr/session.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

console.log('\n──── widening the depth range ────');
{
  /*
   * Stand in for what XR8 hands over: a projection with a near far plane. The
   * numbers do not have to match XR8's, only be too small — the point is that
   * whatever it chooses gets replaced without disturbing the calibration.
   */
  const camera = new THREE.PerspectiveCamera(55, 414 / 896, 0.1, 100);
  camera.updateProjectionMatrix();
  const before = camera.projectionMatrix.elements.slice();

  setDepthRange(camera, 0.01, 8000);
  const after = camera.projectionMatrix.elements;

  // The focal terms carry the whole calibration. Touching either would move
  // every pixel of registration, which is the one thing this must not do.
  check('focal length preserved',
    Math.abs(after[0] - before[0]) < 1e-12 && Math.abs(after[5] - before[5]) < 1e-12,
    `x ${after[0].toFixed(6)}, y ${after[5].toFixed(6)}`);
  // Principal point too, for an off-centre intrinsic matrix.
  check('principal point preserved',
    Math.abs(after[8] - before[8]) < 1e-12 && Math.abs(after[9] - before[9]) < 1e-12);
  check('near and far reported back', camera.near === 0.01 && camera.far === 8000,
    `${camera.near} … ${camera.far}`);

  /** Is a point `metres` straight ahead inside the clip range? */
  const inside = (metres) => {
    const ndc = new THREE.Vector3(0, 0, -metres).project(camera);
    return ndc.z > -1 && ndc.z < 1;
  };

  // The whole reason this function exists: the far end of the circuit.
  check('a point 2.5 km ahead is inside the frustum', inside(2500));
  check('a point 4 km ahead is inside the frustum', inside(4000));
  check('a point 9 km ahead is beyond it', !inside(9000));
  check('a point 5 cm ahead is inside it', inside(0.05));

  // Three caches the inverse; writing to `elements` directly does not refresh it,
  // and the HUD's arrow and any future raycast both read it.
  const round = new THREE.Vector3(0.3, -0.2, 0.5)
    .applyMatrix4(camera.projectionMatrixInverse)
    .applyMatrix4(camera.projectionMatrix);
  check('projectionMatrixInverse kept in step',
    Math.abs(round.x - 0.3) < 1e-6 && Math.abs(round.z - 0.5) < 1e-6,
    `(${round.x.toFixed(6)}, ${round.z.toFixed(6)})`);

  // Idempotent: it runs every frame, so a second call must be a no-op.
  const twice = camera.projectionMatrix.elements.slice();
  setDepthRange(camera, 0.01, 8000);
  check('re-applying changes nothing',
    camera.projectionMatrix.elements.every((v, i) => Math.abs(v - twice[i]) < 1e-15));
}

console.log('\n──── a build with no app key says so ────');
{
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--ignore-certificate-errors',
    ],
  });
  const ctx = await browser.newContext({
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: 51.5104797, longitude: -0.0900796, accuracy: 6 },
    ignoreHTTPSErrors: true,
    viewport: { width: 414, height: 896 },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // No appkey, and no VITE_XR8_APP_KEY in a local build, so this is the
  // misconfigured-deploy case exactly.
  await page.goto(`${BASE}/?ui=debug`, { waitUntil: 'load' });
  await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
  await page.click('#gate-start');

  // The message has to arrive without the gate being dismissed, or the user is
  // left looking at a camera feed with nothing in it and no explanation.
  await page.waitForFunction(
    () => /app key/i.test(document.getElementById('gate-message')?.textContent ?? ''),
    null,
    { timeout: 20_000 },
  ).catch(() => {});

  const state = await page.evaluate(() => ({
    message: document.getElementById('gate-message')?.textContent ?? '',
    gateVisible: !document.getElementById('gate')?.hidden,
    buttonUsable: !document.getElementById('gate-start')?.disabled,
  }));

  check('the message names the missing key', /app key/i.test(state.message), state.message.trim());
  check('it mentions the way to run without one', /sim=1/.test(state.message));
  check('the gate stays up', state.gateVisible);
  check('the button is usable again', state.buttonUsable);
  check('no unhandled page errors', errors.length === 0, errors.join('; '));

  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll XR8 harness checks passed.');
