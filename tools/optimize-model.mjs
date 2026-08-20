/**
 * Shrinks the source GLB for mobile web AR.
 *
 * The model is only ~13k tris but ships four 2048px PNGs, so texture weight is
 * the entire problem: resizing to 1024 and re-encoding as WebP does all the work.
 *
 * Note: do NOT import '@gltf-transform/functions' here. Loading that module has
 * a side effect that leaves sharp unable to encode ("colourspace: parameter
 * space not set" from libvips). Geometry passes aren't worth reintroducing it.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const SRC = process.argv[2] ?? 'witch.glb';
const DST = process.argv[3] ?? 'public/models/witch.glb';
const MAX_TEXTURE = Number(process.env.MAX_TEXTURE ?? 1024);
const WEBP_QUALITY = Number(process.env.WEBP_QUALITY ?? 82);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SRC);

for (const [i, texture] of doc.getRoot().listTextures().entries()) {
  const before = texture.getImage();
  if (!before) continue;

  const { width = 0, height = 0 } = await sharp(before).metadata();
  const scale = Math.min(1, MAX_TEXTURE / Math.max(width, height));

  let pipeline = sharp(before);
  if (scale < 1) {
    pipeline = pipeline.resize(Math.round(width * scale), Math.round(height * scale), { fit: 'fill' });
  }
  const after = await pipeline.webp({ quality: WEBP_QUALITY, effort: 6 }).toBuffer();

  texture.setImage(after).setMimeType('image/webp');
  const label = texture.getName() || `texture ${i}`;
  console.log(`  ${label}: ${width}px png ${kb(before.byteLength)} -> ${Math.round(width * scale)}px webp ${kb(after.byteLength)}`);
}

await mkdir(dirname(DST), { recursive: true });
await io.write(DST, doc);

const from = (await stat(SRC)).size;
const to = (await stat(DST)).size;
console.log(`\n${SRC} ${kb(from)} -> ${DST} ${kb(to)}  (${((1 - to / from) * 100).toFixed(1)}% smaller)`);
