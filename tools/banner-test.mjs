/**
 * The status banner is the only thing that distinguishes "the AR is broken"
 * from "you are in the wrong postcode", so it needs to survive interruption.
 * A transient GPS dropout used to overwrite the far-from-anchor warning
 * permanently, leaving a stale error on screen with no way back.
 */
import { chromium } from 'playwright';
import { INSTALLATION } from '../src/location.js';

const BASE = process.env.BASE_URL ?? 'https://localhost:4173';
const M = 111_320;
const at = (metres) => ({ latitude: INSTALLATION.lat - metres / M, longitude: INSTALLATION.lon, accuracy: 8 });

// CHROMIUM_PATH is for environments that ship a browser Playwright did not
// download itself; unset it and Playwright uses its own.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});
const ctx = await browser.newContext({
  permissions: ['camera', 'geolocation'], geolocation: at(3000),
  ignoreHTTPSErrors: true, viewport: { width: 414, height: 896 },
});
const page = await ctx.newPage();
await page.goto(`${BASE}/?mode=fixed&ui=debug`, { waitUntil: 'load' });
await page.waitForSelector('#gate-start:not([disabled])', { timeout: 60_000 });
await page.click('#gate-start');
await page.waitForFunction(() => document.getElementById('f-anchor')?.textContent !== '—', null, { timeout: 20_000 });

const banner = () => page.evaluate(() => {
  const s = document.getElementById('status');
  return { text: s.hidden ? '' : s.textContent, tone: s.dataset.tone };
});
const failures = [];
const check = (label, actual, predicate, expectation) => {
  const ok = predicate(actual);
  console.log(`  ${ok ? '✔' : '✖'} ${label}: "${actual.text}" [${actual.tone}]`);
  if (!ok) failures.push(`${label} — expected ${expectation}`);
};

// Wait out the six-second welcome message.
await page.waitForTimeout(6500);
check('3 km away', await banner(), (b) => b.text.includes('3.00 km') && b.tone === 'warn', 'the far-from-anchor warning');

// A GPS dropout takes priority...
await page.evaluate(() => window.__ar.locar.emit('gpserror', { code: 2, message: 'position unavailable' }));
await page.waitForTimeout(200);
check('during a GPS dropout', await banner(), (b) => b.tone === 'error', 'an error banner');

// ...and the warning must come back once a fix returns.
await ctx.setGeolocation(at(2990));
await page.waitForTimeout(1500);
check('after GPS recovers', await banner(), (b) => b.text.includes('km') && b.tone === 'warn', 'the far warning to return');

// Within range, the banner gets out of the way entirely.
await ctx.setGeolocation(at(30));
await page.waitForTimeout(1500);
check('back in range', await banner(), (b) => b.text === '', 'no banner');
check('distance in range', await page.evaluate(() => ({ text: document.getElementById('f-distance').textContent, tone: '' })),
  (b) => b.text === '30.0 m', '30.0 m');

await browser.close();
if (failures.length) {
  console.error('\n✖ FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ PASSED — banner reflects state and recovers from errors');
