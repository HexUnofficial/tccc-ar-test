/**
 * Stacks frames from tools/rotation-vis.mjs into a filmstrip, so the aircraft's
 * drift against the backdrop stripes can be read down the page. Each row keeps
 * its own burned-in time, phase and pixel offset, so the labels cannot drift
 * out of step with the images.
 */
import sharp from 'sharp';
import { readdirSync } from 'node:fs';

const BAND = { left: 0, top: 0, width: 480, height: 150 }; // HUD + the aircraft's band
const PICK = 9;

async function strip(label) {
  const dir = `.tmp/vis-${label}`;
  const files = readdirSync(dir).filter(f => f.endsWith('.png')).sort();
  // Sample across the interesting window: the last of the still, the whole pan,
  // and the settle after it.
  const from = Math.round(files.length * 0.22), to = Math.round(files.length * 0.78);
  const step = (to - from) / (PICK - 1);
  const chosen = Array.from({ length: PICK }, (_, i) => files[Math.round(from + i * step)]);
  const rows = await Promise.all(chosen.map(f =>
    sharp(`${dir}/${f}`).extract(BAND).toBuffer()));
  const out = `.tmp/strip-${label}.png`;
  await sharp({ create: { width: BAND.width, height: BAND.height * PICK, channels: 3, background: '#000' } })
    .composite(rows.map((input, i) => ({ input, top: i * BAND.height, left: 0 })))
    .png().toFile(out);
  console.log(out, chosen.join(' '));
  return out;
}

const labels = process.argv.slice(2);
if (!labels.length) { console.error('usage: node tools/rotation-strip.mjs <label> [label...]'); process.exit(1); }
const made = [];
for (const label of labels) made.push(await strip(label));
if (made.length > 1) {
  // Side by side, so the same instant lines up row for row.
  const W = 480, GAP = 12;
  await sharp({ create: { width: made.length * (W + GAP) - GAP, height: 150 * PICK,
      channels: 3, background: '#111' } })
    .composite(made.map((input, i) => ({ input, left: i * (W + GAP), top: 0 })))
    .png().toFile('.tmp/strip-compare.png');
  console.log('.tmp/strip-compare.png');
}
