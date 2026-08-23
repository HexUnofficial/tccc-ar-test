/**
 * ── PUTTING THE 8TH WALL RUNTIME WHERE THE BROWSER CAN REACH IT ───────────
 *
 * The engine cannot go through the bundler. `xr.js` fetches its SLAM and face
 * chunks at runtime by path relative to itself, so rolling it into a hashed
 * bundle breaks those requests — and the licence forbids modifying or
 * recompiling it in any case (it may only be distributed "in the original form
 * distributed by Niantic Spatial"). Both reasons point the same way: copy the
 * files verbatim and serve them as static assets.
 *
 * `public/` is exactly that mechanism in Vite — served at the root in dev,
 * copied into `dist` untouched on build — so this script stages the packages
 * there and `predev`/`prebuild` run it. The staged copy is gitignored: it is
 * generated from `package-lock.json` like anything else in node_modules, and
 * committing a vendored binary would only invite it going stale.
 *
 * The `LICENSE` file inside each package's `dist` is copied along with the
 * rest, deliberately. Clause 1.3 of the engine licence requires the copyright
 * and licence notices to travel with every copy of the software, so it has to
 * land in the deploy rather than be filtered out as build noise.
 */
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where each package's `dist` goes, relative to `public/`.
 *
 * The names are referenced from index.html, so changing one means changing
 * both. They are deliberately not the package names: `external/` says plainly
 * that nothing under here is ours.
 */
const PACKAGES = [
  { from: '@8thwall/engine-binary', to: 'external/xr' },
  { from: '@8thwall/xrextras', to: 'external/xrextras' },
];

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

for (const { from, to } of PACKAGES) {
  const source = join(root, 'node_modules', from, 'dist');
  const target = join(root, 'public', to);

  if (!(await exists(source))) {
    console.error(
      `✖ ${from} is not installed. Run \`npm install\` — the 8th Wall engine is a\n`
      + '  dependency now rather than a hosted script, since the hosted platform\n'
      + '  was retired in February 2026.',
    );
    process.exit(1);
  }

  // Replace rather than merge: a stale chunk left behind by an older version of
  // the engine would be served happily and fail in a way that looks like a
  // tracking bug rather than a build one.
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });

  const version = JSON.parse(
    await readFile(join(root, 'node_modules', from, 'package.json'), 'utf8'),
  ).version;
  console.log(`  ${from}@${version} -> public/${to}`);
}
