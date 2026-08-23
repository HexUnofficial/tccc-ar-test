/**
 * Motion continuity: does she grow *smoothly* as you walk, or in lurches?
 *
 * Walks a simulated pedestrian at a constant pace past a 1 Hz GPS feed and
 * samples the rendered camera position every frame. Correct placement and
 * responsive updates can both be true while the motion still reads as stepping,
 * which is what this measures and nothing else does.
 *
 * Speed variability is the headline number: 0 would be perfectly constant
 * motion. Raw GPS with no follow scores about 7.8 (a teleport once a second,
 * frozen in between).
 */
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const M_PER_DEG_LAT = 111_320;
const WALK_SPEED = 1.4; // m/s, ordinary walking pace
const FIX_INTERVAL_MS = 1000; // phones deliver roughly one fix per second
const FIXES = 10;
const START_DISTANCE = 40;

const MAX_VARIABILITY = 0.25;
const MAX_STALLED = 0.05;
const MAX_LAG = 2.5; // metres

// CHROMIUM_PATH is for environments that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});
const at = (metres) => ({
  latitude: INSTALLATION.lat - metres / M_PER_DEG_LAT,
  longitude: INSTALLATION.lon,
  accuracy: 5,
});
const ctx = await browser.newContext({
  permissions: ['camera', 'geolocation'],
  geolocation: at(START_DISTANCE),
  ignoreHTTPSErrors: true,
  viewport: { width: 414, height: 896 },
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// A stationary subject, so the only motion measured is the camera's.
await page.goto(`${BASE}/?engine=locar&mode=fixed&debug=1&model=witch`, { waitUntil: 'load' });
await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
await page.click('#gate-start');
await page.waitForFunction(() => document.getElementById('f-anchor')?.textContent !== '—', null, { timeout: 20_000 });
await page.evaluate(() => {
  window.__ar.app.deviceOrientationControls = null;
  window.__ar.camera.position.y = 1.6;
});

// Sample in-page, once per frame, to avoid round-trip latency skewing the speeds.
await page.evaluate(() => {
  window.__samples = [];
  const tick = () => {
    const { camera, model } = window.__ar;
    const m = model.root.position;
    const rendered = Math.hypot(camera.position.x - m.x, camera.position.z - m.z);
    const truth = Number.parseFloat(document.getElementById('f-distance').textContent);
    window.__samples.push([performance.now(), camera.position.x, camera.position.z, rendered - truth]);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

let remaining = START_DISTANCE;
for (let i = 0; i < FIXES; i += 1) {
  remaining -= (WALK_SPEED * FIX_INTERVAL_MS) / 1000;
  await ctx.setGeolocation(at(remaining));
  await page.waitForTimeout(FIX_INTERVAL_MS);
}

const samples = await page.evaluate(() => window.__samples);
await browser.close();

const speeds = [];
for (let i = 1; i < samples.length; i += 1) {
  const dt = (samples[i][0] - samples[i - 1][0]) / 1000;
  if (dt <= 0) continue;
  speeds.push(Math.hypot(samples[i][1] - samples[i - 1][1], samples[i][2] - samples[i - 1][2]) / dt);
}
const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
const sd = Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length);
const variability = sd / mean;
const stalled = speeds.filter((s) => s < mean * 0.1).length / speeds.length;

// Steady state only: drop the first and last fifth (spin-up and settling).
const midpoint = samples.slice((samples.length * 0.2) | 0, (samples.length * 0.8) | 0)
  .map((s) => s[3]).filter(Number.isFinite);
const lag = midpoint.reduce((a, b) => a + b, 0) / midpoint.length;

console.table([{
  'mean speed (m/s)': +mean.toFixed(2),
  'walking at': WALK_SPEED,
  'speed variability': +variability.toFixed(3),
  'stalled frames': `${(stalled * 100).toFixed(1)}%`,
  'follow lag (m)': +lag.toFixed(2),
}]);

const failures = [];
if (variability > MAX_VARIABILITY) {
  failures.push(`motion is lurching: speed variability ${variability.toFixed(2)}, want under ${MAX_VARIABILITY}`);
}
if (stalled > MAX_STALLED) {
  failures.push(`camera freezes between fixes ${(stalled * 100).toFixed(1)}% of frames, want under ${MAX_STALLED * 100}%`);
}
if (Math.abs(lag) > MAX_LAG) {
  failures.push(`following ${lag.toFixed(1)} m behind the fix, want under ${MAX_LAG} m`);
}
if (Math.abs(mean - WALK_SPEED) > 0.3) {
  failures.push(`rendered speed ${mean.toFixed(2)} m/s does not match the ${WALK_SPEED} m/s walk`);
}
failures.push(...errors);

if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — continuous motion, no lurching');
