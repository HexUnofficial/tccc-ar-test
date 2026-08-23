/**
 * ── THE SHOWSTOPPER, AS A TEST ────────────────────────────────────────────
 *
 * The complaint that prompted the port: "if the plane is unable to fly past us
 * without being knocked off course by the camera movement, that feels like a
 * showstopper." So the fix is not a feeling, it is four measurements.
 *
 *   1. rotation      panning the camera must not move the aircraft, at all
 *   2. translation   walking must not move it either — but it must change where
 *                    it appears on screen, which is what parallax is
 *   3. flypast       the trajectory flown while the camera is being thrown
 *                    around must be identical to the one flown with it still
 *   4. gps noise     fifteen metres of GPS jitter must move nothing
 *
 * All four are the same claim from different angles: the aircraft's position is
 * a number in a frame the camera is not part of. Under the LocAR engine every
 * one of them fails by construction, because there was one frame and both
 * sensors wrote into it — which is why this file only runs the XR8 engine, and
 * why `?engine=locar` is worth keeping to watch it fail.
 *
 * Runs against ?sim=1, so it needs no 8th Wall app key and no phone. What the
 * simulator supplies is precisely what XR8 supplies and LocAR could not: a
 * camera that can be translated in world metres.
 */
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
/** Metres of lateral "walk" for the parallax check. */
const WALK = 10;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--ignore-certificate-errors',
  ],
});

const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

async function open(query) {
  const ctx = await browser.newContext({
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: INSTALLATION.lat, longitude: INSTALLATION.lon, accuracy: 6 },
    ignoreHTTPSErrors: true,
    viewport: { width: 414, height: 896 },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?sim=1&ui=debug&${query}`, { waitUntil: 'load' });
  await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
  await page.click('#gate-start');
  // The world is placed on the first fix; in the simulator that is immediate,
  // but the model still has to finish decoding first.
  await page.waitForFunction(() => window.__ar?.georef?.locked && window.__ar?.model,
    null, { timeout: 40_000 });
  return { ctx, page, errors };
}

/*
 * A moderate standoff and a short circuit, so the aircraft passes the camera
 * several times a second of wall-clock rather than once a minute. The defect
 * being tested is scale-independent; a 2475 m leg would only make the test slow.
 */
const SCENE = 'mode=relative&distance=200&bearing=0&length=300&turn=40&speed=60&alt=40';

console.log('\n──── 1. panning cannot move the world ────');
{
  const { ctx, page, errors } = await open(SCENE);

  const result = await page.evaluate(async () => {
    const { THREE, camera, model, georef } = window.__ar;
    // Freeze the circuit: this measures what the CAMERA does to the aircraft,
    // and an aircraft that is flying would confound the two.
    window.__ar.setFlightTime(12.5);
    const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await settle();

    const before = model.motion.getWorldPosition(new THREE.Vector3());
    const anchorBefore = model.root.position.clone();

    /*
     * A pan far more violent than a person could manage: a full turn plus a
     * pitch sweep from the pavement to the zenith, 72 steps, each one a frame.
     */
    let worst = 0;
    const after = new THREE.Vector3();
    for (let i = 0; i < 72; i += 1) {
      camera.rotation.order = 'YXZ';
      camera.rotation.set(
        Math.sin((i / 72) * Math.PI * 2) * 1.4,
        (i / 72) * Math.PI * 2,
        0,
      );
      window.__ar.setFlightTime(12.5);
      await settle();
      model.motion.getWorldPosition(after);
      worst = Math.max(worst, before.distanceTo(after));
    }

    return {
      worst,
      anchorDrift: anchorBefore.distanceTo(model.root.position),
      yaw: georef.yaw,
      range: before.distanceTo(camera.position),
    };
  });

  // Sub-millimetre, not "small": nothing in the pipeline is supposed to touch
  // this, so anything above float noise means something read the camera.
  check('aircraft world position unchanged by a full pan', result.worst < 1e-3,
    `worst ${(result.worst * 1000).toFixed(4)} mm over ${result.range.toFixed(0)} m`);
  check('anchor unchanged by a full pan', result.anchorDrift < 1e-3,
    `${(result.anchorDrift * 1000).toFixed(4)} mm`);
  check('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n──── 2. walking gives parallax, not drag ────');
{
  const { ctx, page, errors } = await open(SCENE);

  const result = await page.evaluate(async (walk) => {
    const { THREE, camera, model, georef } = window.__ar;
    window.__ar.setFlightTime(12.5);
    const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await settle();

    const worldBefore = model.motion.getWorldPosition(new THREE.Vector3());
    const screenBefore = worldBefore.clone().project(camera);
    const fixBefore = georef.geoFromWorld(camera.position);
    const start = camera.position.clone();

    // Sidestep, keeping the camera pointing the same way — the cleanest possible
    // parallax: the subject has not moved and the view direction has not changed,
    // so any change on screen is due to the baseline alone.
    camera.position.set(start.x + walk, start.y, start.z);
    window.__ar.setFlightTime(12.5);
    await settle();

    const worldAfter = model.motion.getWorldPosition(new THREE.Vector3());
    const screenAfter = worldAfter.clone().project(camera);
    const fixAfter = georef.geoFromWorld(camera.position);

    /*
     * What the parallax ought to be. Stepping `walk` metres sideways at a range
     * of r shifts the subject by atan(walk / r) radians of bearing; if the
     * aircraft were being dragged along by the camera it would be zero.
     */
    const range = worldBefore.distanceTo(start);
    return {
      worldDrift: worldBefore.distanceTo(worldAfter),
      screenShift: Math.abs(screenAfter.x - screenBefore.x),
      expectedRadians: Math.atan(walk / range),
      range,
      fixMoved: fixBefore && fixAfter
        ? Math.hypot(
            (fixAfter.lat - fixBefore.lat) * 111_320,
            (fixAfter.lon - fixBefore.lon) * 111_320 * Math.cos((fixBefore.lat * Math.PI) / 180),
          )
        : null,
    };
  }, WALK);

  check('aircraft world position unchanged by walking', result.worldDrift < 1e-3,
    `${(result.worldDrift * 1000).toFixed(4)} mm`);
  // The whole point: it must move ON SCREEN. A dragged model would not.
  check('aircraft moves on screen (parallax present)', result.screenShift > 1e-3,
    `${result.screenShift.toFixed(4)} NDC over a ${WALK} m baseline at ${result.range.toFixed(0)} m`);
  // And the position the HUD reports has to follow the camera, because that is
  // now derived from the pose rather than from GPS.
  check('reported viewer fix follows the walk',
    result.fixMoved !== null && Math.abs(result.fixMoved - WALK) < 1,
    `${result.fixMoved?.toFixed(2)} m of ${WALK} m`);
  check('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n──── 3. the flypast is unaffected by the camera ────');
{
  const { ctx, page, errors } = await open(SCENE);

  const result = await page.evaluate(async () => {
    const { THREE, camera, model, flightPath } = window.__ar;
    const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    /*
     * Sample one whole lap twice. The first time the camera is left alone; the
     * second it is panned, pitched and walked between every sample — the worst
     * a spectator tracking a fast aircraft could do to it. Two identical
     * trajectories is the claim: the flight is not a function of the camera.
     */
    const lap = flightPath.lapTime;
    const sample = async (disturb) => {
      const path = [];
      const at = new THREE.Vector3();
      for (let i = 0; i < 48; i += 1) {
        const t = (i / 48) * lap;
        if (disturb) {
          camera.rotation.order = 'YXZ';
          camera.rotation.set(Math.sin(i * 0.7) * 1.2, i * 0.53, Math.sin(i * 0.3) * 0.2);
          camera.position.set(Math.sin(i * 0.4) * 6, 1.6 + Math.sin(i) * 0.5, Math.cos(i * 0.4) * 6);
        }
        window.__ar.setFlightTime(t);
        await settle();
        path.push(model.motion.getWorldPosition(at.clone()));
      }
      return path;
    };

    const still = await sample(false);
    // Put the camera back before the second pass, so the two runs differ only
    // in what happens DURING them.
    camera.position.set(0, 1.6, 0);
    camera.rotation.set(0, 0, 0);
    const thrown = await sample(true);

    let worst = 0;
    for (let i = 0; i < still.length; i += 1) worst = Math.max(worst, still[i].distanceTo(thrown[i]));

    /*
     * And confirm the lap really does pass the camera rather than orbiting in
     * front of it: with the camera at the world origin, the aircraft's own
     * forward axis has to reverse relative to the line of sight, which only
     * happens if it goes by.
     */
    const origin = new THREE.Vector3(0, 1.6, 0);
    const bearings = still.map((p) => Math.atan2(p.x - origin.x, -(p.z - origin.z)));
    const swept = Math.max(...bearings) - Math.min(...bearings);

    return { worst, swept: (swept * 180) / Math.PI, lap };
  });

  check('trajectory identical with the camera thrown around', result.worst < 1e-3,
    `worst divergence ${(result.worst * 1000).toFixed(4)} mm over a ${result.lap.toFixed(1)} s lap`);
  check('the circuit actually passes the viewer', result.swept > 45,
    `sweeps ${result.swept.toFixed(0)}° of bearing`);
  check('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n──── 4. GPS noise moves nothing (geolock=once) ────');
{
  const { ctx, page, errors } = await open(`${SCENE}&simnoise=15&geolock=once`);

  const result = await page.evaluate(async () => {
    const { THREE, model, georef } = window.__ar;
    const anchor = model.root.position.clone();
    const worldOrigin = georef.worldOrigin.clone();
    // Four seconds is four synthetic fixes, each up to 15 m out.
    await new Promise((r) => setTimeout(r, 4200));
    return {
      anchorDrift: anchor.distanceTo(model.root.position),
      originDrift: worldOrigin.distanceTo(georef.worldOrigin),
      residual: georef.residual,
      moved: new THREE.Vector3().subVectors(model.root.position, anchor).length(),
    };
  });

  check('anchor unmoved by 15 m of GPS jitter', result.anchorDrift < 1e-3,
    `${(result.anchorDrift * 1000).toFixed(4)} mm, residual reported as ${result.residual?.toFixed(1)} m`);
  check('world origin unmoved', result.originDrift < 1e-3, `${(result.originDrift * 1000).toFixed(4)} mm`);
  // The residual still has to be *reported*, or the HUD cannot tell you the
  // compass lock went wrong.
  check('residual is still measured and surfaced', Number.isFinite(result.residual),
    `${result.residual?.toFixed(1)} m`);
  check('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

console.log('\n──── 5. geolock=follow does move it (the knob works) ────');
{
  const { ctx, page, errors } = await open(`${SCENE}&simnoise=15&geolock=follow`);

  const drift = await page.evaluate(async () => {
    const anchor = window.__ar.model.root.position.clone();
    await new Promise((r) => setTimeout(r, 4200));
    return anchor.distanceTo(window.__ar.model.root.position);
  });

  // Not a feature — a control. If this passes while test 4 also passes, then the
  // stillness in test 4 is the georeference holding, not the fixes never landing.
  check('following the fixes visibly moves the world', drift > 0.5, `${drift.toFixed(2)} m`);
  check('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll parallax checks passed — the world and the camera are separable.');
