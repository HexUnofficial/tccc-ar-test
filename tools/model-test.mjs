/**
 * The delivered GLB, checked without a browser.
 *
 * Three faults have reached the phone from this file rather than from the code,
 * each looking like something else entirely, and each cheap to catch here:
 *
 *   WebP textures        iOS Safari does not decode EXT_texture_webp, so the
 *                        aircraft renders pure white. Looks like a lighting or
 *                        material bug; is neither.
 *   opaque paint as
 *   alphaMode BLEND      three.js sorts those per object with no depth write,
 *                        so panels stop occluding each other and parts appear
 *                        missing — and the sort depends on the driver, so it
 *                        can look right on the machine it was checked on.
 *   no animation         a silently static aircraft.
 *
 * Run against whatever is in public/, so it covers the file that ships rather
 * than what the pipeline believes it produced.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const MODEL = process.argv[2] ?? 'public/models/tccc-airplane.glb';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(MODEL);
const root = doc.getRoot();

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

// --- textures iOS can actually decode ---
{
  const types = {};
  for (const texture of root.listTextures()) {
    const type = texture.getMimeType() || 'unknown';
    types[type] = (types[type] ?? 0) + 1;
  }
  const webp = types['image/webp'] ?? 0;
  check('no WebP textures', webp === 0,
    Object.entries(types).map(([t, n]) => `${n} ${t.replace('image/', '')}`).join(', '));
  const used = root.listExtensionsUsed().map((e) => e.extensionName);
  check('EXT_texture_webp not required', !used.includes('EXT_texture_webp'), used.join(', ') || 'none');
}

/*
 * --- opaque materials must not be marked BLEND ---
 *
 * The same test the optimiser applies, asserted on the output: a material is
 * only allowed to be BLEND if it is genuinely see-through (opacity below 1) or
 * its base colour texture actually carries an alpha channel. Read from the PNG
 * header rather than by decoding, since a colour type without alpha is proof
 * enough and needs no image library.
 */
{
  const carriesAlpha = (image, mimeType) => {
    if (!image || image.length < 26) return false;
    if (mimeType === 'image/jpeg') return false;
    const png = image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
    if (!png) return true;
    return image[25] === 4 || image[25] === 6;
  };

  const wrong = [];
  const legitimate = [];
  for (const material of root.listMaterials()) {
    if (material.getAlphaMode() !== 'BLEND') continue;
    if (material.getAlpha() < 1) { legitimate.push(material.getName()); continue; }
    const texture = material.getBaseColorTexture();
    if (texture && carriesAlpha(texture.getImage(), texture.getMimeType())) {
      legitimate.push(material.getName());
      continue;
    }
    wrong.push(material.getName());
  }
  check('no fully opaque material is marked BLEND', wrong.length === 0,
    wrong.length ? wrong.join(', ') : `${legitimate.length} genuinely blended`);
}

// --- it has to move ---
{
  const animations = root.listAnimations();
  const channels = animations.reduce((n, a) => n + a.listChannels().length, 0);
  check('carries animation', animations.length > 0 && channels > 0,
    animations.map((a) => `${a.getName()}: ${a.listChannels().length} channels`).join('; '));
}

// --- and be small enough to load over a phone network ---
{
  const { size } = await (await import('node:fs/promises')).stat(MODEL);
  check('under 16 MB', size < 16 * 1024 * 1024, `${(size / 1048576).toFixed(1)} MB`);
}

if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — decodable textures, honest alpha modes, animated');
