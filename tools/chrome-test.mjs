/**
 * Checks the frameless presentation: our own overlay stays out of the way by
 * default, and the browser's chrome is dismissed where the platform allows it.
 */
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';

// Headless Chromium reports no device orientation, which leaves the camera
// facing due south. An anchor due north is therefore reliably behind you.

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const browser = await chromium.launch({
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
  await page.goto(`${BASE}/${query}`, { waitUntil: 'load' });
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
 * is what ?debug=1 is for — so that trade is asserted here rather than left to
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

// --- ?debug=1: the full instrument panel ---
{
  const { ctx, page } = await open('?debug=1&mode=relative&distance=20&bearing=0');
  await page.waitForTimeout(500);
  check('debug shows the panel', await page.isVisible('#panel'));
  check('debug shows the info button', await page.isVisible('#panel-toggle'));
  await page.screenshot({ path: '.tmp/ui-debug.png' });
  await ctx.close();
}

/*
 * --- rotation smoothing gets out of the way while you pan ---
 *
 * A fixed smoothing factor cannot win: enough of it to filter compass noise
 * while you stand still is enough to lag visibly while you turn, and because
 * the scene is pinned to compass north that lag reads as the aircraft sliding
 * about as though it were following you. So the factor is scaled by how fast
 * the view is turning, and it is the scaling that has to keep working.
 */
{
  const { ctx, page } = await open('?sim=0&mode=relative&distance=20&bearing=0');
  const aim = (alpha) => page.evaluate((a) => {
    const name = window.__ar.app.deviceOrientationControls.orientationChangeEventName;
    const event = new Event(name);
    Object.defineProperties(event, {
      alpha: { value: a }, beta: { value: 90 }, gamma: { value: 0 }, absolute: { value: true },
    });
    window.dispatchEvent(event);
  }, alpha);
  const factor = () => page.evaluate(() => window.__ar.app.deviceOrientationControls.smoothingFactor);

  for (let i = 0; i < 60; i += 1) { await aim(90); await page.waitForTimeout(16); }
  const still = await factor();

  for (let i = 0; i < 60; i += 1) { await aim(90 + i * 3); await page.waitForTimeout(16); }
  const panning = await factor();

  for (let i = 0; i < 90; i += 1) { await aim(270); await page.waitForTimeout(16); }
  const settled = await factor();

  check('holding still filters hard', still > 0.3, `factor ${still.toFixed(3)}`);
  check('panning releases the filter', panning < 0.1, `factor ${panning.toFixed(3)}`);
  check('filtering returns once at rest', settled > 0.3, `factor ${settled.toFixed(3)}`);
  await ctx.close();
}

await browser.close();
if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — minimal by default, full detail on request');
