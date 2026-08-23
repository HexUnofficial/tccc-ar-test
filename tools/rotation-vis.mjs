/**
 * Shows the rotation artefact rather than only measuring it.
 *
 * "The model follows the camera for a bit" is a claim about the model moving
 * against the background, so a test that reports numbers alone can agree with
 * a build that looks wrong — and did: a run of this that fed perfectly smooth
 * synthetic events once made a change look good that was awful on the phone.
 *
 * The ruled backdrop stands in for the camera feed and is scrolled by the TRUE
 * heading, i.e. where the phone is actually pointing. The aircraft is drawn by
 * the app from the FILTERED heading. On a perfect tracker the aircraft would
 * sit on the same stripe in every frame, so any sliding across the stripes is
 * the artefact itself, burned into the frames.
 *
 * Readings carry deterministic noise: the point is that a filter must survive
 * a noisy sensor, and a smooth one hides the failure being looked for.
 *
 *   node tools/rotation-vis.mjs                          # current default
 *   node tools/rotation-vis.mjs '&filter=euro&beta=20'   # a candidate
 *
 * Frames land in .tmp/vis-<label>/; tools/rotation-strip.mjs stacks them.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { INSTALLATION } from '../src/location.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';

const FILTER = process.argv[2] ?? '';
const LABEL  = process.argv[3] ?? 'fixed';
const OUT = `.tmp/vis-${LABEL}`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// CHROMIUM_PATH is for sandboxes that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own, as the other tools do.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--ignore-certificate-errors'],
});
const ctx = await browser.newContext({ permissions:['camera','geolocation'],
  geolocation:{latitude:INSTALLATION.lat,longitude:INSTALLATION.lon,accuracy:7},
  ignoreHTTPSErrors:true, viewport:{width:480,height:300} });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('!!!', e.message));
await page.goto(`${BASE}/?sim=0&mode=relative&distance=300&bearing=90&heading=20&length=50&turn=30&alt=30&size=150&speed=1${FILTER}`, { waitUntil:'load' });
await page.waitForSelector('#gate-start:not([disabled])', { timeout:180000 });
await page.click('#gate-start');
await page.waitForFunction(() => window.__ar?.model, null, { timeout:40000 });

await page.evaluate((label) => {
  const bg = document.createElement('div');
  bg.id = 'truth-backdrop';
  bg.style.cssText = `position:fixed;inset:0;z-index:-50;
    background-image:repeating-linear-gradient(90deg,#39505f 0 2px,transparent 2px 26px),
                     repeating-linear-gradient(90deg,#8fd0ff 0 4px,transparent 4px 130px),
                     linear-gradient(#0f1720,#25384a);`;
  document.body.appendChild(bg);
  // The app's own overlay sits dead centre, exactly where the aircraft is, and
  // would hide the thing being measured.
  document.getElementById('hud')?.remove();
  const hud = document.createElement('div');
  hud.id = 'vis-hud';
  hud.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:50;'
    + 'font:bold 13px/1.6 monospace;color:#fff;background:rgba(0,0,0,.62);padding:3px 7px;';
  hud.dataset.label = label;
  document.body.appendChild(hud);
}, LABEL);

// Blind capture wastes runs: confirm the aircraft is actually in frame, and
// how much of it, before recording anything.
const AIM = 252; // aircraft ~18 deg right of centre, so a 36 deg pan keeps it in frame
const framing = await page.evaluate(async (AIM) => {
  const ar = window.__ar, THREE = ar.THREE;
  const name = ar.app.deviceOrientationControls.orientationChangeEventName;
  for (let i = 0; i < 25; i += 1) {
    const e = new Event(name);
    Object.defineProperties(e, {alpha:{value:AIM},beta:{value:85},gamma:{value:0},absolute:{value:true}});
    window.dispatchEvent(e);
    await new Promise(r => setTimeout(r, 40));
  }
  // Not an NDC check: a point directly BEHIND the camera divides by a negative
  // w and lands back near the middle of the screen, which is how an aircraft
  // 177 deg off-axis read as perfectly centred. Count lit pixels instead.
  const target = new THREE.Box3().setFromObject(ar.model.root).getCenter(new THREE.Vector3());
  const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(ar.camera.quaternion);
  const offAxis = THREE.MathUtils.radToDeg(fwd.angleTo(
    target.clone().sub(ar.camera.getWorldPosition(new THREE.Vector3())).normalize()));

  const gl = ar.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const before = new Uint8Array(w*h*4);
  ar.renderer.render(ar.scene, ar.camera);
  gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,before);
  ar.model.root.visible = false;
  ar.renderer.render(ar.scene, ar.camera);
  const after = new Uint8Array(w*h*4);
  gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,after);
  ar.model.root.visible = true;
  let n=0,minX=1e9,maxX=-1,minY=1e9,maxY=-1;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) { const i=(y*w+x)*4;
    if (Math.abs(before[i]-after[i]) + Math.abs(before[i+3]-after[i+3]) > 8) {
      n++; if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; } }
  return { offAxis:+offAxis.toFixed(1), pixels:n,
    box: n?[minX,minY,maxX,maxY]:null, spanPx: n?maxX-minX:0, tallPx: n?maxY-minY:0 };
}, AIM);
console.log(`${LABEL}: framing`, JSON.stringify(framing));
if (!(framing.spanPx > 60 && framing.offAxis < 40)) { console.error('aircraft not usefully in frame — aborting'); await browser.close(); process.exit(2); }

// Kick the profile off without awaiting it, so Node can screenshot while it runs.
await page.evaluate(() => {
  const ar = window.__ar, THREE = ar.THREE;
  const ctrl = ar.app.deviceOrientationControls, name = ctrl.orientationChangeEventName;
  const bg = document.getElementById('truth-backdrop');
  const hud = document.getElementById('vis-hud');
  const cam = ar.camera, el = ar.renderer.domElement;
  let seed = 20260823;
  const rnd = () => { seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x7fffffff - 0.5; };
  const q = new THREE.Quaternion();

  const AIM = 252, PAN_FROM = 0.7, PAN_TO = 1.3, RATE = 60; // deg/s
  const truthAt = e => AIM + (e < PAN_FROM ? 0
    : e < PAN_TO ? (e - PAN_FROM) * RATE
    : (PAN_TO - PAN_FROM) * RATE);

  const t0 = performance.now();
  let last = 0, start = null, worst = 0;
  // Two separate things the user feels: lag while panning (the model "follows
  // the camera"), and jitter while holding still (it twitches on the spot).
  const panLag = [], stillStep = [];
  let prev = null;
  window.__vis = { done: false, worst: () => worst,
    metrics: () => {
      const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
      return { panLagDeg: +mean(panLag).toFixed(3), worstLagDeg: +worst.toFixed(3),
        stillJitterDeg: +mean(stillStep).toFixed(4), frames: stillStep.length + panLag.length };
    } };

  const frame = now => {
    const e = (now - t0) / 1000;
    const truth = truthAt(e);
    if (now - last >= 1000/30) { last = now;
      const ev = new Event(name);
      Object.defineProperties(ev, { alpha:{value: truth + rnd()*1.2}, beta:{value:85}, gamma:{value:0}, absolute:{value:true} });
      window.dispatchEvent(ev); }

    const hFov = 2*Math.atan(Math.tan(cam.fov*Math.PI/360)*cam.aspect)*180/Math.PI;
    const pxPerDeg = el.clientWidth / hFov;
    if (start === null) start = truth;
    bg.style.backgroundPositionX = `${-(truth - start) * pxPerDeg}px`;

    // Where the app is drawing from, against where the phone truly points.
    // Compared as a rotation, not an extracted yaw angle: at beta 60 an
    // atan2 yaw is close enough to the gimbal to report nonsense.
    q.setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(truth), 0, 'YXZ'));
    const err = cam.quaternion.angleTo(ctrl.object.quaternion) * 180/Math.PI;
    if (e > PAN_FROM && e < PAN_TO + 0.15) { worst = Math.max(worst, err); panLag.push(err); }
    // Held still, after everything has had time to settle: whatever is left is
    // the sensor noise getting through, which is the twitch on the spot.
    if (e > PAN_TO + 0.6) {
      if (prev) stillStep.push(cam.quaternion.angleTo(prev) * 180/Math.PI);
      prev = cam.quaternion.clone();
    }
    const phase = e < PAN_FROM ? 'STILL' : e < PAN_TO ? `PANNING ${RATE}°/s` : 'STILL';
    hud.textContent = `${hud.dataset.label}   t=${e.toFixed(2)}s  ${phase}   `
      + `aircraft off by ${(err * pxPerDeg).toFixed(0)}px`;

    if (e < 2.6) requestAnimationFrame(frame); else window.__vis.done = true;
  };
  requestAnimationFrame(frame);
});

// A CDP screencast, not page.screenshot(): a screenshot costs ~280ms of the
// 3.6s profile, so it samples the pan a handful of times. The screencast
// delivers frames off the compositor as they are painted.
const cdp = await page.context().newCDPSession(page);
const shots = [];
cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
  const i = shots.length;
  shots.push(true);
  writeFileSync(`${OUT}/${String(i).padStart(3,'0')}.png`, Buffer.from(data, 'base64'));
  try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}
});
await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
await page.waitForFunction(() => window.__vis.done, null, { timeout: 30000 });
await cdp.send('Page.stopScreencast');
const m = await page.evaluate(() => window.__vis.metrics());
console.log(`${LABEL}: ${shots.length} frames ${JSON.stringify(m)}`);
await browser.close();
