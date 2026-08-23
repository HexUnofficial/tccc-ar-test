/**
 * ── WHAT CAN BE CHECKED WITHOUT A CAMERA ──────────────────────────────────
 *
 * Headless Chromium has no camera to track against, so the pose itself cannot be
 * exercised here. Four things around it can be, and each would otherwise fail
 * silently on site:
 *
 *   1. the depth range. XR8 rewrites the projection matrix from the camera
 *      intrinsics every frame, near and far planes included, sized for content
 *      within reach. This installation's straight leg is 2475 m. If the widening
 *      in setDepthRange is wrong the aircraft is simply clipped away for most of
 *      its circuit, which reads on site as the model failing to load.
 *
 *   2. the runtime being served from our own origin. Since the hosted platform
 *      was retired in February 2026 the engine is an npm dependency staged into
 *      public/external/ — so a deploy that skipped `npm run xr8:sync`, or that
 *      still reached for apps.8thwall.com, is now a way to ship a dead page.
 *
 *   3. the missing-runtime path. It has to say so on screen and leave the gate
 *      usable, rather than white-screening or spinning forever while someone
 *      stands in a field.
 *
 *   4. the licence attribution. Clause 1.3 of the engine licence obliges the
 *      deployed experience to credit Niantic Spatial, and a gate redesign could
 *      drop it without anyone noticing.
 *
 * What is NOT covered here, and has to be checked on a device: that the pose is
 * good, that absolute scale puts the ground where it should, and that tracking
 * holds when the phone is pointed at open sky. See the README.
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

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--ignore-certificate-errors',
  ],
});

const newContext = () => browser.newContext({
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 51.5104797, longitude: -0.0900796, accuracy: 6 },
  ignoreHTTPSErrors: true,
  viewport: { width: 414, height: 896 },
});

console.log('\n──── the engine is served, not fetched from a CDN ────');
{
  /*
   * The hosted platform was retired in February 2026, so there is no app key and
   * nothing to authorise — but there is a new way to ship a broken build: forget
   * `npm run xr8:sync` and deploy without the runtime. These checks are what
   * would catch that in CI rather than in a field.
   */
  const ctx = await newContext();
  const page = await ctx.newPage();
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));

  await page.goto(`${BASE}/?ui=debug`, { waitUntil: 'load' });
  await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });

  const engine = await page.request.get(`${BASE}/external/xr/xr.js`);
  const extras = await page.request.get(`${BASE}/external/xrextras/xrextras.js`);
  const slam = await page.request.get(`${BASE}/external/xr/xr-slam.js`);
  check('xr.js is served from our own origin', engine.ok(),
    `${engine.status()} ${engine.headers()['content-type'] ?? ''}`);
  check('xrextras.js is served', extras.ok(), String(extras.status()));
  // The tracker is the part that matters and the part that is 5 MB; a partial
  // sync that dropped it would still leave a page that loads and never tracks.
  check('the SLAM chunk is served', slam.ok(), String(slam.status()));

  // Nothing may be fetched from the retired platform's hosts.
  const retired = requested.filter((u) => /apps\.8thwall\.com|cdn\.8thwall\.com/.test(u));
  check('nothing is requested from the retired hosted platform', retired.length === 0,
    retired.join('; '));

  check('the engine actually initialises', await page.evaluate(
    () => new Promise((resolve) => {
      if (window.XR8) return resolve(true);
      window.addEventListener('xrloaded', () => resolve(true), { once: true });
      setTimeout(() => resolve(Boolean(window.XR8)), 15_000);
    }),
  ));

  await ctx.close();
}

console.log('\n──── the engine failing to start explains itself ────');
{
  /*
   * Two different failures that look identical on screen if you are careless,
   * and they want different words, because they happen to different people.
   *
   * A blocked request is a network problem, and it happens to a spectator on a
   * riverbank. Telling them to add ?sim=1 would be nonsense — the simulator is a
   * desktop stand-in with no tracking in it.
   *
   * A missing script tag is a deploy problem, and it happens to us. That one
   * should name `xr8:sync` and offer the simulator, because the person reading it
   * is at a keyboard and can act on both.
   *
   * Either way the timeout in `waitForXR8` is what makes a message possible at
   * all: the official `XR8Promise` helper never rejects, so this is the case that
   * would otherwise spin forever with nothing on screen.
   */
  const arrive = async (page) => {
    await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
    await page.click('#gate-start');
    await page.waitForFunction(
      () => /engine/i.test(document.getElementById('gate-message')?.textContent ?? ''),
      null,
      { timeout: 40_000 },
    ).catch(() => {});
    return page.evaluate(() => ({
      message: document.getElementById('gate-message')?.textContent ?? '',
      gateVisible: !document.getElementById('gate')?.hidden,
      buttonUsable: !document.getElementById('gate-start')?.disabled,
    }));
  };

  /** Run the gate with the engine request handled by `handler`. */
  const withEngine = async (handler) => {
    const ctx = await newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/external/xr/xr.js', handler);
    await page.goto(`${BASE}/?ui=debug`, { waitUntil: 'load' });
    const state = await arrive(page);
    await ctx.close();
    return { ...state, errors };
  };

  // (a) 404 — a deploy that never ran xr8:sync. Ours to fix, so name the fix.
  {
    const state = await withEngine((route) => route.fulfill({ status: 404, body: '' }));
    check('a 404 names the fix', /xr8:sync/.test(state.message), state.message.trim());
    check('it offers the simulator', /sim=1/.test(state.message));
    // Both matter: dismissing the gate would leave someone looking at a bare
    // camera feed with no explanation and no way back.
    check('the gate stays up', state.gateVisible);
    check('the button is usable again', state.buttonUsable);
    check('no unhandled page errors', state.errors.length === 0, state.errors.join('; '));
  }

  // (b) the request dies — a spectator's connection, not our deploy. Do not
  //     send them to a desktop simulator.
  {
    const state = await withEngine((route) => route.abort());
    check('a dead connection says so', /reach|connection/i.test(state.message),
      state.message.trim());
    check('it does not offer the simulator', !/sim=1/.test(state.message));
    check('the gate stays up', state.gateVisible);
    check('no unhandled page errors', state.errors.length === 0, state.errors.join('; '));
  }

  // (c) served, but never announces itself — the tracker chunks failing partway
  //     on a weak signal, which is the likeliest of the three on site.
  {
    const state = await withEngine((route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: '/* served, but never fires xrloaded */',
    }));
    check('a silent engine says it did not start', /did not start/i.test(state.message),
      state.message.trim());
    check('it asks for a reload', /reload/i.test(state.message));
    check('the gate stays up', state.gateVisible);
    check('no unhandled page errors', state.errors.length === 0, state.errors.join('; '));
  }
}

console.log('\n──── the licence attribution is present ────');
{
  /*
   * Not housekeeping — a licence term. Clause 1.3 of the XR Engine License
   * Agreement requires the deployed experience to identify Niantic Spatial as
   * the engine's creator, carry a copyright notice, refer to the licence, and
   * note the disclaimer of warranties. A redesign of the gate could quietly drop
   * it, so it is asserted rather than trusted.
   */
  const ctx = await newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?ui=debug`, { waitUntil: 'load' });

  const credit = await page.evaluate(() => {
    const node = document.querySelector('.gate-credit');
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      text: node.textContent.replace(/\s+/g, ' ').trim(),
      href: node.querySelector('a')?.href ?? '',
      opacity: Number(style.opacity),
      visible: style.display !== 'none' && style.visibility !== 'hidden',
    };
  });

  check('an attribution line exists', credit !== null);
  check('it names Niantic Spatial', /Niantic Spatial/.test(credit?.text ?? ''), credit?.text);
  check('it carries a copyright notice', /©|\(c\)|Copyright/i.test(credit?.text ?? ''));
  check('it disclaims warranties', /warrant/i.test(credit?.text ?? ''));
  check('it links the licence', /8thwall\/engine.*LICENSE/i.test(credit?.href ?? ''), credit?.href);
  // Carrying the notice invisibly would not be carrying it.
  check('it is actually visible', credit?.visible === true && (credit?.opacity ?? 0) > 0.5,
    `opacity ${credit?.opacity}`);

  // And the licence files themselves have to reach the deploy, since clause 1.3
  // requires the notices to travel with every copy of the software.
  for (const path of ['/external/xr/LICENSE', '/external/xrextras/LICENSE']) {
    const res = await page.request.get(`${BASE}${path}`);
    check(`${path} is deployed`, res.ok(), String(res.status()));
  }

  await ctx.close();
}

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll XR8 harness checks passed.');
