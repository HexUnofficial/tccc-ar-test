/*
 * The AR.js #278 failure mode: content "sticks" to the camera because it is
 * effectively camera-relative, so walking towards it never makes it bigger.
 * This checks our build for exactly that — walk 150 m at the aircraft and it
 * must grow, while its world position must not move at all.
 */
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';
const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const LAT = INSTALLATION.lat, LON = INSTALLATION.lon;
// CHROMIUM_PATH is for sandboxes that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own, as the other tools do.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--ignore-certificate-errors'] });
const ctx = await browser.newContext({ permissions:['camera','geolocation'],
  geolocation:{latitude:LAT,longitude:LON,accuracy:5},
  ignoreHTTPSErrors:true, viewport:{width:480,height:300} });
const page = await ctx.newPage();
await page.goto(`${BASE}/?engine=locar&sim=0&mode=relative&distance=300&bearing=0&length=50&turn=30&alt=30&size=150&speed=1`, { waitUntil:'load' });
await page.waitForSelector('#gate-start:not([disabled])', { timeout:180000 });
await page.click('#gate-start');
await page.waitForFunction(() => window.__ar?.model?.root, null, { timeout:40000 });

const snapshot = () => page.evaluate(() => {
  const ar = window.__ar, THREE = ar.THREE;
  const box = new THREE.Box3().setFromObject(ar.model.root);
  const world = box.getCenter(new THREE.Vector3());
  const cam = ar.camera.getWorldPosition(new THREE.Vector3());
  const range = world.distanceTo(cam);
  return { world: world.toArray().map(n => +n.toFixed(1)),
    cam: cam.toArray().map(n => +n.toFixed(1)), range: +range.toFixed(1),
    // What "it grows as you walk towards it" actually means.
    subtends: +(THREE.MathUtils.radToDeg(2 * Math.atan(
      box.getSize(new THREE.Vector3()).length() / 2 / range))).toFixed(2) };
});

const before = await snapshot();
// Driven through the real geolocation API so LocAR's own watchPosition does the
// moving, exactly as on the phone. A synthetic gpsupdate would move nothing.
// Repeated fixes, not one: main.js averages the last few fixes, so a single
// new reading parks the camera halfway between old and new for ever. A phone
// gets a fix a second; this is that, sped up.
for (let i = 0; i < 8; i += 1) {
  await ctx.setGeolocation({ latitude: LAT + 150 / 111_320, longitude: LON, accuracy: 5 });
  await page.waitForTimeout(900);
}
// The camera chases each fix at a constant speed rather than teleporting, so
// wait for it to actually arrive instead of guessing at a duration.
await page.waitForFunction(() => {
  const z = window.__ar.camera.position.z;
  const was = window.__lastZ; window.__lastZ = z;
  return was !== undefined && Math.abs(z - was) < 0.05;
}, null, { timeout: 40000, polling: 700 });
const after = await snapshot();

console.log(JSON.stringify({ before, after }, null, 1));
const moved = Math.hypot(after.world[0]-before.world[0], after.world[2]-before.world[2]);
console.log(`\nanchor moved in the world: ${moved.toFixed(1)} m   (must be ~0)`);
console.log(`range to it:    ${before.range} m -> ${after.range} m`);
console.log(`apparent size:  ${before.subtends}° -> ${after.subtends}°`);
// The aircraft flies its circuit at 1 m/s throughout, so a few metres of
// movement is its own travel, not the anchor being dragged by the camera.
const walked = Math.abs(after.cam[2] - before.cam[2]);
console.log(`viewer walked:  ${walked.toFixed(1)} m`);
console.log(after.range < before.range - walked * 0.8 && after.subtends > before.subtends * 1.3 && moved < 20
  ? '\n✔ geo-locked: walking at it closes the range and it grows'
  : '\n✖ camera-relative — this would be the AR.js #278 symptom');
await browser.close();
