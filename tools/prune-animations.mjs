/**
 * Remove animation channels that never move anything.
 *
 * The Blender export applied one action to all 223 objects, so the file carries
 * 223 clips of 41.7 seconds where only the propeller turns. Left in, the mixer
 * evaluates 669 tracks every frame on a phone to reassert values that never
 * change, and they bloat the download.
 *
 * Geometry is deliberately untouched. The weld/simplify pass in
 * optimize-geometry.mjs drops TEXCOORD_0 from 26 primitives, which is why this
 * exists separately: the animation win is free, the geometry win is not.
 *
 *   node tools/prune-animations.mjs in.glb out.glb
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { stat } from 'node:fs/promises';

const SRC = process.argv[2];
const DST = process.argv[3];
if (!SRC || !DST) throw new Error('usage: prune-animations.mjs <in.glb> <out.glb>');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SRC);

const uvBefore = doc.getRoot().listMeshes()
  .flatMap((m) => m.listPrimitives())
  .filter((p) => p.getAttribute('TEXCOORD_0')).length;

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

let channels = 0;
let clips = 0;
for (const animation of doc.getRoot().listAnimations()) {
  for (const channel of animation.listChannels()) {
    const output = channel.getSampler()?.getOutput();
    if (output && isConstant(output)) {
      channel.dispose();
      channels += 1;
    }
  }
  if (animation.listChannels().length === 0) {
    animation.dispose();
    clips += 1;
  }
}

/*
 * Deliberately no prune(). It would reclaim the orphaned keyframe accessors,
 * but it also strips TEXCOORD_0 from the 26 primitives whose materials carry no
 * texture. That is harmless in itself, yet it makes the file look like it lost
 * its textures under inspection, and the ~0.2 MB is not worth the confusion.
 * The win here is runtime: 669 tracks a frame down to 1.
 */

const uvAfter = doc.getRoot().listMeshes()
  .flatMap((m) => m.listPrimitives())
  .filter((p) => p.getAttribute('TEXCOORD_0')).length;

await io.write(DST, doc);

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
console.log(`  dropped ${channels} constant channels and ${clips} empty clips`);
console.log(`  clips remaining: ${doc.getRoot().listAnimations().map((a) => a.getName()).join(', ') || 'none'}`);
console.log(`  primitives with UVs: ${uvBefore} -> ${uvAfter}${uvAfter < uvBefore ? '  *** UVs LOST ***' : ''}`);
console.log(`  ${mb((await stat(SRC)).size)} -> ${mb((await stat(DST)).size)}`);
