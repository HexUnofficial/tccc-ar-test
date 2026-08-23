/**
 * The feed-age estimator's arithmetic, tested against signals of known lag.
 *
 * This is the half of feed matching that needs no browser: given a series of
 * sensor yaw rates and a series of image shifts, recover the delay between
 * them. Testing it here rather than only through a camera matters because the
 * failure that would hurt most is silent — a plausible-looking wrong lag would
 * be applied as a delay and make the aircraft slide the other way.
 */
import { estimateShift, estimateLag } from '../src/feedlag.js';

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

// A repeatable pseudo-random source: a flaky test here would be worse than none.
let seed = 20260823;
const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

const pan = (n) => Array.from({ length: n }, (_, i) =>
  Math.sin(i / 9) * 40 + Math.sin(i / 23) * 15 + Math.sin(i / 4.3) * 6);

/** Image shifts as a camera lagging `lag` samples behind would produce them. */
const laggedImage = (sensor, lag, noiseAmp = 0) => sensor.map((_, i) =>
  -sensor[Math.max(0, i - lag)] * 0.3 + noise() * noiseAmp);

// --- recovers a known lag ---
for (const lag of [0, 2, 5, 9]) {
  const sensor = pan(220);
  const found = estimateLag(sensor, laggedImage(sensor, lag), 14);
  check(`recovers a lag of ${lag} samples`, found?.lag === lag,
    `got ${found?.lag}, r=${found?.correlation.toFixed(3)}`);
}

// --- still recovers it through noise ---
{
  const sensor = pan(300);
  const found = estimateLag(sensor, laggedImage(sensor, 6, 8), 14);
  check('recovers a lag through heavy noise', Math.abs((found?.lag ?? -99) - 6) <= 1,
    `got ${found?.lag}, r=${found?.correlation.toFixed(3)}`);
}

/*
 * --- the correlation's sign is the guard ---
 *
 * Panning right slides the image left, so a real pan correlates NEGATIVELY.
 * Image motion that tracks the sensor positively is something else moving in
 * frame, and must not be read as latency. This is the case that would otherwise
 * apply a confident, wrong delay.
 */
{
  const sensor = pan(220);
  const sameSign = sensor.map((_, i) => sensor[Math.max(0, i - 5)] * 0.3);
  const found = estimateLag(sensor, sameSign, 14);
  check('same-sign image motion is distinguishable by sign', (found?.correlation ?? 0) > 0,
    `r=${found?.correlation.toFixed(3)}`);
}

// --- a still phone yields no usable correlation ---
{
  const sensor = new Array(220).fill(0).map(() => noise() * 0.4);
  const image = new Array(220).fill(0).map(() => noise() * 0.4);
  const found = estimateLag(sensor, image, 14);
  check('unrelated noise correlates weakly', Math.abs(found?.correlation ?? 1) < 0.5,
    `r=${found?.correlation.toFixed(3)}`);
}

// --- too little history to judge ---
check('refuses a window shorter than the lag range', estimateLag(pan(10), pan(10), 14) === null);

// --- shift estimation ---
{
  const base = Array.from({ length: 64 }, (_, i) => 128 + 40 * Math.sin(i / 3.1) + 20 * Math.sin(i / 7.7));
  for (const by of [-4, -1, 0, 2, 5]) {
    const moved = base.map((_, i) => base[Math.min(63, Math.max(0, i + by))]);
    const got = estimateShift(base, moved);
    check(`measures an image shift of ${by}`, got === -by, `got ${got}`);
  }
  check('a featureless scene reports nothing', estimateShift(new Array(64).fill(100), new Array(64).fill(100)) === null);
  check('mismatched lengths report nothing', estimateShift([1, 2, 3], [1, 2]) === null);
}

if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — recovers a known feed age, and refuses when it cannot tell');
