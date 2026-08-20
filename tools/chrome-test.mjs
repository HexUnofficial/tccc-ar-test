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

// --- default: arrow only ---
{
  const { ctx, page } = await open('?mode=relative&distance=20&bearing=0');
  await page.waitForTimeout(500);
  check('telemetry panel hidden by default', !(await page.isVisible('#panel')));
  check('info button hidden by default', !(await page.isVisible('#panel-toggle')));
  check('direction arrow still shown', await page.isVisible('#arrow'));

  // The welcome message is informational, so it should not appear.
  const welcome = await page.evaluate(() => document.getElementById('status').textContent);
  check('no informational banner', welcome === '', `saw "${welcome}"`);

  // A real problem still gets through.
  await page.evaluate(() => window.__ar.locar.emit('gpserror', { code: 2, message: 'position unavailable' }));
  await page.waitForTimeout(200);
  check('errors still surface', await page.isVisible('#status'));

  check('fullscreen requested', await page.evaluate(() => document.fullscreenElement !== null));
  await page.screenshot({ path: '.tmp/ui-minimal.png' });
  await ctx.close();
}

// --- ?ui=none: nothing but the arrow, ever ---
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

await browser.close();
if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — minimal by default, full detail on request');
