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
  // Whatever actually carries the user to the AR page, as the DOM has it.
  previewHref: document.getElementById('preview').getAttribute('href'),
  openHref: document.getElementById('open-ar').getAttribute('href'),
}));
console.log(`  picker drew a ${emitted.outline}-point circuit and emitted a URL`);

/*
 * "Open for real" and "Preview here" must be real links with real hrefs.
 * They used to be buttons calling window.open() with a features string, which
 * iOS Safari classifies as a popup and blocks silently — so on the one device
 * the picker exists to serve, both buttons did nothing at all. Reading #url
 * (as the rest of this test does) would never have caught that.
 */
if (emitted.openHref !== emitted.url) {
  failures.push(`"Open for real" href is ${emitted.openHref}, expected ${emitted.url}`);
}
if (!emitted.previewHref?.includes('sim=1')) {
  failures.push(`"Preview here" href is not a simulated link: ${emitted.previewHref}`);
}

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

/*
 * The "Ship it" snippet must carry the flight settings as code, not as a
 * comment. It used to end with "// length 250, turn 40, ..." and point you at
 * config.js, which made the snippet byte-identical however the sliders were
 * set — so tuning the circuit and pasting the result changed the anchor and
 * silently discarded everything else.
 */
const shipped = await picker.evaluate(async () => {
  const move = (id, value) => {
    const input = document.getElementById(id);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const before = document.getElementById('snippet').value;
  move('alt', '135');
  move('speed', '47');
  move('turn', '75');
  move('size', '250');
  return { before, after: document.getElementById('snippet').value };
});

if (shipped.before === shipped.after) {
  failures.push('moving the sliders did not change the "Ship it" snippet at all');
}
for (const [label, needle] of [
  ['altitude', 'altitude: 135'],
  ['speed', 'speed: 47'],
  ['turnRadius', 'turnRadius: 75'],
  ['size', 'size: 250'],
]) {
  if (!shipped.after.includes(needle)) {
    failures.push(`"Ship it" snippet does not carry ${label} as code (${needle})`);
  }
}
if (/^\s*\/\/\s*length \d/m.test(shipped.after)) {
  failures.push('"Ship it" snippet still emits the flight settings as a comment');
}

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
  window.__sizeApplied = window.__ar.model.preset.size;
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
    size: window.__sizeApplied,
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
const emittedSize = Number(new URL(emitted.url).searchParams.get('size'));
if (Number.isFinite(emittedSize) && Math.abs(applied.size - emittedSize) > 0.01) {
  failures.push(`picker asked for size ${emittedSize} m, AR page used ${applied.size} m`);
} else {
  console.log(`  aircraft size ${applied.size} m carried through`);
}
if (Math.abs(applied.heading - SITE.heading) > 1) {
  failures.push(`AR flying ${applied.heading.toFixed(1)}°, expected ${SITE.heading}°`);
}

/*
 * A coordinate of exactly 0 must be honoured, not treated as absent. Longitude
 * 0 is the Greenwich meridian, which runs through London — the one place this
 * is guaranteed to be used.
 */
{
  const zeroPage = await arCtx.newPage();
  await zeroPage.goto(`${BASE}/?mode=fixed&lat=0&lon=0&debug=1`, { waitUntil: 'load' });
  await zeroPage.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
  await zeroPage.click('#gate-start');
  await zeroPage.waitForFunction(
    () => document.getElementById('f-anchor')?.textContent !== '—',
    { timeout: 20_000 },
  );
  const anchor = await zeroPage.evaluate(() => document.getElementById('f-anchor').textContent);
  const [zLat, zLon] = anchor.split(',').map(Number);
  console.log(`  ?lat=0&lon=0 anchors at ${anchor}`);
  if (Math.abs(zLat) > 1e-6 || Math.abs(zLon) > 1e-6) {
    failures.push(`?lat=0&lon=0 fell back to the configured site (${anchor})`);
  }
  await zeroPage.close();
}

failures.push(...errors);
await browser.close();

if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — picker output drives the AR page correctly');
