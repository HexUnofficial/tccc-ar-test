/**
 * Feed matching has to be safe on every device, not just the one it was
 * written on.
 *
 * It holds the render back by however old the displayed camera frame is, read
 * from requestVideoFrameCallback's `captureTime`. That metadata is not
 * guaranteed: a browser may not implement rVFC at all, or may implement it
 * without a capture time, or may report a nonsense value. Every one of those
 * has to land on the shipped behaviour rather than on a guess or a stall, or
 * the experience breaks on exactly the handsets nobody tested.
 */
// CHROMIUM_PATH is for environments that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own.
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

/**
 * @param query   query string for the AR page
 * @param sabotage  runs in the page BEFORE the session starts, to break the
 *                  metadata the way a less capable browser would
 */
async function open(query, sabotage) {
  const ctx = await browser.newContext({
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: INSTALLATION.lat, longitude: INSTALLATION.lon, accuracy: 6 },
    ignoreHTTPSErrors: true, viewport: { width: 414, height: 720 },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (sabotage) await page.addInitScript(sabotage);
  await page.goto(`${BASE}/${query}`, { waitUntil: 'load' });
  await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
  await page.click('#gate-start');
  await page.waitForFunction(() => window.__ar?.model?.root, null, { timeout: 30_000 });
  // Long enough for several camera frames to have been delivered and smoothed.
  await page.waitForTimeout(3000);
  const state = await page.evaluate(() => ({
    measured: window.__ar.feedLatencyMs,
    delayMs: window.__ar.renderDelaySeconds * 1000,
    filter: window.__ar.activeRotationFilter,
    flow: window.__ar.flowLatencySeconds,
    rendering: window.__ar.renderer.info.render.triangles > 0,
  }));
  return { ctx, state, errors };
}

const BASE_Q = '?sim=0&mode=relative&distance=200&bearing=90';

// --- the default: measure the feed and cancel it ---
{
  const { ctx, state, errors } = await open(BASE_Q);
  check('default cancels the feed delay', state.delayMs > 0, `${state.delayMs.toFixed(1)} ms`);
  check('default uses the euro filter while doing so', state.filter === 'euro', `${state.filter}`);
  check('default still renders', state.rendering);
  check('default is quiet', errors.length === 0, errors[0]);
  await ctx.close();
}

// --- turned off explicitly: exactly the behaviour that shipped before ---
{
  const { ctx, state, errors } = await open(`${BASE_Q}&feedmatch=0`);
  check('feedmatch=0 applies no delay', state.delayMs === 0, `${state.delayMs.toFixed(1)} ms`);
  check('feedmatch=0 falls back to the plain filter', state.filter === 'fixed', `${state.filter}`);
  check('feedmatch=0 is quiet', errors.length === 0, errors[0]);
  await ctx.close();
}

// --- asked for: the delay tracks what the feed reports ---
{
  const { ctx, state, errors } = await open(`${BASE_Q}&feedmatch=1`);
  check('feedmatch reads a latency from the feed', typeof state.measured === 'number' && state.measured > 0,
    state.measured === null ? 'nothing reported' : `${state.measured?.toFixed(1)} ms`);
  check('feedmatch applies it as the delay', Math.abs(state.delayMs - (state.measured ?? -1)) < 0.5,
    `delay ${state.delayMs.toFixed(1)} ms`);
  check('feedmatch still renders', state.rendering);
  check('feedmatch is quiet', errors.length === 0, errors[0]);
  await ctx.close();
}

/*
 * --- a browser with rVFC but no capture time ---
 *
 * This is the important one. `expectedDisplayTime - undefined` is NaN, and a
 * NaN delay would either be applied as a delay of NaN — freezing the view on
 * whatever orientation happened to be in the buffer — or silently poison the
 * history search. It has to be rejected and fall back.
 */
{
  const { ctx, state, errors } = await open(`${BASE_Q}&feedmatch=1`, () => {
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return original.call(this, (now, metadata) => {
        const stripped = { ...metadata };
        delete stripped.captureTime;
        callback(now, stripped);
      });
    };
  });
  check('no capture time reported -> nothing measured from metadata', state.measured === null, `${state.measured}`);
  // Not zero any more: with no measurement available the founded fallback is
  // applied, because applying nothing leaves the WHOLE feed latency
  // uncancelled while a 90 ms estimate leaves only the difference.
  check('no capture time reported -> falls back to an estimate', state.delayMs > 0, `${state.delayMs.toFixed(1)} ms`);
  check('no capture time reported -> still renders', state.rendering);
  check('no capture time reported -> quiet', errors.length === 0, errors[0]);
  await ctx.close();
}

// --- a browser with no rVFC at all (Safari before 15.4, and others) ---
{
  const { ctx, state, errors } = await open(`${BASE_Q}&feedmatch=1`, () => {
    delete HTMLVideoElement.prototype.requestVideoFrameCallback;
  });
  check('no rVFC -> falls back to an estimate', state.delayMs > 0, `${state.delayMs.toFixed(1)} ms`);
  check('no rVFC -> still renders', state.rendering);
  check('no rVFC -> quiet', errors.length === 0, errors[0]);
  await ctx.close();
}

/*
 * --- a feed reporting nonsense ---
 *
 * A stale or wrongly-based clock can report a frame as seconds old. Applying
 * that would swing the world wildly, so it is rejected outright rather than
 * clamped, which would still be a large wrong delay.
 */
{
  const { ctx, state } = await open(`${BASE_Q}&feedmatch=1`, () => {
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return original.call(this, (now, metadata) => {
        callback(now, { ...metadata, captureTime: metadata.expectedDisplayTime - 8000 });
      });
    };
  });
  check('an absurd latency is rejected, not trusted', Math.abs(state.delayMs - 90) < 60, `${state.delayMs.toFixed(1)} ms`);
  await ctx.close();
}

/*
 * --- the fallback can be refused ---
 *
 * ?feedfallback=0 with nothing measurable is the pre-feed-matching behaviour
 * exactly, for anyone who would rather have the known artefact than an
 * estimate.
 */
{
  const { ctx, state } = await open(`${BASE_Q}&feedfallback=0`, () => {
    delete HTMLVideoElement.prototype.requestVideoFrameCallback;
  });
  check('feedfallback=0 with nothing measurable applies no delay', state.delayMs === 0, `${state.delayMs} ms`);
  check('and falls back to the plain filter', state.filter === 'fixed', `${state.filter}`);
  await ctx.close();
}

// --- ?feedlag= is honoured exactly, on any device ---
{
  const { ctx, state } = await open(`${BASE_Q}&feedlag=0.09`);
  check('feedlag is applied verbatim', Math.abs(state.delayMs - 90) < 0.001, `${state.delayMs} ms`);
  await ctx.close();
}

await browser.close();
if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — measures where it can, falls back to the shipped behaviour everywhere else');
