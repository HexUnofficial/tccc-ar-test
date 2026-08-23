import { chromium } from 'playwright';

// The full Chromium build composites <video> into screenshots; the headless
// shell used by the test suite does not, which is why those frames look black.
// CHROMIUM_PATH is for environments that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  channel: 'chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});

// Standing ~15 m south of 174 St John Street.
const ctx = await browser.newContext({
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 51.524198, longitude: -0.102722, accuracy: 9 },
  ignoreHTTPSErrors: true,
  viewport: { width: 414, height: 896 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
/*
 * ?sim=1, because the 8th Wall engine needs an app key and an authorised domain
 * and will not run on localhost from a test runner. What the simulator gives up
 * is XR8's pose and its real intrinsics; what it keeps is everything a
 * screenshot is for — placement, scale, the circuit, and the overlay.
 *
 * `mode=relative&distance=300` puts the aircraft 300 m out rather than at the
 * Thames anchor, so the frame has something in it from wherever this runs.
 */
await page.goto(
  'https://localhost:4173/?sim=1&ui=debug&mode=relative&distance=300&bearing=0',
  { waitUntil: 'load' },
);
await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60000 });
await page.screenshot({ path: '.tmp/shot-gate.png' });

await page.click('#gate-start');
await page.waitForFunction(() => document.getElementById('f-anchor')?.textContent !== '—', null, { timeout: 20000 });

await page.evaluate(() => {
  const ar = window.__ar;
  /*
   * Point the camera at the aircraft rather than at the anchor. On a 300 m
   * circuit those are up to 150 m apart, and the anchor is the empty middle of
   * the racetrack — aiming at it puts the subject out of frame.
   *
   * Nothing has to be detached first. In the LocAR build this line disabled the
   * orientation controls, because they would overwrite the camera on the next
   * sensor event; here the simulator only writes rotation when the pointer is
   * being dragged, and XR8 owns it on device.
   */
  ar.camera.position.set(0, 1.6, 0);
  const subject = ar.model.motion.getWorldPosition(new ar.THREE.Vector3());
  ar.camera.lookAt(subject);
});
await page.waitForTimeout(1200);
await page.screenshot({ path: '.tmp/shot-ar.png' });

console.log(await page.evaluate(() =>
  Object.fromEntries(['fix','accuracy','anchor','distance','bearing','heading']
    .map(k => [k, document.getElementById(`f-${k}`).textContent]))));
await browser.close();
