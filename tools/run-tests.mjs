/**
 * Builds the site, serves it, and runs the smoke test across a spread of
 * placements. One command so there's no excuse not to run it before a deploy.
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

console.log('▸ building…');
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

server.kill();

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
  console.error(`✖ ${failed.length}/${SCENARIOS.length + 7} scenarios failed:`);
  for (const name of failed) console.error(`   - ${name}`);
  process.exit(1);
}
console.log(`✔ all ${SCENARIOS.length + 7} scenarios passed`);
