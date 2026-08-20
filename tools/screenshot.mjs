import { chromium } from 'playwright';

// The full Chromium build composites <video> into screenshots; the headless
// shell used by the test suite does not, which is why those frames look black.
const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});

// Standing ~15 m south of 174 St John Street.
const ctx = await browser.newContext({
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 51.524198, longitude: -0.102722, accuracy: 9 },
  ignoreHTTPSErrors: true,
  viewport: { width: 414, height: 896 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto('https://localhost:4173/?debug=1', { waitUntil: 'load' });
await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60000 });
await page.screenshot({ path: '.tmp/shot-gate.png' });

await page.click('#gate-start');
await page.waitForFunction(() => document.getElementById('f-anchor')?.textContent !== '—', null, { timeout: 20000 });

await page.evaluate(() => {
  const ar = window.__ar;
  ar.app.deviceOrientationControls = null;
  ar.camera.position.y = 1.6;
  const t = ar.model.root.position;
  ar.camera.lookAt(t.x, t.y + 1.4, t.z);
});
await page.waitForTimeout(1200);
await page.screenshot({ path: '.tmp/shot-ar.png' });

console.log(await page.evaluate(() =>
  Object.fromEntries(['fix','accuracy','anchor','distance','bearing','heading']
    .map(k => [k, document.getElementById(`f-${k}`).textContent]))));
await browser.close();
