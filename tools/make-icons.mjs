/**
 * Generates the PWA / home-screen icons. Installed web apps launch without
 * browser chrome, which is the only route to a frameless experience on iOS.
 */
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="g" cx="50%" cy="34%">
      <stop offset="0%" stop-color="#2b2154"/>
      <stop offset="100%" stop-color="#05040c"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <path d="M256 96 140 416l116-72 116 72Z" fill="#ffffff"/>
</svg>`;

await mkdir('public/icons', { recursive: true });
for (const size of [180, 192, 512]) {
  const file = `public/icons/icon-${size}.png`;
  await sharp(Buffer.from(svg(size))).resize(size, size).png().toFile(file);
  console.log(`  ${file}`);
}
