/**
 * Convert an FBX in public/models/ to a GLB, then hand it to the optimiser.
 *
 *   node tools/fbx-to-glb.mjs TcccAirplane_FBX.fbx public/models/tccc-airplane.glb
 *
 * Needs the dev server running (npm run dev) because three's FBXLoader needs a
 * browser, and the FBX has to be fetched over HTTP for its relative texture
 * paths to resolve.
 */
import { chromium } from 'playwright';
import { rename, stat } from 'node:fs/promises';

const SRC = process.argv[2] ?? 'TcccAirplane_FBX.fbx';
const DST = process.argv[3] ?? 'public/models/tccc-airplane.glb';
const BASE = process.env.BASE_URL ?? 'https://localhost:5199';

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true })).newPage();

await page.goto(`${BASE}/tools/fbx/convert.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.convert, { timeout: 30_000 });

console.log(`converting ${SRC} …`);
const [download, report] = await Promise.all([
  page.waitForEvent('download', { timeout: 180_000 }),
  page.evaluate((src) => window.convert(`/models/${src}`), SRC),
]);

await download.saveAs(DST);
await browser.close();

console.log(`  meshes           ${report.meshes}`);
console.log(`  triangles        ${report.triangles.toLocaleString()}`);
console.log(`  materials        ${report.materials} (${report.texturedMaterials} with a texture)`);
console.log(`  animations       ${report.animations}`);
console.log(`  bounding size    ${report.size.join(' x ')} (model units)`);
console.log(`  wrote            ${DST}, ${((await stat(DST)).size / 1048576).toFixed(1)} MB`);

if (report.missingTextures.length) {
  console.log(`\n  ${report.missingTextures.length} textures could not be loaded:`);
  for (const name of report.missingTextures.slice(0, 8)) console.log(`    ${name}`);
  if (report.missingTextures.length > 8) console.log(`    … and ${report.missingTextures.length - 8} more`);
  console.log('  Drop them next to the .fbx and re-run to get a textured model.');
}
