/**
 * Does the scene stay put when the viewer does?
 *
 * A stationary phone still reports a fix that wanders inside its error circle.
 * Following that drift drags the whole scene sideways while nobody is moving,
 * which is indistinguishable from the AR being broken. This feeds jitter of a
 * realistic size and asserts the rendered camera holds station — then feeds a
 * genuine walk and asserts it still follows.
 */
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const M = 111_320;
const ACCURACY = 14; // metres, typical of a phone in a city
const JITTER = 6; // metres of wander, comfortably inside the error circle

// CHROMIUM_PATH is for environments that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});
const at = (north, east) => ({
  latitude: INSTALLATION.lat - 200 / M + north / M,
  longitude: INSTALLATION.lon + east / (M * Math.cos((INSTALLATION.lat * Math.PI) / 180)),
  accuracy: ACCURACY,
});
const ctx = await browser.newContext({
  permissions: ['camera', 'geolocation'], geolocation: at(0, 0),
  ignoreHTTPSErrors: true, viewport: { width: 414, height: 896 },
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/?mode=fixed&debug=1`, { waitUntil: 'load' });
await page.waitForSelector('#gate-start:not([disabled])', { timeout: 90_000 });
await page.click('#gate-start');
await page.waitForFunction(() => window.__ar?.model, { timeout: 40_000 });
await page.evaluate(() => { window.__ar.app.deviceOrientationControls = null; });

const cameraAt = () => page.evaluate(() => {
  const { camera } = window.__ar;
  return { x: camera.position.x, z: camera.position.z };
});

// A deterministic wander, so the test does not depend on chance.
const wander = [[1, 1], [-1, 2], [2, -1], [-2, -2], [1, -2], [-1, 1], [2, 2], [-2, 0]];
const start = await cameraAt();
let worstDrift = 0;
for (const [n, e] of wander) {
  await ctx.setGeolocation(at(n * (JITTER / 2), e * (JITTER / 2)));
  await page.waitForTimeout(700);
  const now = await cameraAt();
  worstDrift = Math.max(worstDrift, Math.hypot(now.x - start.x, now.z - start.z));
}
console.log(`  standing still, +/-${JITTER} m of GPS wander: scene moved ${worstDrift.toFixed(2)} m`);

// Settle back to the true position before testing real movement, so the walk is
// measured from a known point rather than from wherever the noise left us.
await ctx.setGeolocation(at(0, 0));
await page.waitForTimeout(2000);
const beforeWalk = await cameraAt();

// Walk it in steps, as a real walk arrives: one teleport plus one fix would
// only ever move the average by a fraction of the distance.
for (let step = 1; step <= 6; step += 1) {
  await ctx.setGeolocation(at(step * 10, 0));
  await page.waitForTimeout(700);
}

/*
 * Keep the fixes coming after arriving. A rolling average only converges while
 * new samples arrive: stop feeding it and the window keeps the last few values
 * for ever, leaving the scene short of the destination. Real GPS reports about
 * once a second whether or not you are moving, so a stationary phone quickly
 * fills the window with its final position — which is what this reproduces.
 */
for (let tick = 0; tick < 7; tick += 1) {
  // Above LocAR's gpsMinDistance, or the fix is discarded before we see it.
  await ctx.setGeolocation(at(60 + (tick % 2 ? 1.5 : -1.5), 0));
  await page.waitForTimeout(700);
}
await page.waitForTimeout(1500);
const walked = await cameraAt();
const followed = Math.hypot(walked.x - beforeWalk.x, walked.z - beforeWalk.z);
console.log(`  then walking 60 m: scene followed ${followed.toFixed(0)} m`);

await browser.close();

/*
 * Averaging n fixes cuts random error by root n — that is all a client-side
 * filter can do, and no amount of tuning beats it. So assert the theoretical
 * reduction rather than an invented number: with a 3-fix window, 6 m of wander
 * should land near 3.5 m. Anything much worse means the filter is not working;
 * demanding much better would mean demanding lag nobody wants.
 */
const WINDOW = 3; // must match config.gps.averageFixes
const predicted = JITTER / Math.sqrt(WINDOW);
console.log(`  predicted residual for a ${WINDOW}-fix average: ${predicted.toFixed(1)} m`);

const failures = [];
if (worstDrift > predicted * 1.35) {
  failures.push(`scene drifted ${worstDrift.toFixed(1)} m, worse than the `
    + `${predicted.toFixed(1)} m a ${WINDOW}-fix average should give`);
}
if (worstDrift > JITTER * 0.8) {
  failures.push(`the averaging is barely helping: ${worstDrift.toFixed(1)} m of ${JITTER} m survives`);
}
if (followed < 50) {
  failures.push(`the filter is swallowing real movement: followed only ${followed.toFixed(0)} m of a 60 m walk`);
}
failures.push(...errors);

if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — holds station under GPS noise, still follows a real walk');
