/**
 * Stage the 8th Wall engine into public/ so Vite serves it verbatim.
 *
 * The engine is a prebuilt binary that installs itself onto `window.XR8`, and
 * it loads a second chunk (SLAM) by URL at runtime. That rules out importing it
 * as a module: a bundler would neither find that chunk nor be able to rewrite
 * the path it fetches. Its own instructions are to copy the distributed files
 * and reference them with a script tag, and the licence only permits
 * distributing it in the form it arrived in — so it is copied, not processed.
 *
 * Runs from `prebuild`, so a fresh checkout cannot deploy an xr page whose
 * engine is missing.
 */
import { cp, mkdir, stat } from 'node:fs/promises';

const FROM = 'node_modules/@8thwall/engine-binary/dist';
const TO = 'public/xr8';

try {
  await stat(FROM);
} catch {
  console.log('  xr8         engine not installed; skipping (npm i @8thwall/engine-binary)');
  process.exit(0);
}

await mkdir(TO, { recursive: true });
await cp(FROM, TO, { recursive: true });
const { size } = await stat(`${TO}/xr-slam.js`);
console.log(`  xr8         staged engine into ${TO} (SLAM chunk ${(size / 1048576).toFixed(1)} MB)`);
