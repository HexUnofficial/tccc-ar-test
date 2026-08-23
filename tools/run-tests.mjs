/**
 * Builds the site, serves it, and runs the smoke test across a spread of
 * placements. One command so there's no excuse not to run it before a deploy.
 *
 * Two engines are covered. The 8th Wall build is the experience, and the first
 * two suites below are its own — the georeference maths, and the separation of
 * world from camera that the port exists to achieve. Everything after them
 * predates the port and drives the LocAR engine, which is still reachable with
 * `?engine=locar` for side-by-side comparison on site; those tools ask for it by
 * name in their URLs. Several of them measure machinery the XR8 engine does not
 * have (rotation filters, feed-latency matching) and are kept because that
 * engine is kept, not because the settings still apply.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { INSTALLATION } from '../src/location.js';

// The dev cert is self-signed; every request in this file targets our own server.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PORT = 4173;
const BASE_URL = `https://localhost:${PORT}`;

const SCENARIOS = [
  { name: 'near, due north', env: { MODE: 'relative', DISTANCE: '6', BEARING: '0' } },
  { name: 'mid range, east', env: { MODE: 'relative', DISTANCE: '20', BEARING: '90' } },
  { name: 'far, south west', env: { MODE: 'relative', DISTANCE: '50', BEARING: '225' } },
  { name: 'equator (no Mercator distortion)', env: { MODE: 'relative', DISTANCE: '20', LAT: '0' } },
  { name: 'high latitude (worst distortion)', env: { MODE: 'relative', DISTANCE: '20', LAT: '68.5' } },
  {
    // Stand 30 m south of whatever location.js is currently configured for.
    name: `fixed site (${INSTALLATION.label})`,
    env: {
      MODE: 'fixed',
      LAT: String(INSTALLATION.lat - 30 / 111_320),
      LON: String(INSTALLATION.lon),
    },
  },
];

const run = (cmd, args, options = {}) =>
  spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });

/*
 * First, and before anything is built: the georeference maths. It needs no
 * browser and no server, it is where a sign error would hide, and a failure
 * here makes every visual test downstream meaningless.
 */
console.log('──── the georeference ────');
{
  const child = run('node', ['tools/georef-test.mjs']);
  if ((await once(child, 'exit'))[0] !== 0) {
    console.error('georeference maths is wrong; nothing else is worth running');
    process.exit(1);
  }
}

console.log('\n▸ building…');
const buildWith = (env) => run('npx', ['vite', 'build', '--logLevel', 'warn'], {
  env: { ...process.env, ...env },
});
if ((await once(buildWith({}), 'exit'))[0] !== 0) process.exit(1);

console.log(`▸ serving on ${BASE_URL}`);
const server = run('npx', ['vite', 'preview', '--port', String(PORT)], { stdio: 'ignore' });

// Wait for the server to answer rather than guessing at a sleep duration.
for (let attempt = 0; ; attempt += 1) {
  try {
    await fetch(BASE_URL);
    break;
  } catch {
    if (attempt > 50) { server.kill(); throw new Error('preview server never came up'); }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const failed = [];

/*
 * The showstopper, as a test: panning, walking and GPS noise must not move the
 * aircraft, while walking must still change where it appears. Runs against
 * ?sim=1, so it needs no 8th Wall app key.
 */
console.log('\n──── world and camera are separable ────');
{
  const child = run('node', ['tools/parallax-test.mjs'], {
    env: { ...process.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('world and camera are separable');
}

/*
 * The parts of the 8th Wall path that can be checked without a key: the depth
 * range that keeps a 2.5 km circuit inside the frustum, and the message a build
 * deployed without one has to show.
 */
console.log('\n──── the XR8 harness ────');
{
  const child = run('node', ['tools/xr8-test.mjs'], {
    env: { ...process.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('the XR8 harness');
}

for (const scenario of SCENARIOS) {
  console.log(`\n──── ${scenario.name} ────`);
  const child = run('node', ['tools/smoke-test.mjs'], {
    env: { ...process.env, ...scenario.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push(scenario.name);
}

// Static placement is covered above; this one checks she responds to movement.
console.log(`
──── walking towards her ────`);
{
  const child = run('node', ['tools/walk-test.mjs'], {
    env: { ...process.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('walking towards her');
}

// And this one checks that the movement is smooth rather than lurching.
console.log(`
──── walking smoothly ────`);
{
  const child = run('node', ['tools/motion-test.mjs'], {
    env: { ...process.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('walking smoothly');
}

// Being in the wrong place must not look like the AR being broken.
console.log(`\n──── status banner ────`);
{
  const child = run('node', ['tools/banner-test.mjs'], {
    env: { ...process.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('status banner');
}

// Frameless presentation: our overlay out of the way, browser chrome dismissed.
console.log(`\n──── minimal interface ────`);
{
  const child = run('node', ['tools/chrome-test.mjs'], {
    env: { ...process.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('minimal interface');
}

// The aircraft's authored circuit, layered over the GLB's own bob.
console.log(`\n──── flight circuit ────`);
{
  const child = run('node', ['tools/flight-test.mjs'], {
    env: { ...process.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('flight circuit');
}

// The map picker, and the config it hands to the AR page.
console.log(`\n──── map picker ────`);
{
  const child = run('node', ['tools/setup-test.mjs'], {
    env: { ...process.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('map picker');
}

// The delivered GLB itself, before anything is served: a WebP texture or an
// opaque material marked BLEND makes every later visual failure a red herring.
console.log('');
console.log('──── the delivered model ────');
{
  const child = run('node', ['tools/model-test.mjs']);
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('the delivered model');
}

// Feed matching must degrade to the shipped behaviour on browsers that report
// no frame capture time, since this has to run on whatever a visitor brings.
console.log('');
console.log('──── matching the camera feed ────');
{
  const child = run('node', ['tools/feedmatch-test.mjs'], {
    env: { ...process.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('matching the camera feed');
}

server.kill();

// Does the scene stay put when the viewer does?
console.log('');
console.log('──── holding station ────');
{
  const child = run('node', ['tools/drift-test.mjs'], {
    env: { ...process.env, BASE_URL, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) failed.push('holding station');
}

// The picker ships with the site now, but must stay opt-out-able: if the
// placement is ever locked down, a build has to be able to drop it entirely.
console.log('');
console.log('──── build variants ────');
{
  const { existsSync } = await import('node:fs');
  if (!existsSync('dist/setup.html')) {
    console.error('  ✖ dist/setup.html missing - the picker should ship by default');
    failed.push('build variants');
  } else {
    console.log('  ✔ setup.html included by default');
  }

  const [code] = await once(buildWith({ EXCLUDE_SETUP: '1' }), 'exit');
  if (code !== 0) {
    failed.push('build variants');
  } else if (existsSync('dist/setup.html')) {
    console.error('  ✖ EXCLUDE_SETUP=1 still produced dist/setup.html');
    failed.push('build variants');
  } else {
    console.log('  ✔ EXCLUDE_SETUP=1 leaves it out');
  }

  // Leave dist as the real deployable.
  if ((await once(buildWith({}), 'exit'))[0] !== 0) failed.push('build variants');
}

console.log(`\n${'═'.repeat(50)}`);
if (failed.length) {
  console.error(`✖ ${failed.length}/${SCENARIOS.length + 10} scenarios failed:`);
  for (const name of failed) console.error(`   - ${name}`);
  process.exit(1);
}
console.log(`✔ all ${SCENARIOS.length + 10} scenarios passed`);
