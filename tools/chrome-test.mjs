/**
 * Checks the frameless presentation: our own overlay stays out of the way by
 * default, and the browser's chrome is dismissed where the platform allows it.
 */
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';

// Headless Chromium reports no device orientation, which leaves the camera
// facing due south. An anchor due north is therefore reliably behind you.

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
// CHROMIUM_PATH is for environments that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

async function open(query) {
  const ctx = await browser.newContext({
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: INSTALLATION.lat - 20 / 111_320, longitude: INSTALLATION.lon, accuracy: 6 },
    ignoreHTTPSErrors: true, viewport: { width: 414, height: 896 },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${query.replace("?", "?engine=locar&")}`, { waitUntil: 'load' });
  await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
  await page.click('#gate-start');
  await page.waitForFunction(() => document.getElementById('f-anchor')?.textContent !== '—', { timeout: 20_000 });
  return { ctx, page };
}

/*
 * --- default: the arrow and nothing else, ever ---
 *
 * The default is `none`, not `minimal`: this runs over a live camera feed in
 * front of an audience, so the arrow is the only overlay that earns its place.
 * The cost is that a denied permission or a lost fix says nothing at all, which
 * is what ?ui=debug is for — so that trade is asserted here rather than left to
 * be discovered on site.
 */
{
  const { ctx, page } = await open('?mode=relative&distance=20&bearing=0');
  await page.waitForTimeout(500);
  check('telemetry panel hidden by default', !(await page.isVisible('#panel')));
  check('info button hidden by default', !(await page.isVisible('#panel-toggle')));
  check('direction arrow still shown', await page.isVisible('#arrow'));

  // The welcome message is informational, so it should not appear.
  const welcome = await page.evaluate(() => document.getElementById('status').textContent);
  check('no informational banner', welcome === '', `saw "${welcome}"`);

  // Nor should a real problem, by default.
  await page.evaluate(() => window.__ar.locar.emit('gpserror', { code: 2, message: 'position unavailable' }));
  await page.waitForTimeout(200);
  check('even errors stay silent by default', !(await page.isVisible('#status')));

  check('fullscreen requested', await page.evaluate(() => document.fullscreenElement !== null));
  await page.screenshot({ path: '.tmp/ui-default.png' });
  await ctx.close();
}

// --- ?ui=minimal: the arrow, plus a banner when something is actually wrong ---
{
  const { ctx, page } = await open('?ui=minimal&mode=relative&distance=20&bearing=0');
  await page.waitForTimeout(500);
  const welcome = await page.evaluate(() => document.getElementById('status').textContent);
  check('minimal hides informational banners', welcome === '', `saw "${welcome}"`);
  check('minimal hides the telemetry panel', !(await page.isVisible('#panel')));
  await page.evaluate(() => window.__ar.locar.emit('gpserror', { code: 2, message: 'position unavailable' }));
  await page.waitForTimeout(200);
  check('minimal surfaces errors', await page.isVisible('#status'));
  await ctx.close();
}

// --- ?ui=none: same as the default, asked for explicitly ---
{
  const { ctx, page } = await open('?ui=none&mode=relative&distance=20&bearing=0');
  await page.evaluate(() => window.__ar.locar.emit('gpserror', { code: 2, message: 'gone' }));
  await page.waitForTimeout(300);
  check('ui=none suppresses even errors', !(await page.isVisible('#status')));
  check('ui=none keeps the arrow', await page.isVisible('#arrow'));
  await ctx.close();
}

// --- ?ui=debug: the full instrument panel ---
{
  const { ctx, page } = await open('?ui=debug&mode=relative&distance=20&bearing=0');
  await page.waitForTimeout(500);
  check('ui=debug shows the panel', await page.isVisible('#panel'));
  check('ui=debug shows the info button', await page.isVisible('#panel-toggle'));
  await page.screenshot({ path: '.tmp/ui-debug.png' });
  await ctx.close();
}

/*
 * --- ?debug=1 cannot turn the interface on ---
 *
 * The picker used to stamp debug=1 into every URL and QR it emitted, so codes
 * that are already printed and handed out carry it. Those have to open clean,
 * or the instrument panel lands over the camera feed for whoever scans one.
 */
{
  const { ctx, page } = await open('?debug=1&mode=relative&distance=20&bearing=0');
  await page.waitForTimeout(500);
  check('debug=1 in a link does not show the panel', !(await page.isVisible('#panel')));
  check('debug=1 in a link does not show the info button', !(await page.isVisible('#panel-toggle')));
  check('debug=1 still keeps the arrow', await page.isVisible('#arrow'));
  await ctx.close();
}

/*
 * --- the view keeps moving between sensor readings ---
 *
 * LocAR rotates the camera inside its deviceorientation handler and its
 * update() is a no-op, so the view used to advance only when a reading landed:
 * motion was quantised to the sensor's clock rather than the display's, which
 * is the stepping that read as jitter while panning. No smoothing factor could
 * fix that — it only changed the size of each step.
 *
 * The sensor now drives a detached object and the camera eases towards it once
 * per rendered frame, so the test is that the view still moves on frames where
 * no reading arrived at all.
 *
 * Asked for explicitly with ?smoothrot=, which now also selects the 'fixed'
 * filter: the default is the 1€ filter, whose whole point is that its time
 * constant is not fixed. This asserts the plain easing still behaves when it is
 * the one in use — it is what ?filter=fixed falls back to.
 */
{
  const { ctx, page } = await open('?sim=0&smoothrot=0.05&mode=relative&distance=20&bearing=0');
  const aim = (alpha) => page.evaluate((a) => {
    const name = window.__ar.app.deviceOrientationControls.orientationChangeEventName;
    const event = new Event(name);
    Object.defineProperties(event, {
      alpha: { value: a }, beta: { value: 90 }, gamma: { value: 0 }, absolute: { value: true },
    });
    window.dispatchEvent(event);
  }, alpha);

  // Settle, then deliver exactly one new heading and let frames run with no
  // further events. Sample the camera each frame.
  for (let i = 0; i < 20; i += 1) { await aim(90); await page.waitForTimeout(16); }
  await aim(150);
  const track = await page.evaluate(() => new Promise((resolve) => {
    const seen = [];
    const camera = window.__ar.camera;
    let frames = 0;
    const step = () => {
      seen.push(camera.quaternion.toArray().join(','));
      frames += 1;
      if (frames < 12) requestAnimationFrame(step); else resolve(seen);
    };
    requestAnimationFrame(step);
  }));

  const distinct = new Set(track).size;
  check('camera advances on frames with no new reading', distinct > 3,
    `${distinct} distinct orientations across ${track.length} frames`);

  // And it must actually arrive, not ease forever.
  for (let i = 0; i < 40; i += 1) { await aim(150); await page.waitForTimeout(16); }
  const settled = await page.evaluate(() => {
    const { camera, app, THREE } = window.__ar;
    return camera.quaternion.angleTo(app.deviceOrientationControls.object.quaternion) * 180 / Math.PI;
  });
  check('camera converges on the sensor', settled < 1, `${settled.toFixed(3)}° short`);
  await ctx.close();
}

await browser.close();
if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — the arrow alone by default, full detail only on request');
