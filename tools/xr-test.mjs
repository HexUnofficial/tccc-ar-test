/**
 * xr.html — the SLAM build — starts, places the aircraft by GPS, and finds north.
 *
 * What this can and cannot check is worth stating plainly, because the gap is
 * the whole risk of that page.
 *
 * CAN: that the engine loads, that a session starts, that the aircraft is
 * placed at the right bearing and range from a GPS origin, that the circuit is
 * built, that geometry actually reaches the engine's own three.js scene, and
 * that the compass rotates the world to true north at the intended speed.
 *
 * CANNOT: whether SLAM tracks well. That needs a real camera looking at a real
 * scene, and this aircraft is seen against sky, which is the hardest case there
 * is. Nothing here should be read as evidence about tracking quality.
 *
 * The engine refuses desktop browsers outright — isDeviceBrowserCompatible()
 * returns false on Linux — so the page is exercised under an iPhone user agent.
 * That is a way to reach the code at all, not a claim about the device.
 */
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

// 300 m south and 200 m west of the anchor, so range and bearing are both
// non-trivial and a sign error cannot pass.
const SOUTH = 300;
const WEST = 200;
const metresPerDegreeLon = 111_320 * Math.cos((INSTALLATION.lat * Math.PI) / 180);

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});
const ctx = await browser.newContext({
  permissions: ['camera', 'geolocation'],
  geolocation: {
    latitude: INSTALLATION.lat - SOUTH / 111_320,
    longitude: INSTALLATION.lon - WEST / metresPerDegreeLon,
    accuracy: 8,
  },
  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 },
  isMobile: true, hasTouch: true, userAgent: IPHONE,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// A short north constant: the shipped 6 s is deliberate on a phone, but here it
// would only mean waiting 30 s to see the same answer.
await page.goto(`${BASE}/xr.html?xrnorth=0.5`, { waitUntil: 'load' });
await page.click('#xr-start');

let started = true;
await page.waitForFunction(() => window.__xr, null, { timeout: 90_000 }).catch(() => { started = false; });
check('the engine starts a session', started,
  started ? undefined : await page.evaluate(() => document.getElementById('xr-status')?.textContent));

if (started) {
  const placement = await page.evaluate(() => ({
    range: window.__xr.range,
    position: window.__xr.model.root.position.toArray(),
    bearing: Math.atan2(window.__xr.model.root.position.x, -window.__xr.model.root.position.z) * 180 / Math.PI,
    hasFlightPath: Boolean(window.__xr.flightPath),
    triangles: window.__xr.renderer.info.render.triangles,
  }));

  const expectedRange = Math.hypot(SOUTH, WEST);
  const expectedBearing = Math.atan2(WEST, SOUTH) * 180 / Math.PI;
  check('places the aircraft at the right range', Math.abs(placement.range - expectedRange) < 5,
    `${placement.range.toFixed(0)} m, expected ${expectedRange.toFixed(0)}`);
  check('places it on the right bearing', Math.abs(placement.bearing - expectedBearing) < 2,
    `${placement.bearing.toFixed(0)}°, expected ${expectedBearing.toFixed(0)}°`);
  check('builds the circuit', placement.hasFlightPath);
  // Geometry reaching the engine's own scene is the thing most likely to fail
  // silently: the engine reads window.THREE, and a second copy of three would
  // leave everything added here invisible with no error at all.
  check('geometry reaches the engine\'s scene', placement.triangles > 50_000,
    `${placement.triangles} triangles`);

  /*
   * That the compass engages at all, and nothing more.
   *
   * Whether it lands on the RIGHT angle is asserted exactly in
   * tools/xr-north-test.mjs, against the arithmetic. Trying to establish it
   * here produced three different wrong answers for correct code — the easing is
   * exponential and the camera's bearing is whatever SLAM makes of a synthetic
   * feed, so an impatient or unlucky sample reads as a bug that is not there.
   * The lesson is in that file's header.
   */
  const aligned = await page.evaluate(async () => {
    const name = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    for (let i = 0; i < 12; i += 1) {
      const event = new Event(name);
      Object.defineProperties(event, {
        webkitCompassHeading: { value: 90 }, webkitCompassAccuracy: { value: 10 },
        alpha: { value: 270 }, beta: { value: 85 }, gamma: { value: 0 }, absolute: { value: true },
      });
      window.dispatchEvent(event);
      await new Promise((r) => setTimeout(r, 100));
    }
    return { aligned: window.__xr.aligned, compass: window.__xr.compassBearing };
  });
  check('the compass reaches the page', aligned.compass === 90, `${aligned.compass}`);
  check('and turns the world to face north', aligned.aligned);

  check('no page errors', errors.length === 0, errors[0]);
}

await browser.close();
if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — starts, placed by GPS, oriented by compass (tracking quality untested)');
