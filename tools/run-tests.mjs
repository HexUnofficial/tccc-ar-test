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

/*
 * ── THE PORT HAS TO BE OURS ───────────────────────────────────────────────
 *
 * This suite used to spawn a preview server, wait for `fetch(BASE_URL)` to
 * answer, and take that as proof it was up. On Windows that check is a lie.
 *
 * `spawn` runs the server through a shell, so `server.kill()` kills the shell
 * and leaves the `vite` grandchild holding the port. Every run therefore leaked
 * a server; the next run's `vite preview` found 4173 taken, printed nothing
 * useful into `stdio: 'ignore'`, and exited — but `fetch` answered instantly,
 * because the *old* server was still there. The tests then ran against a stale
 * `dist` from a previous build.
 *
 * Which is exactly what it looked like: intermittent failures, a different
 * scenario each run, every one of them passing when run on its own. Thirty
 * leaked servers had accumulated before the cause was found. It is not
 * flakiness, so it does not get retried — it gets refused.
 */
if (await fetch(BASE_URL).then(() => true).catch(() => false)) {
  console.error(
    `✖ something is already serving ${BASE_URL}.\n`
    + '  That is almost certainly a leaked preview server from an earlier run, and\n'
    + '  continuing would test whichever build it is holding rather than this one.\n'
    + '  Kill it first:\n'
    + '    Windows:  Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |\n'
    + '                Where-Object { $_.CommandLine -match \'vite.*preview\' } |\n'
    + '                ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\n'
    + '    macOS/Linux:  pkill -f "vite preview"',
  );
  process.exit(1);
}

console.log(`▸ serving on ${BASE_URL}`);
const server = run('npx', ['vite', 'preview', '--port', String(PORT)], { stdio: 'ignore' });

/** Kill the server and everything the shell spawned under it. */
const stopServer = () => {
  if (!server.pid || server.exitCode !== null) return;
  if (process.platform === 'win32') {
    // /T for the tree, because the shell is the only child we have a handle on.
    spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill();
  }
};
// Including on Ctrl-C, which is how most of the leaked servers got there.
for (const signal of ['exit', 'SIGINT', 'SIGTERM']) process.once(signal, stopServer);

// Wait for the server to answer rather than guessing at a sleep duration. Safe
// to trust now: the port was demonstrably free a moment ago.
for (let attempt = 0; ; attempt += 1) {
  try {
    await fetch(BASE_URL);
    break;
  } catch {
    if (attempt > 50) { stopServer(); throw new Error('preview server never came up'); }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const failed = [];

/*
 * The showstopper, as a test: panning, walking and GPS noise must not move the
 * aircraft, while walking must still change where it appears. Runs against
 * ?sim=1, so it needs no camera and no device.
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
 * The parts of the 8th Wall path reachable without a camera: the depth range that
 * keeps a 2.5 km circuit inside the frustum, the engine being served from our own
 * origin rather than the retired hosted platform, the messages shown when it
 * fails to start, and the licence attribution the engine obliges us to carry.
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

/*
 * The server goes down here rather than before this test, which is where it used
 * to be. That only ever worked because the kill did not: `server.kill()` killed
 * the shell and left `vite` holding the port, so this test ran against a server
 * that was supposed to be gone. Killing it properly turned that into a failure
 * and showed where the line actually belonged.
 *
 * Everything below needs no server — it inspects the built files.
 */
stopServer();

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
