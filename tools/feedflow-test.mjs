/**
 * The feed-age estimator against a real <video>, not just arrays.
 *
 * tools/feedlag-test.mjs covers the arithmetic. What it cannot cover is the
 * half that touches the browser: drawing a video frame to a canvas, reducing it
 * to a column signature, and tracking that through a moving picture. So this
 * builds a camera whose latency is known — a canvas painted with a textured
 * scene, scrolled by a DELAYED copy of the yaw signal, published as a
 * MediaStream — and asks the estimator to recover that delay.
 *
 * If this passes, the mechanism works on pixels from a video element, which is
 * the only thing standing between the arithmetic and a phone.
 */
// CHROMIUM_PATH is for environments that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});
const ctx = await browser.newContext({
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 51.5104797, longitude: -0.0900796, accuracy: 6 },
  ignoreHTTPSErrors: true, viewport: { width: 480, height: 360 },
});
const page = await ctx.newPage();
await page.goto(`${BASE}/?sim=0&mode=relative&distance=200&bearing=90`, { waitUntil: 'load' });
await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
await page.click('#gate-start');
await page.waitForFunction(() => window.__ar?.createFeedLagMeter, null, { timeout: 30_000 });

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

/** Runs a synthetic camera lagging by `latencyMs` and returns what was measured. */
const measure = (latencyMs, { featureless = false } = {}) => page.evaluate(async ({ latencyMs, featureless }) => {
  const SAMPLE_HZ = 60;
  const scene = document.createElement('canvas');
  scene.width = 320; scene.height = 240;
  const paint = scene.getContext('2d');

  // A textured scene: irregular stripes, so the shift search has something
  // unambiguous to lock onto, as a real street does.
  const draw = (offsetPx) => {
    paint.fillStyle = '#203040';
    paint.fillRect(0, 0, scene.width, scene.height);
    if (featureless) return; // a clear sky: nothing to track
    for (let i = 0; i < 40; i += 1) {
      const x = ((i * 37 + Math.sin(i) * 11) % 320 + offsetPx % 320 + 640) % 320;
      paint.fillStyle = i % 3 === 0 ? '#9fd0ff' : i % 3 === 1 ? '#4a6577' : '#d8e6f2';
      paint.fillRect(x, 0, 3 + (i % 4), scene.height);
    }
  };
  draw(0);

  const video = document.createElement('video');
  video.srcObject = scene.captureStream(SAMPLE_HZ);
  video.muted = true; video.playsInline = true;
  await video.play();

  const meter = window.__ar.createFeedLagMeter({ video, sampleHz: SAMPLE_HZ, maxLagSeconds: 0.3 });

  // Yaw history, so the picture can be scrolled by where the phone WAS.
  const history = [];
  const start = performance.now();
  /*
   * Deliberately not a clean sinusoid. A smooth pan correlates well across a
   * range of lags, which leaves the peak broad and the answer ambiguous — real
   * hand-held panning has plenty of high-frequency content, and a test signal
   * without it measures the method's resolution rather than its correctness.
   */
  const yawAt = (t) => Math.sin(t / 0.9) * 55 + Math.sin(t / 2.3) * 20
    + Math.sin(t / 0.21) * 9 + Math.sin(t / 0.11) * 4;
  const PX_PER_DEG = 6;

  let previous = start;
  let previousYaw = yawAt(0);
  await new Promise((resolve) => {
    const step = (now) => {
      const t = (now - start) / 1000;
      const dt = (now - previous) / 1000;
      previous = now;

      // The scene is painted as it was `latencyMs` ago: that is the latency.
      const shown = yawAt(Math.max(0, t - latencyMs / 1000));
      draw(-shown * PX_PER_DEG);

      const yaw = yawAt(t);
      if (dt > 0) meter.update(dt, (yaw - previousYaw) / dt);
      previousYaw = yaw;
      history.push(t);

      if (t < 9) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });

  return {
    latencySeconds: meter.latencySeconds,
    correlation: meter.correlation,
    distinctness: meter.distinctness,
    samples: meter.samples,
  };
}, { latencyMs, featureless });

// --- recovers a known camera latency ---
for (const truth of [33, 66, 100]) {
  const got = await measure(truth);
  const measured = got.latencySeconds === null ? null : got.latencySeconds * 1000;
  /*
   * Tolerance of 35 ms, which is two samples at 60 Hz plus the frame the
   * capture stream itself is behind the canvas. Finer than that is not
   * meaningful here, and is not needed: what matters is cancelling most of the
   * latency, since the residual slide is proportional to what is left.
   */
  check(`recovers a ${truth} ms feed latency`,
    measured !== null && Math.abs(measured - truth) <= 35,
    measured === null ? `nothing measured, r=${got.correlation.toFixed(2)}` : `${measured.toFixed(0)} ms, r=${got.correlation.toFixed(2)}`);
}

/*
 * --- refuses a scene it cannot track ---
 *
 * Pointed at clear sky there is nothing to measure, and the honest answer is
 * "no estimate" so the caller falls back. Reporting a confident wrong number
 * here would apply a wrong delay and make the aircraft slide the other way.
 */
{
  const got = await measure(66, { featureless: true });
  check('reports nothing for a featureless scene', got.latencySeconds === null,
    `${got.latencySeconds}, r=${got.correlation.toFixed(2)}`);
}

await browser.close();
if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — recovers a camera\'s latency from its pixels');
