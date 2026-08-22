/**
 * Geometry pass: weld, simplify, quantise and Draco-compress.
 *
 * Deliberately a SEPARATE process from the texture pass. Importing
 * '@gltf-transform/functions' leaves sharp unable to encode ("colourspace:
 * parameter space not set" out of libvips), so the two cannot share a process.
 * npm run optimize:all runs them in sequence.
 *
 *   node tools/optimize-geometry.mjs in.glb out.glb
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { stat } from 'node:fs/promises';

const SRC = process.argv[2];
const DST = process.argv[3];
if (!SRC || !DST) throw new Error('usage: optimize-geometry.mjs <in.glb> <out.glb>');

/** Fraction of triangles to keep. The aircraft is 20-100 px on screen. */
const RATIO = Number(process.env.SIMPLIFY_RATIO ?? 0.25);
const ERROR = Number(process.env.SIMPLIFY_ERROR ?? 0.002);

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

const doc = await io.read(SRC);

const count = () => doc.getRoot().listMeshes()
  .flatMap((m) => m.listPrimitives())
  .reduce((sum, p) => sum + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0);

const before = count();

/*
 * Drop animation channels that never actually move.
 *
 * The Blender export applied one action to all 223 objects, so the file carries
 * 223 clips of 41.7 seconds where only the propeller turns. The rest are
 * constant keyframes: pure weight, and they force the mixer to evaluate
 * hundreds of no-op tracks every frame.
 */
function isConstant(accessor) {
  const array = accessor.getArray();
  const stride = accessor.getElementSize();
  for (let component = 0; component < stride; component += 1) {
    const first = array[component];
    for (let i = component; i < array.length; i += stride) {
      if (Math.abs(array[i] - first) > 1e-6) return false;
    }
  }
  return true;
}

let droppedChannels = 0;
let droppedClips = 0;
for (const animation of doc.getRoot().listAnimations()) {
  for (const channel of animation.listChannels()) {
    const sampler = channel.getSampler();
    const output = sampler?.getOutput();
    if (output && isConstant(output)) {
      channel.dispose();
      droppedChannels += 1;
    }
  }
  if (animation.listChannels().length === 0) {
    animation.dispose();
    droppedClips += 1;
  }
}
if (droppedChannels) {
  console.log(`  animations  dropped ${droppedChannels} constant channels, `
    + `${droppedClips} empty clips (${doc.getRoot().listAnimations().length} remain)`);
}

await doc.transform(
  dedup(),
  // weld() first: simplify can only collapse edges across shared vertices, and
  // an FBX export typically has none.
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERROR }),
  prune(),
  draco(),
);

await io.write(DST, doc);

const from = (await stat(SRC)).size;
const to = (await stat(DST)).size;
console.log(`  triangles  ${Math.round(before).toLocaleString()} -> ${Math.round(count()).toLocaleString()}`);
console.log(`  ${SRC} ${mb(from)} -> ${DST} ${mb(to)}  (${((1 - to / from) * 100).toFixed(1)}% smaller)`);
