/**
 * The map picker, end to end.
 *
 * Its whole job is to emit configuration that the AR page then honours, so the
 * test does exactly that: drive the picker, take the URL it produces, open it,
 * and check the aircraft really is anchored and aimed where the map said.
 * Checking the picker's own readout would prove nothing about the handoff.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
// A stretch of the Thames at Tower Bridge, running roughly ESE.
const SITE = { lat: 51.505516, lon: -0.075367, heading: 100, length: 300 };

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});
const failures = [];
const errors = [];

// ── The picker ───────────────────────────────────────────────────────────────
const pickerCtx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 800 } });
const picker = await pickerCtx.newPage();
picker.on('pageerror', (e) => errors.push(`setup pageerror: ${e.message}`));

await picker.goto(
  `${BASE}/setup.html?lat=${SITE.lat}&lon=${SITE.lon}&heading=${SITE.heading}&length=${SITE.length}`,
  { waitUntil: 'load' },
);
await picker.waitForFunction(() => window.__setup, { timeout: 20_000 });

const emitted = await picker.evaluate(() => ({
  url: document.getElementById('url').value,
  snippet: document.getElementById('snippet').value,
  outline: window.__setup.outline.points.length,
}));
console.log(`  picker drew a ${emitted.outline}-point circuit and emitted a URL`);

/*
 * The emitted link must point at the AR page, never back at the picker. The
 * dev server serves this page at both /setup.html and /setup, and deriving the
 * base by stripping the filename silently failed on the second, sending every
 * QR scan straight back to the setup page.
 */
if (/setup(?:[.]html)?[?]/.test(emitted.url)) {
  failures.push(`emitted URL points back at the picker: ${emitted.url}`);
}

for (const path of ['/setup.html', '/setup']) {
  const alt = await pickerCtx.newPage();
  await alt.goto(`${BASE}${path}?lat=${SITE.lat}&lon=${SITE.lon}`, { waitUntil: 'load' });
  await alt.waitForFunction(() => window.__setup, { timeout: 20_000 });
  const emittedHere = await alt.evaluate(() => document.getElementById('url').value);
  const target = new URL(emittedHere).pathname;
  console.log(`  opened at ${path} -> emits ${target || '/'}`);
  if (/setup/.test(target)) {
    failures.push(`opened at ${path}, the picker emits a link back to itself (${target})`);
  }
  await alt.close();
}

if (emitted.outline < 50) failures.push('circuit outline barely drawn');
if (!emitted.snippet.includes(`lat: ${SITE.lat}`)) failures.push('location.js snippet has the wrong latitude');

// The two pins ARE the run, so the emitted anchor must be their midpoint and
// the emitted length their separation. Getting this wrong would put the circuit
// half a run-length off the water.
const derived = await picker.evaluate(() => ({
  a: window.__setup.state.a,
  b: window.__setup.state.b,
  heading: window.__setup.heading,
  length: window.__setup.length,
  centre: window.__setup.centre,
}));
console.log(`  pins ${derived.length.toFixed(0)} m apart on ${derived.heading.toFixed(1)}°`);
if (Math.abs(derived.length - SITE.length) > 1) {
  failures.push(`run is ${derived.length.toFixed(0)} m between the pins, expected ${SITE.length}`);
}
if (Math.abs(derived.heading - SITE.heading) > 0.5) {
  failures.push(`run bears ${derived.heading.toFixed(1)}°, expected ${SITE.heading}°`);
}
if (Math.abs(derived.centre.lat - SITE.lat) > 1e-5 || Math.abs(derived.centre.lon - SITE.lon) > 1e-5) {
  failures.push('the emitted anchor is not the midpoint of the two pins');
}

// Dragging an end must lengthen the run and swing its bearing.
const dragged = await picker.evaluate(() => {
  const s = window.__setup;
  s.state.b = { lat: s.state.b.lat + 0.001, lon: s.state.b.lon + 0.001 };
  s.render();
  return { heading: s.heading, length: s.length, url: document.getElementById('url').value };
});
if (Math.abs(dragged.length - derived.length) < 10) {
  failures.push('dragging an end pin did not change the run length');
}
if (!dragged.url.includes(`heading=${dragged.heading.toFixed(1)}`)) {
  failures.push('dragging an end pin did not update the emitted URL');
}
console.log(`  dragging B: ${derived.length.toFixed(0)} m -> ${dragged.length.toFixed(0)} m, `
  + `${derived.heading.toFixed(1)}° -> ${dragged.heading.toFixed(1)}°`);
await pickerCtx.close();

// ── The AR page, driven by what the picker produced ──────────────────────────
const arCtx = await browser.newContext({
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: SITE.lat - 300 / 111_320, longitude: SITE.lon, accuracy: 8 },
  ignoreHTTPSErrors: true, viewport: { width: 414, height: 896 },
});
const ar = await arCtx.newPage();
ar.on('pageerror', (e) => errors.push(`ar pageerror: ${e.message}`));

await ar.goto(emitted.url, { waitUntil: 'load' });
await ar.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
await ar.click('#gate-start');
await ar.waitForFunction(() => window.__ar?.flightPath, { timeout: 20_000 });
// __ar appears the moment the model is placed, but the HUD is written by the
// next render, so wait for the readout rather than racing it.
await ar.waitForFunction(
  () => document.getElementById('f-anchor')?.textContent !== '—',
  { timeout: 20_000 },
);

const applied = await ar.evaluate(() => {
  const { THREE, flightPath, model } = window.__ar;
  // Recover the flown heading from the path itself.
  const a = flightPath.positionAt(0);
  const b = flightPath.positionAt(flightPath.lapTime * 0.2);
  const east = b.x - a.x;
  const north = -(b.z - a.z);
  return {
    anchor: document.getElementById('f-anchor').textContent,
    heading: ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360,
    altitude: model.motion.position.y,
  };
});

const [gotLat, gotLon] = applied.anchor.split(',').map(Number);
console.log(`  AR page anchored at ${applied.anchor}, flying ${applied.heading.toFixed(1)}°`);

// Guard the comparison: an unparsed readout yields NaN, and every `>` test
// against NaN is false, so a missing anchor would quietly pass.
if (!Number.isFinite(gotLat) || !Number.isFinite(gotLon)) {
  failures.push(`AR page never reported an anchor (read "${applied.anchor}")`);
} else if (Math.abs(gotLat - SITE.lat) > 1e-5 || Math.abs(gotLon - SITE.lon) > 1e-5) {
  failures.push(`AR anchored at ${applied.anchor}, expected ${SITE.lat}, ${SITE.lon}`);
}
if (Math.abs(applied.heading - SITE.heading) > 1) {
  failures.push(`AR flying ${applied.heading.toFixed(1)}°, expected ${SITE.heading}°`);
}

failures.push(...errors);
await browser.close();

if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — picker output drives the AR page correctly');
