/**
 * Headless smoke test for the AR page.
 *
 * Runs Chromium with a synthetic webcam and a mocked GPS fix, drives the start
 * gate, and asserts the model actually lands in the scene at the right distance.
 * This can't validate compass drift or real GPS jitter — that needs a phone —
 * but it catches every "the page is blank" class of failure before you walk out.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { INSTALLATION } from '../src/location.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const FIX = {
  latitude: Number(process.env.LAT ?? 51.05043),
  longitude: Number(process.env.LON ?? 3.72509),
  accuracy: 8,
};
const DISTANCE = Number(process.env.DISTANCE ?? 20);
const BEARING = Number(process.env.BEARING ?? 0);

// CHROMIUM_PATH is for environments that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--ignore-certificate-errors',
  ],
});

const context = await browser.newContext({
  permissions: ['geolocation', 'camera'],
  geolocation: FIX,
  viewport: { width: 414, height: 896 },
  ignoreHTTPSErrors: true,
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

const MODE = process.env.MODE ?? 'relative';
const failures = [];
const url = `${BASE}/?engine=locar&sim=0&mode=${MODE}&distance=${DISTANCE}&bearing=${BEARING}&debug=1&model=witch`;
console.log(`→ ${url}`);
await page.goto(url, { waitUntil: 'load' });

// The start button only enables once the GLB has finished downloading.
await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
console.log('✔ model downloaded, gate enabled');

await page.click('#gate-start');
await page.waitForSelector('#gate', { state: 'hidden', timeout: 20_000 });
console.log('✔ camera stream acquired, gate dismissed');

await page.waitForFunction(
  () => {
    const v = document.querySelector('video');
    return v && v.videoWidth > 0 && v.readyState >= 2;
  },
  null,
  { timeout: 20_000 },
);

// The passthrough feed is a <video> behind the canvas. Headless Chromium won't
// composite it into a screenshot, so instead we check it is playing and that
// nothing opaque is stacked in front of it.
const feed = await page.evaluate(() => {
  const video = document.querySelector('video');
  if (!video) return { error: 'no <video> element' };
  const sample = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.drawImage(video, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, (d[i] + d[i + 1] + d[i + 2]) / 3);
    return max;
  })();
  return {
    playing: !video.paused && video.readyState >= 2 && video.videoWidth > 0,
    maxLuma: sample,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    canvasBackground: getComputedStyle(document.getElementById('scene')).backgroundColor,
  };
});

const transparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
if (feed.error) failures.push(feed.error);
else {
  if (!feed.playing) failures.push('camera feed is not playing');
  if (feed.maxLuma <= 0) failures.push('camera feed is delivering black frames');
  if (!transparent(feed.bodyBackground)) {
    failures.push(`<body> background is ${feed.bodyBackground}; it paints over the camera feed and must be transparent`);
  }
  if (!transparent(feed.canvasBackground)) {
    failures.push(`canvas background is ${feed.canvasBackground}; it must be transparent`);
  }
  console.log(`  camera feed playing, peak luma ${feed.maxLuma}, nothing opaque in front of it`);
}

await page.waitForFunction(
  () => document.getElementById('f-anchor')?.textContent !== '—',
  null,
  { timeout: 20_000 },
);
console.log('✔ GPS fix received, model anchored');

const readings = await page.evaluate(() =>
  Object.fromEntries(
    ['fix', 'accuracy', 'heading', 'anchor', 'distance', 'bearing', 'fps'].map((k) => [
      k, document.getElementById(`f-${k}`).textContent,
    ]),
  ),
);
console.table(readings);

// LocAR's world is north = -Z, east = +X. Confirming the model actually lands
// there is what proves the HUD's compass maths agrees with the rendered scene.
const world = await page.evaluate(() => {
  const { x, y, z } = window.__ar.model.root.position;
  return { x, y, z };
});
console.log(`  model world position: x=${world.x.toFixed(2)} y=${world.y.toFixed(2)} z=${world.z.toFixed(2)}`);

const expectedX = DISTANCE * Math.sin((BEARING * Math.PI) / 180);
const expectedZ = -DISTANCE * Math.cos((BEARING * Math.PI) / 180);
if (MODE === 'fixed') {
  console.log('  (fixed mode: checking reported distance only, placement is site-defined)');
}

if (MODE === 'relative') {
  if (Math.abs(world.x - expectedX) > 0.5) failures.push(`model x=${world.x.toFixed(1)}, expected ${expectedX.toFixed(1)}`);
  if (Math.abs(world.z - expectedZ) > 0.5) failures.push(`model z=${world.z.toFixed(1)}, expected ${expectedZ.toFixed(1)}`);
} else {
  const [anchorLat, anchorLon] = readings.anchor.split(',').map(Number);
  if (Math.abs(anchorLat - INSTALLATION.lat) > 1e-5 || Math.abs(anchorLon - INSTALLATION.lon) > 1e-5) {
    failures.push(`anchor ${readings.anchor} does not match INSTALLATION ${INSTALLATION.lat}, ${INSTALLATION.lon}`);
  }
  // The world offset must agree with the haversine distance the HUD reports.
  const planar = Math.hypot(world.x, world.z);
  const reported = Number.parseFloat(readings.distance);
  if (Math.abs(planar - reported) > 0.5) {
    failures.push(`world offset is ${planar.toFixed(1)} m but HUD reports ${reported.toFixed(1)} m`);
  }
}
if (MODE === 'relative') {
  const measured = Number.parseFloat(readings.distance);
  if (!(Math.abs(measured - DISTANCE) < 1)) {
    failures.push(`anchor is ${readings.distance} away, expected ~${DISTANCE} m`);
  }
  if (Math.abs(Number.parseFloat(readings.bearing) - BEARING) > 1) {
    failures.push(`anchor bearing reads ${readings.bearing}, expected ${BEARING}°`);
  }
}
if (Number.parseFloat(readings.fps) < 20) {
  failures.push(`render loop is only managing ${readings.fps} fps`);
}
if (errors.length) failures.push(...errors);

await page.screenshot({ path: '.tmp/hud.png' });

// Aim the camera at the model and confirm it actually rasterises. Placement
// maths can be perfect while the model is invisible — wrong scale, failed
// texture decode, material culled. Counting lit pixels catches all of that.
await page.evaluate(() => {
  const ar = window.__ar;
  ar.app.deviceOrientationControls = null; // stop the (absent) sensors steering
  ar.camera.position.y = 1.6; // eye height
  const t = ar.model.root.position;
  ar.camera.lookAt(t.x, t.y + 1.2, t.z);
});
await page.waitForTimeout(500);

const coverage = await page.evaluate(() => {
  const { THREE, renderer, scene, camera } = window.__ar;
  const w = 256, h = 512;
  const target = new THREE.WebGLRenderTarget(w, h);
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
  renderer.setRenderTarget(null);
  target.dispose();
  let lit = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 16) lit += 1;
  return lit / (w * h);
});
// Screen coverage falls off as 1/d^2, so coverage x distance^2 is roughly
// constant for a correctly scaled model. Checking that invariant catches both
// "nothing rendered" and "rendered at the wrong physical size", at any range.
const range = Number.parseFloat(readings.distance);
const invariant = coverage * range * range;
console.log(
  `  model covers ${(coverage * 100).toFixed(2)}% of the frame at ${range.toFixed(0)} m` +
  ` (scale invariant ${invariant.toFixed(2)}, expected 1.5-6)`,
);
if (coverage <= 0) failures.push('model rendered no pixels at all');
else if (invariant < 1.5 || invariant > 6) {
  failures.push(`model appears the wrong physical size: scale invariant ${invariant.toFixed(2)}, expected 1.5-6`);
}

// The arrow is a "you're facing the wrong way" hint; it must get out of the way
// once the model is in front of you.
const arrowWhenFacing = await page.isVisible('#arrow');
if (arrowWhenFacing) failures.push('direction arrow still showing while looking straight at the model');

await page.evaluate(() => {
  const ar = window.__ar;
  const t = ar.model.root.position;
  ar.camera.lookAt(-t.x, 1.6, -t.z); // spin 180 degrees away
});
await page.waitForTimeout(300);
if (!(await page.isVisible('#arrow'))) failures.push('direction arrow missing while facing away from the model');

await page.evaluate(() => {
  const ar = window.__ar;
  const t = ar.model.root.position;
  ar.camera.lookAt(t.x, t.y + 1.2, t.z);
});
await page.waitForTimeout(300);
await page.screenshot({ path: '.tmp/render.png' });
await writeFile('.tmp/smoke.json', JSON.stringify({ readings, errors }, null, 2));

await browser.close();

if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — screenshot at .tmp/smoke.png');
