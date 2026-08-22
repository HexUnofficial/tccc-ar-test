/**
 * Walking test: does the model respond to you moving?
 *
 * The static smoke test loads a fresh page per distance, so it can't catch the
 * failure mode where placement is correct but nothing updates as you walk. This
 * drives one session and moves the GPS fix underneath it, which is the thing
 * that actually feels broken in the field.
 */
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const M_PER_DEG_LAT = 111_320;
const STEPS = [20, 18, 16, 14, 12, 10]; // 2 m apart: below the old 5 m threshold
const SETTLE_MS = 1400;

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});
const at = (metres) => ({
  latitude: INSTALLATION.lat - metres / M_PER_DEG_LAT,
  longitude: INSTALLATION.lon,
  accuracy: 5,
});

const ctx = await browser.newContext({
  permissions: ['camera', 'geolocation'],
  geolocation: at(STEPS[0]),
  ignoreHTTPSErrors: true,
  viewport: { width: 414, height: 896 },
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// A stationary subject: this measures GPS response, not the flight path.
await page.goto(`${BASE}/?mode=fixed&debug=1&model=witch`, { waitUntil: 'load' });
await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
await page.click('#gate-start');
await page.waitForFunction(() => document.getElementById('f-anchor')?.textContent !== '—', null, { timeout: 20_000 });

// No sensors in headless, so pin the camera and keep it aimed at her.
await page.evaluate(() => {
  window.__ar.app.deviceOrientationControls = null;
  window.__ar.camera.position.y = 1.6;
});

const measure = () => page.evaluate(() => {
  const { THREE, renderer, scene, camera, model } = window.__ar;
  const t = model.root.position;
  camera.lookAt(t.x, t.y + 1.2, t.z);
  const w = 192, h = 384;
  const rt = new THREE.WebGLRenderTarget(w, h);
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  const px = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
  renderer.setRenderTarget(null);
  rt.dispose();
  let lit = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 16) lit += 1;
  return {
    gap: +Math.hypot(camera.position.x - t.x, camera.position.z - t.z).toFixed(2),
    coverage: +((lit / (w * h)) * 100).toFixed(3),
  };
});

const rows = [];
for (const metres of STEPS) {
  await ctx.setGeolocation(at(metres));
  await page.waitForTimeout(SETTLE_MS);
  rows.push({ 'walked to (m)': metres, ...(await measure()) });
}
console.table(rows);

const failures = [];

// Every 2 m step must make her visibly bigger.
for (let i = 1; i < rows.length; i += 1) {
  const growth = rows[i].coverage / rows[i - 1].coverage;
  if (growth <= 1.05) {
    failures.push(
      `walking from ${rows[i - 1]['walked to (m)']} m to ${rows[i]['walked to (m)']} m ` +
      `barely changed her size (${rows[i - 1].coverage}% -> ${rows[i].coverage}%)`,
    );
  }
}

/*
 * The camera must track the fix, but it deliberately lags it: positions are
 * averaged over the last few fixes to stop GPS wander dragging the scene about
 * while the viewer stands still (see config.gps.averageFixes). That lag is a
 * chosen trade, so bound it rather than pretending it is not there.
 */
const MAX_LAG = 5; // metres
for (const row of rows) {
  const lag = row.gap - row['walked to (m)'];
  if (lag < -1) failures.push(`at ${row['walked to (m)']} m the camera has overshot to ${row.gap} m`);
  if (lag > MAX_LAG) failures.push(`at ${row['walked to (m)']} m the camera lags ${lag.toFixed(1)} m behind`);
}

// A 6 m jump should glide, not teleport — otherwise the size pops.
await ctx.setGeolocation(at(16));
await page.waitForTimeout(SETTLE_MS);
await ctx.setGeolocation(at(10));
const trace = [];
for (let i = 0; i < 6; i += 1) {
  await page.waitForTimeout(150);
  trace.push((await measure()).gap);
}
console.log(`  easing after a 6 m step: ${trace.join(' -> ')}`);
const intermediate = trace.filter((g) => g > 10.5 && g < 15.5).length;
if (intermediate < 2) {
  failures.push(`camera snapped to the new fix instead of easing (trace: ${trace.join(', ')})`);
}

failures.push(...errors);
await browser.close();

if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — she grows as you approach, and eases between fixes');
