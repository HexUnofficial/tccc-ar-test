/**
 * The aircraft's circuit.
 *
 * The GLB's own clip is a vertical bob that never leaves the spot, so the
 * travel is authored in code (src/flight.js) and layered on top. That leaves
 * three things that can silently go wrong and all look like "it's just sitting
 * there" or "it's flying sideways": the path not advancing, the nose not
 * tracking the velocity, and the bank not reversing between turns.
 */
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const SAMPLES = 60;

// CHROMIUM_PATH is for environments that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});
const ctx = await browser.newContext({
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: INSTALLATION.lat, longitude: INSTALLATION.lon, accuracy: 6 },
  ignoreHTTPSErrors: true, viewport: { width: 414, height: 896 },
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/?engine=locar&mode=fixed&debug=1`, { waitUntil: 'load' });
await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
await page.click('#gate-start');
await page.waitForFunction(() => window.__ar?.model, { timeout: 20_000 });

const config = await page.evaluate(() => ({
  model: window.__ar.model.preset.url.split('/').pop().split('?')[0],
  behaviour: window.__ar.model.preset.behaviour,
  clip: window.__ar.model.clipName,
  hasFlightPath: Boolean(window.__ar.flightPath),
}));
console.log(`  ${config.model} — behaviour "${config.behaviour}", clip "${config.clip}"`);

const failures = [];
if (!config.hasFlightPath) failures.push('no flight path was created for the default model');

/*
 * The banner must render single-sided. It is a two-layer sheet whose faces
 * carry separate UVs — one copy of the lettering per side — so drawing back
 * faces too puts the reversed copy through the front one and the banner reads
 * forwards and backwards at once. The export marks every material doubleSided,
 * so this is corrected at load time and has to stay corrected.
 */
const bannerSides = await page.evaluate(() => {
  const seen = [];
  window.__ar.model.root.traverse((child) => {
    if (!child.isMesh) return;
    for (const material of [].concat(child.material)) {
      if (material && /banner/i.test(material.name)) seen.push(material.side);
    }
  });
  // THREE.FrontSide === 0, THREE.DoubleSide === 2.
  return { count: seen.length, doubleSided: seen.filter((s) => s === 2).length };
});
if (bannerSides.count === 0) {
  failures.push('found no banner material to check the facing of');
} else if (bannerSides.doubleSided > 0) {
  failures.push(`${bannerSides.doubleSided} banner material(s) still double-sided; `
    + 'the reversed lettering will bleed through');
}

// Sample one full circuit by scrubbing, so the result doesn't depend on timing.
// Must be the path's own lap time — `flightConfig.period` only applies to the
// circle and figure-eight shapes, and using it here silently covers 42% of a
// racetrack lap and misses one of the two turns entirely.
const period = await page.evaluate(() => window.__ar.flightPath.lapTime);
const frames = [];
for (let i = 0; i < SAMPLES; i += 1) {
  const t = (period * i) / SAMPLES;
  frames.push(await page.evaluate((t) => {
    const { THREE, model, flightPath } = window.__ar;
    window.__ar.setFlightTime(t);
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const m = model.motion;
      const h = 0.05;
      const v = flightPath.positionAt(t + h).sub(flightPath.positionAt(t - h)).normalize();
      const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(m.quaternion);
      const wing = new THREE.Vector3(1, 0, 0).applyQuaternion(m.quaternion);
      res({
        x: m.position.x, y: m.position.y, z: m.position.z,
        alignment: v.dot(nose),
        // A banked aircraft has a wing out of the horizontal plane.
        bank: Math.asin(THREE.MathUtils.clamp(wing.y, -1, 1)) * 180 / Math.PI,
      });
    })));
  }, t));
}

// Resolve the circuit's own axes so the assertions don't depend on the heading.
const geometry = await page.evaluate(() => {
  const { THREE, flightPath, flightConfig } = window.__ar;
  const a = flightPath.positionAt(0);
  const b = flightPath.positionAt(flightPath.lapTime * 0.25);
  return {
    lapTime: flightPath.lapTime,
    perimeter: flightPath.perimeter,
    turnRadius: flightConfig.turnRadius,
    axis: [b.x - a.x, 0, b.z - a.z],
  };
});
const axis = new (await import('three')).Vector3(...geometry.axis).normalize();
const cross = new (await import('three')).Vector3(-axis.z, 0, axis.x);

const along = frames.map((f) => f.x * axis.x + f.z * axis.z);
const across = frames.map((f) => f.x * cross.x + f.z * cross.z);
const ys = frames.map((f) => f.y);
const banks = frames.map((f) => f.bank);
const worstAlignment = Math.min(...frames.map((f) => f.alignment));
const alongRange = Math.max(...along) - Math.min(...along);
const acrossRange = Math.max(...across) - Math.min(...across);
const verticalRange = Math.max(...ys) - Math.min(...ys);

console.log(`  lap              ${geometry.perimeter.toFixed(0)} m in ${geometry.lapTime.toFixed(0)}s`);
console.log(`  along the line   ${alongRange.toFixed(0)} m`);
console.log(`  across it        ${acrossRange.toFixed(0)} m (the two legs, ${(2 * geometry.turnRadius)} m apart)`);
console.log(`  altitude         ${Math.min(...ys).toFixed(1)}-${Math.max(...ys).toFixed(1)} m, held by the path`);
console.log(`  bank angle       ${Math.min(...banks).toFixed(0)}° to ${Math.max(...banks).toFixed(0)}°`);
console.log(`  nose alignment   worst ${worstAlignment.toFixed(3)} (1 = nose exactly along travel)`);

if (alongRange < 50) failures.push(`barely travels: only ${alongRange.toFixed(0)} m along the line`);
if (verticalRange > 1) failures.push(`the path changes altitude by ${verticalRange.toFixed(1)} m; the clip should own vertical motion`);
if (worstAlignment < 0.99) failures.push(`nose drifts off the direction of travel (worst dot ${worstAlignment.toFixed(3)})`);
if (Math.max(...banks.map(Math.abs)) < 25) failures.push(`never banks hard into a turn (max ${Math.max(...banks.map(Math.abs)).toFixed(0)}°)`);
if (Math.min(...banks.map(Math.abs)) > 10) failures.push('never flies level; the straight legs should be unbanked');

/*
 * The point of a racetrack over a figure-eight: it must never double back
 * through its own path. Sampling densely, no two points that are far apart in
 * time may be close together in space — which is exactly what a self-crossing
 * loop does at the crossing.
 */
const dense = await page.evaluate((n) => {
  const { flightPath } = window.__ar;
  return Array.from({ length: n }, (_, i) => {
    const p = flightPath.positionAt((flightPath.lapTime * i) / n);
    return [p.x, p.z];
  });
}, 240);

let worstCrossing = Infinity;
for (let i = 0; i < dense.length; i += 1) {
  for (let j = i + 1; j < dense.length; j += 1) {
    // Only compare points at least a fifth of a lap apart in time; neighbours
    // being close together is just the path being continuous.
    const apart = Math.min(j - i, dense.length - (j - i));
    if (apart < dense.length / 5) continue;
    const gap = Math.hypot(dense[i][0] - dense[j][0], dense[i][1] - dense[j][1]);
    worstCrossing = Math.min(worstCrossing, gap);
  }
}
console.log(`  self-crossing    closest approach ${worstCrossing.toFixed(0)} m (0 = flies back through itself)`);
if (worstCrossing < 5) {
  failures.push(`the path doubles back on itself (two legs pass within ${worstCrossing.toFixed(1)} m)`);
}

/*
 * The arrow has to follow the aircraft, not the anchor. On this circuit they
 * are up to 165 m apart, so an anchor-locked arrow points at empty sky for most
 * of the lap — which is exactly what it looked like before.
 */
const pointing = await page.evaluate(async () => {
  const { THREE, model, camera, app, flightPath } = window.__ar;
  app.deviceOrientationControls = null;
  camera.position.y = 1.6;

  // Park the aircraft at the far end of a leg, well away from the anchor.
  window.__ar.setFlightTime(flightPath.lapTime * 0.24);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const plane = model.motion.getWorldPosition(new THREE.Vector3());
  const anchorPoint = model.root.getWorldPosition(new THREE.Vector3());
  const separation = plane.distanceTo(anchorPoint);

  const read = () => ({
    hidden: document.getElementById('arrow').hidden,
    angle: document.getElementById('arrow').querySelector('svg').style.rotate,
    label: document.getElementById('arrow-label').textContent,
  });
  const settle = () => new Promise((r) => setTimeout(r, 120));

  camera.lookAt(anchorPoint);
  await settle();
  const facingAnchor = read();

  camera.lookAt(plane);
  await settle();
  const facingPlane = read();

  return { separation, facingAnchor, facingPlane, planeRange: plane.distanceTo(camera.position) };
});

console.log(`  aircraft is ${pointing.separation.toFixed(0)} m from the anchor at that moment`);
console.log(`  looking at the anchor: arrow ${pointing.facingAnchor.hidden ? 'hidden' : `shown, "${pointing.facingAnchor.label}"`}`);
console.log(`  looking at the aircraft: arrow ${pointing.facingPlane.hidden ? 'hidden' : 'shown'}`);

if (pointing.separation < 50) failures.push('test setup: aircraft too near the anchor to tell the two apart');
if (pointing.facingAnchor.hidden) failures.push('arrow hides when you look at the anchor, even though the aircraft is elsewhere');
if (!pointing.facingPlane.hidden) failures.push('arrow still showing while looking straight at the aircraft');

// And the distance it reports must be to the aircraft, not to the anchor.
const labelled = Number.parseFloat(pointing.facingAnchor.label);
const expected = pointing.planeRange < 1000 ? pointing.planeRange : pointing.planeRange / 1000;
/*
 * Tolerance has to scale with airspeed: the label and the range are sampled a
 * frame or two apart, and at 60 m/s the aircraft moves several metres in that
 * time. Comparing them to within a fixed couple of metres is not a real
 * requirement, it is a race.
 */
const speed = await page.evaluate(() => window.__ar.flightConfig.speed);
const tolerance = Math.max(2, expected * 0.05, speed * 0.25);
if (Number.isFinite(labelled) && Math.abs(labelled - expected) > tolerance) {
  failures.push(`arrow reads "${pointing.facingAnchor.label}" but the aircraft is ${pointing.planeRange.toFixed(0)} m away`);
}

/*
 * If the model ships a clip it must keep running underneath the authored
 * travel - but not every model has one. The TCCC aircraft has no animation at
 * all, so the flight path is its only motion; asserting a clip unconditionally
 * would just be asserting which model happens to be the default.
 */
if (config.clip) {
  const clipAdvances = await page.evaluate(async () => {
    const before = window.__ar.model.mixer?.time ?? 0;
    await new Promise((r) => setTimeout(r, 400));
    return (window.__ar.model.mixer?.time ?? 0) - before;
  });
  console.log(`  bundled clip     "${config.clip}" advanced ${clipAdvances.toFixed(2)}s in 0.4s`);
  if (clipAdvances < 0.2) failures.push(`the model clip "${config.clip}" is not playing`);
} else {
  console.log('  bundled clip     none - the flight path is the only motion');
}

failures.push(...errors);
await browser.close();

if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — beats up and down the line, nose first, never doubling back');
