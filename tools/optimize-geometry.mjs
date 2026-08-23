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

/*
 * ── OPAQUE PAINT EXPORTED AS TRANSPARENT ──────────────────────────────────
 *
 * Blender writes alphaMode BLEND for every material whose Alpha input is
 * connected, whether or not anything is actually see-through. This export
 * arrived with 17 of 18 materials BLEND at opacity 1: paint, metal, tyres,
 * seats, the banner.
 *
 * three.js takes BLEND at its word and puts those meshes in the transparent
 * queue, which is sorted back to front per object rather than per pixel and
 * does not write depth. Interpenetrating parts then fail to occlude each
 * other, so panels show through one another or vanish — and because the
 * ordering depends on the driver's sort, it can look correct on one device and
 * holed on the next. That is the "missing plane panels" report.
 *
 * A material is switched to OPAQUE only when it cannot possibly need blending:
 * full opacity AND a base colour texture with no alpha channel at all (or no
 * base texture). A texture that does carry an alpha channel is left alone even
 * if every pixel in it happens to be opaque — being wrong in that direction
 * puts hard black edges around a decal, which is worse than a sorting artefact.
 *
 * Deliberately not keyed to material names: the next export will rename
 * everything again, and this has to keep working without being edited.
 */
function hasAlphaChannel(image, mimeType) {
  if (!image || image.length < 26) return false;
  // JPEG has no alpha channel, ever.
  if (mimeType === 'image/jpeg') return false;
  const png = image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
  if (!png) return true; // unknown container: assume it might, and leave it be
  // IHDR is the first chunk; colour type is its 10th byte. 4 = grey+alpha,
  // 6 = RGBA. Anything else carries no alpha.
  const colourType = image[25];
  return colourType === 4 || colourType === 6;
}

/*
 * The shell renders solid, glazing included.
 *
 * The cabin glass came in at 0.04 opacity and a light lens at 0.29, so you
 * looked straight through the fuselage at the seats and the far side, and the
 * cabin read as a hole in the aircraft — "missing parts" from outside, which is
 * how this was reported.
 *
 * A hollow interior is not worth defending: this thing is seen from a few
 * hundred metres away with a banner behind it, and nobody is inspecting the
 * upholstery. Forcing the glazing opaque turns the windscreen into a dark
 * panel, which is what a window looks like from outside at that range anyway.
 *
 * KEEP_TRANSPARENCY=1 leaves genuinely see-through materials alone, for a model
 * where the inside IS the point.
 */
const SOLID_SHELL = process.env.KEEP_TRANSPARENCY !== '1';

function fixAlphaModes(document) {
  const fixed = [];
  const solidified = [];
  const kept = [];
  for (const material of document.getRoot().listMaterials()) {
    if (material.getAlphaMode() !== 'BLEND') continue;
    const name = material.getName();

    if (material.getAlpha() < 1) {
      if (!SOLID_SHELL) { kept.push(`${name} (opacity ${material.getAlpha().toFixed(2)})`); continue; }
      solidified.push(`${name} (was ${material.getAlpha().toFixed(2)})`);
      material.setAlpha(1);
      material.setAlphaMode('OPAQUE');
      continue;
    }

    const texture = material.getBaseColorTexture();
    if (texture && hasAlphaChannel(texture.getImage(), texture.getMimeType())) {
      // Left blended even under SOLID_SHELL: forcing a cutout opaque fills in
      // the shape the alpha was carving out, which is a worse artefact than
      // anything it would fix.
      kept.push(`${name} (texture carries alpha)`);
      continue;
    }

    material.setAlphaMode('OPAQUE');
    fixed.push(name);
  }
  if (fixed.length) {
    console.log(`  alpha       ${fixed.length} opaque material(s) were exported as BLEND; set to OPAQUE`);
  }
  for (const s of solidified) console.log(`              made solid: ${s}`);
  for (const k of kept) console.log(`              left blended: ${k}`);
  return fixed.length + solidified.length;
}

fixAlphaModes(doc);

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
